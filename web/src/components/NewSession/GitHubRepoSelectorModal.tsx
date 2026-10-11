// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo, useState } from "react";
import { PickerModal } from "./PickerModal";
import { Button } from "@/components/ui/button";
import type { GitHubRepo } from "@/hooks/queries/useGitHubRepos";

/**
 * Issue #2019 — GitHub repository selection modal for the Create form.
 *
 * Selection-only: the parent owns the repo query and the derived `cloneRepo`
 * state; this modal renders a searchable list, emits `onSelect(repo | null)`,
 * and closes immediately. It performs NO network mutation.
 *
 * Built on the shared `PickerModal` shell so it has byte-identical proportions
 * and behavior to the directory browser (portaled, 80% visual-viewport height,
 * sticky header/footer, internal scroll) — fixes the prior radix-Dialog modal
 * that overflowed the screen top/bottom and ran off the right edge on iOS.
 */
export function GitHubRepoSelectorModal(props: {
  isOpen: boolean;
  onClose: () => void;
  repos: GitHubRepo[];
  /** Selected repo `nameWithOwner`, or null when none chosen. */
  selectedRepo: string | null;
  isLoading?: boolean;
  /** Fired with the chosen repo (or null for "no clone"); the modal then closes. */
  onSelect: (repo: GitHubRepo | null) => void;
}) {
  const { isOpen, onClose, repos, selectedRepo, isLoading, onSelect } = props;
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return repos;
    return repos.filter(r => r.nameWithOwner.toLowerCase().includes(q));
  }, [repos, query]);

  const handleSelect = (repo: GitHubRepo | null) => {
    onSelect(repo);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <PickerModal
      title="Select Repository"
      description="Choose a repository to clone into the working directory on spawn."
      onClose={onClose}
      search={
        <input
          type="text"
          value={query}
          placeholder="Search repositories…"
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          aria-label="Search repositories"
          onChange={e => setQuery(e.target.value)}
          className="h-9 w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2.5 text-sm text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)]"
        />
      }
      footer={
        <Button
          type="button"
          variant="ghost"
          onClick={onClose}
          className="h-auto rounded-md px-4 py-2 text-sm font-normal text-[var(--app-fg)] transition-colors hover:bg-[var(--app-hover)]"
        >
          Cancel
        </Button>
      }
    >
      <div className="flex flex-col gap-1 p-2">
        {/* "None" — clears any clone selection */}
        <Button
          type="button"
          variant="ghost"
          onClick={() => handleSelect(null)}
          className={`flex h-auto w-full items-center justify-start rounded-md border px-3 py-2 text-left text-sm font-normal transition-colors hover:bg-[var(--app-hover)] ${
            selectedRepo === null
              ? "border-[var(--app-link)] bg-[var(--app-link)]/10"
              : "border-[var(--app-border)]"
          }`}
        >
          <span className="text-[var(--app-hint)]">None (no clone)</span>
        </Button>

        {isLoading ? (
          <div className="p-4 text-center text-sm text-[var(--app-hint)]">
            Loading repositories…
          </div>
        ) : repos.length === 0 ? (
          <div className="p-4 text-center text-sm text-[var(--app-hint)]">
            No repositories
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-4 text-center text-sm text-[var(--app-hint)]">
            No repositories match “{query}”
          </div>
        ) : (
          filtered.map(repo => (
            <Button
              key={repo.nameWithOwner}
              type="button"
              variant="ghost"
              onClick={() => handleSelect(repo)}
              title={repo.nameWithOwner}
              className={`flex h-auto w-full flex-col items-start justify-start gap-0.5 rounded-md border px-3 py-2 text-left font-normal transition-colors hover:bg-[var(--app-hover)] ${
                selectedRepo === repo.nameWithOwner
                  ? "border-[var(--app-link)] bg-[var(--app-link)]/10"
                  : "border-[var(--app-border)]"
              }`}
            >
              <span className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm text-[var(--app-fg)]">
                  {repo.nameWithOwner}
                </span>
                {repo.isPrivate && (
                  <span className="shrink-0 rounded-full bg-[var(--app-link)]/10 px-1.5 py-0.5 text-[length:var(--text-caption-xs)] font-medium text-[var(--app-link)]">
                    Private
                  </span>
                )}
              </span>
              {repo.description && (
                <span className="truncate text-xs text-[var(--app-hint)]">
                  {repo.description}
                </span>
              )}
            </Button>
          ))
        )}
      </div>
    </PickerModal>
  );
}
