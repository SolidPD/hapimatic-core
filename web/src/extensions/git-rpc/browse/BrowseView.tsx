// SPDX-License-Identifier: AGPL-3.0-only
import { memo, useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { DirectoryEntry } from "@/types/api";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { useAppContext } from "@/lib/app-context";
import { queryKeys } from "@/lib/query-keys";
import { FileListSkeleton } from "./FileListSkeleton";
import { Breadcrumbs } from "./Breadcrumbs";
import { BrowseRow, type RowActionKind } from "./BrowseRow";
import { BrowseColumnHeaders, BrowseViewMenu } from "./BrowseToolbar";
import { FolderPlusIcon } from "./browseIcons";
import {
  absolutePath,
  baseName,
  friendlyRpcError,
  joinBrowsePath,
  visibleEntries,
  type BrowseSort,
} from "./browseModel";
import { NameInputDialog } from "./dialogs/NameInputDialog";

type PathTarget = { entry: DirectoryEntry; path: string; parent: string };

/**
 * issue #2518: directory-tree navigation rooted at the session working
 * directory. Unlike the ripgrep search view, this shows real directory entries
 * (including git-ignored files) with name/type/size/mtime.
 * issue #2715: adds create-folder / rename / delete, each behind a confirmation.
 * #6222: memoized because the page re-renders on every search keystroke and
 * session poll, and this view stays mounted (hidden) under a search.
 *
 * #6224: the page owns the folder (it lives in the URL) and the sort / hidden /
 * filter preferences; this view lists, sorts and filters the folder and runs
 * the row actions. Every prop is a primitive, a stable callback, or `sort`, the
 * page's state object, which keeps its identity until the sort changes. So
 * `memo` still holds while the user types an "Everywhere" search.
 */
export const BrowseView = memo(function BrowseView(props: {
  sessionId: string;
  /** The relative folder shown; `.` is the session folder. */
  path: string;
  /** The session folder's absolute path, for Copy path; "" when unknown. */
  sessionRoot: string;
  /** The folder filter ("This folder" search); "" shows every entry. */
  filter: string;
  sort: BrowseSort;
  showHidden: boolean;
  onNavigate: (path: string) => void;
  onOpenFile: (fullPath: string) => void;
  onSortChange: (sort: BrowseSort) => void;
  onShowHiddenChange: (show: boolean) => void;
}) {
  const {
    sessionId,
    path,
    sessionRoot,
    onNavigate,
    onOpenFile,
    onSortChange,
    onShowHiddenChange,
  } = props;
  const { api } = useAppContext();
  const queryClient = useQueryClient();
  const { copy } = useCopyToClipboard();
  const { showToast } = useToast();

  // issue #2715: dialog state. Only one op runs at a time, so a single
  // `actionPending` flag drives all three dialogs' spinners.
  // #6224: each dialog holds the folder or path it was opened for, resolved
  // at tap time, so changing folder while it is open cannot retarget it.
  const [createIn, setCreateIn] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<PathTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    entry: DirectoryEntry;
    // #6222: resolved when Delete is tapped. The child count awaits an RPC, and the
    // user can change folder meanwhile, so this can't be derived from the folder.
    path: string;
    childCount: number;
  } | null>(null);
  const [actionPending, setActionPending] = useState(false);

  const dirQuery = useQuery({
    queryKey: queryKeys.sessionDirectory(sessionId, path),
    queryFn: async () => {
      if (!api) throw new Error("Missing API client");
      return await api.listSessionDirectory(sessionId, path);
    },
    enabled: Boolean(api),
  });

  const allEntries = useMemo(
    () => (dirQuery.data?.success ? (dirQuery.data.entries ?? []) : []),
    [dirQuery.data]
  );
  const visible = useMemo(
    () =>
      visibleEntries(allEntries, {
        showHidden: props.showHidden,
        filter: props.filter,
        sort: props.sort,
      }),
    [allEntries, props.showHidden, props.filter, props.sort]
  );
  const errorMessage =
    dirQuery.error instanceof Error
      ? friendlyRpcError(dirQuery.error.message)
      : dirQuery.data && !dirQuery.data.success
        ? friendlyRpcError(dirQuery.data.error ?? "Failed to list directory")
        : null;

  // issue #2715: run a mutating op, surfacing an RPC-level { success:false } as
  // a thrown error so the dialog shows it inline.
  // #6224: refresh in `finally`, because an RPC that timed out or failed may
  // still have changed the folder.
  const runAction = useCallback(
    async (
      op: () => Promise<{ success: boolean; error?: string }>,
      options?: { refreshGit?: boolean }
    ) => {
      setActionPending(true);
      try {
        const result = await op();
        if (!result.success) {
          throw new Error(result.error ?? "Operation failed");
        }
      } finally {
        setActionPending(false);
        // #6222: every listing, because a delete can target a folder the user has
        // since left. #6224: and every search, file and diff of the session,
        // because a rename or delete of a folder touches every file under it.
        void queryClient.invalidateQueries({
          queryKey: queryKeys.sessionDirectories(sessionId),
        });
        void queryClient.invalidateQueries({
          queryKey: queryKeys.sessionFileSearches(sessionId),
        });
        if (options?.refreshGit) {
          void queryClient.invalidateQueries({
            queryKey: queryKeys.sessionFileReads(sessionId),
          });
          void queryClient.invalidateQueries({
            queryKey: queryKeys.gitFileDiffs(sessionId),
          });
          // #6222: a rename or delete can change what Changes has to show (git
          // does not track an empty new folder).
          void queryClient.invalidateQueries({
            queryKey: queryKeys.gitStatus(sessionId),
          });
        }
      }
    },
    [queryClient, sessionId]
  );

  // issue #2715: before showing the delete confirm for a directory, count its
  // children so the dialog can state the count and require the recursive opt-in
  // (sweep finding 2715-5). A file skips the count (childCount stays 0).
  const requestDelete = useCallback(
    async (entry: DirectoryEntry, target: string) => {
      let childCount = 0;
      if (entry.type === "directory" && api) {
        try {
          const res = await api.listSessionDirectory(sessionId, target);
          childCount = res.success ? (res.entries?.length ?? 0) : 0;
        } catch {
          childCount = 0;
        }
      }
      setDeleteTarget({ entry, path: target, childCount });
    },
    [api, sessionId]
  );

  // issue #2715 (R5, UI defense-in-depth): EVERY row action targets a CHILD of
  // the current folder (joinBrowsePath(path, name)), never the session root
  // "." — so the UI structurally cannot emit the root as a mutation target. The
  // server route + CLI handler enforce the same rule authoritatively.
  const handleRowAction = useCallback(
    (entry: DirectoryEntry, kind: RowActionKind) => {
      const target = joinBrowsePath(path, entry.name);
      switch (kind) {
        case "open":
          if (entry.type === "directory") onNavigate(target);
          else onOpenFile(target);
          return;
        case "rename":
          setRenameTarget({ entry, path: target, parent: path });
          return;
        case "copyPath":
          void copy(
            sessionRoot ? absolutePath(sessionRoot, target) : target
          ).then(ok => {
            if (ok) showToast("Path copied");
          });
          return;
        case "delete":
          void requestDelete(entry, target);
          return;
      }
    },
    [path, sessionRoot, onNavigate, onOpenFile, copy, showToast, requestDelete]
  );

  const deleteEntry = deleteTarget?.entry ?? null;
  const deleteIsDir = deleteEntry?.type === "directory";
  const deleteChildCount = deleteTarget?.childCount ?? 0;
  const deleteRecursive = deleteIsDir && deleteChildCount > 0;
  // #6222: the full path, because the dialog can open in a different folder from the
  // one Delete was tapped in, and the same name can exist in both.
  const deletePath = deleteTarget?.path ?? "";
  const deleteDescription = !deleteEntry
    ? ""
    : deleteIsDir
      ? deleteChildCount > 0
        ? `The folder "${deletePath}" contains ${deleteChildCount} item${deleteChildCount === 1 ? "" : "s"}. Delete it and everything inside? This cannot be undone.`
        : `Delete the empty folder "${deletePath}"? This cannot be undone.`
      : `Delete "${deletePath}"? This cannot be undone.`;

  const rootLabel = baseName(sessionRoot) || "root";
  const filtering = props.filter.trim() !== "";
  const { entries, hiddenCount } = visible;

  return (
    <div>
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-[var(--app-divider)]">
        <Breadcrumbs
          path={path}
          rootLabel={rootLabel}
          onNavigate={onNavigate}
        />
        <div className="flex shrink-0 items-center gap-1">
          <BrowseViewMenu
            sort={props.sort}
            showHidden={props.showHidden}
            onSortChange={onSortChange}
            onShowHiddenChange={onShowHiddenChange}
          />
          <button
            type="button"
            onClick={() => setCreateIn(path)}
            className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs font-semibold text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)] transition-colors"
            title="New folder"
            aria-label="New folder"
          >
            <FolderPlusIcon className="h-4 w-4" />
            {/* Icon-only on a phone, so a deep breadcrumb keeps its line. */}
            <span className="hidden sm:inline">New folder</span>
          </button>
        </div>
      </div>
      {/* #6222: isPending, not isLoading: paused with no network, isLoading is
          false with no entries, which would read as an empty folder. */}
      {dirQuery.isPending ? (
        <FileListSkeleton label="Loading directory…" />
      ) : errorMessage ? (
        <div className="p-6 text-sm text-[var(--app-hint)]">{errorMessage}</div>
      ) : entries.length === 0 ? (
        <div className="p-6 text-sm text-[var(--app-hint)]">
          {filtering
            ? "Nothing in this folder matches your search."
            : hiddenCount > 0
              ? "This folder has only hidden items."
              : "This folder is empty."}
        </div>
      ) : (
        <div role="table" aria-label="Folder contents">
          <div role="rowgroup">
            <BrowseColumnHeaders
              sort={props.sort}
              onSortChange={onSortChange}
            />
          </div>
          <div role="rowgroup">
            {entries.map((entry, index) => (
              <BrowseRow
                key={entry.name}
                entry={entry}
                onAction={handleRowAction}
                showDivider={index < entries.length - 1}
              />
            ))}
          </div>
        </div>
      )}
      {!dirQuery.isPending && !errorMessage && hiddenCount > 0 ? (
        <div className="flex items-center gap-1 border-t border-[var(--app-divider)] px-3 py-2 text-xs text-[var(--app-hint)]">
          <span>
            {hiddenCount} hidden item{hiddenCount === 1 ? "" : "s"}
          </span>
          <span aria-hidden>·</span>
          <button
            type="button"
            onClick={() => onShowHiddenChange(true)}
            className="rounded px-1 py-0.5 font-semibold text-[var(--app-link)] hover:bg-[var(--app-subtle-bg)]"
          >
            Show
          </button>
        </div>
      ) : null}

      <NameInputDialog
        isOpen={createIn !== null}
        onClose={() => setCreateIn(null)}
        title="New folder"
        label="Folder name"
        initialValue=""
        submitLabel="Create"
        isPending={actionPending}
        onSubmit={name =>
          runAction(() =>
            (api as NonNullable<typeof api>).createSessionDirectory(
              sessionId,
              joinBrowsePath(createIn ?? path, name)
            )
          )
        }
      />

      <NameInputDialog
        isOpen={renameTarget !== null}
        onClose={() => setRenameTarget(null)}
        title={`Rename "${renameTarget?.entry.name ?? ""}"`}
        label="New name"
        initialValue={renameTarget?.entry.name ?? ""}
        submitLabel="Rename"
        isPending={actionPending}
        onSubmit={newName => {
          const target = renameTarget;
          if (!target) return Promise.resolve();
          return runAction(
            () =>
              (api as NonNullable<typeof api>).renameSessionPath(
                sessionId,
                target.path,
                joinBrowsePath(target.parent, newName)
              ),
            { refreshGit: true }
          );
        }}
      />

      <ConfirmDialog
        isOpen={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title={deleteIsDir ? "Delete folder" : "Delete file"}
        description={deleteDescription}
        confirmLabel="Delete"
        confirmingLabel="Deleting…"
        isPending={actionPending}
        destructive
        onConfirm={() =>
          runAction(
            () =>
              (api as NonNullable<typeof api>).deleteSessionPath(
                sessionId,
                deletePath,
                deleteRecursive
              ),
            { refreshGit: true }
          )
        }
      />
    </div>
  );
});
