// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Cooperative, checkpoint-based cancellation model — issue #3164 (Graph Runtime
 * v1, Graph Engineering Phase 3, Wave 1, Sub-Issue E — the LAST sub-issue).
 *
 * Native per-node / per-branch cancellation that AUGMENTS (never replaces) A's
 * run-level `interrupted` stop (Fallback Preservation Rule). The three
 * non-negotiable properties (synthesis II.1/II.5/II.6, expert ruling R10):
 *
 *   - **Cooperative** (R1): a node yields at DECLARED checkpoints — there is no
 *     preemptive/`SIGKILL`-style stop of a node mid-effect. The token tree is
 *     POLLED (`isCancelled()`); it registers ZERO long-lived listeners, so it is
 *     immune to the `AbortSignal.any` listener-accumulation footgun (a dependent
 *     signal keeps a listener on the long-lived parent per composition, which
 *     accumulates under `map`/`loop` multiplicity — expert R10). `whenCancelled()`
 *     and `toAbortSignal()` are LAZY, per-attempt adapters, released when the
 *     attempt ends — used ONLY where composition with D's backoff or abortable I/O
 *     needs a real signal/promise.
 *   - **Scoped** (R2): the scope tree is `run → branch → node`. `cancel(scope)`
 *     marks a scope (and, via the `isCancelled()` upward walk, its descendants)
 *     cancelled WITHOUT touching siblings or ancestors — so cancelling one
 *     `parallel` arm cancels only that arm's subtree.
 *   - **Ledger-aware** (R3): the cancel-during-effect path lives in C's
 *     `effect-ledger.ts` (a cancel between `EffectIntent` and `EffectCommitted` →
 *     `IN_DOUBT` → `reconcile`, never orphaned). This module is PURE control-flow
 *     signalling — it performs no effect side-effect.
 *
 * A cancellation is a durable append-only resume signal (synthesis II.6): E
 * appends the `kind:"cancellation"` member to A's OPEN `ResumeSignal` union
 * (`types.ts`) — a pre-authorized additive extension, not a new substrate.
 *
 * 🔴 RUNTIME MODULE. Reachable only through the `@hapi/protocol/graph/execute`
 * subpath (the barrel it lives in transitively pulls `node:crypto` via the
 * executor) — never the web-safe root barrel.
 */
import type { CancellationHook, CancellationResumeSignal } from "./types";
import type { PolicyClock } from "./retry-policy";

/**
 * The cooperative-yield sentinel. `checkpoint(token)` throws it, and a cooperative
 * handler MAY throw it from a `handler-yield` poll; the executor catches it and
 * records the node's outcome `cancelled` (NOT `failed_terminal`). Distinct class so
 * the executor's `catch` can tell a cooperative cancel apart from a real failure.
 */
export class Cancelled extends Error {
  /** The id of the scope whose cancellation triggered this yield. */
  readonly scopeId: string | undefined;
  constructor(scopeId?: string) {
    super(`Cancelled${scopeId ? ` (scope '${scopeId}')` : ""}`);
    this.name = "Cancelled";
    this.scopeId = scopeId;
  }
}

/**
 * A read-only cancellation handle a node/handler holds. It can OBSERVE
 * cancellation (poll `isCancelled`, race `whenCancelled`, or derive a per-attempt
 * `AbortSignal`) but cannot cancel other scopes — that authority stays on the
 * owning {@link CancellationScope}.
 */
export interface CancellationToken {
  /** The bound scope's id (surfaced on the thrown {@link Cancelled}). */
  readonly scopeId: string;
  /** True iff the bound scope OR any ancestor is cancelled. */
  isCancelled(): boolean;
  /** Resolves when the bound scope OR any ancestor is cancelled (for racing). */
  whenCancelled(): Promise<void>;
  /**
   * A LAZY, per-attempt `AbortSignal` that aborts when this token cancels. The
   * caller MUST `release()` it when the attempt ends so a late cancel does not
   * abort a completed attempt — this keeps the adapter bounded (one per attempt),
   * NOT a long-lived listener that accumulates under multiplicity (expert R10).
   */
  toAbortSignal(): { signal: AbortSignal; release: () => void };
}

/**
 * A node in the cancellation scope tree (`run → branch → node`). Cancelling a
 * scope marks ONLY that scope's own flag; a descendant discovers it by walking UP
 * to an ancestor in {@link isCancelled}. That is why a run cancel cancels every
 * node (each walks up to the run) while a branch cancel cancels only that subtree
 * (a sibling walks up to the run, which is NOT cancelled) — R2.
 */
export class CancellationScope {
  readonly id: string;
  readonly parent: CancellationScope | undefined;
  private cancelled = false;
  private resolveCancelled: (() => void) | undefined;
  private readonly cancelledPromise: Promise<void>;

  constructor(id: string, parent?: CancellationScope) {
    this.id = id;
    this.parent = parent;
    this.cancelledPromise = new Promise<void>(resolve => {
      this.resolveCancelled = resolve;
    });
  }

  /** Create a linked child scope (e.g. a `parallel` arm, then a node within it). */
  child(id: string): CancellationScope {
    return new CancellationScope(id, this);
  }

  /**
   * Mark THIS scope cancelled — without touching siblings or ancestors (R2).
   * Idempotent. Descendants observe it via {@link isCancelled}'s upward walk;
   * `whenCancelled()` racers resolve because a descendant races against this
   * scope's promise.
   */
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.resolveCancelled?.();
  }

  /** True iff this scope OR any ancestor is cancelled. */
  isCancelled(): boolean {
    if (this.cancelled) return true;
    let scope: CancellationScope | undefined = this.parent;
    while (scope) {
      if (scope.cancelled) return true;
      scope = scope.parent;
    }
    return false;
  }

  /**
   * Resolves when this scope OR any ancestor is cancelled — for racing a
   * cancellable wait (e.g. D's backoff via {@link cancellableClock}). Recursively
   * races self against the parent chain; bounded per call (no persistent listener
   * is registered on a long-lived signal).
   */
  whenCancelled(): Promise<void> {
    if (this.cancelled) return Promise.resolve();
    return this.parent
      ? Promise.race([this.cancelledPromise, this.parent.whenCancelled()])
      : this.cancelledPromise;
  }

  /**
   * A read-only {@link CancellationToken} bound to this scope. The returned object
   * uses arrow functions that capture the lexical `this` (this scope) — no `this`
   * alias, so the handle stays bound even when detached from the scope instance.
   */
  token(): CancellationToken {
    return {
      scopeId: this.id,
      isCancelled: () => this.isCancelled(),
      whenCancelled: () => this.whenCancelled(),
      toAbortSignal: () => {
        const controller = new AbortController();
        if (this.isCancelled()) {
          controller.abort();
          return { signal: controller.signal, release: () => {} };
        }
        let released = false;
        // ONE per-attempt continuation; `release()` neuters a late cancel so a
        // completed attempt is never aborted. No listener is added to a shared
        // long-lived signal (contrast AbortSignal.any) — bounded by construction.
        void this.whenCancelled().then(() => {
          if (!released) controller.abort();
        });
        return {
          signal: controller.signal,
          release: () => {
            released = true;
          },
        };
      },
    };
  }
}

/**
 * A cooperative yield point (R1): throw {@link Cancelled} when the token's scope
 * is cancelled, so a node stops AT a declared checkpoint, never preemptively. A
 * no-op when not cancelled. The executor's handler `catch` maps a {@link Cancelled}
 * throw to node outcome `cancelled`.
 */
export function checkpoint(token: CancellationToken): void {
  if (token.isCancelled()) throw new Cancelled(token.scopeId);
}

/**
 * Build the `CancellationHook` a caller passes as `ExecutorOptions.cancellation`
 * (A/#3160 seam) from a scope tree. Mirrors `makeLedgerHook`/`makeRetryPolicyHook`.
 *
 * The executor polls TWO ways: a RUN-LEVEL poll (`nodeInstanceId === undefined`)
 * asks whether the WHOLE-RUN scope is cancelled (→ the run stops with `cancelled`),
 * and a NODE-LEVEL poll asks whether a specific node's scope is cancelled (→ that
 * node/branch's frontier is dropped, siblings continue — R2). `scopeOf` maps a
 * `node_instance_id` to its scope; nodes with no mapping fall back to `root`.
 */
export function makeCancellationHook(opts: {
  root: CancellationScope;
  scopeOf?: (nodeInstanceId: string) => CancellationScope | undefined;
}): CancellationHook {
  return ctx => {
    if (ctx.nodeInstanceId === undefined) return opts.root.isCancelled();
    const scope = opts.scopeOf?.(ctx.nodeInstanceId) ?? opts.root;
    return scope.isCancelled();
  };
}

/**
 * Build a durable cancellation resume signal (synthesis II.6). Rides A's OPEN
 * `ResumeSignal` channel with the `kind:"cancellation"` discriminant — the
 * executor persists it into the instance-unique `run_dir` alongside gate signals.
 */
export function cancellationResumeSignal(args: {
  nodeId: string;
  scopeId?: string;
  requirement?: string;
}): CancellationResumeSignal {
  return {
    kind: "cancellation",
    node_id: args.nodeId,
    scope_id: args.scopeId,
    requirement:
      args.requirement ??
      "cooperative cancellation (durable resume signal — II.6)",
  };
}

/**
 * Wrap a {@link PolicyClock} so its `sleep` is INTERRUPTED by a cancellation
 * (D's backoff `policy-wait` checkpoint — Task 4g / INT-3). A cancel resolves the
 * race immediately, so the backoff is NOT waited out; D then polls its
 * `checkCancellation("policy-wait")` and returns `cancelled`. `now` is unchanged
 * (the run-relative deadline still measures on the base clock). Only `sleep` is
 * made cancellable — the timeout race is NOT (a cancel must not masquerade as a
 * timeout), which is why E composes this per-clock rather than swapping the clock
 * wholesale inside D.
 */
export function cancellableClock(
  base: PolicyClock,
  token: CancellationToken
): PolicyClock {
  return {
    now: () => base.now(),
    sleep: (ms: number): Promise<void> =>
      Promise.race([base.sleep(ms), token.whenCancelled()]).then(() => {}),
  };
}
