// SPDX-License-Identifier: AGPL-3.0-only
import type {
  AccountHealthEntry,
  SignInAge,
  SignInAgeInput,
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
  state: SignInAge["state"];
};

function daysPhrase(days: number): string {
  if (days <= 0) return "less than a day";
  return days === 1 ? "1 day" : `${days} days`;
}

/**
 * The token's text, tooltip and state, or null when the age shows no token
 * (`flagged-unreported`: a node whose build does not report death times; the
 * pill's red ring and the alert icon still show the dead login).
 */
export function formatSignInAge(
  age: SignInAge,
  nodeLabel: string
): SignInAgeLabel | null {
  switch (age.state) {
    case "running":
      return {
        text: `${age.days}d`,
        tooltip: `Signed in to ${nodeLabel} ${daysPhrase(age.days)} ago`,
        state: age.state,
      };
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
    ...(entry.unrefreshableAt !== undefined
      ? { unrefreshableAt: entry.unrefreshableAt }
      : {}),
    ...(entry.quarantined !== undefined
      ? { quarantined: entry.quarantined }
      : {}),
  };
}
