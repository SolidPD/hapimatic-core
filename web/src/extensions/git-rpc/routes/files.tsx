// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  DirectoryEntry,
  FileSearchItem,
  GitFileStatus,
} from "@/types/api";
import { FileIcon } from "@/components/FileIcon";
import { GitBranchIcon } from "@/components/icons";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useAppContext } from "@/lib/app-context";
import { SessionOfflineBar } from "@/components/session/SessionOfflineBar";
import { useGitStatusFiles } from "@/extensions/git-rpc/hooks/useGitStatusFiles";
import { useSession } from "@/hooks/queries/useSession";
import { useSessionFileSearch } from "@/extensions/git-rpc/hooks/useSessionFileSearch";
import { queryKeys } from "@/lib/query-keys";
import { encodeBase64 } from "@/lib/utils";
import { ViewPicker } from "@/components/session/ViewPicker";

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

function FolderIcon(props: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.className}
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

// issue #2715: icons for the V2 file ops (create-folder / rename / delete).
function FolderPlusIcon(props: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.className}
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <line x1="12" y1="11" x2="12" y2="17" />
      <line x1="9" y1="14" x2="15" y2="14" />
    </svg>
  );
}

function PencilIcon(props: { className?: string }) {
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
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

function TrashIcon(props: { className?: string }) {
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
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  );
}

// issue #2518: human-readable byte size + mtime for the Browse view rows.
function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unitIndex]}`;
}

function formatMtime(epochMs: number | undefined): string {
  if (epochMs === undefined) return "";
  return new Date(epochMs).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// Join a relative browse path with a child segment; "." / "" is the cwd root.
function joinBrowsePath(base: string, child: string): string {
  if (base === "" || base === ".") return child;
  return `${base}/${child}`;
}

// Epic #3285 correction pass 1: the raw transport error the RPC gateway throws
// when a session's CLI process has no file handlers ("RPC handler not
// registered: …" — a session started on an older Hapimatic binary, or one whose
// CLI is gone) is meaningless to the user. Map it to an actionable sentence; any
// other error passes through verbatim.
const RPC_HANDLER_MISSING_COPY =
  "File browsing is not available for this session's CLI process — it predates the file-browser handlers or is no longer running. Reconnect the session to enable it.";
export function friendlyRpcError(message: string): string {
  return /RPC handler not registered|RPC socket|not connected to daemon/i.test(
    message
  )
    ? RPC_HANDLER_MISSING_COPY
    : message;
}

function StatusBadge(props: { status: GitFileStatus["status"] }) {
  const { label, color } = useMemo(() => {
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
      default:
        return { label: "M", color: "var(--app-git-unstaged-color)" };
    }
  }, [props.status]);

  return (
    <span
      className="inline-flex items-center justify-center rounded border px-1.5 py-0.5 text-[10px] font-semibold"
      style={{ color, borderColor: color }}
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
  onOpen: () => void;
  showDivider: boolean;
}) {
  const subtitle = props.file.filePath || "project root";

  return (
    <button
      type="button"
      onClick={props.onOpen}
      className={`flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-[var(--app-subtle-bg)] transition-colors ${props.showDivider ? "border-b border-[var(--app-divider)]" : ""}`}
    >
      <FileIcon fileName={props.file.fileName} size={22} />
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

// issue #2518 / #2715: a single Browse-mode row — a folder (navigates in) or a
// file (opens the viewer/editor) with size/mtime metadata, plus (since #2715)
// per-row Rename / Delete affordances. The row is a <div>, not a <button>, so
// the action buttons are NOT nested inside the open button (invalid HTML).
function BrowseRow(props: {
  entry: DirectoryEntry;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
  showDivider: boolean;
}) {
  const isDir = props.entry.type === "directory";
  const meta = isDir
    ? ""
    : [formatBytes(props.entry.size), formatMtime(props.entry.modified)]
        .filter(Boolean)
        .join(" · ");

  return (
    <div
      className={`flex w-full items-center gap-1 pr-2 hover:bg-[var(--app-subtle-bg)] transition-colors ${props.showDivider ? "border-b border-[var(--app-divider)]" : ""}`}
    >
      <button
        type="button"
        onClick={props.onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left"
      >
        {isDir ? (
          <FolderIcon className="text-[var(--app-link)]" />
        ) : (
          <FileIcon fileName={props.entry.name} size={22} />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{props.entry.name}</div>
          {meta ? (
            <div className="truncate text-xs text-[var(--app-hint)]">
              {meta}
            </div>
          ) : null}
        </div>
      </button>
      {/* issue #2715: mobile has no hover, so the action buttons are always
          visible (not hover-revealed). Each targets THIS entry — a child of the
          current directory — never the cwd root. */}
      <button
        type="button"
        onClick={props.onRename}
        title={`Rename ${props.entry.name}`}
        aria-label={`Rename ${props.entry.name}`}
        className="shrink-0 rounded p-1.5 text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)] transition-colors"
      >
        <PencilIcon className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={props.onDelete}
        title={`Delete ${props.entry.name}`}
        aria-label={`Delete ${props.entry.name}`}
        className="shrink-0 rounded p-1.5 text-[var(--app-hint)] hover:bg-red-500/10 hover:text-red-500 transition-colors"
      >
        <TrashIcon className="h-4 w-4" />
      </button>
    </div>
  );
}

// issue #2518: clickable breadcrumb trail for the Browse view.
function Breadcrumbs(props: {
  path: string;
  onNavigate: (path: string) => void;
}) {
  const segments =
    props.path === "." || props.path === "" ? [] : props.path.split("/");

  return (
    <div className="flex flex-wrap items-center gap-1 text-xs text-[var(--app-hint)]">
      <button
        type="button"
        onClick={() => props.onNavigate(".")}
        className="rounded px-1 py-0.5 hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] transition-colors"
      >
        root
      </button>
      {segments.map((seg, index) => {
        const target = segments.slice(0, index + 1).join("/");
        return (
          <span key={target} className="flex items-center gap-1">
            <span aria-hidden>/</span>
            <button
              type="button"
              onClick={() => props.onNavigate(target)}
              className="rounded px-1 py-0.5 hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] transition-colors"
            >
              {seg}
            </button>
          </span>
        );
      })}
    </div>
  );
}

// issue #2715: a small text-input dialog for create-folder / rename. Modeled on
// RenameSessionDialog but generic. Validates a single path SEGMENT (non-empty,
// no "/", not "." / "..") client-side — defense-in-depth; the server + CLI
// enforce containment authoritatively.
function NameInputDialog(props: {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  label: string;
  initialValue: string;
  submitLabel: string;
  isPending: boolean;
  onSubmit: (value: string) => Promise<void>;
}) {
  const [value, setValue] = useState(props.initialValue);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (props.isOpen) {
      setValue(props.initialValue);
      setError(null);
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 100);
    }
  }, [props.isOpen, props.initialValue]);

  const validate = (raw: string): string | null => {
    const trimmed = raw.trim();
    if (!trimmed) return "Name cannot be empty";
    if (trimmed === "." || trimmed === "..") return "Invalid name";
    if (trimmed.includes("/")) return "Name cannot contain '/'";
    return null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const validationError = validate(value);
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    try {
      await props.onSubmit(value.trim());
      props.onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Operation failed");
    }
  };

  return (
    <Dialog open={props.isOpen} onOpenChange={open => !open && props.onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>Enter a name and submit.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-4">
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={e => {
              setValue(e.target.value);
              setError(null);
            }}
            onKeyDown={e => {
              if (e.key === "Escape") props.onClose();
            }}
            placeholder={props.label}
            aria-label={props.label}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            disabled={props.isPending}
            aria-invalid={error !== null}
            className={`w-full px-3 py-2.5 rounded-lg border bg-[var(--app-bg)] text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-2 focus:border-transparent ${
              error
                ? "border-red-500 focus:ring-red-500"
                : "border-[var(--app-border)] focus:ring-[var(--app-button)]"
            }`}
          />
          {error ? (
            <div className="rounded-md bg-red-900/20 p-3 text-sm text-red-400">
              {error}
            </div>
          ) : null}
          <div className="flex gap-2 justify-end">
            <Button
              type="button"
              variant="secondary"
              onClick={props.onClose}
              disabled={props.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={props.isPending || !value.trim()}>
              {props.isPending ? "Working…" : props.submitLabel}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// issue #2518: directory-tree navigation rooted at the session working
// directory. Unlike the ripgrep search view, this shows real directory entries
// (including git-ignored files) with name/type/size/mtime.
// issue #2715: adds create-folder / rename / delete, each behind a confirmation.
function BrowseView(props: {
  sessionId: string;
  onOpenFile: (fullPath: string) => void;
}) {
  const { api } = useAppContext();
  const queryClient = useQueryClient();
  const [currentPath, setCurrentPath] = useState(".");

  // issue #2715: dialog state. Only one op runs at a time, so a single
  // `actionPending` flag drives all three dialogs' spinners.
  const [createOpen, setCreateOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<DirectoryEntry | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    entry: DirectoryEntry;
    childCount: number;
  } | null>(null);
  const [actionPending, setActionPending] = useState(false);

  const dirQuery = useQuery({
    queryKey: queryKeys.sessionDirectory(props.sessionId, currentPath),
    queryFn: async () => {
      if (!api) throw new Error("Missing API client");
      return await api.listSessionDirectory(props.sessionId, currentPath);
    },
    enabled: Boolean(api),
  });

  const entries = dirQuery.data?.success ? (dirQuery.data.entries ?? []) : [];
  const errorMessage =
    dirQuery.error instanceof Error
      ? friendlyRpcError(dirQuery.error.message)
      : dirQuery.data && !dirQuery.data.success
        ? friendlyRpcError(dirQuery.data.error ?? "Failed to list directory")
        : null;

  // issue #2715: run a mutating op, surfacing an RPC-level { success:false } as
  // a thrown error so the dialog shows it inline, then refresh the listing.
  const runAction = useCallback(
    async (op: () => Promise<{ success: boolean; error?: string }>) => {
      setActionPending(true);
      try {
        const result = await op();
        if (!result.success) {
          throw new Error(result.error ?? "Operation failed");
        }
        await queryClient.invalidateQueries({
          queryKey: queryKeys.sessionDirectory(props.sessionId, currentPath),
        });
      } finally {
        setActionPending(false);
      }
    },
    [queryClient, props.sessionId, currentPath]
  );

  // issue #2715: before showing the delete confirm for a directory, count its
  // children so the dialog can state the count and require the recursive opt-in
  // (sweep finding 2715-5). A file skips the count (childCount stays 0).
  const requestDelete = useCallback(
    async (entry: DirectoryEntry) => {
      let childCount = 0;
      if (entry.type === "directory" && api) {
        try {
          const res = await api.listSessionDirectory(
            props.sessionId,
            joinBrowsePath(currentPath, entry.name)
          );
          childCount = res.success ? (res.entries?.length ?? 0) : 0;
        } catch {
          childCount = 0;
        }
      }
      setDeleteTarget({ entry, childCount });
    },
    [api, props.sessionId, currentPath]
  );

  // issue #2715 (R5, UI defense-in-depth): EVERY affordance below targets a
  // CHILD of the current directory (joinBrowsePath(currentPath, name)), never
  // the cwd root "." — so the UI structurally cannot emit the root as a mutation
  // target. The server route + CLI handler enforce the same rule authoritatively.
  const deleteEntry = deleteTarget?.entry ?? null;
  const deleteIsDir = deleteEntry?.type === "directory";
  const deleteChildCount = deleteTarget?.childCount ?? 0;
  const deleteRecursive = deleteIsDir && deleteChildCount > 0;
  const deleteDescription = !deleteEntry
    ? ""
    : deleteIsDir
      ? deleteChildCount > 0
        ? `The folder "${deleteEntry.name}" contains ${deleteChildCount} item${deleteChildCount === 1 ? "" : "s"}. Delete it and everything inside? This cannot be undone.`
        : `Delete the empty folder "${deleteEntry.name}"? This cannot be undone.`
      : `Delete "${deleteEntry.name}"? This cannot be undone.`;

  return (
    <div>
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-[var(--app-divider)]">
        <Breadcrumbs path={currentPath} onNavigate={setCurrentPath} />
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs font-semibold text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)] transition-colors"
          title="New folder"
        >
          <FolderPlusIcon className="h-4 w-4" />
          New folder
        </button>
      </div>
      {dirQuery.isLoading ? (
        <FileListSkeleton label="Loading directory…" />
      ) : errorMessage ? (
        <div className="p-6 text-sm text-[var(--app-hint)]">{errorMessage}</div>
      ) : entries.length === 0 ? (
        <div className="p-6 text-sm text-[var(--app-hint)]">
          This folder is empty.
        </div>
      ) : (
        <div>
          {entries.map((entry, index) => (
            <BrowseRow
              key={`${entry.name}-${index}`}
              entry={entry}
              onOpen={() => {
                if (entry.type === "directory") {
                  setCurrentPath(joinBrowsePath(currentPath, entry.name));
                } else {
                  props.onOpenFile(joinBrowsePath(currentPath, entry.name));
                }
              }}
              onRename={() => setRenameTarget(entry)}
              onDelete={() => {
                void requestDelete(entry);
              }}
              showDivider={index < entries.length - 1}
            />
          ))}
        </div>
      )}

      <NameInputDialog
        isOpen={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New folder"
        label="Folder name"
        initialValue=""
        submitLabel="Create"
        isPending={actionPending}
        onSubmit={name =>
          runAction(() =>
            (api as NonNullable<typeof api>).createSessionDirectory(
              props.sessionId,
              joinBrowsePath(currentPath, name)
            )
          )
        }
      />

      <NameInputDialog
        isOpen={renameTarget !== null}
        onClose={() => setRenameTarget(null)}
        title={`Rename "${renameTarget?.name ?? ""}"`}
        label="New name"
        initialValue={renameTarget?.name ?? ""}
        submitLabel="Rename"
        isPending={actionPending}
        onSubmit={newName =>
          runAction(() =>
            (api as NonNullable<typeof api>).renameSessionPath(
              props.sessionId,
              joinBrowsePath(currentPath, renameTarget?.name ?? ""),
              joinBrowsePath(currentPath, newName)
            )
          )
        }
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
          runAction(() =>
            (api as NonNullable<typeof api>).deleteSessionPath(
              props.sessionId,
              joinBrowsePath(currentPath, deleteEntry?.name ?? ""),
              deleteRecursive
            )
          )
        }
      />
    </div>
  );
}

function FileListSkeleton(props: { label: string; rows?: number }) {
  const titleWidths = ["w-1/3", "w-1/2", "w-2/3", "w-2/5", "w-3/5"];
  const subtitleWidths = ["w-1/2", "w-2/3", "w-3/4", "w-1/3"];
  const rows = props.rows ?? 6;

  return (
    <div
      className="p-3 animate-pulse space-y-3"
      role="status"
      aria-live="polite"
    >
      <span className="sr-only">{props.label}</span>
      {Array.from({ length: rows }).map((_, index) => (
        <div key={`skeleton-row-${index}`} className="flex items-center gap-3">
          <div className="h-6 w-6 rounded bg-[var(--app-subtle-bg)]" />
          <div className="flex-1 space-y-2">
            <div
              className={`h-3 ${titleWidths[index % titleWidths.length]} rounded bg-[var(--app-subtle-bg)]`}
            />
            <div
              className={`h-2 ${subtitleWidths[index % subtitleWidths.length]} rounded bg-[var(--app-subtle-bg)]`}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function FilesPage() {
  const { api } = useAppContext();
  const navigate = useNavigate();
  const { sessionId } = useParams({ from: "/sessions/$sessionId/files" });
  const { session } = useSession(api, sessionId, true); // Active session polling
  const [searchQuery, setSearchQuery] = useState("");
  // issue #2518: "changes" = git status + ripgrep search (existing behavior);
  // "browse" = the new directory-tree navigation.
  const [viewMode, setViewMode] = useState<"changes" | "browse">("changes");

  // Epic #3285 correction pass 1: every Files view rides session RPC handlers that
  // exist ONLY while the CLI process is alive. Gate the RPCs on an ACTIVE session
  // so an offline session shows the slim offline bar instead of raw
  // "RPC handler not registered" errors (the View Picker also greys the tab, but
  // the route stays reachable by URL / persisted-view redirect).
  const sessionActive = session?.active === true;

  const {
    status: gitStatus,
    error: gitError,
    isLoading: gitLoading,
    refetch: refetchGit,
  } = useGitStatusFiles(api, sessionId, { enabled: sessionActive });

  const shouldSearch =
    Boolean(searchQuery) ||
    (gitStatus
      ? gitStatus.totalStaged === 0 && gitStatus.totalUnstaged === 0
      : Boolean(gitError));

  const searchResults = useSessionFileSearch(api, sessionId, searchQuery, {
    enabled:
      sessionActive && viewMode === "changes" && shouldSearch && !gitLoading,
  });

  const handleOpenFile = useCallback(
    (path: string, staged?: boolean) => {
      const search =
        staged === undefined
          ? { path: encodeBase64(path) }
          : { path: encodeBase64(path), staged };
      navigate({
        to: "/sessions/$sessionId/file",
        params: { sessionId },
        search,
      });
    },
    [navigate, sessionId]
  );

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
            onClick={() => setViewMode("changes")}
            className={`rounded px-3 py-1 text-xs font-semibold ${viewMode === "changes" ? "bg-[var(--app-button)] text-[var(--app-button-text)] opacity-80" : "bg-[var(--app-subtle-bg)] text-[var(--app-hint)]"}`}
          >
            Changes
          </button>
          <button
            type="button"
            onClick={() => setViewMode("browse")}
            className={`rounded px-3 py-1 text-xs font-semibold ${viewMode === "browse" ? "bg-[var(--app-button)] text-[var(--app-button-text)] opacity-80" : "bg-[var(--app-subtle-bg)] text-[var(--app-hint)]"}`}
          >
            Browse
          </button>
          {/* Refresh moved here from the removed page header (correction pass 1). */}
          <button
            type="button"
            onClick={() => {
              void refetchGit();
            }}
            className="ml-auto flex h-7 w-7 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
            title="Refresh"
            aria-label="Refresh"
          >
            <RefreshIcon />
          </button>
        </div>
      </div>

      {viewMode === "changes" ? (
        <div className="bg-[var(--app-bg)]">
          <div className="mx-auto w-full max-w-content p-3 border-b border-[var(--app-border)]">
            <div className="flex items-center gap-2 rounded-md bg-[var(--app-subtle-bg)] px-3 py-2">
              <SearchIcon className="text-[var(--app-hint)]" />
              <input
                value={searchQuery}
                onChange={event => setSearchQuery(event.target.value)}
                placeholder="Search files"
                className="w-full bg-transparent text-sm text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none"
                autoCapitalize="none"
                autoCorrect="off"
              />
            </div>
          </div>
        </div>
      ) : null}

      {viewMode === "changes" && !gitLoading && gitStatus ? (
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
          {viewMode === "browse" ? (
            <BrowseView
              sessionId={sessionId}
              onOpenFile={path => handleOpenFile(path)}
            />
          ) : (
            <>
              {showGitErrorBanner ? (
                <div className="border-b border-[var(--app-divider)] bg-amber-500/10 px-3 py-2 text-xs text-[var(--app-hint)]">
                  {friendlyRpcError(gitError ?? "")}
                </div>
              ) : null}
              {gitLoading ? (
                <FileListSkeleton label="Loading Git status…" />
              ) : shouldSearch ? (
                searchResults.isLoading ? (
                  <FileListSkeleton label="Loading files…" />
                ) : searchResults.error ? (
                  <div className="p-6 text-sm text-[var(--app-hint)]">
                    {friendlyRpcError(searchResults.error ?? "")}
                  </div>
                ) : searchResults.files.length === 0 ? (
                  <div className="p-6 text-sm text-[var(--app-hint)]">
                    {searchQuery
                      ? "No files match your search."
                      : "No files found in this project."}
                  </div>
                ) : (
                  <div className="border-t border-[var(--app-divider)]">
                    {searchResults.files.map((file, index) => (
                      <SearchResultRow
                        key={`${file.fullPath}-${index}`}
                        file={file}
                        onOpen={() => handleOpenFile(file.fullPath)}
                        showDivider={index < searchResults.files.length - 1}
                      />
                    ))}
                  </div>
                )
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
                          onOpen={() =>
                            handleOpenFile(file.fullPath, file.isStaged)
                          }
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
                          onOpen={() =>
                            handleOpenFile(file.fullPath, file.isStaged)
                          }
                          showDivider={
                            index < gitStatus.unstagedFiles.length - 1
                          }
                        />
                      ))}
                    </div>
                  ) : null}

                  {gitStatus &&
                  gitStatus.stagedFiles.length === 0 &&
                  gitStatus.unstagedFiles.length === 0 ? (
                    <div className="p-6 text-sm text-[var(--app-hint)]">
                      No changes detected. Use search or Browse to view files.
                    </div>
                  ) : null}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
