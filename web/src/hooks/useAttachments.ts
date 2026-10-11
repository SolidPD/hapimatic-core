// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useRef, useSyncExternalStore } from "react";
import { useAppContext } from "@/lib/app-context";
import { isFileAllowed } from "@/lib/allowed-file-types";
import {
  type Attachment,
  type AttachmentStatus,
  subscribe,
  getAttachmentsSnapshot,
  updateSessionAttachments,
} from "@/lib/attachment-store";

// Re-export the data types so existing importers (AttachmentManagementModal, its
// test) keep resolving them from "@/hooks/useAttachments" (R6 — public surface
// unchanged). The types now live in the store, which owns the data (issue #2541).
export type { Attachment, AttachmentStatus };

interface UseAttachmentsReturn {
  attachments: Attachment[];
  addFiles: (files: FileList | File[]) => void;
  addAndUpload: (files: FileList | File[]) => Promise<void>;
  removeFile: (id: string) => void;
  renameFile: (id: string, newName: string) => void;
  clearAll: () => void;
  uploadAll: () => Promise<boolean>;
  getUploadedPaths: () => string[];
  /**
   * Push attachments moved IN from the notes field (notes → composer, issue
   * #1075). No cap — the composer has no attachment limit. Names are deduped
   * against the current set. Error state is preserved (R13).
   */
  absorbAttachments: (incoming: Attachment[]) => void;
  /**
   * Return the SETTLED (uploaded/error) attachments and remove them from the
   * composer, for a move OUT to notes (composer → notes, issue #1075). Leaves
   * `pending`/`uploading` entries in place so an in-flight upload's continuation
   * can still resolve them.
   */
  extractAttachments: () => Attachment[];
  isUploading: boolean;
  pendingCount: number;
  uploadedCount: number;
  hasErrors: boolean;
  hasInvalidFiles: boolean;
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Windows-style duplicate-filename de-duplication. If `desired` is already in
 * `taken`, append ` (n)` before the extension (`image.png` → `image (1).png` →
 * `image (2).png` …), incrementing until the name is unique. The extension is
 * split at the LAST dot; a leading dot (dotfiles like `.gitignore`) and names
 * with no dot are treated as having no extension. Exported for direct unit tests.
 */
export function dedupeFilename(desired: string, taken: Set<string>): string {
  if (!taken.has(desired)) return desired;
  const dot = desired.lastIndexOf(".");
  const hasExt = dot > 0; // dot > 0 skips dotfiles (".gitignore") and no-dot names
  const base = hasExt ? desired.slice(0, dot) : desired;
  const ext = hasExt ? desired.slice(dot) : "";
  let n = 1;
  let candidate = `${base} (${n})${ext}`;
  while (taken.has(candidate)) {
    n += 1;
    candidate = `${base} (${n})${ext}`;
  }
  return candidate;
}

/**
 * Session-keyed attachment hook (issue #2541). The staged-attachment list is
 * backed by the module-level `attachment-store`, keyed by `sessionId`, so it
 * survives composer remounts (session-view → list → same session-view) and is
 * isolated per session. The public return shape is unchanged (R6); only the hook
 * signature gained `sessionId` and the per-call `sessionId` args on
 * `addAndUpload`/`uploadAll` were dropped — the hook-level key is now the single
 * source of truth.
 */
export function useAttachments(sessionId: string): UseAttachmentsReturn {
  const { api } = useAppContext();

  // Session-keyed store slice — survives composer remounts. Referentially stable
  // between store writes (the useSyncExternalStore contract); a write to another
  // session returns the same reference here, so this composer does not re-render.
  const attachments = useSyncExternalStore(subscribe, () =>
    getAttachmentsSnapshot(sessionId)
  );

  // Per-instance abort controller. Intentionally NOT hoisted to the store:
  // unmounting the composer must NOT abort a valid in-flight upload (that is the
  // mirror image of the bug this issue fixes). Only the explicit `clearAll()`
  // path aborts, and only the uploads THIS instance started. A continuation that
  // resolves after unmount writes through the store for the captured `sessionId`.
  const abortControllerRef = useRef<AbortController | null>(null);

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const fileArray = Array.from(files);
      // Dedup names inside the updater so they resolve against the fresh `prev`
      // AND against each other within this batch (stale-closure-safe).
      updateSessionAttachments(sessionId, prev => {
        const taken = new Set(prev.map(a => a.name));
        const additions: Attachment[] = fileArray.map(file => {
          const valid = isFileAllowed(file.name);
          const name = dedupeFilename(file.name, taken);
          taken.add(name);
          return {
            id: generateId(),
            file,
            name,
            isValid: valid,
            status: (valid ? "pending" : "error") as AttachmentStatus,
            error: valid ? undefined : "Unsupported file type",
          };
        });
        return [...prev, ...additions];
      });
    },
    [sessionId]
  );

  // Add files and immediately upload them — avoids the stale-closure issue
  // where calling addFiles() then uploadAll() would miss the newly added files.
  const addAndUpload = useCallback(
    async (files: FileList | File[]) => {
      const fileArray = Array.from(files);
      if (fileArray.length === 0) return;

      // Pre-generate stable {id, file, isValid} drafts OUTSIDE the store update so
      // the async upload loop can key writes on id/file; deduped names are assigned
      // INSIDE the updater — the only stale-closure-safe place.
      const drafts = fileArray.map(file => ({
        id: generateId(),
        file,
        isValid: isFileAllowed(file.name),
      }));

      // Add to the store first — dedup names against the fresh slice and within
      // the batch.
      updateSessionAttachments(sessionId, prev => {
        const taken = new Set(prev.map(a => a.name));
        const additions: Attachment[] = drafts.map(d => {
          const name = dedupeFilename(d.file.name, taken);
          taken.add(name);
          return {
            id: d.id,
            file: d.file,
            name,
            isValid: d.isValid,
            status: (d.isValid ? "pending" : "error") as AttachmentStatus,
            error: d.isValid ? undefined : "Unsupported file type",
          };
        });
        return [...prev, ...additions];
      });

      // Only upload valid files — invalid ones are already marked as error.
      // Drafts carry {id, file, isValid}; the loop keys on id (name-agnostic, R4).
      const validAttachments = drafts.filter(d => d.isValid);
      if (validAttachments.length === 0) return;

      const controller = new AbortController();
      abortControllerRef.current = controller;

      try {
        for (const attachment of validAttachments) {
          if (controller.signal.aborted) break;

          // R4: map-by-id over the CURRENT store slice for the captured sessionId.
          // If the id is absent (user removed it / cleared meanwhile), map is a
          // NO-OP — it never re-appends a removed entry.
          updateSessionAttachments(sessionId, prev =>
            prev.map(a =>
              a.id === attachment.id
                ? { ...a, status: "uploading" as AttachmentStatus }
                : a
            )
          );

          try {
            const result = await api.uploadFile(sessionId, attachment.file);

            if (result.success && result.file) {
              updateSessionAttachments(sessionId, prev =>
                prev.map(a =>
                  a.id === attachment.id
                    ? {
                        ...a,
                        status: "uploaded" as AttachmentStatus,
                        storedName: result.file!.storedName,
                        path: result.file!.path,
                      }
                    : a
                )
              );
            } else {
              updateSessionAttachments(sessionId, prev =>
                prev.map(a =>
                  a.id === attachment.id
                    ? {
                        ...a,
                        status: "error" as AttachmentStatus,
                        error: result.error || "Upload failed",
                      }
                    : a
                )
              );
            }
          } catch (err) {
            updateSessionAttachments(sessionId, prev =>
              prev.map(a =>
                a.id === attachment.id
                  ? {
                      ...a,
                      status: "error" as AttachmentStatus,
                      error:
                        err instanceof Error ? err.message : "Upload failed",
                    }
                  : a
              )
            );
          }
        }
      } finally {
        abortControllerRef.current = null;
      }
    },
    [sessionId, api]
  );

  const removeFile = useCallback(
    (id: string) => {
      updateSessionAttachments(sessionId, prev =>
        prev.filter(a => a.id !== id)
      );
    },
    [sessionId]
  );

  const renameFile = useCallback(
    (id: string, newName: string) => {
      updateSessionAttachments(sessionId, prev => {
        // Dedup against the current set MINUS the renamed row itself, so renaming
        // a row to its own name is a no-op and colliding with a DIFFERENT row
        // auto-suffixes (expert-review 2026-07-02, ruling D12 / R5). Mutates only
        // `name` (R4 holds).
        const taken = new Set(prev.filter(a => a.id !== id).map(a => a.name));
        return prev.map(a =>
          a.id === id ? { ...a, name: dedupeFilename(newName, taken) } : a
        );
      });
    },
    [sessionId]
  );

  const clearAll = useCallback(() => {
    // Cancel any ongoing uploads THIS instance started (explicit-cancel path).
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    updateSessionAttachments(sessionId, prev =>
      prev.length === 0 ? prev : []
    );
  }, [sessionId]);

  const uploadAll = useCallback(async (): Promise<boolean> => {
    // Read the current slice fresh (no stale closure) for the captured sessionId.
    const pendingFiles = getAttachmentsSnapshot(sessionId).filter(
      a => a.status === "pending"
    );
    if (pendingFiles.length === 0) return true;

    const controller = new AbortController();
    abortControllerRef.current = controller;
    let allSucceeded = true;

    try {
      for (const attachment of pendingFiles) {
        // Check if aborted (explicit clearAll on this instance)
        if (controller.signal.aborted) {
          allSucceeded = false;
          break;
        }

        // A `pending` attachment always carries its File; this guard is
        // type-narrowing for the optional `file` field (issue #1075) and a
        // defensive skip for the impossible file-less-pending case.
        const pendingFile = attachment.file;
        if (!pendingFile) continue;

        // Mark as uploading (R4: map-by-id, NO-OP if absent)
        updateSessionAttachments(sessionId, prev =>
          prev.map(a =>
            a.id === attachment.id
              ? { ...a, status: "uploading" as AttachmentStatus }
              : a
          )
        );

        try {
          const result = await api.uploadFile(sessionId, pendingFile);

          if (result.success && result.file) {
            updateSessionAttachments(sessionId, prev =>
              prev.map(a =>
                a.id === attachment.id
                  ? {
                      ...a,
                      status: "uploaded" as AttachmentStatus,
                      storedName: result.file!.storedName,
                      path: result.file!.path,
                    }
                  : a
              )
            );
          } else {
            allSucceeded = false;
            updateSessionAttachments(sessionId, prev =>
              prev.map(a =>
                a.id === attachment.id
                  ? {
                      ...a,
                      status: "error" as AttachmentStatus,
                      error: result.error || "Upload failed",
                    }
                  : a
              )
            );
          }
        } catch (err) {
          allSucceeded = false;
          updateSessionAttachments(sessionId, prev =>
            prev.map(a =>
              a.id === attachment.id
                ? {
                    ...a,
                    status: "error" as AttachmentStatus,
                    error: err instanceof Error ? err.message : "Upload failed",
                  }
                : a
            )
          );
        }
      }
    } finally {
      abortControllerRef.current = null;
    }

    return allSucceeded;
  }, [sessionId, api]);

  const getUploadedPaths = useCallback((): string[] => {
    return attachments
      .filter(a => a.status === "uploaded" && a.path)
      .map(a => a.path!);
  }, [attachments]);

  const absorbAttachments = useCallback(
    (incoming: Attachment[]) => {
      if (incoming.length === 0) return;
      updateSessionAttachments(sessionId, prev => {
        const names = new Set(prev.map(a => a.name));
        const additions = incoming.map(a => {
          const name = dedupeFilename(a.name, names);
          names.add(name);
          return { ...a, name };
        });
        return [...prev, ...additions];
      });
    },
    [sessionId]
  );

  const extractAttachments = useCallback((): Attachment[] => {
    // Everything except `uploading` travels on a move: `pending` files carry
    // their File and are uploaded by the receiving box (the composer uploads at
    // Send, so a pending file left behind here would silently vanish from the
    // user's perspective). Only `uploading` stays — its in-flight continuation
    // resolves against THIS box's store key.
    const movable = getAttachmentsSnapshot(sessionId).filter(
      a => a.status !== "uploading"
    );
    if (movable.length === 0) return [];
    const ids = new Set(movable.map(a => a.id));
    updateSessionAttachments(sessionId, prev =>
      prev.filter(a => !ids.has(a.id))
    );
    return movable;
  }, [sessionId]);

  const pendingCount = attachments.filter(a => a.status === "pending").length;
  const uploadedCount = attachments.filter(a => a.status === "uploaded").length;
  const hasErrors = attachments.some(a => a.status === "error");
  const hasInvalidFiles = attachments.some(a => !a.isValid);
  // Derived from the store (not per-instance state) so a remounted composer
  // correctly reflects in-flight uploads whose promises outlived the old mount.
  const isUploading = attachments.some(a => a.status === "uploading");

  return {
    attachments,
    addFiles,
    addAndUpload,
    removeFile,
    renameFile,
    clearAll,
    uploadAll,
    getUploadedPaths,
    absorbAttachments,
    extractAttachments,
    isUploading,
    pendingCount,
    uploadedCount,
    hasErrors,
    hasInvalidFiles,
  };
}
