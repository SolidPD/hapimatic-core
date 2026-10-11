// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useRef, useState } from "react";
import {
  serializeNotes,
  MAX_NOTES_TEXT_LENGTH,
  type NotesContent,
  type NotesAttachment,
} from "@hapi/protocol";
import type { ApiClient } from "@/api/client";
import { useUpdateSessionNotes } from "@/hooks/mutations/useUpdateSessionNotes";

/**
 * Notes text cap. Re-exported from the #1075 content model so there is a SINGLE
 * definition (it was previously re-declared as a literal in SessionNotes.tsx and
 * imported from there by SessionChat).
 */
export const MAX_NOTES_LENGTH = MAX_NOTES_TEXT_LENGTH;

/** Autosave debounce window (ms). */
export const DEBOUNCE_MS = 500;

export interface UseSessionNotesAutosave {
  /** Current notes text (the hook owns this state). */
  notes: string;
  /** Set the text (+ notify parent + clear error). Caps at MAX_NOTES_LENGTH. */
  handleChange: (value: string) => void;
  /**
   * Persist a SPECIFIC envelope immediately (cancels any pending debounce).
   * Dedups internally against the last-saved value. Used by clear / move-to-
   * composer, which save an explicit envelope rather than the current state.
   */
  saveEnvelope: (content: NotesContent) => Promise<void>;
  /** Cancel the debounce and immediately save the CURRENT envelope (blur/close). */
  flush: () => Promise<void>;
  isSaving: boolean;
  error: string | null;
  /** Suppress server→local sync while the user is actively editing. */
  markEditing: () => void;
  endEditing: () => void;
}

/**
 * Shared notes autosave machinery (issue #1617, R3).
 *
 * Extracted from SessionNotes.tsx so BOTH the in-session notes field and the
 * new session-list editable modal consume ONE debounce / flush / dedup /
 * editing-guard implementation — no duplicated save logic.
 *
 * 🔴 R9 (envelope preservation): the hook's save unit is always a
 * `NotesContent` envelope (`{ text, attachments }`), never `string | null`. The
 * consumer supplies `getAttachments`; the hook composes the envelope on every
 * save so no save path can drop the session's attachments. Normal saves route
 * through the optimistic `useUpdateSessionNotes` mutation (R4); the unmount
 * flush uses `api.updateSessionNotes` directly to avoid setState on an
 * unmounting component (#2766).
 */
export function useSessionNotesAutosave(opts: {
  api: ApiClient | null;
  sessionId: string | null;
  initialNotes?: string;
  /** Persisted attachment baseline (drives the save envelope + server sync). */
  initialAttachments?: NotesAttachment[];
  /**
   * Live attachment set — read on every render so a change to text OR the
   * attachment set schedules exactly one debounced save (#1075 unified trigger).
   */
  getAttachments: () => NotesAttachment[];
  /** Lift text changes to a parent (SessionChat's move-to-composer state). */
  onNotesChange?: (text: string) => void;
  /**
   * Fired when the hook hydrates from a server value (session switch / mount /
   * cross-device push). The consumer uses it to hydrate its own attachment
   * store and any derived UI (e.g. expand state).
   */
  onHydrate?: (attachments: NotesAttachment[]) => void;
}): UseSessionNotesAutosave {
  const {
    api,
    sessionId,
    initialNotes = "",
    initialAttachments,
    getAttachments,
    onNotesChange,
    onHydrate,
  } = opts;

  const { updateNotes } = useUpdateSessionNotes(api, sessionId);

  const [notes, setNotes] = useState(initialNotes);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // #1075: lastSavedRef holds the last SERIALIZED envelope written to the
  // server, so a change to EITHER the text or the attachment set triggers a
  // single debounced save.
  const lastSavedRef = useRef<string | null>(
    serializeNotes({
      text: initialNotes,
      attachments: initialAttachments ?? [],
    })
  );
  // #2766 + #1075: the NotesContent scheduled for a debounced save (null =
  // nothing pending). Read by the unmount / session-change flush so navigating
  // away inside the 500 ms debounce window doesn't drop it.
  const pendingContentRef = useRef<NotesContent | null>(null);
  // #1075: count of saves currently in flight. While non-zero the local
  // envelope is strictly NEWER than the server's, so the sync effect must not
  // re-hydrate from a stale server snapshot.
  const saveInFlightRef = useRef(0);
  // Distinguishes mount / a genuine session switch (unconditional re-sync) from
  // a same-session props echo. Starts null so the FIRST run always hydrates.
  const prevSessionIdRef = useRef<string | null>(null);
  // Live mirror of the notes text, read by the blur/flush/unmount paths.
  const notesRef = useRef(initialNotes);
  const isEditingRef = useRef(false);
  // Live mirror of getAttachments so blur/flush/unmount read the latest set
  // without re-creating callbacks per keystroke.
  const getAttachmentsRef = useRef(getAttachments);
  getAttachmentsRef.current = getAttachments;

  notesRef.current = notes;

  const markEditing = useCallback(() => {
    isEditingRef.current = true;
  }, []);
  const endEditing = useCallback(() => {
    isEditingRef.current = false;
  }, []);

  const handleChange = useCallback(
    (value: string) => {
      const capped = value.slice(0, MAX_NOTES_LENGTH);
      setNotes(capped);
      onNotesChange?.(capped);
      setError(null);
    },
    [onNotesChange]
  );

  const saveEnvelope = useCallback(
    async (content: NotesContent) => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
      if (!api || !sessionId) return;
      const serialized = serializeNotes(content);
      if (serialized === lastSavedRef.current) return;

      // Committed to persisting this content — clear the pending marker so a
      // concurrent unmount flush (the list modal's close→flush→unmount path)
      // doesn't redundantly re-save the same envelope via the direct-api path.
      // The blur/debounce paths in SessionNotes await their save, so this is a
      // no-op there; it only matters for the fire-and-unmount list path.
      pendingContentRef.current = null;
      saveInFlightRef.current += 1;
      setIsSaving(true);
      setError(null);
      try {
        // Route through the optimistic mutation (R4): updates the 3 caches +
        // federation override so the list preview reflects the edit at once.
        await updateNotes(content);
        lastSavedRef.current = serialized;
      } catch (e) {
        setError("Failed to save notes");
        console.error("Failed to save session notes:", e);
      } finally {
        saveInFlightRef.current -= 1;
        setIsSaving(false);
      }
    },
    [api, sessionId, updateNotes]
  );

  const flush = useCallback(async () => {
    await saveEnvelope({
      text: notesRef.current,
      attachments: getAttachmentsRef.current(),
    });
  }, [saveEnvelope]);

  // Unified debounce: the serialized envelope is the SINGLE save trigger — a
  // change to text OR the attachment set schedules one debounced save (#1075,
  // eliminates the two-writer race).
  const currentSerialized = serializeNotes({
    text: notes,
    attachments: getAttachments(),
  });
  useEffect(() => {
    if (currentSerialized === lastSavedRef.current) return;
    pendingContentRef.current = {
      text: notesRef.current,
      attachments: getAttachmentsRef.current(),
    };
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      if (pendingContentRef.current) {
        void saveEnvelope(pendingContentRef.current);
      }
    }, DEBOUNCE_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSerialized]);

  // Sync local state from the server-persisted value (session switch, mount,
  // cross-device push). Skip while editing to prevent character drops (#2766).
  // Hydrates BOTH text and attachments (via onHydrate) and resets the baseline.
  //
  // 🔴 Echo/staleness guards (#1075 data-loss fix): this effect ALSO fires when
  // a local mutation lifts text via onNotesChange (SessionChat feeds it back as
  // initialNotes) and when the session object refreshes after our own save.
  // Outside a session switch, sync ONLY when the incoming envelope is a genuine
  // external change: no save in flight, no unsaved pending debounce, and not the
  // echo of our own last save.
  const persistedAttachKey = (initialAttachments ?? [])
    .map(a => a.id)
    .join(",");
  useEffect(() => {
    const sessionChanged = prevSessionIdRef.current !== sessionId;
    prevSessionIdRef.current = sessionId;
    if (!sessionChanged) {
      if (isEditingRef.current) return;
      const pendingUnsaved =
        pendingContentRef.current !== null &&
        serializeNotes(pendingContentRef.current) !== lastSavedRef.current;
      if (saveInFlightRef.current > 0 || pendingUnsaved) return;
      const incoming = serializeNotes({
        text: initialNotes,
        attachments: initialAttachments ?? [],
      });
      if (incoming === lastSavedRef.current) return;
    }

    setNotes(initialNotes);
    onHydrate?.(initialAttachments ?? []);
    lastSavedRef.current = serializeNotes({
      text: initialNotes,
      attachments: initialAttachments ?? [],
    });
    // A session switch supersedes any pending flush from the prior session.
    pendingContentRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialNotes, sessionId, persistedAttachKey]);

  // Flush a pending debounced save on unmount / session change (#2766). An iOS
  // swipe-back / in-app navigation can unmount without firing blur, dropping a
  // save scheduled inside the 500 ms window. Flush via api.updateSessionNotes
  // DIRECTLY (not the mutation, which would setState on an unmounting
  // component). Envelope-shaped (R9). Deps [api, sessionId] so a session switch
  // flushes the outgoing session's pending value before the sync effect resets.
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      const pending = pendingContentRef.current;
      if (
        api &&
        sessionId &&
        pending !== null &&
        serializeNotes(pending) !== lastSavedRef.current
      ) {
        void api.updateSessionNotes(sessionId, pending).catch(() => {
          // Best-effort flush during teardown; nothing to recover to.
        });
      }
    };
  }, [api, sessionId]);

  return {
    notes,
    handleChange,
    saveEnvelope,
    flush,
    isSaving,
    error,
    markEditing,
    endEditing,
  };
}
