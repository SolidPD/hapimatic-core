// SPDX-License-Identifier: AGPL-3.0-only
import { useState, useEffect, useRef, useCallback } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { EditorToolbar } from "@/components/PopOutEditorShell";
import {
  moveLineUp,
  moveLineDown,
  isFirstLine,
  isLastLine,
} from "@/utils/moveLines";
import { handleIndentKeyDown } from "@/utils/indentLines";
import { NotesAttachmentChips } from "@/components/NotesAttachmentChips";
import { type Attachment } from "@/lib/attachment-store";

/**
 * useNotesEditor — the shared notes-editor controller (#3517 Task 6).
 *
 * Mirror of usePromptEditor for session notes: one state instance feeds both the
 * header toolbar and the body across the three notes consumers (in-session notes,
 * fullscreen notes Dialog, session-list notes modal — R5 / R10 / R6).
 *
 * Notes-specific vs prompt: a `maxLength` cap on every write, the local mirror
 * synced ONLY on the closed→open transition (a 10s federation poll must never
 * clobber mid-edit state — issue #1617), no kiosk IME, no send/ComposerButtons.
 *
 * WORKER DECISION (directive Task 6): `textareaRef` and the `localNotes`
 * text-mirror live HERE in the controller — a single owner, never duplicated in
 * a consumer.
 */
type UseNotesEditorParams = {
  /** Is this notes surface currently shown (dialog/modal open OR popped out)? */
  active: boolean;
  notes: string;
  onChange: (value: string) => void;
  maxLength: number;
  disabled?: boolean;
  /** Close the current surface (Escape). Dialog: onClose; pop-out: win.close(). */
  onRequestClose: () => void;
};

export function useNotesEditor(params: UseNotesEditorParams) {
  const {
    active,
    notes,
    onChange,
    maxLength,
    disabled = false,
    onRequestClose,
  } = params;

  const [localNotes, setLocalNotes] = useState(notes);
  const [copyFeedback, setCopyFeedback] = useState(false);
  const [cursorPos, setCursorPos] = useState(0);
  const [clearDialogOpen, setClearDialogOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { showToast } = useToast();

  // Sync local state ONLY on the closed→open transition (issue #1617). Syncing
  // on every `notes` change while active would let a 10s federation poll
  // overwrite mid-edit state; callers round-trip their own onChange.
  const wasActiveRef = useRef(false);
  useEffect(() => {
    if (active && !wasActiveRef.current) {
      setLocalNotes(notes);
    }
    wasActiveRef.current = active;
  }, [active, notes]);

  // Focus the textarea when the surface becomes active.
  useEffect(() => {
    if (active && textareaRef.current) {
      const timer = setTimeout(() => {
        textareaRef.current?.focus();
      }, 100);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [active]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value.slice(0, maxLength);
      setLocalNotes(value);
      onChange(value);
    },
    [maxLength, onChange]
  );

  const copyToClipboard = useCallback(async () => {
    if (!localNotes) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(localNotes);
      } else {
        const textArea = document.createElement("textarea");
        textArea.value = localNotes;
        textArea.style.position = "fixed";
        textArea.style.left = "-9999px";
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand("copy");
        document.body.removeChild(textArea);
      }
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 1500);
    } catch (err) {
      console.error("Copy failed:", err);
      showToast("Failed to copy notes", { type: "error" });
    }
  }, [localNotes, showToast]);

  const doClear = useCallback(async () => {
    setLocalNotes("");
    onChange("");
  }, [onChange]);

  const handleClear = useCallback(() => {
    setClearDialogOpen(true);
  }, []);

  const applyMove = useCallback(
    (moveFn: typeof moveLineUp) => {
      const ta = textareaRef.current;
      if (!ta) return;
      const pos = ta.selectionStart;
      const result = moveFn(localNotes, pos);
      if (!result) return;
      const value = result.text.slice(0, maxLength);
      setLocalNotes(value);
      onChange(value);
      setCursorPos(result.cursorPos);
      requestAnimationFrame(() => {
        ta.setSelectionRange(result.cursorPos, result.cursorPos);
        ta.focus();
      });
    },
    [localNotes, maxLength, onChange]
  );

  const cursorDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );
  const handleCursorChange = useCallback(
    (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
      const pos = (e.target as HTMLTextAreaElement).selectionStart;
      if (cursorDebounceRef.current) clearTimeout(cursorDebounceRef.current);
      cursorDebounceRef.current = setTimeout(() => setCursorPos(pos), 150);
    },
    []
  );

  const hasContent = localNotes.length > 0;

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Avoid intercepting IME composition keystrokes (mirror HappyComposer).
      if (e.nativeEvent.isComposing) return;

      if (e.key === "Escape") {
        e.preventDefault();
        onRequestClose();
        return;
      }

      // Tab / Shift+Tab indent + outdent, capped to maxLength.
      const indent = handleIndentKeyDown(e, e.currentTarget);
      if (indent) {
        const ta = e.currentTarget;
        const value = indent.text.slice(0, maxLength);
        const selStart = Math.min(indent.selectionStart, value.length);
        const selEnd = Math.min(indent.selectionEnd, value.length);
        setLocalNotes(value);
        onChange(value);
        setCursorPos(selStart);
        requestAnimationFrame(() => {
          ta.setSelectionRange(selStart, selEnd);
        });
      }
    },
    [maxLength, onChange, onRequestClose]
  );

  return {
    localNotes,
    cursorPos,
    copyFeedback,
    hasContent,
    clearDialogOpen,
    setClearDialogOpen,
    doClear,
    textareaRef,
    handleChange,
    handleCursorChange,
    handleKeyDown,
    copyToClipboard,
    applyMove,
    handleClear,
    canMoveUp: hasContent && !disabled && !isFirstLine(localNotes, cursorPos),
    canMoveDown: hasContent && !disabled && !isLastLine(localNotes, cursorPos),
    disabled,
    maxLength,
  };
}

export type NotesEditorController = ReturnType<typeof useNotesEditor>;

type NotesEditorToolbarProps = {
  controller: NotesEditorController;
  attachmentCount?: number;
  hasInvalidFiles?: boolean;
  onAttachmentClick?: () => void;
};

/**
 * The notes editor's header toolbar. Wraps the shared EditorToolbar with the
 * notes-specific Clear title ("Clear notes") and a paperclip that carries
 * `disabled` (Task 6 difference #1 vs the prompt paperclip).
 */
export function NotesEditorToolbar({
  controller,
  attachmentCount = 0,
  hasInvalidFiles = false,
  onAttachmentClick,
}: NotesEditorToolbarProps) {
  return (
    <EditorToolbar
      hasContent={controller.hasContent}
      copyFeedback={controller.copyFeedback}
      onCopy={controller.copyToClipboard}
      onMoveUp={() => controller.applyMove(moveLineUp)}
      onMoveDown={() => controller.applyMove(moveLineDown)}
      canMoveUp={controller.canMoveUp}
      canMoveDown={controller.canMoveDown}
      onClear={controller.handleClear}
      clearTitle="Clear notes"
      attachment={
        onAttachmentClick
          ? {
              count: attachmentCount,
              hasInvalid: hasInvalidFiles,
              onClick: onAttachmentClick,
              disabled: controller.disabled,
            }
          : undefined
      }
    />
  );
}

type NotesEditorBodyProps = {
  controller: NotesEditorController;
  attachments?: Attachment[];
  onRemoveAttachment?: (id: string) => void;
  onPaste?: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  onDragOver?: (e: React.DragEvent<HTMLTextAreaElement>) => void;
  onDragEnter?: (e: React.DragEvent<HTMLTextAreaElement>) => void;
  onDragLeave?: (e: React.DragEvent<HTMLTextAreaElement>) => void;
  onDrop?: (e: React.DragEvent<HTMLTextAreaElement>) => void;
};

/**
 * The notes editor body (attachment chips + textarea + Clear confirm), driven by
 * the shared controller. Reused by the fullscreen notes Dialog and the pop-out
 * window (R5 / R6). Drop must be wired explicitly (like the prompt side) — the
 * pop-out renders this outside the notes drop-zone so bubbling no longer reaches.
 */
export function NotesEditorBody({
  controller,
  attachments,
  onRemoveAttachment,
  onPaste,
  onDragOver,
  onDragEnter,
  onDragLeave,
  onDrop,
}: NotesEditorBodyProps) {
  return (
    <>
      {/* overflow-auto (not hidden) so iOS selection handle hit targets aren't clipped.
          A flex column so the textarea takes the height the attachment chips
          leave, instead of 100% PLUS the chips (which overflowed the surface). */}
      <div className="flex flex-1 flex-col p-4 overflow-auto">
        {attachments && attachments.length > 0 ? (
          <div className="mb-2 shrink-0">
            <NotesAttachmentChips
              attachments={attachments}
              onRemove={onRemoveAttachment ?? (() => {})}
              disabled={controller.disabled || !onRemoveAttachment}
            />
          </div>
        ) : null}
        <textarea
          autoCapitalize="none"
          ref={controller.textareaRef}
          value={controller.localNotes}
          onChange={controller.handleChange}
          onSelect={controller.handleCursorChange}
          onKeyDown={controller.handleKeyDown}
          onPaste={onPaste}
          onDragOver={onDragOver}
          onDragEnter={onDragEnter}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          disabled={controller.disabled}
          placeholder="Session notes (for your reference only)"
          maxLength={controller.maxLength}
          className="w-full min-h-24 flex-1 resize-none rounded-lg bg-[var(--app-secondary-bg)] border border-[var(--app-divider)] px-4 py-3 text-sm text-[var(--app-fg)] placeholder-[var(--app-hint)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)] disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ fontSize: "16px" }}
        />
      </div>

      {/* Clear notes confirmation dialog */}
      <ConfirmDialog
        isOpen={controller.clearDialogOpen}
        onClose={() => controller.setClearDialogOpen(false)}
        title="Clear Notes?"
        description="This will delete all notes for this session. This action cannot be undone."
        confirmLabel="Clear"
        confirmingLabel="Clearing..."
        onConfirm={controller.doClear}
        isPending={false}
        destructive
      />
    </>
  );
}
