// SPDX-License-Identifier: AGPL-3.0-only
/**
 * SessionRepoRow — the GitHub-repo row of the expanded session details (issue
 * #4538). Sits between the path row and the branch row and mirrors
 * `SessionBranchRow`'s layout: a 12px icon cell, then dense body text.
 *
 * Three states, all derived from the session's `repoIdentity` metadata
 * (`shared/src/schemas.ts` `RepoIdentitySchema` — `name` is `owner/repo`,
 * `url` is optional):
 *   - name + url  → a mint hotlink to the repo, opened in a new tab (the same
 *                   `target="_blank"` the branch link uses — on the iOS PWA that
 *                   is the system browser). This replaces the GitHub button the
 *                   project header used to carry (#4538 R2).
 *   - name only   → plain hint text (a remote that is not on GitHub)
 *   - neither     → italic "No GitHub repo"
 */
import { GitHubIcon } from "@/components/icons";

type SessionRepoRowProps = {
  /** `repoIdentity.name` — `owner/repo`; null when the session has no repo. */
  repoName: string | null;
  /** `repoIdentity.url` — the web URL; null when unknown / not GitHub. */
  repoUrl: string | null;
  /** Stops the click from toggling / navigating the enclosing card. */
  onLinkClick?: (e: React.MouseEvent) => void;
};

export function SessionRepoRow({
  repoName,
  repoUrl,
  onLinkClick,
}: SessionRepoRowProps) {
  return (
    <div
      className="flex items-center gap-2 min-w-0 text-[length:var(--text-body-dense)]"
      data-testid="session-repo-row"
    >
      <span className="flex h-3 w-3 items-center justify-center shrink-0 text-[var(--app-hint)]">
        <GitHubIcon className="h-3 w-3" />
      </span>
      {repoName ? (
        repoUrl ? (
          <a
            href={repoUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={onLinkClick}
            className="truncate text-[var(--app-link)] hover:underline"
            title={`Open ${repoName} on GitHub`}
          >
            {repoName}
          </a>
        ) : (
          <span className="truncate text-[var(--app-hint)]">{repoName}</span>
        )
      ) : (
        <span className="text-[var(--app-hint)] italic">No GitHub repo</span>
      )}
    </div>
  );
}
