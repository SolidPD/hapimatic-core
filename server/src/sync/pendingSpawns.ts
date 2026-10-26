// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Server-side pending-spawns registry (issue #1565, Option B).
 *
 * The SERVER-AUTHORITATIVE analogue of the web-only `web/src/lib/pending-spawns.ts`
 * stub store. When the local spawn route (`machines.ts`) accepts a spawn with
 * `earlyReturn`, it registers a `spawning` placeholder here keyed by the
 * pre-generated `hapiSessionId`. `computeSessions` (sessions.ts) merges these
 * placeholders into `/api/sessions` so EVERY client — CLI included, which cannot
 * read the web's client-only stub — sees the `spawning → running/failed` state
 * uniformly (the whole point of Option B vs. the minimal client-stub model).
 *
 * Lifecycle of an entry:
 *   1. `spawning` — added on early-ack; surfaces in /api/sessions with
 *      lifecycleState="spawning".
 *   2. reconciled — dropped by `reconcile()` once the real session (SAME id, set
 *      to lifecycleState="running" by the CLI child via sessionFactory) appears.
 *   3. `failed` — set by `markSpawnFailed()` on a background spawn error (R2), OR
 *      by the TTL backstop if the real session never appears. The failed
 *      placeholder lingers (lifecycleState="failed" + the error in
 *      metadata.summary so CLI + web can both read it) until it ages out.
 *
 * Reconciliation key is the shared `hapiSessionId` (NOT a separate
 * spawnCorrelationId), because the server passes the pre-generated id as
 * `options.hapiSessionId` and the daemon honors it — so placeholder and real
 * session share one id and reconcile exactly (no fuzzy path/name matching).
 *
 * Issue #2150 — FEDERATION placeholders. The hub registers one when it proxies a
 * spawn to a peer (`webClient.ts`), keyed by the caller's `spawnCorrelationId`
 * (the only id the caller holds — the federation hop has no pre-generated
 * session id), and marks it failed from the peer's `/federation/spawn-status`
 * callback. Both happen in the HUB process: this Map is per-process and
 * `markSpawnFailed` no-ops on a missing key, so a peer-side placeholder could
 * never be matched (sweep ruling D2-A). They differ from local entries in three
 * ways:
 *   - listed by `listFederationForNamespace` (merged into
 *     `/federation/all-sessions`), NEVER by `listForNamespace` — an
 *     `/api/sessions` row is a LOCAL row, so a remote spawn there would render
 *     as a phantom local session;
 *   - a failed one is retained FEDERATION_FAILED_RETAIN_MS (the CLI poller's
 *     ~60s window plus the hub's 15s peer-poll cadence);
 *   - the TTL backstop DROPS a still-spawning one instead of marking it failed.
 *     The callback is the explicit failure channel; a missing callback is
 *     ambiguous (a lost SUCCESS callback is as likely as a hung spawn), and a
 *     false "Timed out" row would turn a successful spawn into a failure.
 * A settled success is dropped by the spawn-status handler (`dismissPendingSpawn`).
 */

import type { SessionSummary } from "@hapi/protocol";

export type PendingSpawnState = "spawning" | "failed";

type PendingSpawnEntry = {
  sessionId: string;
  namespace: string;
  directory: string;
  name?: string;
  machineId?: string;
  state: PendingSpawnState;
  error?: string;
  /** Issue #3515: the pre-daemon refusal code (account_unrefreshable /
   *  account_token_expired / at_capacity) when a background spawn failed with
   *  one — carried so a caller can render code-specific copy. Absent for a
   *  message-only failure or the TTL backstop. */
  code?: string;
  /** Issue #2150: present only on a federation placeholder — the target peer
   *  (hub registry id + label) the spawn was proxied to. */
  federation?: { nodeId: string; nodeLabel?: string };
  createdAt: number;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * TTL backstop. A `spawning` placeholder flips to `failed` after this long if no
 * real session reconciled it AND no explicit failure arrived — so a lost
 * spawn-failed SSE/event can never leave a placeholder "spawning" forever.
 * Matches the web stub's SPAWN_TTL_MS (web/src/lib/pending-spawns.ts). A failed
 * placeholder is then garbage-collected FAILED_RETAIN_MS later.
 */
export const SPAWN_TTL_MS = 120_000;
const FAILED_RETAIN_MS = 30_000;
/** Issue #2150: a failed FEDERATION placeholder outlives the CLI poller's ~60s
 *  window plus the hub's 15s peer-poll cadence, so the caller cannot miss it. */
export const FEDERATION_FAILED_RETAIN_MS = 90_000;
const TIMEOUT_ERROR = "Timed out waiting for session to start";

const spawns = new Map<string, PendingSpawnEntry>();

function failedRetainMs(entry: PendingSpawnEntry): number {
  return entry.federation ? FEDERATION_FAILED_RETAIN_MS : FAILED_RETAIN_MS;
}

function scheduleTimer(
  sessionId: string,
  ms: number
): ReturnType<typeof setTimeout> {
  const t = setTimeout(() => onTimer(sessionId), ms);
  // Don't let a pending-spawn timer keep the server process alive on shutdown.
  if (typeof t === "object" && t !== null && "unref" in t) {
    (t as { unref: () => void }).unref();
  }
  return t;
}

function onTimer(sessionId: string): void {
  const entry = spawns.get(sessionId);
  if (!entry) return;
  if (entry.state === "spawning" && !entry.federation) {
    // TTL backstop: never reconciled, never explicitly failed → mark failed.
    entry.state = "failed";
    entry.error = TIMEOUT_ERROR;
    entry.timer = scheduleTimer(sessionId, FAILED_RETAIN_MS);
  } else {
    // failed → retention elapsed → drop it. Issue #2150: a federation entry
    // still spawning at the TTL is dropped too (see the header comment).
    spawns.delete(sessionId);
  }
}

/**
 * Register a `spawning` placeholder. Idempotent on `sessionId` — re-adding the
 * same id replaces the prior entry (and resets its TTL).
 */
export function addPendingSpawn(params: {
  sessionId: string;
  namespace: string;
  directory: string;
  name?: string;
  machineId?: string;
}): void {
  const existing = spawns.get(params.sessionId);
  if (existing) clearTimeout(existing.timer);
  spawns.set(params.sessionId, {
    sessionId: params.sessionId,
    namespace: params.namespace,
    directory: params.directory,
    name: params.name,
    machineId: params.machineId,
    state: "spawning",
    createdAt: Date.now(),
    timer: scheduleTimer(params.sessionId, SPAWN_TTL_MS),
  });
}

/**
 * Issue #2150: register a `spawning` FEDERATION placeholder on the hub, keyed by
 * the caller's `spawnCorrelationId`, before the spawn is forwarded to the peer
 * (a fast refusal callback can race the accept response). Re-registering the
 * same id replaces the entry — a retry with the same correlation id is never
 * masked by its earlier failed row. The entry is also the spawn's
 * correlation-id → caller-namespace map for the outcome events (K-4497-1).
 */
export function addFederationPendingSpawn(params: {
  spawnCorrelationId: string;
  namespace: string;
  directory: string;
  nodeId: string;
  nodeLabel?: string;
}): void {
  const id = params.spawnCorrelationId;
  const existing = spawns.get(id);
  if (existing) clearTimeout(existing.timer);
  spawns.set(id, {
    sessionId: id,
    namespace: params.namespace,
    directory: params.directory,
    state: "spawning",
    federation: { nodeId: params.nodeId, nodeLabel: params.nodeLabel },
    createdAt: Date.now(),
    timer: scheduleTimer(id, SPAWN_TTL_MS),
  });
}

/**
 * Issue #2150: the routing facts of a federation placeholder — the caller's
 * namespace and the target node the hub proxied to — or undefined when the hub
 * holds none for this id (no correlation id was sent, the hub restarted, or the
 * entry aged out). Local entries are never returned.
 */
export function getFederationPendingSpawn(
  spawnCorrelationId: string
): { namespace: string; nodeId: string; nodeLabel?: string } | undefined {
  const entry = spawns.get(spawnCorrelationId);
  if (!entry?.federation) return undefined;
  return {
    namespace: entry.namespace,
    nodeId: entry.federation.nodeId,
    nodeLabel: entry.federation.nodeLabel,
  };
}

/**
 * Mark a placeholder failed (R2 — a background spawn error after the early ack).
 * No-op if the placeholder is gone (already reconciled or aged out).
 *
 * Issue #5696: returns `true` only when this call moved the entry from
 * `spawning` to `failed`, so a caller raising a one-time effect (the hub's
 * `spawn-failed` inbox row) skips a repeated failure for the same spawn. An
 * already-failed entry is still refreshed (error, code, retention timer).
 */
export function markSpawnFailed(
  sessionId: string,
  error: string,
  code?: string
): boolean {
  const entry = spawns.get(sessionId);
  if (!entry) return false;
  const wasSpawning = entry.state === "spawning";
  clearTimeout(entry.timer);
  entry.state = "failed";
  entry.error = error;
  // Issue #3515: retain the refusal code alongside the message (optional).
  entry.code = code;
  entry.timer = scheduleTimer(sessionId, failedRetainMs(entry));
  return wasSpawning;
}

/** Explicitly drop a placeholder (e.g. an immediate caller-side cleanup). */
export function dismissPendingSpawn(sessionId: string): void {
  const entry = spawns.get(sessionId);
  if (!entry) return;
  clearTimeout(entry.timer);
  spawns.delete(sessionId);
}

/**
 * Drop any placeholder in `namespace` whose id now appears as a real session.
 * Called by computeSessions BEFORE listForNamespace so a reconciled placeholder
 * never double-renders alongside its real session. Reconciliation is by exact id.
 */
export function reconcile(
  namespace: string,
  realSessionIds: Set<string>
): void {
  for (const [id, entry] of spawns) {
    if (entry.namespace !== namespace) continue;
    // Issue #2150: a federation placeholder never matches a LOCAL session id; it
    // settles through the spawn-status callback instead.
    if (entry.federation) continue;
    if (realSessionIds.has(id)) {
      clearTimeout(entry.timer);
      spawns.delete(id);
    }
  }
}

/**
 * Project the live placeholders for `namespace` into SessionSummary objects that
 * computeSessions appends to the real session list. The failed entries carry the
 * error in metadata.summary so BOTH web and CLI surface it (web also gets the
 * immediate spawn-failed SSE toast).
 */
export function listForNamespace(namespace: string): SessionSummary[] {
  const out: SessionSummary[] = [];
  for (const entry of spawns.values()) {
    if (entry.namespace !== namespace) continue;
    // Issue #2150: federation placeholders are remote rows — listed by
    // listFederationForNamespace (`/federation/all-sessions`) only.
    if (entry.federation) continue;
    out.push({
      id: entry.sessionId,
      tag: entry.sessionId,
      active: false,
      thinking: false,
      activeAt: entry.createdAt,
      updatedAt: Date.now(),
      metadata: {
        path: entry.directory,
        name: entry.name,
        machineId: entry.machineId,
        summary:
          entry.state === "failed" && entry.error
            ? { text: `Spawn failed: ${entry.error}` }
            : undefined,
      },
      todoProgress: null,
      pendingRequestsCount: 0,
      isWaitingForUserQuestion: false,
      lifecycleState: entry.state,
      emoji: null,
      messageCount: 0,
      childBranchCount: 0,
    });
  }
  return out;
}

/**
 * Issue #2150: project the caller's federation placeholders into the remote
 * session rows `/federation/all-sessions` appends to its live sessions — an
 * ADDITIVE member of the HTTP-200 `{sessions, nodes}` envelope (R4), never a
 * route error. `id`/`tag`/`metadata.spawnCorrelationId` all carry the
 * correlation id so a poller can match the row to its own spawn; `nodeId` is the
 * target peer (every remote consumer filters by node). A failed row carries the
 * peer's message in `metadata.summary` and its code in `metadata.spawnErrorCode`.
 *
 * The row deliberately has NO `metadata.name` and NO `metadata.worktree`: the
 * CLI's discovery loop (`hapi-spawn.sh --federation-node`) matches a session by
 * node + display name or worktree name with no lifecycle filter, so a named
 * placeholder would be "discovered" in place of the real session.
 */
export function listFederationForNamespace(
  namespace: string
): SessionSummary[] {
  const out: SessionSummary[] = [];
  for (const entry of spawns.values()) {
    if (entry.namespace !== namespace || !entry.federation) continue;
    const failed = entry.state === "failed";
    out.push({
      id: entry.sessionId,
      tag: entry.sessionId,
      active: false,
      thinking: false,
      activeAt: entry.createdAt,
      updatedAt: Date.now(),
      metadata: {
        path: entry.directory,
        spawnCorrelationId: entry.sessionId,
        summary:
          failed && entry.error
            ? { text: `Spawn failed: ${entry.error}` }
            : undefined,
        ...(failed && entry.code ? { spawnErrorCode: entry.code } : {}),
      },
      todoProgress: null,
      pendingRequestsCount: 0,
      isWaitingForUserQuestion: false,
      lifecycleState: entry.state,
      emoji: null,
      messageCount: 0,
      childBranchCount: 0,
      nodeId: entry.federation.nodeId,
      ...(entry.federation.nodeLabel
        ? { nodeLabel: entry.federation.nodeLabel }
        : {}),
    });
  }
  return out;
}

/** Test-only: clear all entries + timers. */
export function _resetPendingSpawns(): void {
  for (const entry of spawns.values()) clearTimeout(entry.timer);
  spawns.clear();
}

/** Test-only: current entry count. */
export function _pendingSpawnCount(): number {
  return spawns.size;
}

/** Test-only: read one entry's state/error/code (issue #3515). */
export function _getPendingSpawn(
  sessionId: string
): { state: PendingSpawnState; error?: string; code?: string } | undefined {
  const entry = spawns.get(sessionId);
  if (!entry) return undefined;
  return { state: entry.state, error: entry.error, code: entry.code };
}
