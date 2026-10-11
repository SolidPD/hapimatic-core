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
const TIMEOUT_ERROR = "Timed out waiting for session to start";

const spawns = new Map<string, PendingSpawnEntry>();

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
  if (entry.state === "spawning") {
    // TTL backstop: never reconciled, never explicitly failed → mark failed.
    entry.state = "failed";
    entry.error = TIMEOUT_ERROR;
    entry.timer = scheduleTimer(sessionId, FAILED_RETAIN_MS);
  } else {
    // failed → retention elapsed → drop it.
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
 * Mark a placeholder failed (R2 — a background spawn error after the early ack).
 * No-op if the placeholder is gone (already reconciled or aged out).
 */
export function markSpawnFailed(
  sessionId: string,
  error: string,
  code?: string
): void {
  const entry = spawns.get(sessionId);
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.state = "failed";
  entry.error = error;
  // Issue #3515: retain the refusal code alongside the message (optional).
  entry.code = code;
  entry.timer = scheduleTimer(sessionId, FAILED_RETAIN_MS);
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
