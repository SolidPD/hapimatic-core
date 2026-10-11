// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useRef } from "react";
import {
  PopOutEditorShell,
  EditorSessionName,
  popOutWindowTitle,
  type PopOutOrigin,
} from "@/components/PopOutEditorShell";
import {
  useNotesEditor,
  NotesEditorToolbar,
  NotesEditorBody,
} from "@/components/NotesEditorBody";
import { usePopOutWindow } from "@/hooks/usePopOutWindow";
import { type Attachment } from "@/lib/attachment-store";

/**
 * useNotesPopOut (#3517 Tasks 9/10) — hosts a session-notes pop-out window.
 *
 * Shared by the in-session notes editor (SessionNotes) and the session-list
 * card's circle-i notes popup (SessionListNotesModal), so the notes pop-out is
 * ONE shell (R6). Notes has no send, so — unlike the prompt pop-out — there is
 * no programmatic close: every close (Pop-in or window close) runs
 * `onPopOutClose`.
 *
 * The host owns collapse/suppress + restore via the two callbacks:
 *  - `onPopOutOpen`  — after the window opens (collapse the region / suppress the
 *                      dialog). Restore MUST be local-only (setIsExpanded), never
 *                      the persisted onNotesCollapseChange, whose parent swap
 *                      remounts SessionNotes and destroys the window — KD-6.
 *  - `onPopOutClose` — on close, with the surface the editor was popped out
 *                      FROM, so the host docks it back there (the inline region,
 *                      or the fullscreen editor).
 *
 * Returns `isSupported` (for the trigger gate), `isOpen`, the two triggers —
 * `onPopOut` (from the inline field) and `onPopOutFromFullscreen` (from the
 * fullscreen editor) — and the `shell` JSX (renders null when not popped out,
 * R2).
 */
type UseNotesPopOutParams = {
  onPopOutOpen: () => void;
  onPopOutClose: (origin: PopOutOrigin) => void;
  onOpenHaptic?: () => void;
  /** Heading text; the char count is appended by the shell title (R5 parity). */
  titleText: string;
  /**
   * The session these notes belong to — shown in the window's heading + title.
   * Omitted where `titleText` already IS the session name (session-list modal).
   */
  sessionName?: string;
  notes: string;
  onChange: (value: string) => void;
  maxLength: number;
  disabled?: boolean;
  attachments?: Attachment[];
  onRemoveAttachment?: (id: string) => void;
  onPaste?: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  onDragOver?: (e: React.DragEvent<HTMLTextAreaElement>) => void;
  onDragEnter?: (e: React.DragEvent<HTMLTextAreaElement>) => void;
  onDragLeave?: (e: React.DragEvent<HTMLTextAreaElement>) => void;
  onDrop?: (e: React.DragEvent<HTMLTextAreaElement>) => void;
  attachmentCount?: number;
  hasInvalidFiles?: boolean;
  onAttachmentClick?: () => void;
};

export function useNotesPopOut(params: UseNotesPopOutParams) {
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const originRef = useRef<PopOutOrigin>("inline");

  const win = usePopOutWindow({
    fullHeight: true,
    title: popOutWindowTitle(params.titleText, params.sessionName),
    onClose: () => {
      // Pop-in OR window close — both dock the editor back where it came from.
      paramsRef.current.onPopOutClose(originRef.current);
    },
  });

  const popOut = useCallback(
    (origin: PopOutOrigin) => {
      // A blocked window leaves the editor where it is.
      if (!win.open()) return;
      originRef.current = origin;
      paramsRef.current.onPopOutOpen();
      paramsRef.current.onOpenHaptic?.();
    },
    [win]
  );
  // Zero-arg triggers: both are handed to onClick, which would otherwise pass
  // its event object in as the origin.
  const onPopOut = useCallback(() => popOut("inline"), [popOut]);
  const onPopOutFromFullscreen = useCallback(
    () => popOut("fullscreen"),
    [popOut]
  );

  const onRequestClose = useCallback(() => win.close(), [win]);

  const editor = useNotesEditor({
    active: win.isOpen,
    notes: params.notes,
    onChange: params.onChange,
    maxLength: params.maxLength,
    disabled: params.disabled,
    onRequestClose,
  });

  const title = (
    <>
      <h2
        className={`text-base font-semibold ${
          params.sessionName ? "shrink-0" : "min-w-0 truncate"
        }`}
      >
        {params.titleText}
      </h2>
      <EditorSessionName name={params.sessionName} />
      <span className="shrink-0 text-xs text-[var(--app-hint)]">
        ({editor.localNotes.length}/{params.maxLength})
      </span>
    </>
  );

  const shell = (
    <PopOutEditorShell
      win={win}
      title={title}
      toolbar={
        <NotesEditorToolbar
          controller={editor}
          attachmentCount={params.attachmentCount}
          hasInvalidFiles={params.hasInvalidFiles}
          onAttachmentClick={params.onAttachmentClick}
        />
      }
      onRequestClose={onRequestClose}
    >
      <NotesEditorBody
        controller={editor}
        attachments={params.attachments}
        onRemoveAttachment={params.onRemoveAttachment}
        onPaste={params.onPaste}
        onDragOver={params.onDragOver}
        onDragEnter={params.onDragEnter}
        onDragLeave={params.onDragLeave}
        onDrop={params.onDrop}
      />
    </PopOutEditorShell>
  );

  return {
    isSupported: win.isSupported,
    isOpen: win.isOpen,
    onPopOut,
    onPopOutFromFullscreen,
    shell,
  };
}
