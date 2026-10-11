// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Per-node retry / timeout / deadline policy — issue #3163 (Graph Runtime v1,
 * Graph Engineering Phase 3, Wave 1, Sub-Issue D). The runtime ENFORCEMENT layer
 * for the declarative `retry`/`timeout`/`deadline` IR fields (`ir.ts`, Task 1);
 * plugs into A/#3160's `RetryPolicyHook` seam (`opts.retry`) in the
 * `retry(ledger(handler))` composition (KD3).
 *
 * 🔴 What this enforces (synthesis II.5 layer-1 lifecycle):
 *   - **Timeout (R2)**: a node exceeding its `timeout` is marked `timed_out`. The
 *     race runs on the INJECTED clock's `sleep()` (ruling R9) — this module NEVER
 *     calls `AbortSignal.timeout` directly, so `vi.useFakeTimers()` drives the race
 *     and the `simulated` evidence class stays wall-clock-free. A large per-node
 *     `timeout` override protects a slow-but-healthy node from a false timeout. Each
 *     attempt is bounded by the TIGHTER of the per-node timeout and the remaining
 *     `deadline` budget, so both drive the abort.
 *   - **F5 mid-flight termination (architect-review #3159)**: on a timeout/deadline
 *     fire, D calls `ctx.abortInFlight()` — the executor's ONE shared abort
 *     primitive (`NodeExecContext.signal`), the SAME one E/#3164 drives from cancel.
 *     A cooperative handler stops; a non-cooperative handler's late commit stays an
 *     IN_DOUBT hazard the mutating-retry reconcile catches (INT-3). The losing
 *     attempt promise is swallow-caught so a late rejection is never unhandled.
 *   - **Retry (R3)**: a `failed_retryable` (or a policy-retried `timed_out`) loops
 *     up to `retry.max` with `retry.backoff`, bounded by the run-relative
 *     `deadline`; on exhaustion it escalates to `failed_terminal`. A `refused`
 *     outcome is FIRST-CLASS and is NEVER retried (a modified prompt would be a
 *     new node execution). A `failed_terminal`/thrown handler is never retried.
 *   - **Ledger-fenced mutating retry (R4)**: a `risk_tier >= mutating` node's retry
 *     reconciles each open effect through C's ledger (`EffectLedger.reconcile`)
 *     BEFORE any re-perform — `committed` ⇒ the prior attempt landed ⇒ dedup (no
 *     re-perform); `safe_to_retry`/`compensated` ⇒ re-arm ⇒ re-perform (dedups at
 *     the target by idempotency key); an inconclusive reconcile (throws) ⇒ the
 *     effect stays IN_DOUBT ⇒ escalate. A mutating node with NO (or a disabled)
 *     ledger is NEVER blind-retried (II.1 / OR1).
 *   - **Attempt-tracking (R5)**: `runWithPolicy` reports the total attempt count
 *     via `NodeHandlerResult.retry_attempts`; the executor evidences it on the ONE
 *     canonical `RunRecordNode` (`canonical_attempt == N`, `supersedes.length ==
 *     N-1`) through B's supersession — it does NOT store one record per attempt.
 *
 * 🔴 Zero-regression: a node declaring NO `timeout` and NO effective retries is a
 * PASSTHROUGH — `attempt()` runs exactly once and its outcome is returned
 * untouched (byte-identical to A/#3160's default "run once" seam).
 *
 * 🔴 RUNTIME MODULE. Lives under `execute/` (consumes the ledger + `node:crypto`
 * compile helpers) — reachable only through `@hapi/protocol/graph/execute`.
 */
import {
  deriveEffectId,
  hasMutatingEffect,
  mutatingEffectsWithIndex,
} from "../compile/effectLedger";
import type { GraphNode } from "../ir";
import type { EffectLifecycle } from "../run-record";
import type { EffectLedger } from "./effect-ledger";
import type {
  NodeHandlerResult,
  RetryPolicyHook,
  RetryPolicyHookContext,
} from "./types";

/**
 * The injectable clock/sleep seam (KD4). Owns the per-node timeout race and the
 * inter-attempt backoff so timing is deterministic under `vi.useFakeTimers()` and
 * the `simulated` evidence class never touches a real wall-clock. `now()` MUST be
 * monotonic (a run-relative deadline is measured on it).
 */
export interface PolicyClock {
  /** Monotonic milliseconds. */
  now(): number;
  /** Resolve after `ms` (driveable by fake timers). */
  sleep(ms: number): Promise<void>;
}

/**
 * Production `PolicyClock`. `performance.now()` is monotonic; `sleep` is a plain
 * `setTimeout` (NOT `AbortSignal.timeout` — ruling R9 keeps the race on the
 * injected seam). Real timers, so an injected-real-clock test still runs under
 * `vi.useFakeTimers()` if a suite chooses to.
 */
export const realClock: PolicyClock = {
  now: () => performance.now(),
  sleep: (ms: number) =>
    new Promise<void>(resolve => {
      setTimeout(resolve, Math.max(0, ms));
    }),
};

/** Dependencies for the policy engine (all optional — a bare hook is valid). */
export interface RetryPolicyDeps {
  /** Timing seam. Default: {@link realClock}. */
  clock?: PolicyClock;
  /**
   * C's effect ledger, for R4 mutating-retry fencing. When absent (or
   * `mode:"disabled"`), a mutating node is never retried — a re-perform without a
   * ledger would be a blind re-perform (II.1 / OR1).
   */
  ledger?: EffectLedger;
}

/** Distinguishes a won timeout from a genuine handler result in the race. */
const TIMED_OUT = Symbol("policy-timeout");

/** The per-node policy read off the authored IR node (Task 1 fields). */
interface NodePolicy {
  maxRetries: number;
  backoff?: { ms: number; factor?: number };
  timeoutMs?: number;
  deadlineMs?: number;
}

function readPolicy(node: GraphNode): NodePolicy {
  const retry = node.retry;
  // `retry.max` is a RETRY COUNT (#2885: `>= 0`); a negative/absent value ⇒ 0
  // retries. (The #2885 lint owns rejecting a negative; here we clamp defensively.)
  const maxRetries = retry && retry.max > 0 ? retry.max : 0;
  return {
    maxRetries,
    backoff: retry?.backoff,
    timeoutMs: node.timeout?.ms,
    deadlineMs: node.deadline?.ms,
  };
}

/** Inter-attempt delay before retry `i` (1 = first retry). `factor` defaults to 1 (constant). */
function backoffDelay(policy: NodePolicy, i: number): number {
  const b = policy.backoff;
  if (!b) return 0;
  const factor = b.factor ?? 1;
  return b.ms * Math.pow(factor, i - 1);
}

/** Run one attempt, racing it against the node's timeout on the injected clock. */
async function runOnce(
  attempt: () => Promise<NodeHandlerResult>,
  timeoutMs: number | undefined,
  clock: PolicyClock
): Promise<{ timedOut: boolean; result?: NodeHandlerResult }> {
  if (timeoutMs === undefined) {
    return { timedOut: false, result: await attempt() };
  }
  const attemptPromise = attempt();
  // Swallow a LATE rejection from an attempt that LOSES the timeout race — JS has no
  // promise cancellation, so the orphaned handler keeps running; without this a real
  // handler that rejects AFTER the timeout fired surfaces as an unhandled rejection
  // (review finding 2). An EARLY rejection still propagates via the race below (a
  // thrown handler → the executor's failed_terminal).
  attemptPromise.catch(() => {});
  const timeoutMarker = clock.sleep(timeoutMs).then(() => TIMED_OUT);
  const raced = await Promise.race([attemptPromise, timeoutMarker]);
  if (raced === TIMED_OUT) return { timedOut: true };
  return { timedOut: false, result: raced as NodeHandlerResult };
}

/**
 * Reconcile a mutating node's open effects through C BEFORE a retry re-performs.
 * Returns `committed:true` iff EVERY mutating effect reconciled to `committed`
 * (the prior attempt landed at the target ⇒ dedup, do not re-perform). Otherwise
 * the effects were re-armed (`safe_to_retry`) or compensated ⇒ the caller
 * re-performs. Propagates C's throw on an inconclusive reconcile (retry stays
 * blocked — II.1 / OR1).
 */
async function reconcileMutatingNode(
  node: GraphNode,
  nodeInstanceId: string,
  ledger: EffectLedger
): Promise<{ committed: boolean; effects: Record<string, EffectLifecycle> }> {
  const mutating = mutatingEffectsWithIndex(node);
  const statuses: { effectId: string; committed: boolean }[] = [];
  for (const { index } of mutating) {
    const effectId = deriveEffectId(nodeInstanceId, index);
    const { status } = await ledger.reconcile(effectId);
    statuses.push({ effectId, committed: status === "committed" });
  }
  const allCommitted = statuses.length > 0 && statuses.every(s => s.committed);
  const effects: Record<string, EffectLifecycle> = {};
  if (allCommitted) {
    for (const s of statuses) effects[s.effectId] = "committed";
  }
  return { committed: allCommitted, effects };
}

/** Attach the total attempt count for the executor's R5 supersession record-build. */
function withAttempts(
  result: NodeHandlerResult,
  attempts: number
): NodeHandlerResult {
  return { ...result, retry_attempts: attempts };
}

/**
 * The core policy engine (Task 2). Reads the node's `retry`/`timeout`/`deadline`
 * from the IR and drives the timeout race + retry loop over the (ledger-wrapped)
 * `attempt()` thunk. Exported directly so tests can drive it with a fake
 * {@link PolicyClock} and an in-memory {@link EffectLedger} double.
 */
export async function runWithPolicy(
  ctx: RetryPolicyHookContext,
  attempt: () => Promise<NodeHandlerResult>,
  deps: RetryPolicyDeps = {}
): Promise<NodeHandlerResult> {
  const clock = deps.clock ?? realClock;
  const node = ctx.node;
  const policy = readPolicy(node);

  // Zero-regression passthrough: no timeout, no deadline, no retries ⇒ D is a no-op.
  // The single attempt's outcome is returned untouched (byte-identical to #3160).
  if (
    policy.timeoutMs === undefined &&
    policy.deadlineMs === undefined &&
    policy.maxRetries === 0
  ) {
    return attempt();
  }

  const isMutating = hasMutatingEffect(node);
  const start = clock.now();
  const deadlineAt =
    policy.deadlineMs !== undefined ? start + policy.deadlineMs : Infinity;
  // The per-node timeout as a numeric bound (Infinity ⇒ no per-node timeout).
  // Loop-invariant: it bounds every attempt AND decides deadline-vs-timeout precedence.
  const timeoutBound = policy.timeoutMs ?? Infinity;

  let attemptCount = 0;
  let last: NodeHandlerResult | undefined;

  for (let i = 0; i <= policy.maxRetries; i++) {
    if (i > 0) {
      // ── Pre-retry gates (the first attempt, i === 0, is never gated) ──────
      // E/#3164 (policy-wait) — a cancel observed between attempts stops the retry
      // loop with node outcome `cancelled` (INT-3): a cancel and a timeout share
      // one mid-flight-termination convention, so a cancelled node reads exactly
      // like a `timed_out` one (recorded, not blind-retried).
      if (await ctx.checkCancellation?.("policy-wait")) {
        // Spread `last` so a mutating node cancelled BETWEEN attempts keeps the
        // prior attempt's `effects` map (e.g. `{ "n#0": "in_doubt" }`) on the
        // RunRecordNode — the layer-3 observability surface must not go blank just
        // because the retry was cancelled (review Finding 2; mirrors the escalation
        // path below). Only the `outcome` is overridden to `cancelled`.
        return withAttempts(
          { ...(last ?? {}), outcome: "cancelled" },
          attemptCount
        );
      }
      if (clock.now() >= deadlineAt) break; // R3: deadline budget exhausted → escalate

      if (isMutating) {
        // R4: never blind-retry a mutating node — reconcile through C first.
        if (!deps.ledger || deps.ledger.mode === "disabled") break;
        let recon: {
          committed: boolean;
          effects: Record<string, EffectLifecycle>;
        };
        try {
          recon = await reconcileMutatingNode(
            node,
            ctx.nodeInstanceId,
            deps.ledger
          );
        } catch {
          break; // inconclusive reconcile ⇒ effect stays IN_DOUBT ⇒ escalate (II.1/OR1)
        }
        if (recon.committed) {
          // Dedup: the prior attempt's mutating effect(s) landed — do NOT re-perform.
          return withAttempts(
            { outcome: "succeeded", effects: recon.effects },
            attemptCount
          );
        }
        // else safe_to_retry / compensated ⇒ re-armed ⇒ re-perform below.
      }

      const delay = backoffDelay(policy, i);
      if (delay > 0) {
        if (clock.now() + delay > deadlineAt) break; // backoff would blow the deadline
        await clock.sleep(delay);
        // E/#3164 (policy-wait) — with a `cancellableClock` (E's per-attempt clock
        // adapter) the sleep above resolves EARLY on a cancel, so a cancel arriving
        // during backoff does NOT wait the backoff out (Task 4g). Poll here and stop
        // the retry loop with `cancelled` rather than proceeding to the next attempt.
        if (await ctx.checkCancellation?.("policy-wait")) {
          // Spread `last` (review Finding 2) — keep the prior attempt's `effects`
          // map on a cancel that interrupts the backoff, overriding only `outcome`.
          return withAttempts(
            { ...(last ?? {}), outcome: "cancelled" },
            attemptCount
          );
        }
        if (clock.now() >= deadlineAt) break; // deadline crossed during backoff
      }
    }

    attemptCount++;
    // F5: bound each attempt by the TIGHTER of the per-node timeout and the
    // remaining run-relative deadline budget — so BOTH drive the mid-flight abort.
    // `undefined` ⇒ unbounded (no timeout, no deadline).
    const remainingDeadline = deadlineAt - clock.now(); // Infinity when no deadline
    const effTimeout = Math.min(timeoutBound, remainingDeadline);
    const boundMs = Number.isFinite(effTimeout) ? effTimeout : undefined;
    const { timedOut, result } = await runOnce(attempt, boundMs, clock);
    if (timedOut) {
      // F5: signal the raced-out handler to stop (cooperative mid-flight
      // termination); a non-cooperative handler's late commit stays an IN_DOUBT
      // hazard the mutating-retry reconcile catches on the next attempt (INT-3).
      ctx.abortInFlight?.();
      last = { outcome: "timed_out" };
      // If the DEADLINE (not the per-node timeout) was the tighter bound, the retry
      // budget is exhausted mid-attempt → escalate now (no further retries).
      const deadlineWasTighter =
        policy.deadlineMs !== undefined && remainingDeadline <= timeoutBound;
      if (deadlineWasTighter) break;
      continue; // per-node timeout → retry if budget remains
    }
    last = result;
    switch (result!.outcome) {
      case "succeeded":
      case "skipped":
      case "waiting":
      case "refused": // R3: refused is first-class — NOT retried
      case "cancelled": // E/#3164 (INT-3): a cancelled node is TERMINAL — NOT
        // retried. Retrying would re-enter C's ledger, trip its blind-retry guard
        // on the open in_doubt intent (or spuriously reconcile the cancelled
        // effect to succeeded), corrupting the node's `cancelled` outcome. A cancel
        // is terminal exactly like a `refused`; the open effect is reconciled later
        // via the durable resume signal, never a same-run retry.
        return withAttempts(result!, attemptCount);
      case "failed_terminal": // terminal — NOT retried
        return withAttempts(result!, attemptCount);
      default:
        // "failed_retryable" | "timed_out" → retry if budget remains.
        break;
    }
  }

  // Fell out of the loop with a non-terminal-success outcome.
  if (policy.maxRetries > 0) {
    // Retries were configured and exhausted (or the deadline cut them) → escalate
    // to failed_terminal (R3 "escalate/failed_terminal").
    return withAttempts(
      { ...(last ?? {}), outcome: "failed_terminal" },
      attemptCount
    );
  }
  // Timeout-only node (no retries): return the single attempt's outcome as-is
  // (a `timed_out` stays `timed_out`; there is nothing to escalate).
  return withAttempts(last ?? { outcome: "failed_terminal" }, attemptCount);
}

/**
 * Build the `RetryPolicyHook` a caller passes as `ExecutorOptions.retry` (A/#3160
 * seam) — mirrors `makeLedgerHook(ledger)`. Closes over the timing seam and C's
 * ledger (for R4). The returned hook wraps each node's (ledger-wrapped) handler
 * invocation with {@link runWithPolicy}.
 */
export function makeRetryPolicyHook(
  deps: RetryPolicyDeps = {}
): RetryPolicyHook {
  return (ctx, attempt) => runWithPolicy(ctx, attempt, deps);
}
