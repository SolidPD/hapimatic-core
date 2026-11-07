// SPDX-License-Identifier: AGPL-3.0-only
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, useSearch } from "@tanstack/react-router";
import type { GitCommandResponse } from "@/types/api";
import { FileIcon } from "@/components/FileIcon";
import { CopyButton } from "@/components/ui/CopyButton";
import { useAppContext } from "@/lib/app-context";
import { useAppGoBack } from "@/hooks/useAppGoBack";
import { queryKeys } from "@/lib/query-keys";
import { langAlias, useShikiHighlighter } from "@/lib/shiki";
import { decodeBase64, encodeBase64 } from "@/lib/utils";
import { isNoRepoGitError } from "@/lib/files-view";
import { friendlyRpcError } from "@/extensions/git-rpc/browse/browseModel";
import {
  isBinaryContent,
  isUtf8Text,
} from "@/extensions/git-rpc/browse/preview/binaryContent";
import {
  FilePreview,
  base64ToBytes,
  previewKindFor,
} from "@/extensions/git-rpc/browse/preview/FilePreview";

// issue #2964: CodeMirror editor is lazy-loaded so it stays out of the initial
// bundle and only ships when the user enters edit mode (Suspense falls back to
// the plain <textarea> while the chunk loads).
const CodeEditor = lazy(() => import("./CodeEditor"));

// issue #2518: download a file client-side by turning its base64 content into a
// Blob (no query-token endpoint needed — Key Decision 5). Only used for files
// small enough that the server returned their content (<= the read cap).
function triggerDownload(fileName: string, base64Content: string): void {
  const binary = atob(base64Content);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // #6224: revoking at once can cancel the download in Safari and the iOS PWA,
  // which read the blob after click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function EditIcon(props: { className?: string }) {
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

function DownloadIcon(props: { className?: string }) {
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
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function decodePath(value: string): string {
  if (!value) return "";
  const decoded = decodeBase64(value);
  return decoded.ok ? decoded.text : value;
}

function BackIcon(props: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.className}
    >
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function DiffDisplay(props: { diffContent: string }) {
  const lines = props.diffContent.split("\n");

  return (
    <div className="overflow-hidden rounded-md border border-[var(--app-border)] bg-[var(--app-bg)]">
      {lines.map((line, index) => {
        const isAdd = line.startsWith("+") && !line.startsWith("+++");
        const isRemove = line.startsWith("-") && !line.startsWith("---");
        const isHunk = line.startsWith("@@");
        const isHeader = line.startsWith("+++") || line.startsWith("---");

        const className = [
          "whitespace-pre-wrap px-3 py-0.5 text-xs font-mono",
          isAdd
            ? "bg-[var(--app-diff-added-bg)] text-[var(--app-diff-added-text)]"
            : "",
          isRemove
            ? "bg-[var(--app-diff-removed-bg)] text-[var(--app-diff-removed-text)]"
            : "",
          isHunk
            ? "bg-[var(--app-subtle-bg)] text-[var(--app-hint)] font-semibold"
            : "",
          isHeader ? "text-[var(--app-hint)] font-semibold" : "",
        ]
          .filter(Boolean)
          .join(" ");

        const style = isAdd
          ? { borderLeft: "2px solid var(--app-git-staged-color)" }
          : isRemove
            ? { borderLeft: "2px solid var(--app-git-deleted-color)" }
            : undefined;

        return (
          <div key={`${index}-${line}`} className={className} style={style}>
            {line || " "}
          </div>
        );
      })}
    </div>
  );
}

function FileContentSkeleton() {
  const widths = ["w-full", "w-11/12", "w-5/6", "w-3/4", "w-2/3", "w-4/5"];

  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">Loading file…</span>
      <div className="animate-pulse space-y-2 rounded-md border border-[var(--app-border)] bg-[var(--app-code-bg)] p-3">
        {Array.from({ length: 12 }).map((_, index) => (
          <div
            key={`file-skeleton-${index}`}
            className={`h-3 ${widths[index % widths.length]} rounded bg-[var(--app-subtle-bg)]`}
          />
        ))}
      </div>
    </div>
  );
}

function resolveLanguage(path: string): string | undefined {
  const parts = path.split(".");
  if (parts.length <= 1) return undefined;
  const ext = parts[parts.length - 1]?.toLowerCase();
  if (!ext) return undefined;
  return langAlias[ext] ?? ext;
}

function extractCommandError(
  result: GitCommandResponse | undefined
): string | null {
  if (!result) return null;
  if (result.success) return null;
  return result.error ?? result.stderr ?? "Failed to load diff";
}

export default function FilePage() {
  const { api } = useAppContext();
  const queryClient = useQueryClient();
  const goBack = useAppGoBack();
  const { sessionId } = useParams({ from: "/sessions/$sessionId/file" });
  const search = useSearch({ from: "/sessions/$sessionId/file" });
  const encodedPath = typeof search.path === "string" ? search.path : "";
  const staged = search.staged;

  const filePath = useMemo(() => decodePath(encodedPath), [encodedPath]);
  const fileName = filePath.split("/").pop() || filePath || "File";

  const diffQuery = useQuery({
    queryKey: queryKeys.gitFileDiff(sessionId, filePath, staged),
    queryFn: async () => {
      if (!api || !sessionId || !filePath) {
        throw new Error("Missing session or path");
      }
      return await api.getGitDiffFile(sessionId, filePath, staged);
    },
    enabled: Boolean(api && sessionId && filePath),
  });

  const fileQuery = useQuery({
    queryKey: queryKeys.sessionFile(sessionId, filePath),
    queryFn: async () => {
      if (!api || !sessionId || !filePath) {
        throw new Error("Missing session or path");
      }
      return await api.readSessionFile(sessionId, filePath);
    },
    enabled: Boolean(api && sessionId && filePath),
  });

  const diffContent = diffQuery.data?.success
    ? (diffQuery.data.stdout ?? "")
    : "";
  const rawDiffError =
    extractCommandError(diffQuery.data) ??
    (diffQuery.error instanceof Error ? diffQuery.error.message : null);
  // #6224: in a folder that is not a Git repo there is simply no diff; git's
  // usage text must not show. A broken-repo error is not this and still shows.
  const diffNotARepo = isNoRepoGitError(rawDiffError);
  const diffError = diffNotARepo ? null : rawDiffError;
  const diffSuccess = diffQuery.data?.success === true;
  const diffFailed = diffQuery.data?.success === false || diffQuery.isError;

  const fileContentResult = fileQuery.data;
  // issue #2518: the server withholds content for oversized files (tooLarge) —
  // there is nothing to decode, edit, or Blob-download.
  const tooLarge = fileContentResult?.tooLarge === true;
  const fileHash = fileContentResult?.success
    ? fileContentResult.hash
    : undefined;
  const downloadableContent =
    fileContentResult?.success && fileContentResult.content
      ? fileContentResult.content
      : undefined;
  const decodedContentResult =
    fileContentResult?.success && fileContentResult.content
      ? decodeBase64(fileContentResult.content)
      : { text: "", ok: true };
  const decodedContent = decodedContentResult.text;
  const binaryFile = fileContentResult?.success
    ? !decodedContentResult.ok || isBinaryContent(decodedContent)
    : false;
  // #6224: an image or PDF previews inline, from the bytes already fetched.
  const contentBytes = useMemo(
    () => (downloadableContent ? base64ToBytes(downloadableContent) : null),
    [downloadableContent]
  );
  // #6224 review: text that is not valid UTF-8 is shown but cannot be edited,
  // because saving it would rewrite the bytes the lenient decode replaced.
  const utf8Text = useMemo(
    () => (contentBytes ? isUtf8Text(contentBytes) : true),
    [contentBytes]
  );
  const notUtf8Text =
    fileContentResult?.success === true &&
    !tooLarge &&
    !binaryFile &&
    !utf8Text;
  // issue #2518: editing requires a text file whose read returned a hash (for a
  // conflict-safe save round-trip).
  const editable =
    fileContentResult?.success === true &&
    !tooLarge &&
    !binaryFile &&
    utf8Text &&
    typeof fileHash === "string";
  const preview = useMemo(
    () => (tooLarge ? null : previewKindFor(fileName, contentBytes)),
    [fileName, contentBytes, tooLarge]
  );

  const language = useMemo(() => resolveLanguage(filePath), [filePath]);
  const highlighted = useShikiHighlighter(decodedContent, language);

  const [displayMode, setDisplayMode] = useState<"diff" | "file">("diff");
  const [editing, setEditing] = useState(false);
  const [editedContent, setEditedContent] = useState("");

  const saveMutation = useMutation({
    mutationFn: async (content: string) => {
      if (!api || !sessionId || !filePath) {
        throw new Error("Missing session or path");
      }
      return await api.writeSessionFile(
        sessionId,
        filePath,
        encodeBase64(content),
        fileHash ?? null
      );
    },
    onSuccess: result => {
      if (result.success) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.sessionFile(sessionId, filePath),
        });
        void queryClient.invalidateQueries({
          queryKey: queryKeys.gitStatus(sessionId),
        });
        void queryClient.invalidateQueries({
          queryKey: queryKeys.gitFileDiff(sessionId, filePath, staged),
        });
        setEditing(false);
      }
    },
  });

  // Exit edit mode + clear save state when navigating to a different file.
  useEffect(() => {
    setEditing(false);
    saveMutation.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath]);

  useEffect(() => {
    if (editing) return;
    // An image's diff is only "Binary files differ"; open on the picture.
    if (preview) {
      setDisplayMode("file");
      return;
    }
    if (diffSuccess && !diffContent) {
      setDisplayMode("file");
      return;
    }
    if (diffFailed) {
      setDisplayMode("file");
    }
  }, [diffSuccess, diffFailed, diffContent, editing, preview]);

  const loading = diffQuery.isLoading || fileQuery.isLoading;
  // #6224: a thrown error (a 403 from the path guard, a 502 from an unreachable
  // node) used to leave fileQuery.data empty and render "File is empty.".
  const fileError =
    fileContentResult && !fileContentResult.success && !tooLarge
      ? friendlyRpcError(fileContentResult.error ?? "Failed to read file")
      : fileQuery.error instanceof Error
        ? friendlyRpcError(fileQuery.error.message)
        : null;
  const missingPath = !filePath;
  const diffErrorMessage = diffError ? `Diff unavailable: ${diffError}` : null;

  const saveResult = saveMutation.data;
  const saveConflict =
    saveResult?.success === false && saveResult.conflict === true;
  const saveFailedMessage =
    saveMutation.error instanceof Error
      ? saveMutation.error.message
      : saveResult && !saveResult.success && !saveResult.conflict
        ? (saveResult.error ?? "Failed to save file")
        : null;

  const handleStartEdit = () => {
    setEditedContent(decodedContent);
    saveMutation.reset();
    setDisplayMode("file");
    setEditing(true);
  };

  const handleReloadAfterConflict = () => {
    saveMutation.reset();
    setEditing(false);
    void queryClient.invalidateQueries({
      queryKey: queryKeys.sessionFile(sessionId, filePath),
    });
  };

  return (
    <div className="flex h-full flex-col">
      <div className="bg-[var(--app-bg)]">
        <div className="mx-auto w-full max-w-content flex items-center gap-2 p-3 border-b border-[var(--app-border)]">
          <button
            type="button"
            onClick={goBack}
            title="Back to files"
            aria-label="Back to files"
            className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
          >
            <BackIcon />
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold">{fileName}</div>
            <div className="truncate text-xs text-[var(--app-hint)]">
              {filePath || "Unknown path"}
            </div>
          </div>
        </div>
      </div>

      <div className="bg-[var(--app-bg)]">
        <div className="mx-auto w-full max-w-content px-3 py-2 flex items-center gap-2 border-b border-[var(--app-divider)]">
          <FileIcon fileName={fileName} size={20} />
          <span className="min-w-0 flex-1 truncate text-xs text-[var(--app-hint)]">
            {filePath}
          </span>
          {downloadableContent && !editing ? (
            <button
              type="button"
              onClick={() => triggerDownload(fileName, downloadableContent)}
              className="shrink-0 rounded p-1 text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] transition-colors"
              title="Download"
            >
              <DownloadIcon className="h-3.5 w-3.5" />
            </button>
          ) : null}
          {editable && !editing ? (
            <button
              type="button"
              onClick={handleStartEdit}
              className="shrink-0 rounded p-1 text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] transition-colors"
              title="Edit"
            >
              <EditIcon className="h-3.5 w-3.5" />
            </button>
          ) : null}
          <CopyButton text={filePath} className="shrink-0" title="Copy path" />
        </div>
      </div>

      {diffContent && !editing ? (
        <div className="bg-[var(--app-bg)]">
          <div className="mx-auto w-full max-w-content px-3 py-2 flex items-center gap-2 border-b border-[var(--app-divider)]">
            <button
              type="button"
              onClick={() => setDisplayMode("diff")}
              className={`rounded px-3 py-1 text-xs font-semibold ${displayMode === "diff" ? "bg-[var(--app-button)] text-[var(--app-button-text)] opacity-80" : "bg-[var(--app-subtle-bg)] text-[var(--app-hint)]"}`}
            >
              Diff
            </button>
            <button
              type="button"
              onClick={() => setDisplayMode("file")}
              className={`rounded px-3 py-1 text-xs font-semibold ${displayMode === "file" ? "bg-[var(--app-button)] text-[var(--app-button-text)] opacity-80" : "bg-[var(--app-subtle-bg)] text-[var(--app-hint)]"}`}
            >
              File
            </button>
          </div>
        </div>
      ) : null}

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-content p-4">
          {diffErrorMessage && !editing ? (
            <div className="mb-3 rounded-md bg-amber-500/10 p-2 text-xs text-[var(--app-hint)]">
              {diffErrorMessage}
            </div>
          ) : null}
          {notUtf8Text && !preview && !editing ? (
            <div
              role="note"
              className="mb-3 rounded-md bg-[var(--app-subtle-bg)] p-2 text-xs text-[var(--app-hint)]"
            >
              This file isn&apos;t UTF-8 text, so it can&apos;t be edited here
              without changing its bytes.
            </div>
          ) : null}
          {missingPath ? (
            <div className="text-sm text-[var(--app-hint)]">
              No file path provided.
            </div>
          ) : loading ? (
            <FileContentSkeleton />
          ) : fileError ? (
            <div className="text-sm text-[var(--app-hint)]">{fileError}</div>
          ) : tooLarge ? (
            <div className="rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-4 text-sm text-[var(--app-hint)]">
              <div className="mb-1 flex items-center gap-2 font-semibold text-[var(--app-fg)]">
                <DownloadIcon />
                File too large to open in the browser
              </div>
              <p>
                {fileContentResult?.size !== undefined
                  ? `This file is ${(fileContentResult.size / (1024 * 1024)).toFixed(1)} MB. `
                  : ""}
                Files above 5 MB are not loaded into the browser. Access it from
                the terminal (a streaming in-browser download is planned).
              </p>
            </div>
          ) : editing ? (
            <div className="space-y-2">
              {saveConflict ? (
                <div className="rounded-md bg-amber-500/10 p-2 text-xs text-[var(--app-hint)]">
                  This file changed on disk since you opened it. Saving would
                  overwrite those changes.{" "}
                  <button
                    type="button"
                    onClick={handleReloadAfterConflict}
                    className="font-semibold text-[var(--app-link)] underline"
                  >
                    Reload the latest version
                  </button>{" "}
                  (your edits will be discarded).
                </div>
              ) : null}
              {saveFailedMessage ? (
                <div className="rounded-md bg-red-500/10 p-2 text-xs text-[var(--app-git-deleted-color)]">
                  {saveFailedMessage}
                </div>
              ) : null}
              <Suspense
                fallback={
                  <textarea
                    value={editedContent}
                    onChange={event => setEditedContent(event.target.value)}
                    spellCheck={false}
                    autoCapitalize="none"
                    autoCorrect="off"
                    className="h-[60vh] w-full resize-y rounded-md border border-[var(--app-border)] bg-[var(--app-code-bg)] p-3 text-xs font-mono text-[var(--app-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--app-button)]"
                  />
                }
              >
                <CodeEditor
                  value={editedContent}
                  onChange={setEditedContent}
                  language={language}
                />
              </Suspense>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => saveMutation.mutate(editedContent)}
                  disabled={
                    saveMutation.isPending || editedContent === decodedContent
                  }
                  className="rounded px-3 py-1 text-xs font-semibold bg-[var(--app-button)] text-[var(--app-button-text)] disabled:opacity-50"
                >
                  {saveMutation.isPending ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(false);
                    saveMutation.reset();
                  }}
                  className="rounded px-3 py-1 text-xs font-semibold bg-[var(--app-subtle-bg)] text-[var(--app-hint)]"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : preview && contentBytes && displayMode === "file" ? (
            <FilePreview
              fileName={fileName}
              bytes={contentBytes}
              kind={preview.kind}
              mime={preview.mime}
              onDownload={
                downloadableContent
                  ? () => triggerDownload(fileName, downloadableContent)
                  : undefined
              }
            />
          ) : binaryFile ? (
            <div className="rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-4 text-sm text-[var(--app-hint)]">
              <p className="mb-2">
                This looks like a binary file and cannot be displayed.
              </p>
              {downloadableContent ? (
                <button
                  type="button"
                  onClick={() => triggerDownload(fileName, downloadableContent)}
                  className="inline-flex items-center gap-2 rounded px-3 py-1 text-xs font-semibold bg-[var(--app-button)] text-[var(--app-button-text)]"
                >
                  <DownloadIcon />
                  Download
                </button>
              ) : null}
            </div>
          ) : displayMode === "diff" && diffContent ? (
            <DiffDisplay diffContent={diffContent} />
          ) : displayMode === "diff" && diffError ? (
            <div className="text-sm text-[var(--app-hint)]">{diffError}</div>
          ) : displayMode === "file" ? (
            decodedContent ? (
              <pre className="shiki overflow-auto rounded-md bg-[var(--app-code-bg)] p-3 text-xs font-mono">
                <code>{highlighted ?? decodedContent}</code>
              </pre>
            ) : (
              <div className="text-sm text-[var(--app-hint)]">
                File is empty.
              </div>
            )
          ) : (
            <div className="text-sm text-[var(--app-hint)]">
              No changes to display.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
