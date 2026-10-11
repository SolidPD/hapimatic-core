// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useMemo, useState } from "react";
import { parseNotes } from "@hapi/protocol";
import type { ApiClient } from "@/api/client";
import { SessionNotesEditorModal } from "@/components/SessionNotesEditorModal";
import { usePlatform } from "@/hooks/usePlatform";
import { useNotesPopOut } from "@/components/NotesPopOut";
import {
  useSessionNotesAutosave,
  MAX_NOTES_LENGTH,
} from "@/hooks/useSessionNotesAutosave";

/**
 * Editable, auto-saving session-notes modal opened from a session-list card's
 * circle-i (issue #1617). Replaces the read-only `SessionNotesModal`.
 *
 * A thin wrapper: it decodes the opaque persisted value ONCE, drives the shared
 * `useSessionNotesAutosave` hook (500 ms debounce + optimistic cache/federation
 * update, DRY with the in-session editor), and renders the parameterized
 * `SessionNotesEditorModal` at the ~75vh size.
 *
 * 🔴 R9 (envelope preservation): this surface edits TEXT ONLY and round-trips
 * the prior attachments untouched — it has no upload affordance, so
 * `getAttachments` is a pure pass-through of the decoded envelope's attachments.
 *
 * #3517 Task 10: this surface keeps a working pop-out even though KD-1 lifted the
 * pop-out capability out of SessionNotesEditorModal. Since it never renders
 * SessionNotes (which hosts the in-session pop-out), it hosts its OWN
 * PopOutEditorShell here via useNotesPopOut. There is no collapse state — opening
 * the pop-out SUPPRESSES the dialog (R2: no scrim behind the popped-out editor) and
 * closing it restores the dialog. This is the THIRD live usePopOutWindow instance;
 * each instance opens and closes only its own window (R9), so it coexists with
 * the in-session prompt and notes pop-outs.
 */
export function SessionListNotesModal(props: {
  api: ApiClient | null;
  sessionId: string;
  sessionName: string;
  /** The opaque persisted notes value (a NotesContent envelope or legacy string). */
  initialNotes: string | undefined;
  isOpen: boolean;
  onClose: () => void;
}) {
  const { api, sessionId, sessionName, initialNotes, isOpen, onClose } = props;

  // Decode the opaque incoming value ONCE. The list editor never mutates the
  // attachment set, so the decoded attachments are the pass-through baseline
  // (both the save-envelope baseline and the live getAttachments source).
  const parsed = useMemo(() => parseNotes(initialNotes), [initialNotes]);

  const { notes, handleChange, flush } = useSessionNotesAutosave({
    api,
    sessionId,
    initialNotes: parsed.text,
    initialAttachments: parsed.attachments,
    getAttachments: () => parsed.attachments,
  });

  // Flush any pending debounced save before closing so the circle-i title /
  // hover preview reflect the edit immediately (the flush routes through the
  // optimistic mutation). The hook's unmount flush is the safety net for an
  // abrupt close that skips this path.
  const handleClose = useCallback(() => {
    void flush();
    onClose();
  }, [flush, onClose]);

  // #3517 Task 10: notes pop-out. Opening suppresses the dialog (R2), closing
  // restores it. Text-only (R9 envelope preservation) — no attachments/paperclip.
  const { isTouch } = usePlatform();
  const [dialogSuppressed, setDialogSuppressed] = useState(false);
  const notesPopOut = useNotesPopOut({
    titleText: sessionName,
    notes,
    onChange: handleChange,
    maxLength: MAX_NOTES_LENGTH,
    onPopOutOpen: () => setDialogSuppressed(true),
    onPopOutClose: () => setDialogSuppressed(false),
  });

  return (
    <>
      {notesPopOut.shell}
      {/* Suppress (unmount) the dialog while popped out so no scrim renders
          behind the popped-out editor (R2). Conditional rendering does NOT fire
          Radix onOpenChange, so this never triggers handleClose's teardown. */}
      {!dialogSuppressed && (
        <SessionNotesEditorModal
          isOpen={isOpen}
          onClose={handleClose}
          notes={notes}
          onChange={handleChange}
          maxLength={MAX_NOTES_LENGTH}
          size="threeQuarter"
          title={sessionName}
          onPopOut={
            notesPopOut.isSupported && !isTouch
              ? notesPopOut.onPopOut
              : undefined
          }
        />
      )}
    </>
  );
}
