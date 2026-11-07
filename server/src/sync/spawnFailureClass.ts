// SPDX-License-Identifier: AGPL-3.0-only
/**
 * How a failed spawn should be treated by the bounded retry loop (#2301), split out
 * of `rpcGateway.ts` (which re-exports both names) to keep that file under its
 * line limit when #6156 added the `insufficient_memory` code.
 */

/** Issue #2301 (Task 1): how a failed spawn should be treated by the retry loop. */
export type SpawnFailureKind = "capacity" | "transient-rpc" | "deterministic";

/** Which limit a "capacity" refusal hit: the session count, or free memory (#6156). */
export type SpawnCapacityCause = "slots" | "memory";

/** The limit behind a capacity refusal, so a waiting notice names the right one. */
export function spawnCapacityCause(result: {
  message?: string;
  code?: string;
}): SpawnCapacityCause {
  return result.code === "insufficient_memory" ||
    (result.message ?? "").includes("Not enough free memory to start a session")
    ? "memory"
    : "slots";
}

/**
 * Issue #2301 (Task 1, R2): classify a failed spawn result so switchAccount +
 * reconnectSession (and any future call site, e.g. #3618) share ONE source of
 * truth for "is this retriable" — avoiding two skills disagreeing about what
 * "transient" means. Promoted from the #1349 daemon-offline include-idiom (used
 * by cleanupTmuxSession / reapRemoteWindow in `rpcGateway.ts`).
 *
 * Prefers the daemon's structured error `code` when present (D1): the daemon mints
 * `code:"at_capacity"` for the concurrency-cap rejection (#1772) and it is preserved
 * through the spawn-result chain (#2299 switch-path pre-check re-tag + #2300 Task 2
 * reconnect-failure preservation). Falls back to a message substring test otherwise.
 * Everything not matched is `deterministic` (account_not_found, account_unrefreshable,
 * cwd_missing, unsupported-agent, …) → fail fast, zero retries.
 */
export function isRetriableSpawnFailure(result: {
  message?: string;
  code?: string;
}): { retriable: boolean; kind: SpawnFailureKind } {
  // Prefer the structured code (D1). #6156: a low-memory refusal is a busy node
  // too — retriable once a job finishes or a session ends.
  if (result.code === "at_capacity" || result.code === "insufficient_memory") {
    return { retriable: true, kind: "capacity" };
  }
  const msg = result.message ?? "";
  // Substring fallback for capacity: the daemon's cap message. Some paths carry
  // only the message (e.g. pendingSpawns.markSpawnFailed) with no code.
  if (
    msg.includes("Too many concurrent sessions") ||
    msg.includes("Not enough free memory to start a session")
  ) {
    return { retriable: true, kind: "capacity" };
  }
  // Transient RPC faults — the #1349 include-idiom. rpcCall throws these when the
  // daemon socket drops under CPU starvation; they are retriable once it recovers.
  if (
    msg.includes("RPC handler not registered") ||
    msg.includes("RPC socket disconnected")
  ) {
    return { retriable: true, kind: "transient-rpc" };
  }
  return { retriable: false, kind: "deterministic" };
}
