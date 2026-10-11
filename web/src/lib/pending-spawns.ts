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
  /** Correlation ID sent with the spawn request for reliable hub→client matching (issue #933) */
  spawnCorrelationId?: string;
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
  const id = crypto.randomUUID();
  const spawn: PendingSpawn = {
    ...params,
    id,
    state: "spawning",
    createdAt: Date.now(),
  };
  spawns.set(id, spawn);

  // Auto-expire after TTL → transitions to failed so user can dismiss
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
      }
    }, SPAWN_TTL_MS)
  );

  updateSnapshot();
  return id;
}

export function markSpawnFailed(id: string, rawError: string): void {
  const existing = spawns.get(id);
  if (!existing) return;

  // Extract clean error from raw HTTP error bodies.
  // ApiClient throws "HTTP 503 Service Unavailable: {"type":"error","message":"..."}"
  // — extract the JSON message field for a user-friendly display.
  let error = rawError;
  const jsonMatch = rawError.match(/"message"\s*:\s*"([^"]+)"/);
  if (jsonMatch?.[1]) {
    error = jsonMatch[1];
  }

  spawns.set(id, { ...existing, state: "failed", error });

  // Clear the auto-expire timer — failed stubs persist until dismissed
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }

  updateSnapshot();
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
 */
export function handleSpawnFailed(event: {
  nodeId: string;
  directory: string;
  spawnCorrelationId?: string | null;
  error: string;
}): void {
  let matched = false;

  for (const [id, spawn] of spawns) {
    if (spawn.state !== "spawning") continue;

    // Strategy 1: correlation ID match (most reliable)
    if (
      event.spawnCorrelationId &&
      spawn.spawnCorrelationId &&
      event.spawnCorrelationId === spawn.spawnCorrelationId
    ) {
      markSpawnFailed(id, event.error);
      matched = true;
      break;
    }

    // Strategy 2: nodeId + directory match (fallback)
    if (spawn.nodeId === event.nodeId) {
      const spawnDir = normalizePath(spawn.directory);
      const eventDir = normalizePath(event.directory);
      if (spawnDir && eventDir && spawnDir === eventDir) {
        markSpawnFailed(id, event.error);
        matched = true;
        break;
      }
    }
  }

  if (!matched) {
    // No matching pending spawn found — the stub may have already timed out
    // or been dismissed. This is not an error.
  }
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
 */
export function reconcilePendingSpawns(
  sessions: Array<{
    nodeId?: string;
    metadata?: {
      path?: string;
      name?: string;
      spawnCorrelationId?: string;
    } | null;
  }>
): void {
  if (spawns.size === 0) return;

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
