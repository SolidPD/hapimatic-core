// SPDX-License-Identifier: AGPL-3.0-only
import {
  useState,
  useRef,
  useEffect,
  useCallback,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { LinkedIssue } from "@hapi/protocol/types";
import { sanitizeSessionName } from "@hapi/protocol";
import type { ApiClient } from "@/api/client";
import type { RepoIssueItem } from "@/hooks/queries/useRepoIssues";
import { claimedIssueKey, type IssueClaimant } from "@/lib/claimedIssues";
import { FormField } from "./FormField";
import { Button } from "@/components/ui/button";

type LinkIssueFieldProps = {
  api: ApiClient | null;
  issues: RepoIssueItem[];
  repo: string | null;
  isLoading: boolean;
  /**
   * #2327: issue resolution FAILED (vs. this repo simply having none). Renders
   * a distinct placeholder so an empty picker is not read as "no issues".
   */
  unavailable?: boolean;
  isDisabled: boolean;
  linkedIssue: LinkedIssue | null;
  onLinkIssue: (issue: LinkedIssue | null) => void;
  onAutoPopulateName: (name: string) => void;
  /**
   * Issues already linked to a live session, keyed by `repo#number`
   * (see buildClaimedIssueIndex). When a dropdown row matches, it is marked
   * "claimed" and names the claimant. Informational only — non-blocking (#1899).
   */
  claimedIssues?: Map<string, IssueClaimant>;
};

export function LinkIssueField({
  api,
  issues,
  repo,
  isLoading,
  unavailable,
  isDisabled,
  linkedIssue,
  onLinkIssue,
  onAutoPopulateName,
  claimedIssues,
}: LinkIssueFieldProps) {
  const [query, setQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  // Exact-number fallback state. The prefetched list only carries the most
  // recent OPEN issues (gh issue list --state open --limit 200), so older or
  // closed issues are absent — resolve any typed number directly instead.
  const [directIssue, setDirectIssue] = useState<RepoIssueItem | null>(null);
  const [directLoading, setDirectLoading] = useState(false);
  const [directError, setDirectError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const fetchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fieldDisabled = isDisabled || !repo;

  const repoParts = repo ? repo.split("/") : [];
  const owner = repoParts[0] ?? "";
  const repoName = repoParts[1] ?? "";

  const trimmedQuery = query.trim();
  const numericQuery =
    trimmedQuery && /^#?\d+$/.test(trimmedQuery)
      ? parseInt(trimmedQuery.replace(/^#/, ""), 10)
      : null;

  const filtered = query.trim()
    ? issues.filter(issue => {
        const q = query.trim().toLowerCase();
        const numMatch = q.startsWith("#")
          ? String(issue.number).startsWith(q.slice(1))
          : String(issue.number).includes(q);
        const titleMatch = issue.title.toLowerCase().includes(q);
        return numMatch || titleMatch;
      })
    : issues;

  // Surface a directly-resolved issue (typed number absent from the prefetch)
  // at the top of the list, de-duped against any title match already shown.
  const displayItems =
    directIssue && !filtered.some(i => i.number === directIssue.number)
      ? [directIssue, ...filtered]
      : filtered;

  // Debounced exact-number lookup. Mirrors IssueInputModal's single-issue
  // fallback — hits GET /github/issues/:owner/:repo/:number (gh issue view),
  // which has no recency/state limit, so ANY issue (open or closed) is linkable.
  useEffect(() => {
    if (fetchTimeoutRef.current) {
      clearTimeout(fetchTimeoutRef.current);
      fetchTimeoutRef.current = null;
    }

    if (numericQuery == null || numericQuery <= 0) {
      setDirectIssue(null);
      setDirectError(null);
      setDirectLoading(false);
      return;
    }

    // Already in the prefetched list — the normal filter surfaces it.
    if (issues.some(i => i.number === numericQuery)) {
      setDirectIssue(null);
      setDirectError(null);
      setDirectLoading(false);
      return;
    }

    if (!api || !owner || !repoName) {
      setDirectIssue(null);
      setDirectError(null);
      setDirectLoading(false);
      return;
    }

    setDirectLoading(true);
    setDirectError(null);
    fetchTimeoutRef.current = setTimeout(async () => {
      try {
        const result = await api.getGitHubIssue(owner, repoName, numericQuery);
        if (result.success && result.issue) {
          setDirectIssue({
            number: result.issue.number,
            title: result.issue.title,
            labels: result.issue.labels.map(l => l.name),
            state: result.issue.state,
          });
          setDirectError(null);
        } else {
          setDirectIssue(null);
          setDirectError(result.error ?? `Issue #${numericQuery} not found`);
        }
      } catch (err) {
        setDirectIssue(null);
        setDirectError(
          err instanceof Error ? err.message : "Failed to fetch issue"
        );
      } finally {
        setDirectLoading(false);
      }
    }, 400);

    return () => {
      if (fetchTimeoutRef.current) {
        clearTimeout(fetchTimeoutRef.current);
        fetchTimeoutRef.current = null;
      }
    };
  }, [numericQuery, issues, api, owner, repoName]);

  const handleSelect = useCallback(
    (issue: RepoIssueItem) => {
      if (!repo) return;
      const linked: LinkedIssue = {
        number: issue.number,
        title: issue.title,
        repo,
        state: issue.state,
      };
      onLinkIssue(linked);

      // Store the FULL issue title (bounded only by sanitizeSessionName's
      // 100-char tmux limit). No 57-char + "..." pre-truncation: that baked a
      // literal ellipsis into the stored name, which defeated the session-list
      // FadeTruncate (its width-aware, fade-only truncation only fires on a
      // name that overflows its box at render time). Letting the fuller name
      // through lets FadeTruncate expand it to the available width and fade at
      // the account chip (operator request 2026-09-21).
      const raw = `#${issue.number} ${issue.title}`;
      onAutoPopulateName(sanitizeSessionName(raw.replace(/:/g, " -")));

      setQuery("");
      setIsOpen(false);
      setDirectIssue(null);
      setDirectError(null);
    },
    [repo, onLinkIssue, onAutoPopulateName]
  );

  const handleClear = useCallback(() => {
    onLinkIssue(null);
    setQuery("");
    setDirectIssue(null);
    setDirectError(null);
  }, [onLinkIssue]);

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (!isOpen || displayItems.length === 0) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex(i => (i >= displayItems.length - 1 ? 0 : i + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex(i => (i <= 0 ? displayItems.length - 1 : i - 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (selectedIndex >= 0 && selectedIndex < displayItems.length) {
          handleSelect(displayItems[selectedIndex]);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        setIsOpen(false);
        inputRef.current?.blur();
      }
    },
    [isOpen, displayItems, selectedIndex, handleSelect]
  );

  // Scroll selected item into view
  const scrollSelectedIntoView = useCallback((index: number) => {
    if (!listRef.current) return;
    const item = listRef.current.children[index] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, []);

  const gitHubIssuesUrl = repo ? `https://github.com/${repo}/issues` : null;

  // If an issue is already linked, show the badge
  if (linkedIssue) {
    return (
      <div className="px-3 py-1.5">
        <FormField
          label="Linked Issue"
          tooltip="The GitHub issue this session is working on. The link makes the issue this session's default for issue commands, marks it as claimed so other sessions don't pick it up, and auto-fills the session name."
        >
          {/* Inline clear: the × sits INSIDE the badge (Directory pattern). */}
          <div className="relative">
            <div className="flex h-9 min-w-0 overflow-hidden items-center gap-2 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2.5 pr-9 text-sm">
              <span className="text-[var(--app-link)] font-medium">
                #{linkedIssue.number}
              </span>
              <span className="text-[var(--app-fg)] truncate">
                {linkedIssue.title}
              </span>
            </div>
            {!isDisabled && (
              <Button
                type="button"
                variant="ghost"
                onClick={handleClear}
                className="absolute right-1.5 top-1/2 h-auto -translate-y-1/2 rounded p-1"
                title="Remove linked issue"
                aria-label="Remove linked issue"
              >
                <svg
                  className="h-3.5 w-3.5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </Button>
            )}
          </div>
        </FormField>
      </div>
    );
  }

  return (
    <div className="px-3 py-1.5">
      {/* No bookmarkId: a session's linked issue must never have a saved
          default — each session links its own issue (or none). */}
      <FormField
        label="Link Issue"
        tooltip="Link a GitHub issue to this session. The link makes the issue this session's default for issue commands, marks it as claimed so other sessions don't pick it up, and auto-fills the session name."
      >
        <div className="relative flex items-center gap-2">
          <div className="flex-1 relative">
            <input
              autoCapitalize="none"
              ref={inputRef}
              type="text"
              value={query}
              onChange={e => {
                setQuery(e.target.value);
                setIsOpen(true);
                setSelectedIndex(0);
              }}
              onFocus={() => {
                setIsOpen(true);
                setSelectedIndex(0);
                // Positioning on focus is owned by useKeyboardAwareFieldFocus
                // (container-level) — no per-field scrollIntoView here.
              }}
              onBlur={() => {
                // Delay to allow click on dropdown items
                setTimeout(() => setIsOpen(false), 200);
              }}
              onKeyDown={handleKeyDown}
              placeholder={
                // #3558: a failed repo LOOKUP (thrown request, node offline,
                // peer error) must not read as "not a git directory".
                !repo && unavailable
                  ? "Repo lookup failed — could not detect a repository"
                  : fieldDisabled
                    ? "Select a git directory first"
                    : isLoading
                      ? "Loading issues..."
                      : unavailable
                        ? "GitHub unavailable — could not load issues"
                        : "Search issues by # or title (optional)"
              }
              disabled={fieldDisabled}
              className={`h-9 w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2.5 text-sm text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)] disabled:opacity-50 ${
                query && !fieldDisabled ? "pr-8" : ""
              }`}
            />

            {/* Inline clear for typed search text (Directory pattern).
                mousedown is swallowed so the input keeps focus and the
                dropdown stays open for an immediate retype. */}
            {query && !fieldDisabled && (
              <Button
                type="button"
                variant="ghost"
                onMouseDown={e => e.preventDefault()}
                onClick={() => {
                  setQuery("");
                  setDirectIssue(null);
                  setDirectError(null);
                }}
                className="absolute right-1.5 top-1/2 h-auto -translate-y-1/2 rounded p-1"
                title="Clear issue search"
                aria-label="Clear issue search"
              >
                <svg
                  className="h-3.5 w-3.5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </Button>
            )}

            {isOpen &&
              !fieldDisabled &&
              (displayItems.length > 0 ||
                directLoading ||
                (query.trim() !== "" && !isLoading)) && (
                <div
                  ref={listRef}
                  className="absolute top-full left-0 right-0 z-30 mt-1 max-h-[200px] overflow-y-auto rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] shadow-lg"
                  style={{ touchAction: "pan-y" }}
                >
                  {displayItems.map((issue, index) => {
                    // Repo + number match (never number alone) using the
                    // picker's repo — keeps claims from leaking across repos.
                    const claimant = repo
                      ? claimedIssues?.get(claimedIssueKey(repo, issue.number))
                      : undefined;
                    const claimantLabel = claimant
                      ? `Claimed by ${claimant.emoji ? claimant.emoji + " " : ""}${claimant.title}${claimant.nodeLabel ? " · " + claimant.nodeLabel : ""}`
                      : undefined;
                    return (
                      <Button
                        key={issue.number}
                        type="button"
                        variant="ghost"
                        onMouseDown={e => e.preventDefault()}
                        onClick={() => handleSelect(issue)}
                        onMouseEnter={() => {
                          setSelectedIndex(index);
                          scrollSelectedIntoView(index);
                        }}
                        className={`flex h-auto w-full items-start justify-start gap-2 rounded-none px-3 py-2 text-left text-sm font-normal transition-colors ${
                          index === selectedIndex
                            ? "bg-[var(--app-hover)]"
                            : "hover:bg-[var(--app-hover)]"
                        }`}
                      >
                        <span className="text-[var(--app-link)] font-medium shrink-0">
                          #{issue.number}
                        </span>
                        <span className="text-[var(--app-fg)] truncate">
                          {issue.title}
                        </span>
                        {(claimant || issue.state === "closed") && (
                          <span className="ml-auto shrink-0 self-center flex items-center gap-1">
                            {claimant && (
                              <span
                                className="rounded border border-[var(--app-link)] px-1 py-0.5 text-[length:var(--text-caption-xs)] uppercase tracking-wide text-[var(--app-link)]"
                                title={claimantLabel}
                              >
                                claimed
                              </span>
                            )}
                            {issue.state === "closed" && (
                              <span className="rounded border border-[var(--app-border)] px-1 py-0.5 text-[length:var(--text-caption-xs)] uppercase tracking-wide text-[var(--app-hint)]">
                                closed
                              </span>
                            )}
                          </span>
                        )}
                      </Button>
                    );
                  })}

                  {directLoading && (
                    <div className="px-3 py-2 text-sm text-[var(--app-hint)]">
                      Looking up #{numericQuery}…
                    </div>
                  )}

                  {!directLoading &&
                    displayItems.length === 0 &&
                    query.trim() !== "" &&
                    !isLoading && (
                      <div className="px-3 py-2 text-sm text-[var(--app-hint)]">
                        {directError ?? "No matching issues"}
                      </div>
                    )}
                </div>
              )}
          </div>

          {gitHubIssuesUrl && (
            <a
              href={gitHubIssuesUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="p-2 rounded-md text-[var(--app-hint)] hover:text-[var(--app-link)] hover:bg-[var(--app-hover)] transition-colors"
              title="View issues on GitHub"
              aria-label="View issues on GitHub"
            >
              <svg
                className="w-4 h-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            </a>
          )}
        </div>
      </FormField>
    </div>
  );
}
