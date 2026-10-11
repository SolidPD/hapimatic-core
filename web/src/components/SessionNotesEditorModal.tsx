// SPDX-License-Identifier: AGPL-3.0-only
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { CloseIcon, PopOutIcon } from "@/components/ui/icons";
import { TouchButton } from "@/components/ui/TouchButton";
import { EditorSessionName } from "@/components/PopOutEditorShell";
import {
  useNotesEditor,
  NotesEditorToolbar,
  NotesEditorBody,
} from "@/components/NotesEditorBody";
import { type Attachment } from "@/lib/attachment-store";

type SessionNotesEditorModalProps = {
  isOpen: boolean;
  onClose: () => void;
  notes: string;
  onChange: (value: string) => void;
  maxLength: number;
  disabled?: boolean;
  /**
   * Notes attachments (issue #1075) — shown as read/removable chips in the
   * fullscreen editor. Files can also be ADDED here when the parent wires it
   * (parity with the inline notes field): paste / drag-drop via `onPaste` /
   * `onDrop`, and the toolbar paperclip via `onAttachmentClick`. The
   * session-list surface wires none of these and stays read/remove-only.
   */
  attachments?: Attachment[];
  onRemoveAttachment?: (id: string) => void;
  /**
   * Attachment parity with the inline notes field: the parent's own paste and
   * drag-drop attachment handlers (e.g. SessionNotes') attach to this textarea
   * so a pasted or dropped file attaches from the fullscreen surface.
   */
  onPaste?: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  onDragOver?: (e: React.DragEvent<HTMLTextAreaElement>) => void;
  onDragLeave?: (e: React.DragEvent<HTMLTextAreaElement>) => void;
  onDrop?: (e: React.DragEvent<HTMLTextAreaElement>) => void;
  /**
   * Toolbar paperclip — mirrors the prompt editor's button: gray empty, accent
   * with files, red when any file is invalid, with a count badge. Rendered only
   * when `onAttachmentClick` is wired; the session-list notes modal omits it
   * because that surface edits text only (#1617 R9, envelope preservation).
   */
  attachmentCount?: number;
  hasInvalidFiles?: boolean;
  onAttachmentClick?: () => void;
  /**
   * Issue #1617: the dialog size. "fullscreen" (default) is the in-session
   * editor; "threeQuarter" is the ~75vh centered variant used by the session-
   * list notes modal.
   */
  size?: "fullscreen" | "threeQuarter";
  /**
   * Dialog title (default "Session Notes"). The session-list modal passes the
   * session name.
   */
  title?: string;
  /**
   * The session these notes belong to, shown beside the title: fullscreen
   * covers the thread, so the editor itself has to say whose notes they are.
   * Omitted where `title` already IS the session name (session-list modal).
   */
  sessionName?: string;
  /**
   * #3517 Task 10: optional pop-out trigger, surfaced as a Pop-out button in
   * this header. KD-1 lifts the pop-out capability to the hosts, so this only
   * renders the button — the host owns the pop-out window + shell and closes this Dialog.
   * Both hosts wire it: the in-session fullscreen editor (SessionNotes, whose
   * pop-out docks back INTO this Dialog on Pop-in) and the session-list notes
   * modal. Left undefined on touch / browsers without a pop-out.
   */
  onPopOut?: () => void;
};

/**
 * The session-notes editor Dialog (fullscreen or ~75vh "threeQuarter"). Since
 * #3517 (KD-1) the pop-out capability is LIFTED OUT of this Dialog up to the
 * notes hosts (SessionNotes for the in-session editor, SessionListNotesModal for
 * the session-list card), so this component is now purely the notes Dialog: a
 * Radix Dialog wrapping the shared NotesEditorBody + NotesEditorToolbar, driven
 * by the shared useNotesEditor controller (R5 / R6).
 */
export function SessionNotesEditorModal(props: SessionNotesEditorModalProps) {
  const {
    isOpen,
    onClose,
    notes,
    onChange,
    maxLength,
    disabled = false,
    attachments,
    onRemoveAttachment,
    onPaste,
    onDragOver,
    onDragLeave,
    onDrop,
    attachmentCount = 0,
    hasInvalidFiles = false,
    onAttachmentClick,
    size = "fullscreen",
    title = "Session Notes",
    sessionName,
    onPopOut,
  } = props;

  const editor = useNotesEditor({
    active: isOpen,
    notes,
    onChange,
    maxLength,
    disabled,
    onRequestClose: onClose,
  });

  return (
    <Dialog open={isOpen} onOpenChange={open => !open && onClose()}>
      <DialogContent
        {...(size === "threeQuarter"
          ? { heightVariant: "threeQuarter" as const, hideCloseButton: true }
          : { fullscreen: true })}
        className="flex flex-col p-0 gap-0"
      >
        <DialogHeader className="px-4 py-2 border-b border-[var(--app-divider)] shrink-0">
          {/* #1617 round-3 feedback: TWO-ROW header. Row 1: title + char count +
              close. Row 2: the full toolbar, always visible. */}
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-baseline gap-2">
                <DialogTitle
                  className={`text-base font-semibold ${
                    sessionName ? "shrink-0" : "min-w-0 truncate"
                  }`}
                >
                  {title}
                </DialogTitle>
                <EditorSessionName name={sessionName} />
                <span className="shrink-0 text-xs text-[var(--app-hint)]">
                  ({editor.localNotes.length}/{maxLength})
                </span>
              </div>
              <DialogDescription className="sr-only">
                Edit session notes
              </DialogDescription>
              <TouchButton
                onAction={onClose}
                className="shrink-0 p-1.5 rounded-full transition-colors text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-hover)]"
                title="Close"
              >
                <CloseIcon className="h-4 w-4" />
              </TouchButton>
            </div>

            {/* Toolbar row — right-justified (round-4 feedback). */}
            <div className="flex items-center justify-end gap-2">
              <NotesEditorToolbar
                controller={editor}
                attachmentCount={attachmentCount}
                hasInvalidFiles={hasInvalidFiles}
                onAttachmentClick={onAttachmentClick}
              />
              {/* #3517 Task 10: pop-out trigger, only when the host wires it. */}
              {onPopOut ? (
                <>
                  <div className="w-px h-4 bg-[var(--app-divider)] mx-1" />
                  <TouchButton
                    onAction={onPopOut}
                    className="p-1.5 rounded-full transition-colors text-[var(--app-hint)] hover:text-[var(--app-link)] hover:bg-[var(--app-hover)]"
                    title="Pop out to a separate window"
                  >
                    <PopOutIcon className="h-4 w-4" />
                  </TouchButton>
                </>
              ) : null}
            </div>
          </div>
        </DialogHeader>

        <NotesEditorBody
          controller={editor}
          attachments={attachments}
          onRemoveAttachment={onRemoveAttachment}
          onPaste={onPaste}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        />
      </DialogContent>
    </Dialog>
  );
}
