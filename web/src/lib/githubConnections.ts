// SPDX-License-Identifier: AGPL-3.0-only
import type { GitHubConnectionStatus } from "@hapi/protocol/githubConnection";

/**
 * Where the app links for GitHub connections (issue #4793).
 *
 * A cloud VM's GitHub accounts are links its users made on hapimatic.com; the gateway holds their
 * tokens and owns every mutation (link, re-link, install, unlink, default). The app only lists them
 * (Settings → GitHub section, Task 6) and links out. These are the ONE source of those targets, so
 * the Create page's "Connect GitHub" and the Settings section can never point at different places.
 */

/** The in-app Settings section that lists the GitHub accounts (`id="github"`). */
export const GITHUB_SETTINGS_HREF = "/settings/connectors#github";

/** The gateway that holds the links (the public origin, not the instance). */
export const GITHUB_GATEWAY_ORIGIN = "https://hapimatic.com";

/**
 * hapimatic.com's connect flow, returning to `returnUrl` (an allowlisted target: this instance's
 * own URL, R9). `another` forces GitHub's account picker (Connect another account).
 */
export function githubConnectHref(
  returnUrl: string,
  opts: { another?: boolean } = {}
): string {
  const url = new URL("/github/connect", GITHUB_GATEWAY_ORIGIN);
  url.searchParams.set("return", returnUrl);
  if (opts.another) url.searchParams.set("select", "1");
  return url.toString();
}

/** hapimatic.com's manage page: re-link, install, unlink, make default. */
export const GITHUB_MANAGE_HREF = `${GITHUB_GATEWAY_ORIGIN}/github/connections`;

/**
 * GitHub's own "Installed GitHub Apps" page, where the signed-in user chooses which repositories
 * the app reaches ("Configure" on a connected account — the hand-off Vercel, Netlify and Linear
 * use rather than listing repositories themselves; D-4793-8).
 */
export const GITHUB_INSTALLED_APPS_HREF =
  "https://github.com/settings/installations";

/** A GitHub account's public avatar (no token: GitHub serves `<login>.png` to anyone). */
export function githubAvatarUrl(login: string, size = 80): string {
  return `https://github.com/${encodeURIComponent(login)}.png?size=${size}`;
}

/** The one action a linked account's row offers, chosen by its status (D-4793-8). */
export type GitHubAccountAction = "configure" | "install" | "relink";

/**
 * How each link status reads (Settings → Connectors and the Create page picker share it, so the
 * two never word a status differently). `tone` is the `StatusDot` / text colour; `detail` is the
 * line under the status in Settings, worded from the status alone. A connected account whose
 * installation list hapimatic.com sent shows {@link githubReachText} in place of `detail` (#5973).
 */
export const GITHUB_STATUS_PRESENTATION: Record<
  GitHubConnectionStatus,
  {
    label: string;
    tone: "ok" | "warn" | "hot";
    detail: string;
    action: GitHubAccountAction;
  }
> = {
  connected: {
    label: "Connected",
    tone: "ok",
    detail: "Lists private and public repositories through the Hapimatic app",
    action: "configure",
  },
  not_installed: {
    label: "Public repositories only",
    tone: "warn",
    detail: "Install the Hapimatic app on GitHub to list private repositories",
    action: "install",
  },
  expired: {
    label: "Link expired",
    tone: "hot",
    detail: "Re-link to keep listing its repositories",
    action: "relink",
  },
  revoked: {
    label: "Access removed",
    tone: "hot",
    detail: "Access was removed on GitHub. Re-link to use it again",
    action: "relink",
  },
};

/**
 * The note under a linked account whose status hapimatic.com could not confirm with GitHub in time
 * (`statusUnchecked`, #6085): the status shown is the stored one (the last known, or a first link's
 * provisional status). Settings → Connectors and the Create page share it, so the two never word it
 * differently. It carries the same message as hapimatic.com's own warning
 * (`GITHUB_STATUS_UNCHECKED_NOTICE` in gateway/src/routes/githubConnect.ts) and what its
 * "Installation status not checked" page already told the user ("reopen the page there after that").
 * A standalone line, so no terminal period.
 */
export const GITHUB_STATUS_UNCHECKED_NOTE =
  "Could not check this account's status with GitHub just now, so it may be out of date. Reopen this page in a minute or two";

/**
 * Whether to show {@link GITHUB_STATUS_UNCHECKED_NOTE} for an account (#6085): only a linked
 * (broker) account has a status, and the flag counts only when it is strictly `true`. One rule for
 * Settings → Connectors and the Create page, so the surfaces never disagree.
 */
export function isGitHubStatusUnchecked(account: {
  status?: GitHubConnectionStatus;
  statusUnchecked?: boolean;
}): boolean {
  return account.status !== undefined && account.statusUnchecked === true;
}

/**
 * #5973: the verb of the reach line (decision D10, Matt's pick at the render sign-off). "Installed
 * on" is literally true even for an "Only select repositories" install, which "Reaches" is not.
 * One constant, so the wording changes in one place.
 */
export const GITHUB_REACH_VERB = "Installed on";

/**
 * #5973: the account's GitHub display name to show beside `@login`, or null when it has none, it
 * is blank, or it only repeats the login (case-insensitively, so never "@alice · alice").
 */
export function githubDisplayName(account: {
  login: string;
  name: string | null;
}): string | null {
  const name = account.name?.trim();
  if (!name) return null;
  return name.toLowerCase() === account.login.toLowerCase() ? null : name;
}

/** #5973: "a", "a and b", "a, b, and c" (the Oxford comma). */
function joinNames(names: readonly string[]): string {
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/**
 * #5973: the reach line of a linked account, "Installed on alice-gh and acme-labs", or null. Only a
 * `connected` account with a non-empty `installedOn` has one: the list is a snapshot from
 * hapimatic.com's last read, so it is never worded as live. The account's own login comes first
 * when it is listed, then the rest in the order received. At most `max` names, then "and N more".
 */
export function githubReachText(
  account: {
    login: string;
    status?: GitHubConnectionStatus;
    installedOn?: readonly string[];
  },
  max: number
): string | null {
  if (account.status !== "connected" || !account.installedOn?.length) {
    return null;
  }
  const own = account.login.toLowerCase();
  const ordered = [
    ...account.installedOn.filter(l => l.toLowerCase() === own),
    ...account.installedOn.filter(l => l.toLowerCase() !== own),
  ];
  const limit = Math.max(1, max);
  const shown = ordered.slice(0, limit);
  const rest = ordered.length - shown.length;
  const names = rest > 0 ? [...shown, `${rest} more`] : shown;
  return `${GITHUB_REACH_VERB} ${joinNames(names)}`;
}

/**
 * Where each row action goes. Install and re-link open hapimatic.com's manage page, whose row for
 * the same account carries the App's install URL and the account's re-link id — neither reaches
 * the VM. Configure opens GitHub directly.
 */
export const GITHUB_ACCOUNT_ACTIONS: Record<
  GitHubAccountAction,
  { label: string; href: string; title: string }
> = {
  configure: {
    label: "Configure",
    href: GITHUB_INSTALLED_APPS_HREF,
    title: "Choose which repositories the app can reach, on GitHub",
  },
  install: {
    label: "Install app",
    href: GITHUB_MANAGE_HREF,
    title: "Opens hapimatic.com, where this account's Install button is",
  },
  relink: {
    label: "Re-link",
    href: GITHUB_MANAGE_HREF,
    title: "Opens hapimatic.com, where this account's Re-link button is",
  },
};

/**
 * Group linked accounts by the Hapimatic user who linked them, keeping the broker's order (each
 * user's default first). On a shared instance every user's links are listed (ruling R6), and
 * grouping is what makes each "Default" unambiguous. Accounts with no linker (a `gh` host) form
 * one group with `email: null`.
 */
export function groupGitHubAccountsByLinker<T extends { email?: string }>(
  accounts: readonly T[]
): Array<{ email: string | null; accounts: T[] }> {
  const groups = new Map<string | null, T[]>();
  for (const account of accounts) {
    const key = account.email ?? null;
    const group = groups.get(key);
    if (group) group.push(account);
    else groups.set(key, [account]);
  }
  return [...groups].map(([email, members]) => ({
    email,
    accounts: members,
  }));
}
