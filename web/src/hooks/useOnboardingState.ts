// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useRef, useState } from "react";
import {
  OnboardingStateSchema,
  type OnboardingState,
  type OnboardingStatePatch,
  type OnboardingStepId,
} from "@hapi/protocol/schemas";
import type { ApiClient } from "@/api/client";
import { useToast } from "@/components/Toast";

/**
 * Window event that opens the in-app onboarding tour (#3865) and announces that
 * it opened. The Settings "Getting started" entry dispatches it to ask the
 * app-level `OnboardingHost` to open the tour; the host dispatches it itself when
 * it auto-presents. #4791's first-run backup prompt (epic #4789, contract LC6)
 * closes without acknowledging when it receives this event.
 */
export const ONBOARDING_OPEN_EVENT = "hapi:onboarding-open";

/** LC6: #4791's backup prompt dispatches these while it is on screen. */
export const BACKUP_PROMPT_OPEN_EVENT = "hapi:backup-prompt-open";
export const BACKUP_PROMPT_CLOSE_EVENT = "hapi:backup-prompt-close";

/** Ask the app-level host to open the tour (the Settings re-entry signal). */
export function requestOpenOnboarding(): void {
  window.dispatchEvent(new CustomEvent(ONBOARDING_OPEN_EVENT));
}

/**
 * `"unknown"` while the read is in flight and after a failed read; otherwise the
 * server's effective state. Never an optimistic `pending`: a modal must not
 * flash at existing users before the read resolves, or ambush them whenever the
 * server is unreachable.
 */
export type OnboardingStateView = "unknown" | OnboardingState;

function applyPatch(
  prev: OnboardingStateView,
  patch: OnboardingStatePatch
): OnboardingStateView {
  if (prev !== "unknown") return { ...prev, ...patch };
  // A patch without a status cannot make an unknown state known.
  return patch.status ? { ...patch, status: patch.status } : "unknown";
}

/**
 * Node-local onboarding-tour state (#3865, OQ-2), read from and written to
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
 * - `dismiss` during a re-run after completion keeps the status `completed`.
 */
export function useOnboardingState(api: ApiClient | null): {
  state: OnboardingStateView;
  advance: (step: OnboardingStepId) => void;
  dismiss: (step: OnboardingStepId) => void;
  complete: () => void;
} {
  const [state, setState] = useState<OnboardingStateView>("unknown");
  const stateRef = useRef<OnboardingStateView>("unknown");
  const localPatchRef = useRef<OnboardingStatePatch>({});
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
        setState(applyPatch(parsed.data, localPatchRef.current));
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
      localPatchRef.current = { ...localPatchRef.current, ...patch };
      setState(prev => applyPatch(prev, patch));
      if (!api) return;
      writeQueueRef.current = writeQueueRef.current
        .then(() => api.setOnboardingState(patch))
        .then(
          () => undefined,
          () => {
            showToast(
              "Couldn't save your tour progress — it may not have persisted.",
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

  const dismiss = useCallback(
    (step: OnboardingStepId) => {
      const current = stateRef.current;
      if (current !== "unknown" && current.status === "completed") return;
      persist({ status: "dismissed", lastStep: step });
    },
    [persist]
  );

  const complete = useCallback(
    () => persist({ status: "completed" }),
    [persist]
  );

  return { state, advance, dismiss, complete };
}
