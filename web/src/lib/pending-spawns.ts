// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Pending Spawns Store
 *
 * Manages stub session entries for remote spawns that have been accepted
 * by the federation node but haven't appeared in poll data yet.
 *
 * Lifecycle:
 *   1. "spawning" — grayed-out stub with spinner (immediate feedback)
 *   2. Reconciled — stub removed when real session appears in federation poll
 *   3. "failed" — error indicator + dismiss button (on spawn error or timeout)
 *
 * Pattern mirrors federation-mutation-overrides.ts: module-level Map store
 * with useSyncExternalStore-compatible subscribe/getSnapshot.
 */
import { randomUuid } from "@/lib/randomUuid";

export type PendingSpawnState = "spawning" | "failed";

export type PendingSpawn = {
  id: string;
  state: PendingSpawnState;
  nodeId: string;
  nodeLabel: string;
  directory: string;
  name?: string;
  emoji?: string;
  agent?: string;
  createdAt: number;
  error?: string;
  /** Issue #2150: the peer's refusal code on a failed remote spawn (e.g.
   *  `account_unrefreshable`), when it sent one. */
  code?: string;
  /** Correlation ID sent with the spawn request for reliable hub→client matching (issue #933) */
  spawnCorrelationId?: string;
};

/**
 * Issue #2150: the window event raised when a remote spawn's stub turns failed
 * ASYNCHRONOUSLY — the hub's `federation-spawn-failed` SSE, a hub placeholder row
 * that reports the failure on the next poll, or the 120s TTL — so
 * `RemoteSpawnFailedToastListener` (App.tsx) can raise ONE toast per failure.
 * A synchronous refusal of the spawn request is NOT announced here: the Create
 * page already shows it inline.
 */
export const REMOTE_SPAWN_FAILED_EVENT = "hapi:remoteSpawnFailed";

export type RemoteSpawnFailedDetail = {
  nodeId: string;
  nodeLabel: string;
  error: string;
  code?: string;
  /** True when the 120s TTL expired with no outcome from the node. */
  timedOut: boolean;
};

// ── Module-level store ──────────────────────────────────────────────

const spawns = new Map<string, PendingSpawn>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

/**
 * Auto-expire spawning stubs after 120s (failure fallback).
 * Remote federation spawns traverse: hub → remote node → CLI bootstrap → hub
 * poll (15s) → client poll (30s), so 60s was too tight.
 */
const SPAWN_TTL_MS = 120_000;

/** Error message set by the TTL auto-expire timer. */
const TIMEOUT_ERROR = "Timed out waiting for session to appear";

let snapshot: PendingSpawn[] = [];

function updateSnapshot(): void {
  snapshot = Array.from(spawns.values());
  for (const fn of listeners) fn();
}

// ── Public API ──────────────────────────────────────────────────────

export function addPendingSpawn(
  params: Omit<PendingSpawn, "id" | "state" | "createdAt">
): string {
  // #4497: not crypto.randomUUID() — it throws on a plain-HTTP origin.
  const id = randomUuid();
  const spawn: PendingSpawn = {
    ...params,
    id,
    state: "spawning",
    createdAt: Date.now(),
  };
  spawns.set(id, spawn);

  // Auto-expire after TTL → transitions to failed so user can dismiss.
  // Issue #2150: the timeout is announced (toast), like a node-reported failure.
  timers.set(
    id,
    setTimeout(() => {
      const existing = spawns.get(id);
      if (existing && existing.state === "spawning") {
        spawns.set(id, {
          ...existing,
          state: "failed",
          error: TIMEOUT_ERROR,
        });
        timers.delete(id);
        updateSnapshot();
        announceRemoteSpawnFailed(existing, TIMEOUT_ERROR, undefined, true);
      }
    }, SPAWN_TTL_MS)
  );

  updateSnapshot();
  return id;
}

/** Issue #2150: tell the toast listener a stub failed asynchronously. */
function announceRemoteSpawnFailed(
  spawn: PendingSpawn,
  error: string,
  code: string | undefined,
  timedOut: boolean
): void {
  window.dispatchEvent(
    new CustomEvent<RemoteSpawnFailedDetail>(REMOTE_SPAWN_FAILED_EVENT, {
      detail: {
        nodeId: spawn.nodeId,
        nodeLabel: spawn.nodeLabel,
        error,
        ...(code ? { code } : {}),
        timedOut,
      },
    })
  );
}

/**
 * Flip a stub to failed. Returns the clean error text, or null when no stub has
 * this id. `markSpawnFailed` (the Create page's synchronous refusal path) does
 * NOT announce; the asynchronous paths below do.
 */
function failStub(
  id: string,
  rawError: string,
  code?: string
): { spawn: PendingSpawn; error: string } | null {
  const existing = spawns.get(id);
  if (!existing) return null;

  // Extract clean error from raw HTTP error bodies.
  // ApiClient throws "HTTP 503 Service Unavailable: {"type":"error","message":"..."}"
  // — extract the JSON message field for a user-friendly display.
  let error = rawError;
  const jsonMatch = rawError.match(/"message"\s*:\s*"([^"]+)"/);
  if (jsonMatch?.[1]) {
    error = jsonMatch[1];
  }

  spawns.set(id, {
    ...existing,
    state: "failed",
    error,
    ...(code ? { code } : {}),
  });

  // Clear the auto-expire timer — failed stubs persist until dismissed
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }

  updateSnapshot();
  return { spawn: existing, error };
}

/**
 * #4497: true for a stub that failed because its 120 s TTL expired with no
 * outcome from the node — as opposed to a refusal the node reported. The stub
 * carries no timeout flag, so this is the only way to tell the two apart (the
 * fan-out reports a timeout as "unconfirmed", a refusal as "refused").
 */
export function isPendingSpawnTimeout(spawn: PendingSpawn): boolean {
  return spawn.state === "failed" && spawn.error === TIMEOUT_ERROR;
}

export function markSpawnFailed(id: string, rawError: string): void {
  failStub(id, rawError);
}

export function dismissPendingSpawn(id: string): void {
  spawns.delete(id);
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
  updateSnapshot();
}

/**
 * Mark a pending spawn as failed based on a spawn-status callback from
 * the remote node (issue #933). Matches by spawnCorrelationId first,
 * then falls back to nodeId + directory.
 *
 * Issue #2150: the node + directory fallback only pairs an event and a stub
 * when one of them carries no correlation id. Two ids that differ name two
 * different spawns, so a refusal for one spawn never fails another spawn's
 * stub in the same directory.
 */
export function handleSpawnFailed(event: {
  nodeId: string;
  directory: string;
  spawnCorrelationId?: string | null;
  error: string;
  /** Issue #2150: the peer's refusal code and the hub-stamped node label. */
  code?: string;
  nodeLabel?: string;
}): void {
  const eventDir = normalizePath(event.directory);
  let matchId: string | undefined;

  // Strategy 1: correlation ID match (most reliable)
  if (event.spawnCorrelationId) {
    for (const [id, spawn] of spawns) {
      if (
        spawn.state === "spawning" &&
        spawn.spawnCorrelationId === event.spawnCorrelationId
      ) {
        matchId = id;
        break;
      }
    }
  }

  // Strategy 2: nodeId + directory match (fallback)
  if (!matchId) {
    for (const [id, spawn] of spawns) {
      if (spawn.state !== "spawning" || spawn.nodeId !== event.nodeId) {
        continue;
      }
      if (event.spawnCorrelationId && spawn.spawnCorrelationId) continue;
      const spawnDir = normalizePath(spawn.directory);
      if (spawnDir && eventDir && spawnDir === eventDir) {
        matchId = id;
        break;
      }
    }
  }

  // No matching pending spawn found — the stub may have already timed out
  // or been dismissed. This is not an error.
  if (!matchId) return;

  const spawn = spawns.get(matchId);
  const failed = failStub(matchId, event.error, event.code);
  if (spawn && failed) {
    announceRemoteSpawnFailed(
      { ...failed.spawn, nodeLabel: event.nodeLabel ?? spawn.nodeLabel },
      failed.error,
      event.code,
      false
    );
  }
}

/**
 * Issue #2150: the hub's `federation-spawn-succeeded` outcome for a remote
 * spawn — clear the stub that carries its correlation id. The real session
 * arrives through the remote-session refetch that the same SSE event
 * triggers. Without this, a session that runs in a different directory than
 * the one the stub recorded (a worktree or clone spawn) and has no name never
 * matches the stub, and its 120 s timeout would raise a false failure toast.
 * Covers a stub still spawning and one that already timed out; a stub the
 * node refused is left for the user to dismiss.
 */
export function handleSpawnSucceeded(event: {
  spawnCorrelationId?: string | null;
}): void {
  const correlationId = event.spawnCorrelationId;
  if (!correlationId) return;
  for (const [id, spawn] of spawns) {
    if (spawn.spawnCorrelationId !== correlationId) continue;
    if (spawn.state === "failed" && spawn.error !== TIMEOUT_ERROR) continue;
    dismissPendingSpawn(id);
  }
}

/**
 * Issue #2150: true for a hub-side FEDERATION spawn placeholder row in
 * `/federation/all-sessions` (a `spawning` / `failed` row keyed by the spawn's
 * correlation id) — never a real session. No real session carries
 * `metadata.spawnCorrelationId`.
 */
export function isFederationSpawnPlaceholder(s: {
  lifecycleState?: string | null;
  metadata?: { path?: string; spawnCorrelationId?: string } | null;
}): boolean {
  return (
    Boolean(s.metadata?.spawnCorrelationId) &&
    (s.lifecycleState === "spawning" || s.lifecycleState === "failed")
  );
}

/** "Spawn failed: <message>" (the server placeholder's summary) → "<message>". */
function placeholderError(summaryText: string | undefined): string | null {
  if (!summaryText) return null;
  return summaryText.replace(/^Spawn failed:\s*/, "") || null;
}

/**
 * Normalize a filesystem path for comparison: strip trailing slash
 * (except root "/") and collapse duplicate slashes.
 */
export function normalizePath(p: string): string {
  if (!p) return "";
  let n = p.replace(/\/\/+/g, "/");
  if (n.length > 1 && n.endsWith("/")) n = n.slice(0, -1);
  return n;
}

/**
 * Reconcile pending spawns against fresh federation poll data.
 *
 * Matching strategies (all require nodeId match):
 *   1. Normalized directory path — handles trailing-slash and double-slash
 *      differences between the form value and process.cwd() on the remote node.
 *   2. Session name — handles symlink/mount-point differences where the
 *      resolved cwd differs from the directory the user selected.
 *
 * Also reconciles stubs that timed out (state "failed" with the timeout
 * error message) — if the real session appeared after the TTL expired, the
 * stale stub is cleaned up so the user doesn't see a misleading error.
 *
 * Issue #2150: the poll data also carries the hub's federation spawn
 * placeholders. A placeholder is NOT a real session, so it never reconciles a
 * stub away (the stub stays the one row the list renders for the spawn). A
 * FAILED placeholder whose correlation id matches a still-spawning stub flips
 * that stub to failed with the node's error — the poll backstop for a lost
 * `federation-spawn-failed` SSE.
 */
export function reconcilePendingSpawns(
  polled: Array<{
    nodeId?: string;
    lifecycleState?: string | null;
    metadata?: {
      path?: string;
      name?: string;
      spawnCorrelationId?: string;
      spawnErrorCode?: string;
      summary?: { text: string };
    } | null;
  }>
): void {
  if (spawns.size === 0) return;

  const real: typeof polled = [];
  for (const s of polled) {
    if (!isFederationSpawnPlaceholder(s)) {
      real.push(s);
      continue;
    }
    if (s.lifecycleState !== "failed") continue;
    const correlationId = s.metadata?.spawnCorrelationId;
    const error = placeholderError(s.metadata?.summary?.text);
    if (!correlationId || !error) continue;
    for (const [id, spawn] of spawns) {
      if (spawn.state !== "spawning") continue;
      if (spawn.spawnCorrelationId !== correlationId) continue;
      const code = s.metadata?.spawnErrorCode;
      const failed = failStub(id, error, code);
      if (failed) {
        announceRemoteSpawnFailed(failed.spawn, failed.error, code, false);
      }
      break;
    }
  }
  const sessions = real;

  let changed = false;
  for (const [id, spawn] of spawns) {
    // Match "spawning" stubs (waiting) AND "failed" stubs that timed out
    // (the real session may have appeared after the TTL expired). Stubs
    // that failed due to an API error are left for the user to dismiss.
    if (spawn.state === "failed" && spawn.error !== TIMEOUT_ERROR) continue;

    const spawnDir = normalizePath(spawn.directory);

    const match = sessions.some(s => {
      if (s.nodeId !== spawn.nodeId) return false;

      // Strategy 0: Correlation ID match (most reliable — issue #933)
      if (
        spawn.spawnCorrelationId &&
        s.metadata?.spawnCorrelationId &&
        spawn.spawnCorrelationId === s.metadata.spawnCorrelationId
      ) {
        return true;
      }

      // Strategy 1: Normalized path match
      const sessionDir = normalizePath(s.metadata?.path ?? "");
      if (sessionDir && spawnDir && sessionDir === spawnDir) return true;

      // Strategy 2: Name match (if the spawn included a name)
      if (spawn.name && s.metadata?.name && s.metadata.name === spawn.name) {
        return true;
      }

      return false;
    });

    if (match) {
      spawns.delete(id);
      const timer = timers.get(id);
      if (timer) {
        clearTimeout(timer);
        timers.delete(id);
      }
      changed = true;
    }
  }

  if (changed) updateSnapshot();
}

// ── useSyncExternalStore interface ──────────────────────────────────

export function subscribePendingSpawns(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

export function getPendingSpawnsSnapshot(): PendingSpawn[] {
  return snapshot;
}
