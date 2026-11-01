// SPDX-License-Identifier: AGPL-3.0-only
import { useAppContext } from "@/lib/app-context";
import {
  useGitHubAccounts,
  type GitHubAccount,
} from "@/hooks/queries/useGitHubRepos";
import { ArrowUpRight, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { StatusDot } from "@/components/ui/StatusDot";
import { GitHubAccountAvatar } from "@/components/GitHubAccountAvatar";
import {
  GITHUB_ACCOUNT_ACTIONS,
  GITHUB_MANAGE_HREF,
  GITHUB_SETTINGS_HREF,
  GITHUB_STATUS_PRESENTATION,
  githubConnectHref,
  groupGitHubAccountsByLinker,
} from "@/lib/githubConnections";

/**
 * The GitHub section of Settings (issue #4793, Task 6; R4).
 *
 * On a cloud VM the GitHub accounts are links the instance's users made on hapimatic.com: the
 * gateway holds each account's read-only GitHub App token, and the VM only ever sees the list the
 * gateway's read broker returns (R2). So this section LISTS the accounts — grouped by who linked
 * them, each with its avatar, status and default mark (D-4793-8) — and every action is a
 * top-level navigation: connect, connect another, re-link, install, unlink and make default go to
 * hapimatic.com, which owns the mutations (KD2); a connected account's Configure goes to GitHub. A connect
 * returns here (`return=<this page>`, R9); the gateway's sign-in round trip carries the return
 * path, so one click completes the link even when the gateway session has lapsed (Task 3a).
 *
 * DETECT-AND-HIDE, like the backup-key row (#3119): it renders only on a broker-backed host
 * (`source === "broker"`), or when the broker failed to answer there (`broker_unavailable`), or
 * answered that hapimatic.com's GitHub App is not set up yet (`broker_not_configured`) — reasons
 * only a broker-provisioned host reports. On RP1, CI or an operator VM signed in with `gh`, there
 * is nothing to connect, so the section — and its Settings row — are absent (finding 4793-14).
 */
export function useGitHubConnectionsVisible(): {
  visible: boolean;
  accounts: GitHubAccount[];
  isLoading: boolean;
  /** hapimatic.com did not answer (or answered with an error). */
  outage: boolean;
  /** hapimatic.com answered: its GitHub App is not set up yet (operator activation pending). */
  notConfigured: boolean;
  /**
   * The request to this instance failed outright (offline, timeout, server restarting), so the
   * host's kind is unknown: neither "connectors here" nor "none here" is true yet.
   */
  loadFailed: boolean;
} {
  const { api } = useAppContext();
  const query = useGitHubAccounts(api, null);
  const outage = query.unavailable && query.reason === "broker_unavailable";
  const notConfigured =
    query.unavailable && query.reason === "broker_not_configured";
  return {
    visible: query.source === "broker" || outage || notConfigured,
    accounts: query.accounts,
    isLoading: query.isLoading,
    outage,
    notConfigured,
    loadFailed:
      query.error !== null && query.source === null && !query.unavailable,
  };
}

/** The page this section lives on, as an absolute URL the gateway may return to. */
function thisPageUrl(): string {
  return new URL(GITHUB_SETTINGS_HREF, window.location.origin).toString();
}

const TONE_TEXT = {
  ok: "text-[var(--status-ok)]",
  warn: "text-[var(--status-warn)]",
  hot: "text-[var(--status-hot)]",
} as const;

/**
 * One linked account (D-4793-8, Matt's pick G1): avatar, @login, the Default mark, a coloured
 * status line, what the status means for repository listing, and the ONE action that status
 * calls for — the row pattern GitHub's account switcher and VS Code's Accounts menu use, with the
 * account kept apart from what its app install reaches.
 */
function AccountRow(props: { account: GitHubAccount }) {
  const { account } = props;
  const status = account.status
    ? GITHUB_STATUS_PRESENTATION[account.status]
    : null;
  const action = status ? GITHUB_ACCOUNT_ACTIONS[status.action] : null;
  const quiet = status?.action === "configure";
  return (
    <li
      className="flex items-center gap-3 border-t border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3.5 py-3 first:border-t-0"
      data-testid={`github-account-${account.login}`}
    >
      <GitHubAccountAvatar login={account.login} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate text-sm font-semibold text-[var(--app-fg)]">
            @{account.login}
          </span>
          {account.name && (
            <span className="truncate text-[length:var(--text-caption)] text-[var(--app-hint)]">
              {account.name}
            </span>
          )}
          {account.isDefault && <Badge variant="success">Default</Badge>}
        </div>
        {status && (
          <span
            className={`flex items-center gap-1.5 text-[length:var(--text-caption)] ${TONE_TEXT[status.tone]}`}
          >
            {/* Decorative: the text beside it carries the status, so the dot is not announced too. */}
            <span aria-hidden="true" className="inline-flex">
              <StatusDot status={status.tone} label={status.label} />
            </span>
            {status.label}
          </span>
        )}
        {status && (
          <span className="text-[length:var(--text-caption)] text-[var(--app-hint)]">
            {status.detail}
          </span>
        )}
      </div>
      {action && (
        <a
          href={action.href}
          title={action.title}
          className={`inline-flex h-8 shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-2.5 text-[length:var(--text-caption)] font-medium no-underline ${
            quiet
              ? "border-[var(--app-border)] text-[var(--app-hint)]"
              : "border-[var(--app-link)]/40 text-[var(--app-link)]"
          }`}
        >
          {action.label}
          <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
        </a>
      )}
    </li>
  );
}

export function GitHubConnectionsSection() {
  const { visible, accounts, isLoading, outage, notConfigured } =
    useGitHubConnectionsVisible();
  if (!visible) return null;
  const listClass =
    "flex flex-col overflow-hidden rounded-xl border border-[var(--app-border)]";
  const groupHeading =
    "text-[length:var(--text-caption)] font-medium uppercase tracking-wide text-[var(--app-hint)]";
  return (
    <div
      className="flex flex-col gap-4"
      data-testid="github-connections-section"
    >
      {notConfigured ? (
        // An answer, not an outage: hapimatic.com has no GitHub App yet, so nothing can be linked
        // and neither link would help. It changes when the operator sets the App up.
        <p className="text-sm text-[var(--app-hint)]" role="status">
          GitHub connections are not set up on hapimatic.com yet.
        </p>
      ) : outage ? (
        <p className="text-sm text-[var(--status-warn)]" role="status">
          hapimatic.com did not answer, so the linked accounts cannot be shown
          right now.
        </p>
      ) : isLoading ? (
        <p className="text-sm text-[var(--app-hint)]">Loading accounts…</p>
      ) : accounts.length === 0 ? (
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm text-[var(--app-fg)]">
            No GitHub account is linked yet.
          </p>
          <a
            className="inline-flex h-9 items-center rounded-md bg-accent px-3 text-sm font-medium text-[var(--palette-accent-fg)] no-underline"
            href={githubConnectHref(thisPageUrl())}
          >
            Connect GitHub
          </a>
        </div>
      ) : (
        <>
          {groupGitHubAccountsByLinker(accounts).map(group => {
            const label = group.email
              ? `Linked by ${group.email}`
              : "Linked GitHub accounts";
            return (
              <div key={group.email ?? ""} className="flex flex-col gap-2">
                {group.email && <h3 className={groupHeading}>{label}</h3>}
                <ul className={listClass} aria-label={label}>
                  {group.accounts.map(account => (
                    <AccountRow
                      key={`${account.email ?? ""}/${account.login}`}
                      account={account}
                    />
                  ))}
                </ul>
              </div>
            );
          })}
          {/* "Add account" closes the list, as on GitHub, Linear and Vercel. It adds a GitHub
              identity (not an org), so it says exactly that. */}
          <a
            className="flex items-center gap-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3.5 py-3 text-sm font-semibold text-[var(--app-link)] no-underline"
            href={githubConnectHref(thisPageUrl(), { another: true })}
          >
            <span
              aria-hidden="true"
              className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-dashed border-[var(--app-link)]/60"
            >
              <Plus className="h-5 w-5" />
            </span>
            Add another GitHub account
          </a>
        </>
      )}
      {/* Not set up yet: no link (hapimatic.com's GitHub pages are off until the App exists).
          In an outage the list is unknown, not empty: only the manage page, never a "Connect"
          implying none is linked. */}
      {!notConfigured && (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-[length:var(--text-caption)] text-[var(--app-hint)]">
          <span>
            {accounts.length > 0
              ? "Unlink an account or change the default on hapimatic.com. "
              : ""}
            This instance never holds a GitHub token.
          </span>
          <a
            className="inline-flex items-center gap-1 font-medium text-[var(--app-link)] no-underline"
            href={GITHUB_MANAGE_HREF}
          >
            Manage on hapimatic.com
            <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        </div>
      )}
    </div>
  );
}
