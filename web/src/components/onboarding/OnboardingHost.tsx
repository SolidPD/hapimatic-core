// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import type { ApiClient } from "@/api/client";
import {
  backupPromptVariant,
  useRecordBackupSkip,
} from "@/components/backup/BackupFirstRunPrompt";
import { useGitHubConnectionsVisible } from "@/components/settings/sections/GitHubConnectionsSection";
import {
  isBackupProvisioned,
  useBackupIdentityStatus,
} from "@/hooks/queries/useBackupIdentityStatus";
import { useMachines } from "@/hooks/queries/useMachines";
import {
  nodeAgents,
  startProvider,
  useModelConnection,
} from "@/hooks/queries/useModelConnection";
import { useTailscaleStatus } from "@/hooks/queries/useTailscaleStatus";
import {
  BACKUP_PROMPT_CLOSE_EVENT,
  BACKUP_PROMPT_OPEN_EVENT,
  ONBOARDING_OPEN_EVENT,
  ONBOARDING_RESTART_EVENT,
  setOnboardingGuideOpen,
  useOnboardingState,
} from "@/hooks/useOnboardingState";
import { useAppContext } from "@/lib/app-context";
import { OnboardingGuide, useGuideTarget } from "./OnboardingGuide";
import {
  buildOnboardingSteps,
  nextOnboardingStep,
  onboardingStepRoute,
  resolveOnboardingStep,
  shouldPresentOnboarding,
  startNeedsAnotherModel,
  type OnboardingStep,
  type StartCaveat,
} from "./onboardingSteps";
import { TOUR_CARDS, tourIndexOf } from "./tourCards";

type OnboardingActions = ReturnType<typeof useOnboardingState>;

/**
 * The ONE controller of the first-run wizard (#6211, replacing the #3865 tour and
 * the gateway walk), mounted once at app level in `App.tsx` beside `InstallPrompt`
 * and `SettingsDrawer`. It is the only writer of the onboarding state, because the
 * state hook reads once per consumer and a second writer would leave this one
 * stale; everything else reaches it through a window event.
 *
 * Why app level: `SessionList` renders twice in split view, `SessionsPage` unmounts
 * on every `/settings/*` navigation, and the wizard has to stay up across the real
 * Settings pages it walks through. `App` renders once at the router root.
 *
 * Presenting (R22, R15; `shouldPresentOnboarding`): a `pending` state presents when
 * the user arrives at `/sessions`, or on the current step's own page when not
 * paused. Close without "Don't show this again" pauses it until the next arrival,
 * at the step they left; close with it, or finishing, ends the auto-present. This
 * supersedes #3865's rule that a dismissal never re-presents. Settings can always
 * reopen it (`hapi:onboarding-restart`), and Help's "Replay the tour"
 * (`hapi:onboarding-open`) opens the tour step, or the step they left while setup
 * is still pending.
 *
 * LC6 (epic #4789): the wizard dispatches `hapi:onboarding-open` whenever it opens,
 * which closes #4791's backup prompt, and it holds while that prompt is on screen.
 * The host ignores the echo of its own dispatch because it marks itself open first.
 */
export function OnboardingHost() {
  const { api } = useAppContext();
  const actions = useOnboardingState(api);
  const { state, resume, restart, goToStep } = actions;
  const pathname = useLocation({ select: location => location.pathname });
  const hasDrawerParam = useLocation({
    select: location =>
      (location.search as { drawer?: unknown } | undefined)?.drawer !==
      undefined,
  });
  const navigate = useNavigate();

  const [open, setOpen] = useState(false);
  const [backupPromptOpen, setBackupPromptOpen] = useState(false);
  const [closedOnThisVisit, setClosedOnThisVisit] = useState(false);
  const openRef = useRef(false);

  useEffect(() => {
    setOnboardingGuideOpen(open);
    return () => setOnboardingGuideOpen(false);
  }, [open]);

  const showWizard = useCallback((announce: boolean) => {
    if (openRef.current) return;
    openRef.current = true;
    setOpen(true);
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

  // Help's "Replay the tour".
  useEffect(() => {
    const onOpenRequest = () => {
      // A failed read has no state to write to, and the panel would not render.
      if (openRef.current || state === "unknown") return;
      // Someone part way through keeps their place (R22): the tour is a later step
      // of this wizard, and moving them to it would lose the step they left.
      if (state.status !== "pending") goToStep("tour");
      void navigate({ to: "/sessions" });
      showWizard(false);
    };
    window.addEventListener(ONBOARDING_OPEN_EVENT, onOpenRequest);
    return () =>
      window.removeEventListener(ONBOARDING_OPEN_EVENT, onOpenRequest);
  }, [goToStep, navigate, showWizard, state]);

  // Settings' "Restart onboarding": no write of its own there, so this stays the
  // only writer. It resets nothing but progress.
  useEffect(() => {
    const onRestart = () => {
      restart();
      setClosedOnThisVisit(false);
      void navigate({ to: onboardingStepRoute("connect") });
      showWizard(true);
    };
    window.addEventListener(ONBOARDING_RESTART_EVENT, onRestart);
    return () =>
      window.removeEventListener(ONBOARDING_RESTART_EVENT, onRestart);
  }, [navigate, restart, showWizard]);

  // A close is for this visit to /sessions: leaving ends it, so coming back counts.
  useEffect(() => {
    if (pathname !== "/sessions") setClosedOnThisVisit(false);
  }, [pathname]);

  const status = state === "unknown" ? "unknown" : state.status;
  const flow = state === "unknown" ? undefined : state.flow;
  const paused = flow?.paused === true;

  const present = shouldPresentOnboarding({
    status,
    paused,
    pathname,
    stepRoute: onboardingStepRoute(flow?.step),
    hasDrawerParam,
    backupPromptOpen,
    closedOnThisVisit,
  });

  useEffect(() => {
    if (!present) return;
    if (paused && pathname === "/sessions") resume();
    showWizard(true);
  }, [present, paused, pathname, resume, showWizard]);

  const hide = useCallback(() => {
    openRef.current = false;
    setOpen(false);
  }, []);

  if (!open || state === "unknown") return null;

  return (
    <OnboardingWizardPanel
      key={flow?.run}
      api={api}
      actions={actions}
      pathname={pathname}
      onClosed={() => {
        if (pathname === "/sessions") setClosedOnThisVisit(true);
        hide();
      }}
      onFinished={hide}
    />
  );
}

/**
 * The open wizard. Its own component so the reads it needs run only while it is on
 * screen, not on every app load of an instance that finished onboarding long ago.
 */
function OnboardingWizardPanel({
  api,
  actions,
  pathname,
  onClosed,
  onFinished,
}: {
  api: ApiClient | null;
  actions: OnboardingActions;
  pathname: string;
  onClosed: () => void;
  onFinished: () => void;
}) {
  const { state, advance, complete, goToStep, recordOutcome, close } = actions;
  const navigate = useNavigate();
  const connection = useModelConnection(api, { everyProvider: true });
  const tailscale = useTailscaleStatus(api);
  const github = useGitHubConnectionsVisible();
  const backup = useBackupIdentityStatus(api);
  const recordBackupSkip = useRecordBackupSkip(api);
  const { machines } = useMachines(api, true);
  const agents = nodeAgents(machines);
  const start = startProvider(connection.providers, agents);
  let startCaveat: StartCaveat | undefined;
  if (connection.status === "none") startCaveat = "no-model";
  // #6275 S3: with no provider found, an unanswered or failed read says neither
  // "set" nor "no model". A provider any one read found decides the step below.
  else if (connection.status === "unknown") startCaveat = "unknown";
  else if (!start) {
    startCaveat = agents?.includes("claude")
      ? "no-harness-has-claude"
      : "no-harness";
  } else if (start.choice) {
    // #6275 S1: a gateway key needs a model, and an Anthropic key is used only once picked.
    startCaveat = start.choice;
  }

  const steps = buildOnboardingSteps({
    // An unanswered read keeps the step: the path text still guides the user.
    tailscale: tailscale.data?.state !== "unavailable",
    connectors: github.visible || github.isLoading || github.loadFailed,
    // While it loads too, so a reload on this step does not flip to the next one.
    backup: backup.isPending || isBackupProvisioned(backup.data),
    backupNoKey: backupPromptVariant(backup.data, false) === "no-key",
    startCaveat,
  });
  const stored = state === "unknown" ? undefined : state.flow?.step;
  const step = resolveOnboardingStep(steps, stored);
  const position = steps.findIndex(s => s.id === step.id) + 1;
  const onStepPage = pathname === step.route;

  useGuideTarget(step.guide, onStepPage);

  // Only someone still in the tour resumes a card; a replay starts from the first.
  const lastTourStep =
    state !== "unknown" && state.status === "pending"
      ? state.lastStep
      : undefined;
  const [cardIndex, setCardIndex] = useState(() =>
    lastTourStep ? tourIndexOf(lastTourStep) : 0
  );

  const done =
    step.id === "connect"
      ? connection.status === "connected"
      : step.id === "tailscale"
        ? tailscale.data?.state === "joined"
        : step.id === "connectors"
          ? github.accounts.length > 0
          : step.id === "backup"
            ? backup.data?.revealed === true
            : true;

  const statusLines =
    step.id === "connect"
      ? // Two accounts of one kind read alike, and one line says all it needs to.
        [...new Set(connection.providers.map(p => `Connected ✓ ${p.label}`))]
      : step.id === "tailscale" && done
        ? [
            `Connected ✓ ${tailscale.data?.hostname ?? tailscale.data?.ip ?? "on your tailnet"}`,
          ]
        : step.id === "connectors"
          ? github.accounts.map(a => `Connected ✓ ${a.login}`)
          : step.id === "backup" && done
            ? ["Saved ✓"]
            : [];

  const goTo = (target: OnboardingStep) =>
    void navigate({ to: target.route, hash: target.hash });

  const provider =
    step.id === "connect" ? connection.providers[0]?.kind : undefined;

  const finish = (outcome: "completed" | "skipped") => {
    recordOutcome(step.id, outcome);
    complete();
    onFinished();
  };

  const moveOn = (outcome: "completed" | "skipped") => {
    const next = nextOnboardingStep(steps, step.id);
    if (!next) {
      finish(outcome);
      return;
    }
    recordOutcome(step.id, outcome, {
      ...(provider ? { provider } : {}),
      next: next.id,
    });
    goTo(next);
  };

  const isTour = step.id === "tour";
  const card = TOUR_CARDS[cardIndex];
  const Illustration = card?.Illustration;

  const onNext = () => {
    if (isTour && cardIndex < TOUR_CARDS.length - 1) {
      const nextCard = cardIndex + 1;
      setCardIndex(nextCard);
      const id = TOUR_CARDS[nextCard]?.id;
      if (id) advance(id);
      return;
    }
    if (step.id === "start") {
      finish("completed");
      if (startNeedsAnotherModel(startCaveat)) {
        void navigate({ to: "/settings/account-usage" });
        return;
      }
      void navigate({
        to: "/sessions/new",
        ...(start ? { search: { agent: start.harness } } : {}),
      });
      return;
    }
    // A passphrase VM's step has just said what its standalone prompt would repeat.
    if (step.id === "backup" && !step.needsAction) recordBackupSkip.mutate();
    moveOn("completed");
  };

  const onSkip = () => {
    if (step.id === "backup") recordBackupSkip.mutate();
    moveOn("skipped");
  };

  return (
    <OnboardingGuide
      key={step.id}
      step={step}
      position={position}
      total={steps.length}
      onStepPage={onStepPage}
      ready={!step.needsAction || done}
      statusLines={statusLines}
      primaryLabel={
        step.id === "start"
          ? startNeedsAnotherModel(startCaveat)
            ? "Go to Provider Accounts"
            : "Start your first session"
          : isTour && cardIndex < TOUR_CARDS.length - 1
            ? "Next card"
            : undefined
      }
      onGoToPage={() => {
        goTo(step);
        goToStep(step.id);
      }}
      onNext={onNext}
      onSkip={onSkip}
      onClose={opts => {
        close(opts);
        onClosed();
      }}
    >
      {isTour && card && Illustration ? (
        <div className="flex flex-col items-center gap-2">
          <Illustration />
          <p
            className="w-full text-[length:var(--text-label-strong)] font-medium"
            data-testid="onboarding-card-title"
          >
            {card.title}
          </p>
          <p className="w-full text-[length:var(--text-body)] leading-relaxed">
            {card.body}
          </p>
        </div>
      ) : null}
    </OnboardingGuide>
  );
}
