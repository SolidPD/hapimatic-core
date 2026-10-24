// SPDX-License-Identifier: AGPL-3.0-only
/**
 * #4497: settle ONE remote fan-out peer's spawn.
 *
 * The hub answers an accepted federation spawn with `{ type: "success",
 * sessionId: "" }` — it does not know the session id yet. The outcome arrives
 * later, keyed by the spawn's correlation id (#2150, contract K-4497-1):
 *
 *   1. `hapi:federationSpawnSucceeded` → success with the session id;
 *   2. `hapi:federationSpawnFailed` → refused with the node's message + code;
 *   3. the peer's own stub turning `failed` in the stub store → refused (the
 *      poll backstop for a lost failure event), or unconfirmed when the stub
 *      failed only because its 120 s TTL ran out;
 *   4. a caller-supplied list probe (a lost success event — the SSE stream
 *      reconnected during the spawn) → success with the probed id;
 *   5. `timeoutMs` with none of these → unconfirmed.
 *
 * The first source wins (a settled latch). A stub that DISAPPEARS is not a
 * signal: a success clears it, and the reconciler can drop it early when a
 * listed session on the same node has the same path or name.
 *
 * Create the waiter BEFORE sending the spawn request: a fast refusal reaches
 * the browser over SSE, which can beat the proxy's HTTP response.
 */
import {
  getPendingSpawnsSnapshot,
  isPendingSpawnTimeout,
  subscribePendingSpawns,
} from "@/lib/pending-spawns";

/** Window events re-emitted by `useSSE` for the hub's K-4497-1 outcomes. */
export const FEDERATION_SPAWN_SUCCEEDED_EVENT = "hapi:federationSpawnSucceeded";
export const FEDERATION_SPAWN_FAILED_EVENT = "hapi:federationSpawnFailed";

export type RemoteSpawnOutcome =
  | { kind: "success"; sessionId: string }
  | { kind: "refused"; message: string; code?: string }
  | { kind: "unconfirmed" };

export type AwaitRemoteSpawnOptions = {
  /** The `spawnCorrelationId` sent with the spawn request. */
  correlationId: string;
  /** The id of the peer's stub in the stub store, when one was registered. */
  stubId?: string;
  /** Give up (unconfirmed) after this long. Matches the stub TTL. */
  timeoutMs?: number;
  /** Resolve the peer's session id from the node's list, or null. */
  probe?: () => Promise<string | null>;
  probeAfterMs?: number;
  probeEveryMs?: number;
};

export type RemoteSpawnWaiter = {
  promise: Promise<RemoteSpawnOutcome>;
  /** Tear the waiter down without settling it (the caller stops awaiting). */
  cancel: () => void;
};

type SucceededDetail = { spawnCorrelationId?: string; sessionId?: string };
type FailedDetail = {
  spawnCorrelationId?: string;
  error?: string;
  code?: string;
};

export function awaitRemoteSpawn({
  correlationId,
  stubId,
  timeoutMs = 120_000,
  probe,
  probeAfterMs = 15_000,
  probeEveryMs = 10_000,
}: AwaitRemoteSpawnOptions): RemoteSpawnWaiter {
  let done = false;
  let resolveOutcome: (outcome: RemoteSpawnOutcome) => void = () => {};
  const promise = new Promise<RemoteSpawnOutcome>(resolve => {
    resolveOutcome = resolve;
  });

  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let probeTimer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribe: (() => void) | null = null;

  const teardown = (): void => {
    done = true;
    window.removeEventListener(FEDERATION_SPAWN_SUCCEEDED_EVENT, onSucceeded);
    window.removeEventListener(FEDERATION_SPAWN_FAILED_EVENT, onFailed);
    unsubscribe?.();
    unsubscribe = null;
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (probeTimer) clearTimeout(probeTimer);
    timeoutTimer = null;
    probeTimer = null;
  };

  const settle = (outcome: RemoteSpawnOutcome): void => {
    if (done) return;
    teardown();
    resolveOutcome(outcome);
  };

  function onSucceeded(event: Event): void {
    const detail = (event as CustomEvent<SucceededDetail>).detail;
    if (detail?.spawnCorrelationId !== correlationId) return;
    // An empty id cannot be prompted or linked; leave it to the other sources.
    if (!detail.sessionId) return;
    settle({ kind: "success", sessionId: detail.sessionId });
  }

  function onFailed(event: Event): void {
    const detail = (event as CustomEvent<FailedDetail>).detail;
    if (detail?.spawnCorrelationId !== correlationId) return;
    settle({
      kind: "refused",
      message: detail.error || "The node refused the spawn",
      ...(detail.code ? { code: detail.code } : {}),
    });
  }

  const checkStub = (): void => {
    if (!stubId) return;
    const stub = getPendingSpawnsSnapshot().find(s => s.id === stubId);
    if (!stub || stub.state !== "failed") return;
    if (isPendingSpawnTimeout(stub)) {
      settle({ kind: "unconfirmed" });
      return;
    }
    settle({
      kind: "refused",
      message: stub.error || "The node refused the spawn",
      ...(stub.code ? { code: stub.code } : {}),
    });
  };

  const runProbe = async (): Promise<void> => {
    probeTimer = null;
    if (done || !probe) return;
    let sessionId: string | null = null;
    try {
      sessionId = await probe();
    } catch {
      sessionId = null;
    }
    if (done) return;
    if (sessionId) {
      settle({ kind: "success", sessionId });
      return;
    }
    probeTimer = setTimeout(() => void runProbe(), probeEveryMs);
  };

  window.addEventListener(FEDERATION_SPAWN_SUCCEEDED_EVENT, onSucceeded);
  window.addEventListener(FEDERATION_SPAWN_FAILED_EVENT, onFailed);
  if (stubId) {
    unsubscribe = subscribePendingSpawns(checkStub);
  }
  timeoutTimer = setTimeout(() => settle({ kind: "unconfirmed" }), timeoutMs);
  if (probe) {
    probeTimer = setTimeout(() => void runProbe(), probeAfterMs);
  }
  // A stub may already be failed when the waiter is created.
  checkStub();

  return { promise, cancel: teardown };
}
