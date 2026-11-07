// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useMemo, useState } from "react";
import { PickerModal } from "./PickerModal";
import { Button } from "@/components/ui/button";
import type { GitHubRepo } from "@/hooks/queries/useGitHubRepos";
import { OwnerChipRow, RepoFilterControls } from "./RepoFilterBar";
import {
  clearOtherFilters,
  deriveRepoView,
  effectiveFilters,
  formatCount,
  isDefaultOtherFilters,
  readRepoFilters,
  reportedFields,
  writeRepoFilters,
  type RepoFilters,
} from "./repoFilters";

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
 *
 * Issue #6326 — owner chips, visibility, hide forks, archived (hidden by default) and a sort,
 * remembered between visits (`repoFilters.ts`). The search applies within the filters, and a
 * search match the filters hide is counted in a hint line with a one-tap reveal (a match hidden
 * by both a filter and the archived rule takes two taps: Clear filters, then Show archived), so
 * a remembered filter does not make a repository look missing (the #6312 symptom).
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
  /** #6326: the server stopped at its repository cap, so `repos` is not the whole set. */
  truncated?: boolean;
}) {
  const { isOpen, onClose, repos, selectedRepo, isLoading, onSelect } = props;
  const [query, setQuery] = useState("");
  // #6326: the remembered settings. Only user actions change them; what is APPLIED to this
  // list is derived (`effectiveFilters`) and never written back, so an account switch or a
  // list still loading cannot erase the remembered owner.
  const [stored, setStored] = useState<RepoFilters>(readRepoFilters);
  useEffect(() => writeRepoFilters(stored), [stored]);
  const reported = useMemo(() => reportedFields(repos), [repos]);
  const filters = useMemo(
    () => effectiveFilters(stored, repos, reported),
    [stored, repos, reported]
  );
  const view = useMemo(
    () => deriveRepoView(repos, filters, query),
    [repos, filters, query]
  );
  const update = (patch: Partial<RepoFilters>) =>
    setStored(prev => ({ ...prev, ...patch }));
  const clearOther = () => setStored(prev => clearOtherFilters(prev));
  const showArchived = () => update({ showArchived: true });
  const hasQuery = query.trim() !== "";

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
        <>
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
          {repos.length > 0 && (
            <OwnerChipRow
              chips={view.ownerChips}
              allCount={view.allCount}
              selected={filters.owner}
              onSelect={owner => update({ owner })}
            />
          )}
        </>
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
        {repos.length > 0 && (
          <RepoFilterControls
            filters={filters}
            reported={reported}
            countText={formatCount(
              view.rows.length,
              repos.length,
              props.truncated === true
            )}
            countTitle={
              props.truncated
                ? "Only the most recently pushed repositories are loaded; filters and sorting apply to those."
                : undefined
            }
            showClear={!isDefaultOtherFilters(filters)}
            onChange={update}
            onClearOther={clearOther}
          />
        )}

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
        ) : view.rows.length === 0 && !hasQuery ? (
          <div className="flex flex-col items-center gap-1 p-4 text-center text-sm text-[var(--app-hint)]">
            No repositories match these filters
            {!isDefaultOtherFilters(filters) && (
              <Button
                type="button"
                variant="ghostStatic"
                size="bare"
                onClick={clearOther}
                className="text-sm text-[var(--app-link)] hover:underline"
              >
                Clear filters
              </Button>
            )}
          </div>
        ) : view.rows.length === 0 ? (
          <div className="p-4 text-center text-sm text-[var(--app-hint)]">
            No repositories match “{query}”
          </div>
        ) : (
          view.rows.map(repo => (
            // items-stretch, not items-start: each line must take the row's width so `truncate`
            // ellipsizes and the Private badge stays in view on a long name (#6326, 393 px).
            <Button
              key={repo.nameWithOwner}
              type="button"
              variant="ghost"
              onClick={() => handleSelect(repo)}
              title={repo.nameWithOwner}
              className={`flex h-auto w-full flex-col items-stretch justify-start gap-0.5 rounded-md border px-3 py-2 text-left font-normal transition-colors hover:bg-[var(--app-hover)] ${
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

        {/* #6326: a search the filters hide is said out loud, with a one-tap way back. */}
        {!isLoading && hasQuery && view.hiddenByFilters > 0 && (
          <div className="flex flex-wrap items-center justify-center gap-1.5 px-3 py-2 text-xs text-[var(--app-hint)]">
            <span>{view.hiddenByFilters} more match with filters off</span>
            <Button
              type="button"
              variant="ghostStatic"
              size="bare"
              onClick={clearOther}
              className="text-xs text-[var(--app-link)] hover:underline"
            >
              Clear filters
            </Button>
          </div>
        )}
        {!isLoading &&
          hasQuery &&
          reported.archived &&
          view.hiddenArchived > 0 && (
            <div className="flex flex-wrap items-center justify-center gap-1.5 px-3 py-2 text-xs text-[var(--app-hint)]">
              <span>
                {view.hiddenArchived} archived{" "}
                {view.hiddenArchived === 1 ? "match" : "matches"}
              </span>
              <Button
                type="button"
                variant="ghostStatic"
                size="bare"
                onClick={showArchived}
                className="text-xs text-[var(--app-link)] hover:underline"
              >
                Show archived
              </Button>
            </div>
          )}
      </div>
    </PickerModal>
  );
}
