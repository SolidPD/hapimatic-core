// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { FileSearchItem, GitFileStatus } from "@/types/api";
import { FileIcon } from "@/components/FileIcon";
import { GitBranchIcon } from "@/components/icons";
import { SegmentedToggle } from "@/components/ui/SegmentedToggle";
import { useAppContext } from "@/lib/app-context";
import { SessionOfflineBar } from "@/components/session/SessionOfflineBar";
import { useGitStatusFiles } from "@/extensions/git-rpc/hooks/useGitStatusFiles";
import { useSession } from "@/hooks/queries/useSession";
import { useSessionFileSearch } from "@/extensions/git-rpc/hooks/useSessionFileSearch";
import {
  getChangesAvailability,
  isChangesSelectable,
  readFilesView,
  shouldFallBackToBrowse,
  writeFilesView,
  type FilesView,
} from "@/lib/files-view";
import { queryKeys } from "@/lib/query-keys";
import { encodeBase64 } from "@/lib/utils";
import { ViewPicker } from "@/components/session/ViewPicker";
import { BrowseView } from "@/extensions/git-rpc/browse/BrowseView";
import { FileListSkeleton } from "@/extensions/git-rpc/browse/FileListSkeleton";
import { FolderIcon } from "@/extensions/git-rpc/browse/browseIcons";
import {
  friendlyRpcError,
  type BrowseSort,
} from "@/extensions/git-rpc/browse/browseModel";
import {
  readBrowsePrefs,
  writeBrowsePrefs,
  type BrowsePrefs,
  type SearchScope,
} from "@/extensions/git-rpc/browse/browsePrefs";
import {
  browseLocationSearch,
  useBrowseLocation,
} from "@/extensions/git-rpc/browse/useBrowseLocation";

// #6224: how long the search box waits before writing `q` to the URL. Local,
// not the search hook's debounce, because tests replace that module whole.
const URL_QUERY_WRITE_MS = 300;

const SCOPE_OPTIONS: { value: SearchScope; label: string }[] = [
  { value: "folder", label: "This folder" },
  { value: "everywhere", label: "Everywhere" },
];

function RefreshIcon(props: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.className}
    >
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <polyline points="21 3 21 9 15 9" />
    </svg>
  );
}

function SearchIcon(props: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.className}
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function StatusBadge(props: { status: GitFileStatus["status"] }) {
  const { label, color, title } = useMemo(() => {
    switch (props.status) {
      case "added":
        return { label: "A", color: "var(--app-git-staged-color)" };
      case "deleted":
        return { label: "D", color: "var(--app-git-deleted-color)" };
      case "renamed":
        return { label: "R", color: "var(--app-git-renamed-color)" };
      case "untracked":
        return { label: "?", color: "var(--app-git-untracked-color)" };
      case "conflicted":
        return { label: "U", color: "var(--app-git-deleted-color)" };
      // #6224: a status line the parser could not read.
      case "unknown":
        return {
          label: "?",
          color: "var(--app-hint)",
          title: "Git reported a change this app could not read",
        };
      default:
        return { label: "M", color: "var(--app-git-unstaged-color)" };
    }
  }, [props.status]);

  return (
    <span
      className="inline-flex items-center justify-center rounded border px-1.5 py-0.5 text-[10px] font-semibold"
      style={{ color, borderColor: color }}
      title={title}
    >
      {label}
    </span>
  );
}

function LineChanges(props: { added: number; removed: number }) {
  if (!props.added && !props.removed) return null;

  return (
    <span className="flex items-center gap-1 text-[11px] font-mono">
      {props.added ? (
        <span className="text-[var(--app-diff-added-text)]">
          +{props.added}
        </span>
      ) : null}
      {props.removed ? (
        <span className="text-[var(--app-diff-removed-text)]">
          -{props.removed}
        </span>
      ) : null}
    </span>
  );
}

function GitFileRow(props: {
  file: GitFileStatus;
  /** Absent for an entry that cannot be opened (an unreadable status line). */
  onOpen?: () => void;
  showDivider: boolean;
}) {
  const subtitle = props.file.filePath || "project root";

  return (
    <button
      type="button"
      onClick={props.onOpen}
      disabled={!props.onOpen}
      className={`flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-[var(--app-subtle-bg)] transition-colors disabled:cursor-default disabled:hover:bg-transparent ${props.showDivider ? "border-b border-[var(--app-divider)]" : ""}`}
    >
      {props.file.isDirectory ? (
        <FolderIcon className="text-[var(--app-link)]" />
      ) : (
        <FileIcon fileName={props.file.fileName} size={22} />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{props.file.fileName}</div>
        <div className="truncate text-xs text-[var(--app-hint)]">
          {subtitle}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <LineChanges
          added={props.file.linesAdded}
          removed={props.file.linesRemoved}
        />
        <StatusBadge status={props.file.status} />
      </div>
    </button>
  );
}

function SearchResultRow(props: {
  file: FileSearchItem;
  onOpen: () => void;
  showDivider: boolean;
}) {
  const subtitle = props.file.filePath || "project root";
  const icon =
    props.file.fileType === "file" ? (
      <FileIcon fileName={props.file.fileName} size={22} />
    ) : (
      <FolderIcon className="text-[var(--app-link)]" />
    );

  return (
    <button
      type="button"
      onClick={props.onOpen}
      className={`flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-[var(--app-subtle-bg)] transition-colors ${props.showDivider ? "border-b border-[var(--app-divider)]" : ""}`}
    >
      {icon}
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{props.file.fileName}</div>
        <div className="truncate text-xs text-[var(--app-hint)]">
          {subtitle}
        </div>
      </div>
    </button>
  );
}

// #6222: tree-wide file search results, shown over either view.
// #6224: says when it is waiting for the network, when the list was cut short,
// and which files a search never looks at.
function FileSearchResults(props: {
  isLoading: boolean;
  isPaused: boolean;
  /** The files are an earlier query's results while the new one runs. */
  isStale: boolean;
  error: string | null;
  files: FileSearchItem[];
  truncated: boolean;
  hidden: boolean;
  onOpenFile: (fullPath: string) => void;
}) {
  // Paused wins over kept-up results, which belong to the previous query. The
  // hook does not report paused for an offline Refresh of the current query,
  // so its results stay up.
  if (props.isPaused) {
    return (
      <div className="p-6 text-sm text-[var(--app-hint)]" role="status">
        Waiting for network…
      </div>
    );
  }
  if (props.isLoading || (props.isStale && props.files.length === 0)) {
    return <FileListSkeleton label="Loading files…" />;
  }
  if (props.error) {
    return (
      <div className="p-6 text-sm text-[var(--app-hint)]">
        {friendlyRpcError(props.error)}
      </div>
    );
  }
  const notSearched = props.hidden
    ? "Git-ignored files are not searched."
    : "Hidden and Git-ignored files are not searched.";
  if (props.files.length === 0) {
    return (
      <div className="p-6 text-sm text-[var(--app-hint)]">
        <p>No files match your search.</p>
        <p className="mt-1 text-xs">{notSearched}</p>
      </div>
    );
  }
  return (
    <div className="border-t border-[var(--app-divider)]">
      {props.isStale ? (
        <div
          role="status"
          className="px-3 py-1.5 text-xs text-[var(--app-hint)]"
        >
          Searching…
        </div>
      ) : null}
      <div className={props.isStale ? "opacity-60" : undefined}>
        {props.files.map((file, index) => (
          <SearchResultRow
            key={`${file.fullPath}-${index}`}
            file={file}
            onOpen={() => props.onOpenFile(file.fullPath)}
            showDivider={index < props.files.length - 1}
          />
        ))}
      </div>
      {props.truncated && !props.isStale ? (
        <div className="border-t border-[var(--app-divider)] px-3 py-2 text-xs text-[var(--app-hint)]">
          Showing the first {props.files.length} matches. Type more to narrow
          the search.
        </div>
      ) : null}
    </div>
  );
}

export default function FilesPage() {
  const { sessionId } = useParams({ from: "/sessions/$sessionId/files" });
  // #6222: this route stays mounted when only sessionId changes (no remountDeps),
  // so key by session to keep one session's view, search and folder out of another.
  return <FilesPageContent key={sessionId} sessionId={sessionId} />;
}

function FilesPageContent(props: { sessionId: string }) {
  const { sessionId } = props;
  const { api } = useAppContext();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { session, loadFailure: sessionLoadFailure } = useSession(
    api,
    sessionId,
    true // Active session polling
  );
  // #6224: the folder and search come from the URL, so Back from the viewer
  // returns to them. The page keeps its own copy of each, because the URL
  // follows a navigation a moment later and typing must not wait on it.
  const { urlDir, urlQuery, pushDir, replaceQuery } =
    useBrowseLocation(sessionId);
  const [browsePath, setBrowsePath] = useState(urlDir);
  const [syncedUrlDir, setSyncedUrlDir] = useState(urlDir);
  const [searchQuery, setSearchQuery] = useState(urlQuery);
  // The browser's Back and Forward step between folders by changing the URL.
  if (urlDir !== syncedUrlDir) {
    setSyncedUrlDir(urlDir);
    setBrowsePath(urlDir);
    setSearchQuery(urlQuery);
  }
  const [prefs, setPrefs] = useState<BrowsePrefs>(readBrowsePrefs);
  useEffect(() => {
    writeBrowsePrefs(prefs);
  }, [prefs]);
  // #6222: the view the user last chose for this session. What the tab shows is
  // derived from it below, because Changes can be unavailable.
  const [chosenView, setChosenView] = useState<FilesView>(() =>
    readFilesView(sessionId)
  );
  const [fellBackToBrowse, setFellBackToBrowse] = useState(false);

  // Epic #3285 correction pass 1: every Files view rides session RPC handlers that
  // exist ONLY while the CLI process is alive. Gate the RPCs on an ACTIVE session
  // so an offline session shows the slim offline bar instead of raw
  // "RPC handler not registered" errors (the View Picker also greys the tab, but
  // the route stays reachable by URL / persisted-view redirect).
  const sessionActive = session?.active === true;

  const {
    status: gitStatus,
    error: gitError,
    isSettled: gitIdle,
    refetch: refetchGit,
  } = useGitStatusFiles(api, sessionId, { enabled: sessionActive });

  // A disabled query is idle with no status and no error, which reads as unknown and
  // would make Changes tappable, so Git status has settled only once the session is
  // known active.
  const gitSettled = sessionActive && gitIdle;
  const changesAvailability = getChangesAvailability(gitStatus, gitError);

  // The remembered view decides where the tab opens. A fallback to Browse holds for
  // this visit, so a Refresh or file operation that creates changes never pulls the
  // user out of the folder they are in; the next open returns to Changes.
  if (
    !fellBackToBrowse &&
    shouldFallBackToBrowse(chosenView, changesAvailability, gitSettled)
  ) {
    setFellBackToBrowse(true);
  }
  const viewMode: FilesView = fellBackToBrowse ? "browse" : chosenView;
  const changesDisabled =
    viewMode !== "changes" &&
    !isChangesSelectable(changesAvailability, gitSettled);
  // A cached list of changes stays up during a background refetch. Anything else
  // waits, so a stale "no changes" never renders as an empty Changes view while a
  // fetch is pending. After a failed refetch it shows under the error banner.
  const changesLoading = !gitSettled && changesAvailability !== "available";

  // Saved only on a tap, never by a fallback to Browse, so the tab reopens on
  // Changes when the repo has changes again.
  const chooseView = useCallback(
    (view: FilesView) => {
      setChosenView(view);
      setFellBackToBrowse(false);
      writeFilesView(sessionId, view);
    },
    [sessionId]
  );

  // #6224: in Browse the search box filters the folder ("This folder") or
  // searches the whole session folder ("Everywhere"); Changes has no folder, so
  // there it always searches everywhere.
  const hasQuery = searchQuery.trim() !== "";
  const treeSearch = viewMode === "changes" || prefs.scope === "everywhere";
  const showTreeResults = treeSearch && hasQuery;
  const folderFilter =
    viewMode === "browse" && prefs.scope === "folder" ? searchQuery : "";

  const searchResults = useSessionFileSearch(api, sessionId, searchQuery, {
    enabled: sessionActive && treeSearch && hasQuery,
    hidden: prefs.showHidden,
  });

  // #6224: `q` follows the typing after a pause, replacing the history entry.
  useEffect(() => {
    if (searchQuery.trim() === urlQuery) return;
    const timer = setTimeout(
      () => replaceQuery(searchQuery),
      URL_QUERY_WRITE_MS
    );
    return () => clearTimeout(timer);
  }, [searchQuery, urlQuery, replaceQuery]);

  // Read at tap time, so opening a file stays one stable callback while the
  // user types (BrowseView is memoized on its props).
  const locationRef = useRef({ browsePath, searchQuery });
  useEffect(() => {
    locationRef.current = { browsePath, searchQuery };
  }, [browsePath, searchQuery]);

  const handleOpenFile = useCallback(
    (path: string, staged?: boolean) => {
      const { browsePath: dir, searchQuery: query } = locationRef.current;
      navigate({
        to: "/sessions/$sessionId/file",
        params: { sessionId },
        search: {
          path: encodeBase64(path),
          ...(staged === undefined ? {} : { staged }),
          ...browseLocationSearch(dir, query),
        },
      });
    },
    [navigate, sessionId]
  );

  // Entering a folder clears the folder filter, which was for the folder left.
  const handleNavigate = useCallback(
    (path: string) => {
      setBrowsePath(path);
      setSearchQuery("");
      pushDir(path);
    },
    [pushDir]
  );
  const handleOpenBrowseFile = useCallback(
    (path: string) => handleOpenFile(path),
    [handleOpenFile]
  );
  const handleSortChange = useCallback(
    (sort: BrowseSort) => setPrefs(prev => ({ ...prev, sort })),
    []
  );
  const handleShowHiddenChange = useCallback(
    (showHidden: boolean) => setPrefs(prev => ({ ...prev, showHidden })),
    []
  );
  const handleScopeChange = useCallback(
    (scope: SearchScope) => setPrefs(prev => ({ ...prev, scope })),
    []
  );

  // #6224 (R20): when the agent's turn ends, what it wrote shows up without a
  // Refresh. The session record is polled every 5 s while active.
  const thinking = session?.thinking === true;
  const wasThinking = useRef(thinking);
  useEffect(() => {
    if (wasThinking.current && !thinking && sessionActive) {
      void refetchGit();
      void queryClient.invalidateQueries({
        queryKey: queryKeys.sessionDirectories(sessionId),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.sessionFileSearches(sessionId),
      });
    }
    wasThinking.current = thinking;
  }, [thinking, sessionActive, refetchGit, queryClient, sessionId]);

  // A folder in Changes (a nested repository) opens in Browse for this visit,
  // like the fallback, so the remembered view stays Changes.
  const handleOpenGitEntry = useCallback(
    (file: GitFileStatus) => {
      if (file.isDirectory) {
        setFellBackToBrowse(true);
        handleNavigate(file.fullPath);
        return;
      }
      handleOpenFile(file.fullPath, file.isStaged);
    },
    [handleNavigate, handleOpenFile]
  );
  const gitEntryOpener = (file: GitFileStatus) =>
    file.status === "unknown" ? undefined : () => handleOpenGitEntry(file);

  const branchLabel = gitStatus?.branch ?? "detached";
  const showGitErrorBanner = Boolean(gitError);

  // Offline session: the tab row + the slim offline bar, nothing that would fire
  // an RPC (BrowseView's directory query included). Hooks above already ran, so
  // this early return is safe.
  if (session && !sessionActive) {
    return (
      <div className="flex h-full flex-col">
        <ViewPicker session={session} api={api} activeView="files" />
        <SessionOfflineBar message="Session is offline. Files are unavailable." />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* #3286 (View Picker) + epic #3285 correction pass 1: the tab row IS the
          top of this view — the old Back / "Files" / path header is gone (the
          Chat tab returns to the transcript). Mounted once the session record is
          loaded (this page renders before session resolves, so guard it — no
          picker flash of the wrong active tab). */}
      {session ? (
        <ViewPicker session={session} api={api} activeView="files" />
      ) : null}

      <div className="bg-[var(--app-bg)]">
        <div className="mx-auto w-full max-w-content px-3 pt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => chooseView("changes")}
            disabled={changesDisabled}
            title={
              changesDisabled && changesAvailability === "unavailable"
                ? "No Git changes to show"
                : undefined
            }
            className={`rounded px-3 py-1 text-xs font-semibold ${viewMode === "changes" ? "bg-[var(--app-button)] text-[var(--app-button-text)] opacity-80" : "bg-[var(--app-subtle-bg)] text-[var(--app-hint)]"} ${changesDisabled ? "cursor-not-allowed opacity-30" : ""}`}
          >
            Changes
          </button>
          <button
            type="button"
            onClick={() => chooseView("browse")}
            className={`rounded px-3 py-1 text-xs font-semibold ${viewMode === "browse" ? "bg-[var(--app-button)] text-[var(--app-button-text)] opacity-80" : "bg-[var(--app-subtle-bg)] text-[var(--app-hint)]"}`}
          >
            Browse
          </button>
          {/* Refresh moved here from the removed page header (correction pass 1). */}
          <button
            type="button"
            onClick={() => {
              void refetchGit();
              void queryClient.invalidateQueries({
                queryKey: queryKeys.sessionDirectories(sessionId),
              });
              if (showTreeResults) void searchResults.refetch();
            }}
            className="ml-auto flex h-7 w-7 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
            title="Refresh"
            aria-label="Refresh"
          >
            <RefreshIcon />
          </button>
        </div>
      </div>

      <div className="bg-[var(--app-bg)]">
        <div className="mx-auto w-full max-w-content p-3 border-b border-[var(--app-border)]">
          <div className="flex items-center gap-2 rounded-md bg-[var(--app-subtle-bg)] px-3 py-2">
            <SearchIcon className="text-[var(--app-hint)]" />
            <input
              value={searchQuery}
              onChange={event => setSearchQuery(event.target.value)}
              placeholder="Search files"
              aria-label="Search files"
              className="w-full bg-transparent text-sm text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none"
              autoCapitalize="none"
              autoCorrect="off"
            />
          </div>
          {viewMode === "browse" ? (
            <SegmentedToggle
              ariaLabel="Search in"
              options={SCOPE_OPTIONS}
              value={prefs.scope}
              onChange={handleScopeChange}
              testIdPrefix="files-search-scope"
              className="mt-2"
            />
          ) : null}
        </div>
      </div>

      {viewMode === "changes" && !changesLoading && gitStatus ? (
        <div className="bg-[var(--app-bg)]">
          <div className="mx-auto w-full max-w-content px-3 py-2 border-b border-[var(--app-divider)]">
            <div className="flex items-center gap-2 text-sm">
              <GitBranchIcon className="h-4 w-4 text-[var(--app-hint)]" />
              <span className="font-semibold">{branchLabel}</span>
            </div>
            <div className="text-xs text-[var(--app-hint)]">
              {gitStatus.totalStaged} staged, {gitStatus.totalUnstaged} unstaged
            </div>
          </div>
        </div>
      ) : null}

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-content">
          {!session ? (
            // #6222: BrowseView's query is gated only on the API client, so it
            // mounts only once the session is known to be active. The early
            // return above covers an offline session.
            sessionLoadFailure ? (
              <div className="p-6 text-sm text-[var(--app-hint)]">
                This session could not be loaded.
              </div>
            ) : (
              <FileListSkeleton label="Loading session…" />
            )
          ) : (
            <>
              {showTreeResults ? (
                <FileSearchResults
                  isLoading={searchResults.isLoading}
                  isPaused={searchResults.isPaused === true}
                  isStale={searchResults.isStale === true}
                  error={searchResults.error}
                  files={searchResults.files}
                  truncated={searchResults.truncated === true}
                  hidden={prefs.showHidden}
                  onOpenFile={handleOpenBrowseFile}
                />
              ) : null}
              {viewMode === "browse" ? (
                // Stays mounted under a search, so clearing it returns to the
                // same folder.
                <div className={showTreeResults ? "hidden" : undefined}>
                  <BrowseView
                    sessionId={sessionId}
                    path={browsePath}
                    sessionRoot={session.metadata?.path ?? ""}
                    filter={folderFilter}
                    sort={prefs.sort}
                    showHidden={prefs.showHidden}
                    onNavigate={handleNavigate}
                    onOpenFile={handleOpenBrowseFile}
                    onSortChange={handleSortChange}
                    onShowHiddenChange={handleShowHiddenChange}
                  />
                </div>
              ) : showTreeResults ? null : (
                <>
                  {showGitErrorBanner ? (
                    <div className="border-b border-[var(--app-divider)] bg-amber-500/10 px-3 py-2 text-xs text-[var(--app-hint)]">
                      {friendlyRpcError(gitError ?? "")}
                    </div>
                  ) : null}
                  {changesLoading ? (
                    <FileListSkeleton label="Loading Git status…" />
                  ) : (
                    <div>
                      {gitStatus?.stagedFiles.length ? (
                        <div>
                          <div className="border-b border-[var(--app-divider)] bg-[var(--app-bg)] px-3 py-2 text-xs font-semibold text-[var(--app-git-staged-color)]">
                            Staged Changes ({gitStatus.stagedFiles.length})
                          </div>
                          {gitStatus.stagedFiles.map((file, index) => (
                            <GitFileRow
                              key={`staged-${file.fullPath}-${index}`}
                              file={file}
                              onOpen={gitEntryOpener(file)}
                              showDivider={
                                index < gitStatus.stagedFiles.length - 1 ||
                                gitStatus.unstagedFiles.length > 0
                              }
                            />
                          ))}
                        </div>
                      ) : null}

                      {gitStatus?.unstagedFiles.length ? (
                        <div>
                          <div className="border-b border-[var(--app-divider)] bg-[var(--app-bg)] px-3 py-2 text-xs font-semibold text-[var(--app-git-unstaged-color)]">
                            Unstaged Changes ({gitStatus.unstagedFiles.length})
                          </div>
                          {gitStatus.unstagedFiles.map((file, index) => (
                            <GitFileRow
                              key={`unstaged-${file.fullPath}-${index}`}
                              file={file}
                              onOpen={gitEntryOpener(file)}
                              showDivider={
                                index < gitStatus.unstagedFiles.length - 1
                              }
                            />
                          ))}
                        </div>
                      ) : null}
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
