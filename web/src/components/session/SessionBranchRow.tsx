// SPDX-License-Identifier: AGPL-3.0-only
/**
 * SessionBranchRow — the git-branch row in a session's expanded detail block.
 *
 * Extracted from SessionList + SessionHeader (issue #1050). The container resolves
 * `branchName` / `branchUrl` itself — including SessionList's `cachedBranch` fallback for
 * inactive sessions — and passes the resolved values in. This primitive does NOT call
 * `useBranchInfo`.
 *
 * Variant props (R6): the meaningful axes are `isDetached`, `branchUrl`-vs-null (link vs
 * plain text), and `isActive` ("Retrieving…" vs "failed") — 3. `branchName` / `branchError`
 * are data; `onLinkClick` is an optional callback (SessionList passes `e.stopPropagation()`;
 * SessionHeader passes none).
 */
import { GitBranchIcon } from "@/components/icons";

type SessionBranchRowProps = {
  branchName: string | null;
  branchUrl: string | null;
  isDetached: boolean;
  branchError: string | null | undefined;
  isActive: boolean;
  onLinkClick?: (e: React.MouseEvent) => void;
};

export function SessionBranchRow({
  branchName,
  branchUrl,
  isDetached,
  branchError,
  isActive,
  onLinkClick,
}: SessionBranchRowProps) {
  return (
    <div className="flex items-center gap-2 min-w-0 text-[length:var(--text-body-dense)]">
      <span className="flex h-3 w-3 items-center justify-center shrink-0 text-[var(--app-hint)]">
        <GitBranchIcon className="h-3 w-3" />
      </span>
      {isDetached ? (
        <span className="truncate text-[var(--app-hint)] italic">
          Detached HEAD
        </span>
      ) : branchName ? (
        branchUrl ? (
          <a
            href={branchUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={onLinkClick}
            className="truncate text-[var(--app-link)] hover:underline"
            title={`Open ${branchName} on GitHub`}
          >
            {branchName}
          </a>
        ) : (
          <span className="truncate text-[var(--app-hint)]">{branchName}</span>
        )
      ) : branchError?.toLowerCase().includes("not a git") ? (
        <span className="text-[var(--app-hint)] italic">No Git</span>
      ) : isActive ? (
        <span className="text-[var(--app-hint)] italic">
          Retrieving branch...
        </span>
      ) : (
        <span className="text-[var(--app-hint)] italic">
          Branch retrieval failed
        </span>
      )}
    </div>
  );
}
