// SPDX-License-Identifier: AGPL-3.0-only
import { useRef, useCallback, useState, useMemo, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import type { Attachment } from "@/hooks/useAttachments";
import { ImageFullscreenModal } from "@/components/ImageFullscreenModal";
import { PdfViewerModal } from "@/components/PdfViewerModal";
import { TextFileViewerModal } from "@/components/TextFileViewerModal";
import { usePdfThumbnail } from "@/hooks/usePdfThumbnail";
import { getFileCategory, type FileCategory } from "@/lib/file-types";
import { ATTACHMENT_PICKER_ACCEPT } from "@/lib/allowed-file-types";
import { Button } from "@/components/ui/button";
import { BareButton } from "@/components/ui/BareButton";
import { useVisualViewportHeight } from "@/hooks/useVisualViewportHeight";

interface AttachmentManagementModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  attachments: Attachment[];
  onAddFiles: (files: FileList | File[]) => void;
  onRemoveFile: (id: string) => void;
  onRenameFile: (id: string, newName: string) => void;
  onClearAll: () => void;
  onUploadAll: () => void;
  isUploading: boolean;
  pendingCount: number;
  uploadedCount: number;
}

function EditIcon() {
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
    >
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
      <path d="m15 5 4 4" />
    </svg>
  );
}

function DeleteIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function PlusIcon() {
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
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function UploadIcon() {
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
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg
      className="animate-spin"
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
      <path d="M12 2a10 10 0 0 1 10 10" strokeOpacity="0.75" />
    </svg>
  );
}

function ErrorIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="15" y1="9" x2="9" y2="15" />
      <line x1="9" y1="9" x2="15" y2="15" />
    </svg>
  );
}

function FileIcon({ mimeType }: { mimeType: string }) {
  if (mimeType.startsWith("image/")) {
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
      >
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <polyline points="21 15 16 10 5 21" />
      </svg>
    );
  }
  if (mimeType === "application/pdf") {
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
      >
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
        <line x1="10" y1="9" x2="8" y2="9" />
      </svg>
    );
  }
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
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function AttachmentItem({
  attachment,
  onRemove,
  onRename,
  disabled,
}: {
  attachment: Attachment;
  onRemove: () => void;
  onRename: (newName: string) => void;
  disabled: boolean;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(attachment.name);
  const [viewerOpen, setViewerOpen] = useState(false);

  // Issue #1075: `attachment.file` is optional (an uploaded attachment can arrive
  // without its in-memory File, e.g. transferred from notes). The composer always
  // supplies a File, so these guards are defensive — preview features degrade to a
  // file-type icon when the File is absent rather than crashing.
  const file = attachment.file;
  const category: FileCategory = getFileCategory(
    attachment.name,
    file?.type ?? ""
  );
  const isImage = category === "image";
  const isPdf = category === "pdf";
  const isText = category === "text";

  const thumbnailUrl = useMemo(
    () => (isImage && file ? URL.createObjectURL(file) : null),
    [isImage, file]
  );

  const pdfThumbnail = usePdfThumbnail(isPdf ? (file ?? null) : null);

  const [textContent, setTextContent] = useState<string | null>(null);
  useEffect(() => {
    if (!isText || !viewerOpen || !file) return;
    let cancelled = false;
    file.text().then(content => {
      if (!cancelled) setTextContent(content);
    });
    return () => {
      cancelled = true;
    };
  }, [isText, viewerOpen, file]);

  useEffect(() => {
    return () => {
      if (thumbnailUrl) URL.revokeObjectURL(thumbnailUrl);
    };
  }, [thumbnailUrl]);

  const handleStartEdit = useCallback(() => {
    setEditValue(attachment.name);
    setIsEditing(true);
  }, [attachment.name]);

  const handleSaveEdit = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== attachment.name) {
      onRename(trimmed);
    }
    setIsEditing(false);
  }, [editValue, attachment.name, onRename]);

  const handleCancelEdit = useCallback(() => {
    setEditValue(attachment.name);
    setIsEditing(false);
  }, [attachment.name]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleSaveEdit();
      } else if (e.key === "Escape") {
        handleCancelEdit();
      }
    },
    [handleSaveEdit, handleCancelEdit]
  );

  const statusIcon = {
    pending: null,
    uploading: <SpinnerIcon />,
    uploaded: <CheckIcon />,
    error: <ErrorIcon />,
  }[attachment.status];

  const statusColor = {
    pending: "text-[var(--app-fg)]/60",
    uploading: "text-[var(--app-link)]",
    uploaded: "text-green-500",
    error: "text-amber-500",
  }[attachment.status];

  const canEdit =
    (attachment.status === "pending" || attachment.status === "uploaded") &&
    !disabled;
  const canView = isImage || isPdf || isText;

  const pdfObjectUrl = useMemo(
    () => (isPdf && file ? URL.createObjectURL(file) : null),
    [isPdf, file]
  );
  useEffect(() => {
    return () => {
      if (pdfObjectUrl) URL.revokeObjectURL(pdfObjectUrl);
    };
  }, [pdfObjectUrl]);

  function renderThumbnail() {
    if (isImage && thumbnailUrl) {
      return (
        <button /* design-tokens-allow: image viewer wrapper - D2 E2 exception (#3357) */
          type="button"
          onClick={() => setViewerOpen(true)}
          className="flex-shrink-0 rounded overflow-hidden cursor-pointer"
          aria-label={`View ${attachment.name} fullscreen`}
        >
          <img
            src={thumbnailUrl}
            alt={attachment.name}
            className="h-10 w-10 object-cover rounded"
          />
        </button>
      );
    }
    if (isPdf) {
      return (
        <button /* design-tokens-allow: pdf thumbnail-card viewer wrapper - D2 E2 exception (#3357) */
          type="button"
          onClick={() => setViewerOpen(true)}
          className="flex-shrink-0 rounded overflow-hidden cursor-pointer"
          aria-label={`View ${attachment.name}`}
        >
          {pdfThumbnail ? (
            <img
              src={pdfThumbnail}
              alt={`${attachment.name} page 1`}
              className="h-10 w-10 object-cover rounded border border-white/10"
            />
          ) : (
            <div className="h-10 w-10 rounded bg-red-500/10 flex items-center justify-center text-red-400">
              <FileIcon mimeType="application/pdf" />
            </div>
          )}
        </button>
      );
    }
    if (isText) {
      return (
        <Button
          type="button"
          variant="ghostStatic"
          size="bare"
          onClick={() => setViewerOpen(true)}
          className="flex-shrink-0 cursor-pointer text-[var(--app-link)]/60 transition-colors hover:text-[var(--app-link)]"
          aria-label={`View ${attachment.name}`}
        >
          <FileIcon mimeType={file?.type || "text/plain"} />
        </Button>
      );
    }
    return (
      <div className="flex-shrink-0 text-[var(--app-fg)]/60">
        <FileIcon mimeType={file?.type ?? "text/plain"} />
      </div>
    );
  }

  return (
    <div
      className={`flex items-center gap-3 rounded-lg p-3 ${
        !attachment.isValid
          ? "bg-red-500/10 border border-red-500/20"
          : "bg-[var(--app-bg)]"
      }`}
    >
      {renderThumbnail()}
      <div className="flex-1 min-w-0">
        {isEditing ? (
          <input
            autoCapitalize="none"
            type="text"
            value={editValue}
            onChange={e => setEditValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={handleSaveEdit}
            autoFocus
            className="w-full rounded border border-[var(--app-link)]/50 bg-[var(--app-surface)] px-2 py-1 text-sm text-[var(--app-fg)] focus:border-[var(--app-link)] focus:outline-none"
          />
        ) : (
          <Button
            type="button"
            variant="ghostStatic"
            size="bare"
            onClick={canView ? () => setViewerOpen(true) : undefined}
            className={`text-sm truncate block text-left w-full font-normal hover:text-[var(--app-fg)] ${
              !attachment.isValid
                ? "text-red-400"
                : canView
                  ? "text-[var(--app-fg)] cursor-pointer hover:text-[var(--app-link)] transition-colors"
                  : "text-[var(--app-fg)]"
            }`}
          >
            {attachment.name}
          </Button>
        )}
        <p className="text-xs text-[var(--app-fg)]/50">
          {file ? formatFileSize(file.size) : ""}
          {!attachment.isValid && (
            <span className="text-red-500 ml-2 font-medium">Unsupported</span>
          )}
          {attachment.isValid && attachment.error && (
            <span className="text-amber-500 ml-2">{attachment.error}</span>
          )}
        </p>
      </div>
      {statusIcon && (
        <div className={`flex-shrink-0 ${statusColor}`}>{statusIcon}</div>
      )}
      {canEdit && !isEditing && (
        <Button
          type="button"
          variant="ghost"
          onClick={handleStartEdit}
          className="h-auto flex-shrink-0 rounded p-1.5 text-[var(--app-link)] transition-colors hover:bg-[var(--app-link)]/20 hover:text-[var(--app-link)]"
          aria-label={`Rename ${attachment.name}`}
          title="Rename"
        >
          <EditIcon />
        </Button>
      )}
      <BareButton
        type="button"
        onClick={onRemove}
        disabled={disabled || attachment.status === "uploading"}
        className="flex-shrink-0 p-1.5 rounded text-[var(--app-fg)]/50 hover:text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        aria-label={`Remove ${attachment.name}`}
        title="Remove"
      >
        <DeleteIcon />
      </BareButton>
      {isImage && thumbnailUrl && (
        <ImageFullscreenModal
          src={thumbnailUrl}
          alt={attachment.name}
          open={viewerOpen}
          onOpenChange={setViewerOpen}
        />
      )}
      {isPdf && pdfObjectUrl && (
        <PdfViewerModal
          src={pdfObjectUrl}
          filename={attachment.name}
          open={viewerOpen}
          onOpenChange={setViewerOpen}
        />
      )}
      {isText && file && (
        <TextFileViewerModal
          src=""
          filename={attachment.name}
          open={viewerOpen}
          onOpenChange={setViewerOpen}
          file={file}
        />
      )}
    </div>
  );
}

function AddFilesButton({
  onAddFiles,
  disabled,
}: {
  onAddFiles: (files: FileList | File[]) => void;
  disabled: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const handleClick = useCallback(() => {
    inputRef.current?.click();
  }, []);
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        onAddFiles(e.target.files);
        e.target.value = "";
      }
    },
    [onAddFiles]
  );
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        onChange={handleChange}
        className="hidden"
        accept={ATTACHMENT_PICKER_ACCEPT}
      />
      <Button
        type="button"
        variant="ghostStatic"
        onClick={handleClick}
        disabled={disabled}
        className="flex h-auto w-full items-center justify-start gap-2 rounded-lg border border-dashed border-[var(--app-fg)]/20 p-3 font-normal text-[var(--app-fg)]/60 transition-colors hover:border-[var(--app-link)]/50 hover:text-[var(--app-link)] disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <PlusIcon />
        <span className="text-sm">Add files</span>
      </Button>
    </>
  );
}

export function AttachmentManagementModal({
  isOpen,
  onOpenChange,
  attachments,
  onAddFiles,
  onRemoveFile,
  onRenameFile,
  onClearAll,
  onUploadAll,
  isUploading,
  pendingCount,
  uploadedCount,
}: AttachmentManagementModalProps) {
  const hasAttachments = attachments.length > 0;
  const hasInvalidFiles = attachments.some(a => !a.isValid);
  const canUpload = pendingCount > 0 && !isUploading;
  // The height cap follows the VISUAL viewport, not the layout viewport: a
  // plain `max-h-[80vh]` ignores the iOS on-screen keyboard, so tapping the
  // rename pencil (an autofocused input) re-centered the dialog in the visible
  // strip while leaving it 80% of the FULL screen tall — its top, with the
  // input being edited, slid under the status bar. Same lever as
  // `heightVariant="threeQuarter"` (#1617), applied as a max-height so a
  // one-file list stays short. The file list below is the scroll region.
  const viewportHeight = useVisualViewportHeight();
  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex flex-col border-2 border-[var(--app-link)]/40 bg-[var(--app-bg)]"
        style={{ maxHeight: `min(80vh, calc(${viewportHeight}px - 24px))` }}
      >
        <DialogHeader className="flex-shrink-0">
          <DialogTitle className="flex items-center gap-2 text-[var(--app-link)]">
            <span>Attachments</span>
            {hasAttachments && (
              <span className="px-2 py-0.5 rounded-full bg-[var(--app-link)]/20 text-[var(--app-link)] text-xs font-medium">
                {attachments.length}
              </span>
            )}
          </DialogTitle>
          <DialogDescription>
            Review and manage your file attachments.
          </DialogDescription>
        </DialogHeader>
        {hasInvalidFiles && (
          <div className="flex-shrink-0 rounded-md bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400">
            Some files have unsupported types and will not be sent to Claude.
            Remove them to send your message.
          </div>
        )}
        <div className="flex-1 overflow-y-auto space-y-2 py-2 min-h-0">
          {attachments.length === 0 ? (
            <div className="text-center py-8 text-[var(--app-hint)]">
              <p className="text-sm">No files attached</p>
              <p className="text-xs mt-1">
                Add files to include them with your message
              </p>
            </div>
          ) : (
            attachments.map(attachment => (
              <AttachmentItem
                key={attachment.id}
                attachment={attachment}
                onRemove={() => onRemoveFile(attachment.id)}
                onRename={newName => onRenameFile(attachment.id, newName)}
                disabled={isUploading}
              />
            ))
          )}
        </div>
        <div className="flex-shrink-0 pt-2 border-t border-[var(--app-fg)]/10">
          <AddFilesButton onAddFiles={onAddFiles} disabled={isUploading} />
        </div>
        <div className="flex-shrink-0 flex items-center justify-between pt-3 border-t border-[var(--app-fg)]/10 mt-2">
          <Button
            type="button"
            variant="ghostStatic"
            size="bare"
            onClick={onClearAll}
            disabled={!hasAttachments || isUploading}
            className="text-sm font-normal text-red-500 transition-colors hover:text-red-400 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Clear All
          </Button>
          <Button
            type="button"
            variant="accent"
            onClick={onUploadAll}
            disabled={!canUpload}
            className="gap-2 rounded-lg text-[var(--app-bg)] transition-colors hover:opacity-100 hover:brightness-110 disabled:cursor-not-allowed"
          >
            <UploadIcon />
            <span>Upload {pendingCount > 0 ? `(${pendingCount})` : ""}</span>
          </Button>
        </div>
        {isUploading && (
          <p className="text-xs text-center text-[var(--app-link)] mt-2">
            Uploading files...
          </p>
        )}
        {uploadedCount > 0 && !isUploading && (
          <p className="text-xs text-center text-green-500 mt-2">
            {uploadedCount} file{uploadedCount !== 1 ? "s" : ""} uploaded and
            ready
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
