// SPDX-License-Identifier: AGPL-3.0-only
// Pure burst-coalescer for tool-error toasts (issue #1612).
//
// Decides, per arriving event, whether the caller should show an individual
// toast, show/refresh a single summary toast carrying a running count, or stay
// silent. Framework-free with an injectable `now` so it is unit-testable
// without flaky DOM timers — mirrors the "since-last-toast counter + threshold
// + dedup" pattern in `error-reporter.ts` (`maybeShowDropToast`).
//
// Model: a "window" opens at the first event and stays open while events keep
// arriving within `windowMs` of the previous one. The first `threshold` events
// in a window toast individually; once the window count exceeds `threshold`,
// further events emit a `summary` (with the running window count), throttled to
// one summary per `summaryDedupMs`. A quiet gap longer than `windowMs` resets
// the window (and clears any reconnect priming).

export interface ToastCoalescerOptions {
  /** First `threshold` events within a window toast individually; beyond → summary. */
  threshold: number;
  /** Quiet gap (ms) after which the window — and any priming — resets. */
  windowMs: number;
  /** Minimum gap (ms) between successive summary emissions. */
  summaryDedupMs: number;
}

export type ToastCoalescerDecision =
  | { action: "individual" }
  | { action: "summary"; count: number }
  | { action: "silent" };

export interface ToastCoalescer {
  /** Record one event and decide how it should surface. */
  record(now?: number): ToastCoalescerDecision;
  /**
   * Prime the coalescer so the very next event (and subsequent in-window
   * events) coalesce into a summary instead of toasting individually. Used on
   * SSE (re)connect (R2) so a reconnect-delivered backlog never produces
   * individual toasts. The priming clears on the next quiet gap > windowMs.
   */
  forceSummaryWindow(now?: number): void;
}

export function createToastCoalescer({
  threshold,
  windowMs,
  summaryDedupMs,
}: ToastCoalescerOptions): ToastCoalescer {
  let lastEventAt = 0;
  let countInWindow = 0;
  // -Infinity = "no summary emitted yet", so the FIRST summary is never
  // throttled regardless of the magnitude of `now` (a literal 0 would falsely
  // read as "a summary fired at t=0" and suppress the first real summary when
  // `now` is small — e.g. under injected integer clocks in tests).
  let lastSummaryAt = -Infinity;
  let windowActive = false;
  // Set by forceSummaryWindow — coalesce from the very next event until the
  // window next resets.
  let primed = false;

  function record(now: number = Date.now()): ToastCoalescerDecision {
    // A genuine quiet gap (or a never-opened window) resets the window and
    // clears reconnect priming.
    if (!windowActive || now - lastEventAt > windowMs) {
      countInWindow = 0;
      windowActive = true;
      primed = false;
    }
    lastEventAt = now;
    countInWindow += 1;

    const pastThreshold = primed || countInWindow > threshold;
    if (!pastThreshold) {
      return { action: "individual" };
    }

    // Coalescing: emit at most one summary per `summaryDedupMs`, keep counting
    // in between.
    if (now - lastSummaryAt < summaryDedupMs) {
      return { action: "silent" };
    }
    lastSummaryAt = now;
    return { action: "summary", count: countInWindow };
  }

  function forceSummaryWindow(now: number = Date.now()): void {
    countInWindow = 0;
    lastEventAt = now;
    windowActive = true;
    primed = true;
    // Backdate the throttle so the first post-reconnect summary fires promptly,
    // regardless of any summary emitted just before the reconnect.
    lastSummaryAt = now - summaryDedupMs;
  }

  return { record, forceSummaryWindow };
}
