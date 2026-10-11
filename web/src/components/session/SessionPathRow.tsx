// SPDX-License-Identifier: AGPL-3.0-only
/**
 * SessionPathRow — the project-path row in a session's expanded detail block.
 *
 * Presentational primitive extracted from SessionList + SessionHeader (issue #1050).
 * Worktree sessions show a mint TreeIcon + a highlighted `/.worktrees` segment; plain
 * sessions show a FolderIcon. Clicking the path text triggers the container's `onCopy`.
 *
 * The container computes `isWorktree` / `displayPath` (preserving the original
 * `Boolean(metadata.worktree)` semantics) and owns the copy hook so the "Copied!" flash is
 * scoped to the right block. The click handler always calls `e.stopPropagation()` — a safe
 * no-op for SessionHeader (no parent navigation listener) and required for SessionList
 * (the row is click-to-navigate).
 *
 * Variant props (R6, max 3): `isWorktree` (1). `displayPath` is data; `pathCopied` is
 * container state; `onCopy` is a callback — none count toward the variant cap.
 */
import { FolderIcon, TreeIcon } from "@/components/icons";

type SessionPathRowProps = {
  isWorktree: boolean;
  displayPath: string | undefined;
  pathCopied: boolean;
  onCopy: () => void;
};

export function SessionPathRow({
  isWorktree,
  displayPath,
  pathCopied,
  onCopy,
}: SessionPathRowProps) {
  return (
    <div className="flex items-center gap-2 min-w-0">
      <span
        className={`flex h-3 w-3 items-center justify-center shrink-0 ${isWorktree ? "text-[var(--app-link)]" : "text-[var(--app-hint)]"}`}
      >
        {isWorktree ? (
          <TreeIcon className="h-3 w-3" />
        ) : (
          <FolderIcon className="h-3 w-3" />
        )}
      </span>
      {displayPath ? (
        <span
          className="truncate text-[length:var(--text-body-dense)] text-[var(--app-hint)] cursor-pointer hover:text-[var(--app-fg)] transition-colors"
          title="Click to copy project path"
          onClick={e => {
            e.stopPropagation();
            onCopy();
          }}
        >
          {pathCopied
            ? "Copied!"
            : isWorktree && displayPath.includes("/.worktrees")
              ? displayPath.split(/(\/\.worktrees)/).map((seg, i) =>
                  seg === "/.worktrees" ? (
                    <span key={i} className="text-[var(--app-link)]">
                      {seg}
                    </span>
                  ) : (
                    <span key={i}>{seg}</span>
                  )
                )
              : displayPath}
        </span>
      ) : (
        <span className="text-[length:var(--text-body-dense)] text-[var(--app-hint)] italic">
          No project path
        </span>
      )}
    </div>
  );
}
