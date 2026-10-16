// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import type { OnboardingStepId } from "@hapi/protocol/schemas";
import { useAppContext } from "@/lib/app-context";
import {
  BACKUP_PROMPT_CLOSE_EVENT,
  BACKUP_PROMPT_OPEN_EVENT,
  ONBOARDING_OPEN_EVENT,
  useOnboardingState,
  type OnboardingStateView,
} from "@/hooks/useOnboardingState";
import { OnboardingWizard } from "./OnboardingWizard";

/** Where a (re-)opened tour starts: the step recorded for an unfinished tour, else T1. */
function firstIncompleteStep(state: OnboardingStateView): OnboardingStepId {
  if (state === "unknown" || state.status === "completed") return "t1";
  return state.lastStep ?? "t1";
}

/**
 * The ONE controller of the in-app onboarding tour (#3865), mounted once at app
 * level in `App.tsx` beside `InstallPrompt` / `SettingsDrawer`.
 *
 * Why app level: `SessionList` renders twice in split view, `SessionsPage`
 * unmounts on every `/settings/*` navigation (so a wizard mounted there could
 * not be opened from Settings), and `App` renders exactly once at the router
 * root on every route.
 *
 * Auto-present (operator ruling 3865-D2 → D) — opens when ALL hold: the
 * pathname is exactly `/sessions` with no `drawer` search param; the server
 * state is `pending` (the server stamped it at the instance's first boot —
 * `"unknown"`, `dismissed` and `completed` present nothing); the host has not
 * presented during this app load; and #4791's backup prompt is not on screen
 * (LC6). The state is the only data the gate reads — no session list.
 *
 * Re-entry — a `hapi:onboarding-open` window event (the Settings "Getting
 * started" entry) opens the tour on whatever route the user is on, in every
 * state, at the first incomplete step.
 *
 * Close — every exit records progress (a dismissal keeps a completed tour
 * completed) and lands on `/sessions`; the app stays fully usable behind one
 * Skip.
 *
 * LC6 (epic #4789, operator-confirmed 2026-10-08): the tour dispatches
 * `hapi:onboarding-open` whenever it opens (the Settings entry's own dispatch
 * covers re-entry; the host dispatches it on auto-present), which closes #4791's
 * backup prompt; and it holds its auto-present between that prompt's
 * `hapi:backup-prompt-open` and `hapi:backup-prompt-close`, re-checking after the
 * close. The host ignores the echo of its own dispatch because it marks itself
 * open first.
 */
export function OnboardingHost() {
  const { api } = useAppContext();
  const { state, advance, dismiss, complete } = useOnboardingState(api);
  const pathname = useLocation({ select: location => location.pathname });
  const hasDrawerParam = useLocation({
    select: location =>
      (location.search as { drawer?: unknown } | undefined)?.drawer !==
      undefined,
  });
  const navigate = useNavigate();

  const [tour, setTour] = useState<{
    key: number;
    step: OnboardingStepId;
  } | null>(null);
  const [backupPromptOpen, setBackupPromptOpen] = useState(false);
  const openRef = useRef(false);
  const presentedRef = useRef(false);
  const tourCountRef = useRef(0);
  const stateRef = useRef<OnboardingStateView>(state);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const openTour = useCallback((step: OnboardingStepId, announce: boolean) => {
    if (openRef.current) return;
    openRef.current = true;
    presentedRef.current = true;
    tourCountRef.current += 1;
    setTour({ key: tourCountRef.current, step });
    if (announce) {
      window.dispatchEvent(new CustomEvent(ONBOARDING_OPEN_EVENT));
    }
  }, []);

  useEffect(() => {
    const onBackupOpen = () => setBackupPromptOpen(true);
    const onBackupClose = () => setBackupPromptOpen(false);
    window.addEventListener(BACKUP_PROMPT_OPEN_EVENT, onBackupOpen);
    window.addEventListener(BACKUP_PROMPT_CLOSE_EVENT, onBackupClose);
    return () => {
      window.removeEventListener(BACKUP_PROMPT_OPEN_EVENT, onBackupOpen);
      window.removeEventListener(BACKUP_PROMPT_CLOSE_EVENT, onBackupClose);
    };
  }, []);

  useEffect(() => {
    const onOpenRequest = () =>
      openTour(firstIncompleteStep(stateRef.current), false);
    window.addEventListener(ONBOARDING_OPEN_EVENT, onOpenRequest);
    return () =>
      window.removeEventListener(ONBOARDING_OPEN_EVENT, onOpenRequest);
  }, [openTour]);

  const pendingStep =
    state !== "unknown" && state.status === "pending"
      ? (state.lastStep ?? "t1")
      : null;

  useEffect(() => {
    if (presentedRef.current || pendingStep === null) return;
    if (pathname !== "/sessions" || hasDrawerParam || backupPromptOpen) return;
    openTour(pendingStep, true);
  }, [pendingStep, pathname, hasDrawerParam, backupPromptOpen, openTour]);

  const close = () => {
    openRef.current = false;
    setTour(null);
    if (pathname !== "/sessions") {
      void navigate({ to: "/sessions" });
    }
  };

  if (!tour) return null;

  return (
    <OnboardingWizard
      key={tour.key}
      open
      initialStep={tour.step}
      onAdvance={advance}
      onDismiss={step => {
        dismiss(step);
        close();
      }}
      onComplete={() => {
        complete();
        close();
      }}
    />
  );
}
