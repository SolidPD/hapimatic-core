// SPDX-License-Identifier: AGPL-3.0-only
import { reasonDisplayText } from "@hapi/protocol/githubFailureReason";
import { FormField } from "./FormField";
import { CONTROL_BASE, ControlChevron } from "./controls";
import { Button } from "@/components/ui/button";
import { BareButton } from "@/components/ui/BareButton";
import type { GitHubAccount, GitHubRepo } from "@/hooks/queries/useGitHubRepos";

/** Drop the owner/ prefix for display — "MattStarfield/foo" → "foo". */
function repoName(nameWithOwner: string): string {
  const i = nameWithOwner.indexOf("/");
  return i === -1 ? nameWithOwner : nameWithOwner.slice(i + 1);
}

/**
 * Plain-language text for each server failure reason (#2327) now comes from
 * `@hapi/protocol/githubFailureReason` (#2391).
 *
 * It was a local `REASON_TEXT: Record<string, string>` here while the server kept
 * its own `GITHUB_REASON_MESSAGE` for the same enum — a drift pair whose halves
 * had ASYMMETRIC type safety. The server's map was `Record<GitHubFailureReason,
 * string>` (exhaustive: a new reason failed the build), this one was keyed by bare
 * `string` (not exhaustive: a new reason silently fell through to "resolution
 * failed"). The shared map is exhaustive for both, so the two can no longer drift.
 *
 * The copy still MUST stay distinct from the genuinely-empty copy ("No GitHub
 * account connected"): the whole point of #2327 is that a user can tell "we could
 * not resolve your account" from "you have no account", without reading logs.
 *
 * `reasonDisplayText` keeps the tolerant `string` parameter deliberately — on the
 * federation path the reason is forwarded verbatim from a peer node, so an older
 * peer can send a value this client has never heard of.
 */

/**
 * Build the collapsed-accordion summary for the GitHub section.
 *
 * Lives here rather than in the page container so the collapsed summary and the
 * expanded field derive their "unavailable" wording from ONE place — a collapsed
 * section reading "Disabled" while the expanded field reads "GitHub unavailable"
 * would be the same class of contradiction #2327 set out to remove.
 */
export function buildGitHubSummary(args: {
  sessionMode: string;
  githubAccount: string | null;
  cloneRepo: string | null;
  detectedRepo: string | null | undefined;
  isWorktree: boolean;
  accountsUnavailable: boolean;
}): string {
  if (args.sessionMode !== "standard") return "Local (no GitHub)";
  const repo = args.cloneRepo || args.detectedRepo;
  const account = args.accountsUnavailable
    ? "GitHub unavailable"
    : args.githubAccount || "Disabled";
  const parts = [account];
  if (repo) parts.push(repo);
  parts.push(args.isWorktree ? "Worktree" : "Basic");
  return parts.join(" · ");
}

/**
 * Issue #1953 (A6) — GitHub-account → repository selector for the Create form.
 * Issue #2019 — converted from native `<select>`s to field-button(s) that open a
 * selection modal (`GitHubAccountSelectorModal` / `GitHubRepoSelectorModal`),
 * mirroring the Claude-account `AccountSelector` → `AccountSelectorModal` pattern.
 * The iOS OS picker wheel is gone; the repo modal adds search + a private badge.
 *
 * Two modes, matching the locked V1 mock-up (`docs/design/create-page`):
 *
 * 1. **Directory already a repo** (`detectedRepo` set, resolved from the dir's
 *    git remote): the Repo field shows that repo READ-ONLY ("auto-detected from
 *    directory") and the clone-repo picker is hidden — you're opening an existing
 *    repo, not cloning one.
 * 2. **Empty / non-repo directory** (`detectedRepo` null): the clone-on-spawn
 *    picker — choose a host `gh` account, then a repo to clone into the working
 *    dir before launch.
 *
 * The "account" is the host `gh` CLI identity (NOT an OAuth account). Presentational
 * only — the parent owns the queries, the derived `directory`/`cloneRepo` state, and
 * the modal open-state + modal mounts (it opens them via `onOpenAccount`/`onOpenRepo`).
 */
export function GitHubAccountRepoSelector(props: {
  accounts: GitHubAccount[];
  repos: GitHubRepo[];
  /** Selected account login, or null when none chosen. */
  selectedAccount: string | null;
  /** Selected repo `nameWithOwner`, or null when none chosen. */
  selectedRepo: string | null;
  /**
   * Repo already present at the selected directory ("owner/repo"). When set, the
   * Repo field is read-only + auto-detected and the clone picker is suppressed.
   */
  detectedRepo?: string | null;
  isLoadingAccounts?: boolean;
  isLoadingRepos?: boolean;
  /**
   * #2327: account resolution FAILED (as opposed to succeeding with zero
   * accounts). Renders a visibly distinct unavailable state.
   */
  accountsUnavailable?: boolean;
  /** #2327: machine-readable cause behind `accountsUnavailable`. */
  accountsUnavailableReason?: string | null;
  isDisabled: boolean;
  /** Open the GitHub account selection modal (parent owns the open state + mount). */
  onOpenAccount: () => void;
  /** Open the GitHub repo selection modal (parent owns the open state + mount). */
  onOpenRepo: () => void;
}) {
  const {
    accounts,
    repos,
    selectedAccount,
    selectedRepo,
    detectedRepo,
    isLoadingAccounts,
    isLoadingRepos,
    accountsUnavailable,
    accountsUnavailableReason,
    isDisabled,
    onOpenAccount,
    onOpenRepo,
  } = props;

  const noAccounts = accounts.length === 0;
  // #2327: resolution failed. Distinct from `noAccounts` — which now means only
  // "resolution SUCCEEDED and returned nothing".
  const isUnavailable = Boolean(accountsUnavailable) && !isLoadingAccounts;

  // Compact account-field summary. Four states, in priority order.
  let accountSummary: string;
  if (isLoadingAccounts && noAccounts) {
    accountSummary = "Loading accounts…";
  } else if (isUnavailable) {
    accountSummary = `GitHub unavailable — ${reasonDisplayText(accountsUnavailableReason)}`;
  } else if (noAccounts) {
    accountSummary = "No GitHub account connected";
  } else if (selectedAccount) {
    const a = accounts.find(x => x.login === selectedAccount);
    accountSummary = a?.name ? `${a.login} — ${a.name}` : selectedAccount;
  } else {
    accountSummary = "None (no clone)";
  }

  // Compact repo-field summary + private flag for the badge.
  const selectedRepoObj = selectedRepo
    ? (repos.find(r => r.nameWithOwner === selectedRepo) ?? null)
    : null;
  const repoSummary = isLoadingRepos
    ? "Loading repositories…"
    : selectedRepo
      ? selectedRepo
      : "Select a repository…";

  return (
    <div className="flex flex-col gap-1 px-3 py-1.5">
      <FormField
        label="GitHub Account"
        tooltip="The GitHub identity (host gh CLI login) this session uses for repository access — cloning, issue lookups, and pull requests act as this account. Pick None to skip GitHub integration for this session."
        bookmarkId="githubAccount"
      >
        <BareButton
          type="button"
          aria-label="GitHub account"
          title={isUnavailable ? accountSummary : undefined}
          onClick={onOpenAccount}
          disabled={isDisabled || (noAccounts && !isLoadingAccounts)}
          className={`${CONTROL_BASE} flex items-center justify-between gap-2 px-2.5 text-left font-normal`}
        >
          <span
            className={`truncate ${
              isUnavailable
                ? "text-[var(--status-warn)]"
                : selectedAccount
                  ? ""
                  : "text-[var(--app-hint)]"
            }`}
          >
            {accountSummary}
          </span>
          <ControlChevron className="h-4 w-4 shrink-0 text-[var(--app-hint)]" />
        </BareButton>
      </FormField>

      {detectedRepo ? (
        /* Auto-inherited state: NO bookmarkId — a saved default is ineligible
           while the directory's repo owns this field (inheritance wins). */
        <FormField
          label="Repo"
          hint="auto-detected from directory"
          tooltip="The GitHub repository this session works in. When the selected directory already contains a repository it is detected from the git remote and shown read-only here; issue linking below draws from this repo."
        >
          <div
            className="flex h-9 items-center rounded-md border border-dashed border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-2.5 text-sm text-[var(--app-hint)]"
            title={detectedRepo}
          >
            {repoName(detectedRepo)}
          </div>
        </FormField>
      ) : (
        selectedAccount && (
          <FormField
            label="Repo"
            tooltip="The GitHub repository to clone into the working directory before the session starts. Use this when the selected directory is empty — the session begins with a fresh checkout of the chosen repo."
            bookmarkId="repo"
          >
            <Button
              type="button"
              variant="ghost"
              aria-label="GitHub repository"
              onClick={onOpenRepo}
              disabled={isDisabled || isLoadingRepos}
              className={`${CONTROL_BASE} flex items-center justify-between gap-2 px-2.5 text-left font-normal hover:bg-[var(--app-bg)]`}
            >
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <span
                  className={`truncate ${selectedRepo ? "" : "text-[var(--app-hint)]"}`}
                >
                  {repoSummary}
                </span>
                {selectedRepoObj?.isPrivate && (
                  <span className="shrink-0 rounded-full bg-[var(--app-link)]/10 px-1.5 py-0.5 text-[length:var(--text-caption-xs)] font-medium text-[var(--app-link)]">
                    Private
                  </span>
                )}
              </span>
              <ControlChevron className="h-4 w-4 shrink-0 text-[var(--app-hint)]" />
            </Button>
          </FormField>
        )
      )}
    </div>
  );
}
