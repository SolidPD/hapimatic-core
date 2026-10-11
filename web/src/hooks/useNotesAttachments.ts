// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useRef, useSyncExternalStore } from "react";
import { useAppContext } from "@/lib/app-context";
import { isFileAllowed } from "@/lib/allowed-file-types";
import { useToast } from "@/components/Toast";
import { MAX_NOTES_ATTACHMENTS, type NotesAttachment } from "@hapi/protocol";
import {
  type Attachment,
  type AttachmentStatus,
  subscribe,
  getAttachmentsSnapshot,
  updateSessionAttachments,
} from "@/lib/attachment-store";
import { dedupeFilename } from "@/hooks/useAttachments";

/**
 * Notes attachment hook (issue #1075) — the persisted sibling of
 * {@link useAttachments}. Notes attachments live in the SAME session-keyed
 * `attachment-store` primitive as the composer's, but under a namespaced
 * `notes:<sessionId>` key so the two boxes are fully independent. Unlike the
 * composer's ephemeral staged attachments, notes attachments are PERSISTED as
 * part of the `NotesContent` envelope on the server and re-hydrated on session
 * open / cross-device sync.
 *
 * Beyond the composer's upload surface it adds:
 * - {@link UseNotesAttachmentsReturn.getStateForPersist} — the persist-shape
 *   (`NotesAttachment[]`, uploaded-only) written into the notes envelope.
 * - {@link UseNotesAttachmentsReturn.hydrateFromPersisted} — seed the store from
 *   a persisted set (no in-memory File; render from metadata).
 * - {@link UseNotesAttachmentsReturn.absorbAttachments} — accept attachments
 *   moved IN from the composer (composer → notes), preserving error state (R13),
 *   capped at {@link MAX_NOTES_ATTACHMENTS}.
 * - {@link UseNotesAttachmentsReturn.extractAttachments} — return + clear all,
 *   for moving notes → composer.
 *
 * The 10-attachment cap (R8) is enforced on every entry point that grows the
 * list (`addFiles`, `addAndUpload`, `absorbAttachments`) with a user toast.
 */

export interface UseNotesAttachmentsReturn {
  attachments: Attachment[];
  addFiles: (files: FileList | File[]) => void;
  addAndUpload: (files: FileList | File[]) => Promise<void>;
  removeFile: (id: string) => void;
  renameFile: (id: string, newName: string) => void;
  clearAll: () => void;
  uploadAll: () => Promise<boolean>;
  getUploadedPaths: () => string[];
  getStateForPersist: () => NotesAttachment[];
  hydrateFromPersisted: (attachments: NotesAttachment[]) => void;
  absorbAttachments: (incoming: Attachment[]) => void;
  extractAttachments: () => Attachment[];
  isUploading: boolean;
  pendingCount: number;
  uploadedCount: number;
  hasErrors: boolean;
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/** Namespaced store key so notes and composer attachments never collide. */
function notesKey(sessionId: string): string {
  return `notes:${sessionId}`;
}

export function useNotesAttachments(
  sessionId: string
): UseNotesAttachmentsReturn {
  const { api } = useAppContext();
  const { showToast } = useToast();
  const key = notesKey(sessionId);

  const attachments = useSyncExternalStore(subscribe, () =>
    getAttachmentsSnapshot(key)
  );

  const abortControllerRef = useRef<AbortController | null>(null);

  // How many MORE attachments will fit. Returns 0 when at/over the cap.
  const roomLeft = useCallback(
    () =>
      Math.max(0, MAX_NOTES_ATTACHMENTS - getAttachmentsSnapshot(key).length),
    [key]
  );

  const warnCapped = useCallback(
    (skipped: number) => {
      if (skipped > 0) {
        showToast(
          `Notes attachment limit: max ${MAX_NOTES_ATTACHMENTS}. ${skipped} file${
            skipped === 1 ? "" : "s"
          } skipped.`,
          { type: "error" }
        );
      }
    },
    [showToast]
  );

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const fileArray = Array.from(files);
      updateSessionAttachments(key, prev => {
        const room = Math.max(0, MAX_NOTES_ATTACHMENTS - prev.length);
        const taken = fileArray.slice(0, room);
        warnCapped(fileArray.length - taken.length);
        if (taken.length === 0) return prev;
        const names = new Set(prev.map(a => a.name));
        const additions: Attachment[] = taken.map(file => {
          const valid = isFileAllowed(file.name);
          const name = dedupeFilename(file.name, names);
          names.add(name);
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
    [key, warnCapped]
  );

  const addAndUpload = useCallback(
    async (files: FileList | File[]) => {
      const fileArray = Array.from(files);
      if (fileArray.length === 0) return;

      // Cap against the CURRENT slice before generating drafts (R8).
      const room = roomLeft();
      const accepted = fileArray.slice(0, room);
      warnCapped(fileArray.length - accepted.length);
      if (accepted.length === 0) return;

      const drafts = accepted.map(file => ({
        id: generateId(),
        file,
        isValid: isFileAllowed(file.name),
      }));

      updateSessionAttachments(key, prev => {
        const names = new Set(prev.map(a => a.name));
        const additions: Attachment[] = drafts.map(d => {
          const name = dedupeFilename(d.file.name, names);
          names.add(name);
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

      const valid = drafts.filter(d => d.isValid);
      if (valid.length === 0) return;

      const controller = new AbortController();
      abortControllerRef.current = controller;
      try {
        for (const draft of valid) {
          if (controller.signal.aborted) break;
          updateSessionAttachments(key, prev =>
            prev.map(a =>
              a.id === draft.id
                ? { ...a, status: "uploading" as AttachmentStatus }
                : a
            )
          );
          try {
            const result = await api.uploadFile(sessionId, draft.file);
            if (result.success && result.file) {
              updateSessionAttachments(key, prev =>
                prev.map(a =>
                  a.id === draft.id
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
              updateSessionAttachments(key, prev =>
                prev.map(a =>
                  a.id === draft.id
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
            updateSessionAttachments(key, prev =>
              prev.map(a =>
                a.id === draft.id
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
    [key, sessionId, api, roomLeft, warnCapped]
  );

  const removeFile = useCallback(
    (id: string) => {
      updateSessionAttachments(key, prev => prev.filter(a => a.id !== id));
    },
    [key]
  );

  const renameFile = useCallback(
    (id: string, newName: string) => {
      updateSessionAttachments(key, prev => {
        const taken = new Set(prev.filter(a => a.id !== id).map(a => a.name));
        return prev.map(a =>
          a.id === id ? { ...a, name: dedupeFilename(newName, taken) } : a
        );
      });
    },
    [key]
  );

  // Upload any still-pending attachments (the shared modal exposes an
  // "upload all" action; notes normally upload on add, so this is usually a
  // no-op). Returns whether every pending upload succeeded.
  const uploadAll = useCallback(async (): Promise<boolean> => {
    const pending = getAttachmentsSnapshot(key).filter(
      a => a.status === "pending" && a.file
    );
    if (pending.length === 0) return true;
    const controller = new AbortController();
    abortControllerRef.current = controller;
    let allOk = true;
    try {
      for (const att of pending) {
        if (controller.signal.aborted) {
          allOk = false;
          break;
        }
        const file = att.file;
        if (!file) continue;
        updateSessionAttachments(key, prev =>
          prev.map(a =>
            a.id === att.id
              ? { ...a, status: "uploading" as AttachmentStatus }
              : a
          )
        );
        try {
          const result = await api.uploadFile(sessionId, file);
          if (result.success && result.file) {
            updateSessionAttachments(key, prev =>
              prev.map(a =>
                a.id === att.id
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
            allOk = false;
            updateSessionAttachments(key, prev =>
              prev.map(a =>
                a.id === att.id
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
          allOk = false;
          updateSessionAttachments(key, prev =>
            prev.map(a =>
              a.id === att.id
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
    return allOk;
  }, [key, sessionId, api]);

  const clearAll = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    updateSessionAttachments(key, prev => (prev.length === 0 ? prev : []));
  }, [key]);

  const getUploadedPaths = useCallback((): string[] => {
    return attachments
      .filter(a => a.status === "uploaded" && a.path)
      .map(a => a.path!);
  }, [attachments]);

  // The persist shape: only uploaded attachments with a server path survive a
  // reload. `pending`/`uploading` are mid-flight; `error` entries have no file
  // on disk to re-hydrate, so they are dropped from persistence (they still
  // travel on an in-session move — R13 — via extractAttachments).
  const getStateForPersist = useCallback((): NotesAttachment[] => {
    return getAttachmentsSnapshot(key)
      .filter(a => a.status === "uploaded" && a.storedName && a.path)
      .map(a => ({
        id: a.id,
        storedName: a.storedName!,
        path: a.path!,
        name: a.name,
        size: a.file?.size,
        mimeType: a.file?.type,
        status: "uploaded" as const,
        error: a.error,
      }));
  }, [key]);

  const hydrateFromPersisted = useCallback(
    (persisted: NotesAttachment[]) => {
      updateSessionAttachments(key, () =>
        persisted.map(na => ({
          id: na.id,
          // No in-memory File — hydrated from server metadata. Chips render from
          // name/status; preview features degrade to a file-type icon.
          name: na.name,
          isValid: true,
          storedName: na.storedName,
          path: na.path,
          status: na.status as AttachmentStatus,
          error: na.error,
        }))
      );
    },
    [key]
  );

  const absorbAttachments = useCallback(
    (incoming: Attachment[]) => {
      if (incoming.length === 0) return;
      updateSessionAttachments(key, prev => {
        const room = Math.max(0, MAX_NOTES_ATTACHMENTS - prev.length);
        const taken = incoming.slice(0, room);
        warnCapped(incoming.length - taken.length);
        if (taken.length === 0) return prev;
        const names = new Set(prev.map(a => a.name));
        const additions = taken.map(a => {
          const name = dedupeFilename(a.name, names);
          names.add(name);
          return { ...a, name };
        });
        return [...prev, ...additions];
      });
    },
    [key, warnCapped]
  );

  const extractAttachments = useCallback((): Attachment[] => {
    // Everything except `uploading` travels on a move: `pending` files carry
    // their File and are uploaded by the receiving box. Only `uploading` stays —
    // its in-flight continuation resolves against THIS box's store key.
    const movable = getAttachmentsSnapshot(key).filter(
      a => a.status !== "uploading"
    );
    if (movable.length === 0) return [];
    const ids = new Set(movable.map(a => a.id));
    updateSessionAttachments(key, prev => prev.filter(a => !ids.has(a.id)));
    return movable;
  }, [key]);

  const pendingCount = attachments.filter(a => a.status === "pending").length;
  const uploadedCount = attachments.filter(a => a.status === "uploaded").length;
  const hasErrors = attachments.some(a => a.status === "error");
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
    getStateForPersist,
    hydrateFromPersisted,
    absorbAttachments,
    extractAttachments,
    isUploading,
    pendingCount,
    uploadedCount,
    hasErrors,
  };
}
