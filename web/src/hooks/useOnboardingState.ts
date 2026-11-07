// SPDX-License-Identifier: AGPL-3.0-only
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  mergeOnboardingPatch,
  OnboardingStateSchema,
  type OnboardingFlowStep,
  type OnboardingOutcome,
  type OnboardingProviderKind,
  type OnboardingState,
  type OnboardingStatePatch,
  type OnboardingStepId,
} from "@hapi/protocol/schemas";
import type { ApiClient } from "@/api/client";
import { useToast } from "@/components/Toast";

/**
 * Window event that opens the first-run wizard and announces that it opened. Help's
 * "Replay the tour" dispatches it to ask the app-level `OnboardingHost` to open; the
 * host dispatches it itself when it presents. #4791's first-run backup
 * prompt (epic #4789, contract LC6) closes without acknowledging when it receives
 * this event.
 */
export const ONBOARDING_OPEN_EVENT = "hapi:onboarding-open";

/** #6211: Settings' "Restart onboarding" asks the host to replay from step 1. */
export const ONBOARDING_RESTART_EVENT = "hapi:onboarding-restart";

/** LC6: #4791's backup prompt dispatches these while it is on screen. */
export const BACKUP_PROMPT_OPEN_EVENT = "hapi:backup-prompt-open";
export const BACKUP_PROMPT_CLOSE_EVENT = "hapi:backup-prompt-close";

/** Ask the app-level host to open the wizard (Help's replay). */
export function requestOpenOnboarding(): void {
  window.dispatchEvent(new CustomEvent(ONBOARDING_OPEN_EVENT));
}

/** Ask the app-level host to replay the wizard from step 1 (Settings). */
export function requestRestartOnboarding(): void {
  window.dispatchEvent(new CustomEvent(ONBOARDING_RESTART_EVENT));
}

/**
 * Whether the wizard is on screen (#6211). Module state rather than an event, so a
 * component mounting while it is already open still reads the right answer. Only
 * `OnboardingHost` sets it.
 */
let guideOpen = false;
const guideOpenListeners = new Set<() => void>();

export function setOnboardingGuideOpen(open: boolean): void {
  if (guideOpen === open) return;
  guideOpen = open;
  for (const listener of guideOpenListeners) listener();
}

export function useOnboardingGuideOpen(): boolean {
  return useSyncExternalStore(
    onChange => {
      guideOpenListeners.add(onChange);
      return () => guideOpenListeners.delete(onChange);
    },
    () => guideOpen
  );
}

/**
 * `"unknown"` while the read is in flight and after a failed read; otherwise the
 * server's effective state. Never an optimistic `pending`: the wizard must not
 * flash at existing users before the read resolves, or ambush them whenever the
 * server is unreachable.
 */
export type OnboardingStateView = "unknown" | OnboardingState;

function applyPatch(
  prev: OnboardingStateView,
  patch: OnboardingStatePatch
): OnboardingStateView {
  if (prev !== "unknown") return mergeOnboardingPatch(prev, patch);
  // A patch without a status cannot make an unknown state known.
  if (patch.restart) return mergeOnboardingPatch({ status: "pending" }, patch);
  return patch.status
    ? mergeOnboardingPatch({ status: patch.status }, patch)
    : "unknown";
}

/**
 * Node-local first-run wizard state (#3865, OQ-2), read from and written to
 * `GET/PUT /api/preferences/onboarding` — this instance's settings file, never
 * the gateway and never browser storage.
 *
 * - Reads once on mount; stays `"unknown"` until the read resolves, and after a
 *   failed or unparseable read.
 * - Writes are fire-and-forget PATCH-style PUTs, applied optimistically in
 *   memory and sent one at a time in order; a failed write shows an error
 *   toast (the #2615 idiom) and does not block the writes after it.
 * - A user action taken before the read resolves is not clobbered by it: the
 *   read is overlaid with every patch applied since mount, which is what the
 *   server holds once those PUTs land.
 * - A dismissal during a re-run after completion keeps the status `completed`.
 *
 * Reads once per consumer, so a second writing instance would leave the first
 * stale and a close would not stick (#6211): only `OnboardingHost` holds one, and
 * everything else reaches it through a window event.
 */
export function useOnboardingState(api: ApiClient | null): {
  state: OnboardingStateView;
  advance: (step: OnboardingStepId) => void;
  complete: () => void;
  /** #6211: move the wizard to a step. */
  goToStep: (step: OnboardingFlowStep) => void;
  /** #6211: record a step's outcome, and optionally move on in the same write. */
  recordOutcome: (
    step: OnboardingFlowStep,
    outcome: OnboardingOutcome,
    opts?: { provider?: OnboardingProviderKind; next?: OnboardingFlowStep }
  ) => void;
  /**
   * #6211 R22: closed without "Don't show this again", the wizard waits for the
   * next arrival at /sessions; with it, it does not present again by itself.
   */
  close: (opts: { dontShowAgain: boolean }) => void;
  /** #6211: the user arrived at /sessions, which ends a pause. */
  resume: () => void;
  /** #6211 R16: replay from the first step. */
  restart: () => void;
} {
  const [state, setState] = useState<OnboardingStateView>("unknown");
  const stateRef = useRef<OnboardingStateView>("unknown");
  const localPatchesRef = useRef<OnboardingStatePatch[]>([]);
  // Writes go out one at a time, in order: two overlapping patches (Next then
  // Finish on a double tap) must reach the server in the order the user made
  // them. The server also serializes its read-modify-write per settings file.
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const { showToast } = useToast();

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    void Promise.resolve()
      .then(() => api.getOnboardingState())
      .then(read => {
        if (cancelled) return;
        const parsed = OnboardingStateSchema.safeParse(read);
        if (!parsed.success) return;
        setState(localPatchesRef.current.reduce(applyPatch, parsed.data));
      })
      .catch(() => {
        /* stay "unknown": nothing auto-presents; the Settings entry still works */
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const persist = useCallback(
    (patch: OnboardingStatePatch) => {
      localPatchesRef.current.push(patch);
      setState(prev => applyPatch(prev, patch));
      if (!api) return;
      writeQueueRef.current = writeQueueRef.current
        .then(() => api.setOnboardingState(patch))
        .then(
          () => undefined,
          () => {
            showToast(
              "Couldn't save your setup progress — it may not have persisted.",
              { type: "error" }
            );
          }
        );
    },
    [api, showToast]
  );

  const advance = useCallback(
    (step: OnboardingStepId) => persist({ lastStep: step }),
    [persist]
  );

  const complete = useCallback(
    () => persist({ status: "completed" }),
    [persist]
  );

  const goToStep = useCallback(
    (step: OnboardingFlowStep) => persist({ flow: { step } }),
    [persist]
  );

  const recordOutcome = useCallback(
    (
      step: OnboardingFlowStep,
      outcome: OnboardingOutcome,
      opts: {
        provider?: OnboardingProviderKind;
        next?: OnboardingFlowStep;
      } = {}
    ) =>
      persist({
        flow: {
          ...(opts.next ? { step: opts.next } : {}),
          outcomes: {
            [step]: {
              outcome,
              ...(opts.provider ? { provider: opts.provider } : {}),
            },
          },
        },
      }),
    [persist]
  );

  const close = useCallback(
    ({ dontShowAgain }: { dontShowAgain: boolean }) => {
      const current = stateRef.current;
      // A closed replay of a finished wizard is simply over: it stays finished.
      if (current !== "unknown" && current.status === "completed") return;
      if (dontShowAgain) {
        persist({ status: "dismissed" });
        return;
      }
      if (current !== "unknown" && current.status !== "pending") return;
      persist({ flow: { paused: true } });
    },
    [persist]
  );

  const resume = useCallback(() => {
    const current = stateRef.current;
    if (current === "unknown" || !current.flow?.paused) return;
    persist({ flow: { paused: false } });
  }, [persist]);

  const restart = useCallback(() => persist({ restart: true }), [persist]);

  return {
    state,
    advance,
    complete,
    goToStep,
    recordOutcome,
    close,
    resume,
    restart,
  };
}
