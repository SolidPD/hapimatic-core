// SPDX-License-Identifier: AGPL-3.0-only
import {
  ONBOARDING_FLOW_STEP_IDS,
  type OnboardingFlowStep,
  type OnboardingStatus,
} from "@hapi/protocol/schemas";
import { BACKUP_NO_KEY_COPY } from "@/components/backup/backupPolicyCopy";

/** Why the last step cannot just say "You are set". */
export type StartCaveat =
  | "no-model"
  | "no-harness"
  | "no-harness-has-claude"
  | "pick-model"
  | "pick-key"
  | "unknown";

/** What this install can offer, so a step that cannot apply is left out (R24). */
export type OnboardingCapabilities = {
  /** Joined, or able to join. */
  tailscale: boolean;
  /** A GitHub broker is present. */
  connectors: boolean;
  /** This instance has a backup key or passphrase. */
  backup: boolean;
  /** It has no key to save here, so that step informs rather than waits. */
  backupNoKey?: boolean;
  /** Set when a first session needs something more, so the last step says what. */
  startCaveat?: StartCaveat;
};

export type OnboardingStep = {
  id: OnboardingFlowStep;
  title: string;
  body: string;
  /** Where this lives, in words, so the wizard also teaches the Settings menu (R21). */
  menuPath: string;
  /** The page's name, for the button that goes there. */
  pageName: string;
  route:
    | "/settings/account-usage"
    | "/settings/network"
    | "/settings/connectors"
    | "/settings/preferences"
    | "/sessions";
  hash?: string;
  /** The `data-guide` value of the control this step points at. */
  guide?: string;
  /** Shown on Skip for now's step only when it has a consequence (R12). */
  skipNote?: string;
  /** Whether Next waits for the step to read as done. */
  needsAction: boolean;
};

/** What the last step says when "You are set" would not be true (R12). */
const START_CAVEAT_BODY: Record<StartCaveat, string> = {
  "no-model":
    "No model is connected yet, and a session needs one. The next page links to Provider Accounts when you are ready. This guide stays in Settings if you want it again.",
  "no-harness":
    "This node has no command-line tool for your connected model, so a session cannot use it yet. Go to Provider Accounts and connect a model this node can run. This guide stays in Settings if you want it again.",
  "no-harness-has-claude":
    "This node has no command-line tool for your connected model, so a session cannot use it yet. It does have Claude Code: on Provider Accounts, press Add under Anthropic, then Sign in to Claude Code. This guide stays in Settings if you want it again.",
  "pick-model":
    "One more choice: on the next page, pick a model for your API key, because a session without one does not use the key. This guide stays in Settings if you want it again.",
  // #6275 S1: an Anthropic key binds only when picked; nothing selects it by default.
  "pick-key":
    "One more choice: on the next page, choose your API key under Provider Account, because a session uses a key only when you pick it. This guide stays in Settings if you want it again.",
  // #6275 S3: a read that failed or has not answered cannot say a session will work.
  unknown:
    "This could not check whether a model is connected, so it cannot say a session will start. Start one to find out, or check Settings → Provider Accounts. This guide stays in Settings if you want it again.",
};

/** No connected model can run here, so the last step leads to Provider Accounts, not Create. */
export function startNeedsAnotherModel(
  caveat: StartCaveat | undefined
): boolean {
  return caveat === "no-harness" || caveat === "no-harness-has-claude";
}

/**
 * The wizard, one row per step (R14): each one that acts on something lands on the
 * real Settings page where it happens, and the action happens on that page (R21).
 */
const STEPS: Record<OnboardingFlowStep, OnboardingStep> = {
  connect: {
    id: "connect",
    title: "Connect a model",
    body: "Sessions need a model to work with. Sign in to Claude Code, or add an account or API key for any provider. You can connect more than one.",
    menuPath: "Settings → Provider Accounts",
    pageName: "Provider Accounts",
    route: "/settings/account-usage",
    guide: "connect-model",
    skipNote:
      "Without a model, sessions cannot start. You can connect one any time from Settings → Provider Accounts.",
    needsAction: true,
  },
  tailscale: {
    id: "tailscale",
    title: "Add this VM to your tailnet",
    body: "Optional. Tailscale puts this VM on a private network with your own devices. An auth key from your Tailscale account joins it.",
    menuPath: "Settings → Network",
    pageName: "Network",
    route: "/settings/network",
    guide: "tailscale-key",
    needsAction: true,
  },
  connectors: {
    id: "connectors",
    title: "Connect GitHub",
    body: "Optional. A GitHub account lets Hapimatic list your repositories and issues when you create a session. This opens hapimatic.com, then brings you back.",
    menuPath: "Settings → Connectors",
    pageName: "Connectors",
    route: "/settings/connectors",
    hash: "github",
    guide: "github-connect",
    needsAction: true,
  },
  backup: {
    id: "backup",
    title: "Save your backup key",
    body: "This VM holds the key that decrypts your backups. Save it somewhere safe. You can see it once, and no one else can recover it for you.",
    menuPath: "Settings → Preferences → Backup Key",
    pageName: "Preferences",
    route: "/settings/preferences",
    hash: "backup-key",
    guide: "backup-reveal",
    needsAction: true,
  },
  tour: {
    id: "tour",
    title: "Getting started",
    body: "A quick look at where things are.",
    menuPath: "Sessions",
    pageName: "Sessions",
    route: "/sessions",
    guide: "create-session",
    needsAction: false,
  },
  start: {
    id: "start",
    title: "Start your first session",
    body: "You are set. Start a session to put your model to work. This guide stays in Settings if you want it again.",
    menuPath: "Sessions → New Session",
    pageName: "Sessions",
    route: "/sessions",
    guide: "create-session",
    needsAction: false,
  },
};

/** The steps this install shows, in order (R14, R24). */
export function buildOnboardingSteps(
  capabilities: OnboardingCapabilities
): OnboardingStep[] {
  return ONBOARDING_FLOW_STEP_IDS.filter(id => {
    if (id === "tailscale") return capabilities.tailscale;
    if (id === "connectors") return capabilities.connectors;
    if (id === "backup") return capabilities.backup;
    return true;
  }).map(id => {
    if (id === "backup" && capabilities.backupNoKey) {
      return {
        ...STEPS.backup,
        title: BACKUP_NO_KEY_COPY.heading,
        body: BACKUP_NO_KEY_COPY.lead,
        needsAction: false,
      };
    }
    if (id === "start" && capabilities.startCaveat) {
      return {
        ...STEPS.start,
        body: START_CAVEAT_BODY[capabilities.startCaveat],
      };
    }
    return STEPS[id];
  });
}

/**
 * The step to show for a stored one. A stored step this install no longer offers
 * lands on the next one that it does.
 */
export function resolveOnboardingStep(
  steps: OnboardingStep[],
  stored: OnboardingFlowStep | undefined
): OnboardingStep {
  const fallback = steps[0] ?? STEPS.connect;
  if (!stored) return fallback;
  const from = ONBOARDING_FLOW_STEP_IDS.indexOf(stored);
  return (
    steps.find(step => ONBOARDING_FLOW_STEP_IDS.indexOf(step.id) >= from) ??
    fallback
  );
}

/** The step after `current`, or null on the last. */
export function nextOnboardingStep(
  steps: OnboardingStep[],
  current: OnboardingFlowStep
): OnboardingStep | null {
  const index = steps.findIndex(step => step.id === current);
  return steps[index + 1] ?? null;
}

/** The page a stored step lives on; the host needs it before capabilities load. */
export function onboardingStepRoute(
  stored: OnboardingFlowStep | undefined
): OnboardingStep["route"] {
  return STEPS[stored ?? "connect"].route;
}

/**
 * When the wizard presents itself (R22, R15). Only a `pending` state can, and never
 * under the Settings drawer or the backup prompt. Then either the user has arrived
 * at `/sessions`, which also ends a pause, unless they closed it on this visit; or
 * it is not paused and this is the current step's own page, which is what brings it
 * back when a phone reloads the PWA on a Settings page mid-sign-in.
 */
export function shouldPresentOnboarding(input: {
  status: OnboardingStatus | "unknown";
  paused: boolean;
  pathname: string;
  stepRoute: string;
  hasDrawerParam: boolean;
  backupPromptOpen: boolean;
  closedOnThisVisit: boolean;
}): boolean {
  if (input.status !== "pending") return false;
  if (input.hasDrawerParam || input.backupPromptOpen) return false;
  if (input.pathname === "/sessions") return !input.closedOnThisVisit;
  return !input.paused && input.pathname === input.stepRoute;
}
