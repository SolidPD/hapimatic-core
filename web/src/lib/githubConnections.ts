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
 * line under the status in Settings, worded from the status alone because the VM never sees which
 * accounts the app is installed on (that list is the #4789 follow-up, D-4793-8).
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
