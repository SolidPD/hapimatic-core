// SPDX-License-Identifier: AGPL-3.0-only
/**
 * abortControlState — pure helpers for the composer's Stop control (issue
 * #4750, building on the #706 queue-then-fire abort).
 *
 * The composer cannot abort a turn before the server reports it running
 * (`thread.isRunning` is `session.thinking`, which arrives over SSE only once
 * the CLI has dequeued the message). Between `api.composer().send()` and that
 * signal the Stop button used to be DISABLED, so the #706 "queue the stop and
 * fire it when the thread starts" branch was unreachable from the button. These
 * helpers add one input — `sendInFlight`, true from the send until the thread
 * runs, a session goes inactive, or `SEND_IN_FLIGHT_TIMEOUT_MS` elapses — and
 * fold it into the enablement so a tap in that gap registers as a pending stop.
 *
 * Kept React-free so the gating truth table is unit-testable without the full
 * composer harness (`abortControlState.test.ts`).
 */

/**
 * How long a send may wait for the thread to start before a pending stop and
 * the in-flight marker self-clear (a slow Pi or federated round trip is well
 * under this; a stuck turn should not pin the button forever).
 */
export const SEND_IN_FLIGHT_TIMEOUT_MS = 30_000;

/**
 * How long an ISSUED stop (`cancelRun()` sent, `isAborting` true) may wait for
 * the thread to stop before the Stop button re-enables for a retry (#4751).
 * Must comfortably exceed the tmux/pty launchers' 1500 ms Escape debounce and a
 * federated round trip; matches `SEND_IN_FLIGHT_TIMEOUT_MS`.
 */
export const ABORT_IN_FLIGHT_TIMEOUT_MS = 30_000;

export interface AbortControlInput {
  /**
   * Session offline (`!active`). Excludes the send-POST round-trip flags
   * (`disabled` / `thread.isDisabled` = `isSending`): that window is exactly
   * where Stop must stay live, so folding them in would re-create the gap.
   */
  controlsDisabled: boolean;
  /** A `cancelRun()` has been issued and the thread has not stopped yet. */
  isAborting: boolean;
  /** `thread.isRunning` — the server's `session.thinking`. */
  threadIsRunning: boolean;
  /** A stop was tapped before the thread ran; fires once it does (#706). */
  abortQueued: boolean;
  /** A send was dispatched and the thread has not started yet (#4750). */
  sendInFlight: boolean;
}

/**
 * Whether the Stop button is disabled. Identical to the pre-#4750 expression
 * except for the trailing `&& !sendInFlight` term: a send in flight keeps the
 * button live so the tap can be queued.
 */
export function computeAbortDisabled(i: AbortControlInput): boolean {
  return (
    i.controlsDisabled ||
    i.isAborting ||
    (!i.threadIsRunning && !i.abortQueued && !i.sendInFlight)
  );
}

export type AbortTapResolution = "ignore" | "fire" | "queue";

/**
 * What a Stop tap should do: nothing while a stop is already pending or in
 * progress (or controls are disabled), an immediate `cancelRun()` while the
 * thread runs, otherwise queue it for the moment the thread starts.
 */
export function resolveAbortTap(i: AbortControlInput): AbortTapResolution {
  if (i.isAborting || i.abortQueued || i.controlsDisabled) {
    return "ignore";
  }
  return i.threadIsRunning ? "fire" : "queue";
}

/** Accessible label / tooltip for the Stop button in each state. */
export function stopButtonLabel(i: {
  isAborting: boolean;
  abortQueued: boolean;
}): string {
  if (i.abortQueued) return "Stopping as soon as possible…";
  if (i.isAborting) return "Stopping…";
  return "Stop";
}
