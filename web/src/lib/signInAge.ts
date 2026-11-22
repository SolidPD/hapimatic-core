// SPDX-License-Identifier: AGPL-3.0-only
import type {
  AccountHealthEntry,
  SignInAge,
  SignInAgeInput,
  SignInEnding,
} from "@hapi/protocol";

/**
 * The sign-in age token's words (issue #6801, R6 + R9). The visible text is
 * compact ("12d", "died 30d", "died") so six node pills keep their lines at
 * 393 px; the full sentence is the tooltip and the accessible name. The age
 * itself comes from `computeSignInAge` (`@hapi/protocol`), the one age rule.
 */
export type SignInAgeLabel = {
  text: string;
  tooltip: string;
  /** Issue #6161: `ending` / `due` inside the warning window (R9, R10). */
  state: SignInAge["state"] | "ending" | "due";
};

/**
 * Issue #6161 (Q5): which countdown text the token shows. `"window"` (Q5 option
 * 1, built): a countdown ("2d left") only inside the warning window, #6801's
 * count-up elsewhere. `"always"` (Q5 option 2): a countdown ("18d left")
 * whenever a deadline is resolved; the warning colour still applies only inside
 * the window. Matt picks at Gate 2.
 */
export const SIGN_IN_COUNTDOWN_MODE: "window" | "always" = "window";

/**
 * Issue #6161: where the token is shown. On the Provider Accounts node row the
 * pill beside it opens the re-login, so the sentence says to tap it; the
 * account switcher shows no node pill, so its sentence does not. Issue #6884:
 * on a federation node card the account's chip opens the re-login (a tap on
 * the card itself opens the node), so the sentence says to tap the account.
 */
export type SignInAgeSurface = "node-row" | "node-card" | "switcher";

/** The sentence's tap hint for each surface (#6161, #6884). */
const SIGN_IN_TAP_HINT: Record<SignInAgeSurface, string> = {
  "node-row": " · tap the node to sign in again",
  "node-card": " · tap the account to sign in again",
  switcher: "",
};

/** Issue #6161: the entry's resolved deadline, as the token reads it. */
export type SignInDeadlineView = {
  /** The resolved deadline, or null (`unknown`, `disproved`, `unreported`). */
  at: number | null;
  /** The deadline is an estimate ("about"). */
  estimated: boolean;
  /** `computeSignInEnding`'s answer: inside the warning window, or null. */
  ending: SignInEnding | null;
};

function daysPhrase(days: number): string {
  if (days <= 0) return "less than a day";
  return days === 1 ? "1 day" : `${days} days`;
}

/**
 * Issue #6161: "4 days" / "1 day", with "about" for an estimate. The one
 * wording for how long a sign-in has left, shared by the token, the node row,
 * the row-1 alert and the Ending soon list.
 */
export function daysLeftPhrase(days: number, estimated: boolean): string {
  const n = days === 1 ? "1 day" : `${days} days`;
  return estimated ? `about ${n}` : n;
}

/** Whole days until `at`, rounded up, floored at 0. */
function daysUntil(at: number, nowMs: number): number {
  return Math.max(0, Math.ceil((at - nowMs) / 86_400_000));
}

/**
 * The token's text, tooltip and state, or null when the age shows no token
 * (`flagged-unreported`: a node whose build does not report death times; the
 * pill's red ring and the alert icon still show the dead login).
 *
 * Issue #6161: a `running` entry also reads its deadline (`opts.deadline`).
 * Inside the warning window the text is the countdown ("2d left", or "due") in
 * the warning state, and the sentence says when the sign-in ends; outside it the
 * text is #6801's count-up (or, in `"always"` mode, the countdown) and the
 * sentence adds "; ends in about N days". An end the rule cannot resolve adds
 * "; end date unknown", so it never reads like a healthy sign-in. A flagged or
 * quarantined entry is exactly #6801's token.
 */
export function formatSignInAge(
  age: SignInAge,
  nodeLabel: string,
  opts: {
    deadline?: SignInDeadlineView;
    surface?: SignInAgeSurface;
    mode?: "window" | "always";
    nowMs?: number;
  } = {}
): SignInAgeLabel | null {
  switch (age.state) {
    case "running": {
      const deadline = opts.deadline;
      const tapHint = SIGN_IN_TAP_HINT[opts.surface ?? "switcher"];
      const ending = deadline?.ending ?? null;
      if (ending) {
        return ending.state === "due"
          ? {
              text: "due",
              tooltip: `Sign-in on ${nodeLabel} reached its end date${tapHint}`,
              state: "due",
            }
          : {
              text: `${ending.daysLeft}d left`,
              tooltip: `Sign-in on ${nodeLabel} ends in ${daysLeftPhrase(ending.daysLeft, ending.estimated)}${tapHint}`,
              state: "ending",
            };
      }
      const signedIn = `Signed in to ${nodeLabel} ${daysPhrase(age.days)} ago`;
      if (!deadline) {
        return { text: `${age.days}d`, tooltip: signedIn, state: age.state };
      }
      if (deadline.at === null) {
        return {
          text: `${age.days}d`,
          tooltip: `${signedIn}; end date unknown`,
          state: age.state,
        };
      }
      const left = daysUntil(deadline.at, opts.nowMs ?? Date.now());
      return {
        text:
          (opts.mode ?? SIGN_IN_COUNTDOWN_MODE) === "always"
            ? `${left}d left`
            : `${age.days}d`,
        tooltip: `${signedIn}; ends in ${daysLeftPhrase(left, true)}`,
        state: age.state,
      };
    }
    case "stopped":
      return {
        text: `died ${age.days}d`,
        tooltip: `Stopped refreshing on ${nodeLabel} ${daysPhrase(age.days)} after its sign-in`,
        state: age.state,
      };
    case "stopped-unknown":
      return {
        text: "died",
        tooltip: `Stopped refreshing on ${nodeLabel}; this build did not record when`,
        state: age.state,
      };
    case "quarantined":
      return {
        text: `${age.days}d`,
        tooltip: `Signed in to ${nodeLabel} ${daysPhrase(age.days)} ago; held until a new sign-in because its login was shared with ~/.claude`,
        state: age.state,
      };
    case "flagged-unreported":
      return null;
  }
}

/**
 * The age fields of one account-health entry. An absent `unrefreshableAt` key
 * stays absent, because absence is what marks a node whose build sends no death
 * times (`computeSignInAge`'s `flagged-unreported`).
 */
export function pickSignInAgeInput(entry: AccountHealthEntry): SignInAgeInput {
  return {
    provider: entry.provider,
    authKind: entry.authKind,
    capturedAt: entry.capturedAt,
    unrefreshable: entry.unrefreshable,
    // Issue #6161 (R7): the deadline rule's facts. The four optional keys stay
    // absent when absent: absence marks a node that does not report them
    // (`unreported`), as with `unrefreshableAt`.
    lastRefreshedAt: entry.lastRefreshedAt,
    expiresAt: entry.expiresAt,
    ...(entry.unrefreshableAt !== undefined
      ? { unrefreshableAt: entry.unrefreshableAt }
      : {}),
    ...(entry.quarantined !== undefined
      ? { quarantined: entry.quarantined }
      : {}),
    ...(entry.signInDeadlineAt !== undefined
      ? { signInDeadlineAt: entry.signInDeadlineAt }
      : {}),
    ...(entry.signInDeadlineSource !== undefined
      ? { signInDeadlineSource: entry.signInDeadlineSource }
      : {}),
    ...(entry.folderDeadlineAt !== undefined
      ? { folderDeadlineAt: entry.folderDeadlineAt }
      : {}),
    ...(entry.folderSignInAt !== undefined
      ? { folderSignInAt: entry.folderSignInAt }
      : {}),
  };
}
