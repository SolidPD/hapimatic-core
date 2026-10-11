// SPDX-License-Identifier: AGPL-3.0-only
import {
  useState,
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { ApiClient } from "@/api/client";

interface IssueInputModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (issue: {
    number: number;
    title: string;
    repo: string;
    state?: "open" | "closed";
  }) => void;
  defaultRepo: string;
  currentIssueNumber?: number;
  api: ApiClient | null;
}

interface GitHubIssue {
  number: number;
  title: string;
  state: "open" | "closed";
}

/**
 * Modal for linking a GitHub issue with autocomplete dropdown.
 * Fetches open issues for the repo and lets users search by number or title.
 * Falls back to single-issue lookup for manually typed numbers.
 */
export function IssueInputModal({
  isOpen,
  onClose,
  onSubmit,
  defaultRepo,
  currentIssueNumber,
  api,
}: IssueInputModalProps) {
  const [query, setQuery] = useState("");
  const [fetchedIssue, setFetchedIssue] = useState<GitHubIssue | null>(null);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [singleFetchLoading, setSingleFetchLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const fetchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Parse owner/repo with guard
  const parts = defaultRepo.split("/");
  const owner = parts[0] ?? "";
  const repo = parts[1] ?? "";

  // Fetch all open issues for the repo (cached by TanStack Query)
  const { data: allIssues = [], isLoading: issuesLoading } = useQuery({
    queryKey: ["repo-issues-by-name", defaultRepo],
    queryFn: async () => {
      if (!api || !defaultRepo || !owner || !repo) return [];
      const result = await api.listRepoIssuesByName(defaultRepo);
      if (!result.success) return [];
      return result.issues;
    },
    enabled: isOpen && Boolean(api) && Boolean(owner) && Boolean(repo),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  // Filter issues based on query
  const filtered = query.trim()
    ? allIssues.filter(issue => {
        const q = query.trim().toLowerCase();
        const numMatch = q.startsWith("#")
          ? String(issue.number).startsWith(q.slice(1))
          : String(issue.number).includes(q);
        const titleMatch = issue.title.toLowerCase().includes(q);
        return numMatch || titleMatch;
      })
    : allIssues;

  // Reset form when modal opens
  useEffect(() => {
    if (isOpen) {
      setQuery(currentIssueNumber?.toString() ?? "");
      setFetchedIssue(null);
      setError(null);
      setSingleFetchLoading(false);
      setIsDropdownOpen(false);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen, currentIssueNumber]);

  // Single-issue fallback fetch (when user types a number not in the dropdown)
  useEffect(() => {
    if (fetchTimeoutRef.current) {
      clearTimeout(fetchTimeoutRef.current);
    }

    const trimmed = query.trim();
    const num = parseInt(trimmed, 10);

    if (isNaN(num) || num <= 0 || trimmed !== String(num)) {
      // Not a pure number — clear single-fetch state
      setFetchedIssue(null);
      setError(null);
      setSingleFetchLoading(false);
      return;
    }

    // Check if this issue is already in the dropdown list
    const inList = allIssues.find(i => i.number === num);
    if (inList) {
      setFetchedIssue(prev =>
        prev?.number === num
          ? prev
          : { number: inList.number, title: inList.title, state: inList.state }
      );
      setError(null);
      setSingleFetchLoading(false);
      return;
    }

    if (!api || !owner || !repo) {
      setError("Not connected");
      return;
    }

    // Debounce single-issue lookup for numbers not in the list
    setSingleFetchLoading(true);
    setError(null);
    fetchTimeoutRef.current = setTimeout(async () => {
      try {
        const result = await api.getGitHubIssue(owner, repo, num);
        if (result.success && result.issue) {
          setFetchedIssue(result.issue);
          setError(null);
        } else {
          setFetchedIssue(null);
          setError(result.error ?? `Issue #${num} not found`);
        }
      } catch (err) {
        setFetchedIssue(null);
        setError(err instanceof Error ? err.message : "Failed to fetch issue");
      } finally {
        setSingleFetchLoading(false);
      }
    }, 500);

    return () => {
      if (fetchTimeoutRef.current) {
        clearTimeout(fetchTimeoutRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, api, owner, repo, allIssues]);

  const handleSelect = useCallback(
    (issue: { number: number; title: string; state: "open" | "closed" }) => {
      setQuery(String(issue.number));
      setFetchedIssue({
        number: issue.number,
        title: issue.title,
        state: issue.state,
      });
      setIsDropdownOpen(false);
      setError(null);
    },
    []
  );

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();

      if (!fetchedIssue) {
        setError("Please enter a valid issue number");
        return;
      }

      onSubmit({
        number: fetchedIssue.number,
        title: fetchedIssue.title,
        repo: defaultRepo,
        state: fetchedIssue.state,
      });
      onClose();
    },
    [fetchedIssue, onSubmit, onClose, defaultRepo]
  );

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (isDropdownOpen && filtered.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSelectedIndex(i => (i >= filtered.length - 1 ? 0 : i + 1));
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          setSelectedIndex(i => (i <= 0 ? filtered.length - 1 : i - 1));
        } else if (e.key === "Enter") {
          e.preventDefault();
          if (selectedIndex >= 0 && selectedIndex < filtered.length) {
            handleSelect(filtered[selectedIndex]);
          }
          return;
        } else if (e.key === "Escape") {
          e.preventDefault();
          setIsDropdownOpen(false);
          return;
        }
      }

      if (e.key === "Escape" && !isDropdownOpen) {
        onClose();
      }
    },
    [isDropdownOpen, filtered, selectedIndex, handleSelect, onClose]
  );

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current || !isDropdownOpen) return;
    const item = listRef.current.children[selectedIndex] as
      | HTMLElement
      | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, isDropdownOpen]);

  const canSubmit = fetchedIssue && !singleFetchLoading;
  const showDropdown = isDropdownOpen && !issuesLoading && filtered.length > 0;
  const showNoResults =
    isDropdownOpen &&
    !issuesLoading &&
    query.trim() !== "" &&
    filtered.length === 0 &&
    allIssues.length > 0;

  return (
    <Dialog open={isOpen} onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Link GitHub Issue</DialogTitle>
          <DialogDescription>
            Search issues from {defaultRepo}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div>
            <label
              htmlFor="issue-search"
              className="block text-sm font-medium text-[var(--app-fg)] mb-1"
            >
              Issue
            </label>
            <div className="relative">
              <input
                autoCapitalize="none"
                ref={inputRef}
                id="issue-search"
                type="text"
                inputMode="text"
                autoComplete="off"
                value={query}
                onChange={e => {
                  setQuery(e.target.value);
                  setIsDropdownOpen(true);
                  setSelectedIndex(0);
                  setFetchedIssue(null);
                }}
                onFocus={() => {
                  setIsDropdownOpen(true);
                  setSelectedIndex(0);
                }}
                onBlur={() => {
                  setTimeout(() => setIsDropdownOpen(false), 200);
                }}
                onKeyDown={handleKeyDown}
                placeholder={
                  issuesLoading ? "Loading issues..." : "Search by # or title"
                }
                className="w-full px-3 py-2 rounded-lg bg-[var(--app-bg)] border border-[var(--app-border)] text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)]"
                style={{ fontSize: "16px" }}
              />

              {showDropdown && (
                <div
                  ref={listRef}
                  className={
                    /* design-tokens-allow: 200px dropdown scroll-cap sentinel, off the spacing scale (L8 #3410) */ "absolute top-full left-0 right-0 z-10 mt-1 max-h-[200px] overflow-y-auto rounded-lg border border-[var(--app-border)] bg-[var(--app-secondary-bg)] shadow-lg"
                  }
                  style={{ touchAction: "pan-y" }}
                >
                  {filtered.map((issue, index) => (
                    <Button
                      key={issue.number}
                      type="button"
                      variant="ghost"
                      onMouseDown={e => e.preventDefault()}
                      onClick={() => handleSelect(issue)}
                      onMouseEnter={() => setSelectedIndex(index)}
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
                    </Button>
                  ))}
                </div>
              )}

              {showNoResults && (
                <div className="absolute top-full left-0 right-0 z-10 mt-1 rounded-lg border border-[var(--app-border)] bg-[var(--app-secondary-bg)] shadow-lg px-3 py-2 text-sm text-[var(--app-hint)]">
                  No matching issues
                </div>
              )}
            </div>
          </div>

          {/* Show single-fetch loading state */}
          {singleFetchLoading && (
            <p className="text-sm text-[var(--app-hint)]">
              Looking up issue...
            </p>
          )}

          {/* Show fetched issue preview */}
          {fetchedIssue && !singleFetchLoading && (
            <div className="p-3 rounded-lg bg-[var(--app-secondary-bg)] border border-[var(--app-border)]">
              <div className="flex items-center gap-2">
                <span
                  className={`text-xs px-1.5 py-0.5 rounded ${
                    fetchedIssue.state === "open"
                      ? "bg-green-500/20 text-green-400"
                      : "bg-purple-500/20 text-purple-400"
                  }`}
                >
                  {fetchedIssue.state}
                </span>
                <span className="text-sm font-medium text-[var(--app-fg)]">
                  #{fetchedIssue.number}
                </span>
              </div>
              <p className="mt-1 text-sm text-[var(--app-fg)] line-clamp-2">
                {fetchedIssue.title}
              </p>
            </div>
          )}

          {/* Show error */}
          {error && !singleFetchLoading && (
            <p className="text-sm text-[var(--app-badge-error-text)]">
              {error}
            </p>
          )}

          <div className="flex gap-2 justify-end pt-2">
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              className="h-auto rounded-lg px-4 py-2 text-sm font-normal text-[var(--app-hint)] hover:bg-[var(--app-bg)]"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!canSubmit}
              className="rounded-lg bg-[var(--app-link)] text-[var(--app-bg)] font-medium hover:opacity-100 hover:brightness-110 transition-all disabled:cursor-not-allowed disabled:opacity-50"
            >
              Link Issue
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
