// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The status of a GitHub account a user linked on hapimatic.com (issue #4793).
 *
 * The gateway's read broker reports one per linked account (`GET /github-broker/accounts`); the VM
 * server passes it through to the Create page, which shows an install hint for `not_installed` and
 * a re-link hint for `expired` / `revoked`. One list for the server and the web, so the two cannot
 * drift (the #2391 lesson). The gateway keeps its own copy in gateway/src/lib/githubConnections.ts
 * because it deploys standalone, without `shared/`; the four values must stay identical.
 *
 * A status the gateway could not confirm with GitHub in time arrives with a separate
 * `statusUnchecked: true` beside it (#6085). That flag is not a fifth status: the status stays the
 * stored value (the last known one, or a first link's provisional one), so this list and the
 * gateway's copy keep four values.
 *
 *   - `connected`: the App is installed where the user can see it; private repositories list too.
 *   - `not_installed`: authorized but not installed; public repositories only.
 *   - `expired`: the refresh token is dead; the user must re-link.
 *   - `revoked`: the user removed the App at github.com; the user must re-link.
 */
export const GITHUB_CONNECTION_STATUSES = [
  "connected",
  "not_installed",
  "expired",
  "revoked",
] as const;

export type GitHubConnectionStatus =
  (typeof GITHUB_CONNECTION_STATUSES)[number];

/** Narrow an untrusted value (a broker answer) to a known status, else undefined. */
export function asGitHubConnectionStatus(
  value: unknown
): GitHubConnectionStatus | undefined {
  return typeof value === "string" &&
    (GITHUB_CONNECTION_STATUSES as readonly string[]).includes(value)
    ? (value as GitHubConnectionStatus)
    : undefined;
}
