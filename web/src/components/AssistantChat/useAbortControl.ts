// SPDX-License-Identifier: AGPL-3.0-only
/**
 * useAbortControl — the composer's Stop-button state machine.
 *
 * Owns the #706 queue-then-fire abort (`isAborting` / `abortQueued` and the
 * effects that resolve them) plus the #4750 send-in-flight window that keeps
 * the button live between `api.composer().send()` and the server's
 * `thread.isRunning` signal, so a tap in that gap is recorded as a pending stop
 * and fired the moment the thread starts.
 *
 * Extracted from `HappyComposer` (issue #4750): the composer sits at the #2077
 * 1,500-line `max-lines` guardrail, and the machine is easier to reason about —
 * and test — on its own. The queue-fire effect below is the SINGLE place a
 * queued stop becomes `cancelRun()`, which is what guarantees exactly one abort
 * when a tap races the running transition.
 *
 * An ISSUED stop is bounded too (#4751): if the thread is still running
 * `ABORT_IN_FLIGHT_TIMEOUT_MS` after `cancelRun()`, the Stop button re-enables
 * for a retry — symmetric with the pending-stop lane's send-in-flight timeout.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  ABORT_IN_FLIGHT_TIMEOUT_MS,
  computeAbortDisabled,
  resolveAbortTap,
  SEND_IN_FLIGHT_TIMEOUT_MS,
} from "./abortControlState";

/** The slice of the assistant-ui runtime API the machine needs. */
interface AbortRuntimeApi {
  thread: () => { cancelRun: () => void };
}

export interface UseAbortControlOptions {
  api: AbortRuntimeApi;
  /**
   * The session the composer is showing. The composer stays mounted across
   * session switches, so every pending intent belongs to this session: a switch
   * drops them all, and a stop queued on one session never fires on another
   * (#4773).
   */
  sessionId: string | null;
  /** `thread.isRunning` — the server's `session.thinking`. */
  threadIsRunning: boolean;
  /** Session connectivity; going inactive clears any pending stop. */
  active: boolean;
  /**
   * `!active` (session offline). Deliberately NOT the composer's
   * `actionControlsDisabled`: that folds in `disabled` / `thread.isDisabled`,
   * which are the send POST round-trip (`isSending`) — the very window in which
   * the Stop button must stay live (#4750).
   */
  controlsDisabled: boolean;
  haptic: (type: "light" | "success" | "error") => void;
  showToast: (message: string, options?: { type?: "error" }) => void;
}

export interface AbortControl {
  isAborting: boolean;
  abortQueued: boolean;
  abortDisabled: boolean;
  /** Stop-button tap: fires now while running, queues during the send gap. */
  handleAbort: () => void;
  /**
   * Call right after `api.composer().send()`: cancels a stale pending stop (a
   * new send is a conflicting intent), opens the in-flight window, and arms the
   * bounded timeout that closes it if the thread never starts.
   */
  markSendDispatched: () => void;
}

export function useAbortControl({
  api,
  sessionId,
  threadIsRunning,
  active,
  controlsDisabled,
  haptic,
  showToast,
}: UseAbortControlOptions): AbortControl {
  const [isAborting, setIsAborting] = useState(false);
  const [abortQueued, setAbortQueued] = useState(false);
  const [sendInFlight, setSendInFlight] = useState(false);

  // #4773: a session switch drops every pending intent. Reset DURING render
  // (React's "adjust state when a prop changes"): React discards this render
  // and re-renders before committing, so no effect ever sees a stop queued on
  // the previous session together with the new session's `threadIsRunning`.
  // A reset effect would be too late: in the switch commit the queue-fire
  // effect below would already have called cancelRun() on the new session.
  const [stateSessionId, setStateSessionId] = useState(sessionId);
  if (sessionId !== stateSessionId) {
    setStateSessionId(sessionId);
    setIsAborting(false);
    setAbortQueued(false);
    setSendInFlight(false);
  }
  // Mirror of `abortQueued` for the timeout callback (reading state inside a
  // setState updater would make the toast a side effect of the updater).
  const abortQueuedRef = useRef(false);
  const sendInFlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );

  // Read by the issued-stop timeout (#4751) at fire time, so neither has to
  // be an effect dependency: a showToast whose identity changes per render
  // (the no-provider fallback) would otherwise restart the 30 s clock on every
  // streaming re-render. Mirrored in a layout effect, declared before the
  // timeout effect, so a timer firing right after a commit never reads a
  // pre-commit threadIsRunning.
  const threadIsRunningRef = useRef(threadIsRunning);
  const showToastRef = useRef(showToast);

  useEffect(() => {
    abortQueuedRef.current = abortQueued;
  }, [abortQueued]);

  useLayoutEffect(() => {
    threadIsRunningRef.current = threadIsRunning;
    showToastRef.current = showToast;
  }, [threadIsRunning, showToast]);

  const clearSendInFlightTimer = useCallback(() => {
    if (sendInFlightTimerRef.current !== null) {
      clearTimeout(sendInFlightTimerRef.current);
      sendInFlightTimerRef.current = null;
    }
  }, []);

  // #706: the abort has taken effect once the thread stops running.
  useEffect(() => {
    if (!isAborting) return;
    if (threadIsRunning) return;
    setIsAborting(false);
    setAbortQueued(false);
  }, [isAborting, threadIsRunning]);

  // #4751: bound an ISSUED stop. When the timeout fires, Stop re-enables for a
  // retry; if the thread is still running (the cancel never took effect) a
  // toast says so. Re-enabling only: this never calls cancelRun() itself (the
  // tap and the queue-fire effect stay the only abort sites). The cleanup
  // disarms on every resolution path — thread stopped, session switch (#4773),
  // inactive, unmount. A layout effect, like the #4773 disarm below, so a
  // switch disarms in its own commit. Going offline disarms the bound
  // (isAborting persists); reconnecting re-arms a fresh full timeout.
  useLayoutEffect(() => {
    if (!isAborting || !active) return;
    const timer = setTimeout(() => {
      setIsAborting(false);
      if (threadIsRunningRef.current) {
        showToastRef.current("Stop did not take effect — try again", {
          type: "error",
        });
      }
    }, ABORT_IN_FLIGHT_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [isAborting, active, sessionId]);

  // #706: fire the queued abort when the thread starts running. The single
  // `cancelRun()` site for a queued stop (see the module doc comment).
  useEffect(() => {
    if (!abortQueued) return;
    if (!threadIsRunning) return;
    setAbortQueued(false);
    setIsAborting(true);
    api.thread().cancelRun();
  }, [abortQueued, threadIsRunning, api]);

  // #4750: the turn started — the send→running gap is over.
  useEffect(() => {
    if (!threadIsRunning) return;
    setSendInFlight(false);
    clearSendInFlightTimer();
  }, [threadIsRunning, clearSendInFlightTimer]);

  // #706 (extended by #4750): an inactive session clears every pending intent.
  useEffect(() => {
    if (active) return;
    setAbortQueued(false);
    setSendInFlight(false);
    clearSendInFlightTimer();
  }, [active, clearSendInFlightTimer]);

  // #4773: also disarm the timeout armed for the previous session, so it never
  // fires while the next one is shown. Clearing a timer is a side effect, so it
  // cannot join the render-time reset; a layout effect runs in the switch
  // commit's own task, before the timer could fire.
  useLayoutEffect(() => {
    abortQueuedRef.current = false;
    clearSendInFlightTimer();
  }, [sessionId, clearSendInFlightTimer]);

  // Never let the bounded timeout fire against an unmounted composer.
  useEffect(() => clearSendInFlightTimer, [clearSendInFlightTimer]);

  const markSendDispatched = useCallback(() => {
    // New send cancels any pending abort (conflicting intents) — #706.
    setAbortQueued(false);
    setSendInFlight(true);
    clearSendInFlightTimer();
    sendInFlightTimerRef.current = setTimeout(() => {
      sendInFlightTimerRef.current = null;
      setSendInFlight(false);
      if (abortQueuedRef.current) {
        showToast("Stop request expired — the turn never started", {
          type: "error",
        });
      }
      setAbortQueued(false);
    }, SEND_IN_FLIGHT_TIMEOUT_MS);
  }, [clearSendInFlightTimer, showToast]);

  const handleAbort = useCallback(() => {
    const tap = resolveAbortTap({
      controlsDisabled,
      isAborting,
      threadIsRunning,
      abortQueued,
      sendInFlight,
    });
    if (tap === "ignore") return;

    haptic("error");

    if (tap === "fire") {
      // Thread is running — fire the abort immediately (#706 behavior).
      setIsAborting(true);
      api.thread().cancelRun();
    } else {
      // Thread not running yet (send in flight) — queue the abort intent; the
      // queue-fire effect above issues it the moment the thread starts.
      setAbortQueued(true);
    }
  }, [
    controlsDisabled,
    isAborting,
    threadIsRunning,
    abortQueued,
    sendInFlight,
    api,
    haptic,
  ]);

  const abortDisabled = computeAbortDisabled({
    controlsDisabled,
    isAborting,
    threadIsRunning,
    abortQueued,
    sendInFlight,
  });

  return {
    isAborting,
    abortQueued,
    abortDisabled,
    handleAbort,
    markSendDispatched,
  };
}
