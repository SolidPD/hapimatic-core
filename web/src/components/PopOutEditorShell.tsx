// SPDX-License-Identifier: AGPL-3.0-only
import { createPortal } from "react-dom";
import {
  PopInIcon,
  UiCopyIcon,
  UiCheckIcon,
  TrashIcon,
} from "@/components/ui/icons";
import {
  ChevronUpIcon,
  ChevronDownIcon,
  PaperclipIcon,
} from "@/components/icons";
import { TouchButton } from "@/components/ui/TouchButton";
import type { UsePopOutWindowReturn } from "@/hooks/usePopOutWindow";

/**
 * Which surface an editor was popped out FROM — and therefore where its Pop-in
 * docks it back to: the inline field in the thread, or the fullscreen editor.
 */
export type PopOutOrigin = "inline" | "fullscreen";

/**
 * The session an editor belongs to, shown beside the editor's heading in every
 * pop-out window and fullscreen editor — so a window (or a fullscreen view
 * covering the thread) can be told apart from another session's without
 * closing it. Renders nothing without a name.
 */
export function EditorSessionName({ name }: { name?: string }) {
  if (!name) return null;
  return (
    <span
      data-testid="editor-session-name"
      title={name}
      className="min-w-0 truncate text-xs text-[var(--app-hint)]"
    >
      {name}
    </span>
  );
}

/** A pop-out window's title: the session first, so the taskbar tells windows apart. */
export function popOutWindowTitle(label: string, sessionName?: string): string {
  return sessionName ? `${sessionName} — ${label}` : label;
}

type PopOutEditorShellProps = {
  /**
   * The lifted `usePopOutWindow` instance, owned by the host (one per host).
   * Lifting it up (rather than owning it inside the shell) lets the host gate
   * its trigger on `win.isSupported && !isTouch`, drive `win.open()`, and own
   * the collapse/restore (R4) + close-reason logic. This is the "lift the
   * instance into the parent" option from the #3517 directive Task 3.
   */
  win: UsePopOutWindowReturn;
  /**
   * Header title. Typed `React.ReactNode` (not `string`) so the notes surface
   * can carry a live char-count span beside the heading (R5 parity).
   */
  title: React.ReactNode;
  /** Optional toolbar rendered in the header, before the Pop-in button. */
  toolbar?: React.ReactNode;
  /**
   * Called when the user clicks the header Pop-in button (user-initiated). The
   * host closes the window; its close handler docks the editor back where it was
   * popped out from (the inline field, or the fullscreen editor).
   */
  onRequestClose: () => void;
  /** The editor body, portaled into the pop-out window's document. */
  children: React.ReactNode;
};

/**
 * The single shared pop-out window shell (R6). Owns the pop-out window's
 * chrome — a header (title + optional toolbar slot + Pop-in button, the
 * opposing control to the editors' Pop-out button) and the `createPortal`
 * wiring that renders `children` (the editor body) into the window's document. It replaces the two hand-rolled `pipContent` blocks that lived
 * in `FullscreenPromptEditorModal` and `SessionNotesEditorModal`.
 *
 * Renders NOTHING when not popped out (R2 — no blocking modal/scrim behind the
 * popped-out editor). That `null` return is also what keeps the
 * exactly-2-open-dialogs assertion in `SessionNotes.test.tsx` valid.
 */
export function PopOutEditorShell({
  win,
  title,
  toolbar,
  onRequestClose,
  children,
}: PopOutEditorShellProps) {
  if (!win.isOpen || !win.container) return null;

  return createPortal(
    <div
      className="flex flex-col bg-[var(--app-bg)] text-[var(--app-fg)]"
      style={{ height: "100%" }}
    >
      {/* Pop-out header — mirrors the removed hand-rolled pipContent headers */}
      <div className="px-4 py-3 border-b border-[var(--app-divider)] shrink-0">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-baseline gap-2">{title}</div>
          <div className="flex items-center gap-2">
            {toolbar}
            {toolbar ? (
              <div className="w-px h-4 bg-[var(--app-divider)] mx-1" />
            ) : null}
            <TouchButton
              onAction={onRequestClose}
              className="p-1.5 rounded-full transition-colors text-[var(--app-hint)] hover:text-[var(--app-link)] hover:bg-[var(--app-hover)]"
              title="Pop back in"
            >
              <PopInIcon className="h-4 w-4" />
            </TouchButton>
          </div>
        </div>
      </div>
      {children}
    </div>,
    win.container
  );
}

type EditorToolbarProps = {
  hasContent: boolean;
  copyFeedback: boolean;
  onCopy: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onClear: () => void;
  /** "Clear message" (prompt) vs "Clear notes" (notes) — Task 6 difference #4. */
  clearTitle: string;
  /**
   * Optional paperclip. Present only when the surface wires attachments. The
   * `disabled` field (Task 6 difference #1) is set by the notes toolbar and left
   * undefined by the prompt toolbar; the `disabled:` classes are inert when so.
   */
  attachment?: {
    count: number;
    hasInvalid: boolean;
    onClick: () => void;
    disabled?: boolean;
  };
};

/**
 * The shared editor toolbar cluster (Copy / Move-up / Move-down / paperclip? /
 * Clear) rendered in the shell header and the fullscreen Dialog header, for
 * BOTH the prompt and notes editors (R6 / KD-2). The four prompt/notes
 * differences the directive enumerates are parameterized: the Clear title, the
 * Clear handler, the paperclip `disabled`, and the badge token (standardized
 * here on `--text-caption-xs`, resolving difference #2).
 */
export function EditorToolbar({
  hasContent,
  copyFeedback,
  onCopy,
  onMoveUp,
  onMoveDown,
  canMoveUp,
  canMoveDown,
  onClear,
  clearTitle,
  attachment,
}: EditorToolbarProps) {
  return (
    <>
      {/* Copy button */}
      <TouchButton
        onAction={onCopy}
        disabled={!hasContent}
        className={`p-1.5 rounded-full transition-colors ${
          hasContent
            ? "text-[var(--app-hint)] hover:text-[var(--app-link)] hover:bg-[var(--app-hover)]"
            : "text-[var(--app-hint)] opacity-30 cursor-not-allowed"
        }`}
        title={copyFeedback ? "Copied!" : "Copy to clipboard"}
      >
        {copyFeedback ? (
          <UiCheckIcon className="h-4 w-4 text-[var(--app-success)]" />
        ) : (
          <UiCopyIcon className="h-4 w-4" />
        )}
      </TouchButton>

      {/* Move line up */}
      <TouchButton
        onAction={onMoveUp}
        disabled={!canMoveUp}
        className={`p-1.5 rounded-full transition-colors ${
          canMoveUp
            ? "text-[var(--app-hint)] hover:text-[var(--app-link)] hover:bg-[var(--app-hover)]"
            : "text-[var(--app-hint)] opacity-30 cursor-not-allowed"
        }`}
        title="Move line up"
      >
        <ChevronUpIcon className="h-4 w-4" />
      </TouchButton>

      {/* Move line down */}
      <TouchButton
        onAction={onMoveDown}
        disabled={!canMoveDown}
        className={`p-1.5 rounded-full transition-colors ${
          canMoveDown
            ? "text-[var(--app-hint)] hover:text-[var(--app-link)] hover:bg-[var(--app-hover)]"
            : "text-[var(--app-hint)] opacity-30 cursor-not-allowed"
        }`}
        title="Move line down"
      >
        <ChevronDownIcon className="h-4 w-4" />
      </TouchButton>

      {/* Attachment (paperclip) — rendered only when the surface wires it */}
      {attachment ? (
        <TouchButton
          onAction={attachment.onClick}
          disabled={attachment.disabled}
          className={`relative p-1.5 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
            attachment.count > 0 && attachment.hasInvalid
              ? "bg-red-500/20 text-red-500 hover:bg-red-500/30"
              : attachment.count > 0
                ? "bg-[var(--app-link)]/20 text-[var(--app-link)] hover:bg-[var(--app-link)]/30"
                : "text-[var(--app-hint)] hover:bg-[var(--app-hover)] hover:text-[var(--app-fg)]"
          }`}
          aria-label={
            attachment.count > 0
              ? `${attachment.count} file${attachment.count > 1 ? "s" : ""} attached - click to manage`
              : "Attach files"
          }
          title={
            attachment.count > 0
              ? `${attachment.count} file${attachment.count > 1 ? "s" : ""} attached - click to manage`
              : "Attach files"
          }
        >
          <PaperclipIcon />
          {attachment.count > 0 && (
            <span
              className={`absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[length:var(--text-caption-xs)] font-bold ${
                attachment.hasInvalid
                  ? "bg-red-500 text-white"
                  : "bg-[var(--app-link)] text-[var(--app-bg)]"
              }`}
            >
              {attachment.count}
            </span>
          )}
        </TouchButton>
      ) : null}

      {/* Clear button */}
      <TouchButton
        onAction={onClear}
        disabled={!hasContent}
        className={`p-1.5 rounded-full transition-colors ${
          hasContent
            ? "text-[var(--app-hint)] hover:text-red-400 hover:bg-[var(--app-hover)]"
            : "text-[var(--app-hint)] opacity-30 cursor-not-allowed"
        }`}
        title={clearTitle}
      >
        <TrashIcon className="h-4 w-4" />
      </TouchButton>
    </>
  );
}
