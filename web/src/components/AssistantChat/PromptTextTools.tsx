// SPDX-License-Identifier: AGPL-3.0-only
import { type MouseEvent as ReactMouseEvent } from "react";
import { CopyButton } from "@/components/ui/CopyButton";
import { BareButton } from "@/components/ui/BareButton";
import {
  UiCopyIcon,
  UiCheckIcon,
  MaximizeIcon,
  PopOutIcon,
  TrashIcon,
} from "@/components/ui/icons";
import {
  ChevronUpIcon,
  ChevronDownIcon,
  ChevronsUpIcon,
  ChevronsDownIcon,
  PaperclipIcon,
} from "@/components/icons";

/**
 * PromptTextTools (issue #3289, S4) — the canonical 7-tool text-tools row shared
 * by BOTH the Prompt Field (Row 1) and the Notes Field (Row 1). This is a
 * RELOCATION of the strip that previously rendered hard-coded inside
 * `StatusBar.tsx` (the prompt cluster, gated by `showPromptControls`; #2882) and
 * inside `SessionNotes.tsx` — after #3289 exactly ONE instance of the strip
 * renders per surface (the duplicate-row failure mode is what V1 guards).
 *
 * The two surfaces are identical except the middle "push" tool:
 * - `direction="down"` (Prompt Field): **Push Down to Notes** (`ChevronsDownIcon`).
 * - `direction="up"` (Notes Field): **Push Up to Prompt** (`ChevronsUpIcon`).
 *
 * Order (both directions, per `docs/internal/architecture/ui-component-taxonomy.md`):
 * Copy · Move Line Up · Move Line Down · Push · Expand-Fullscreen · Attach
 * Paperclip · Trash/Delete.
 *
 * Presentational only — every handler is supplied by the caller so the existing
 * composer/notes behaviour (moveLines, onMoveToNotes/onMoveToComposer,
 * attachments, fullscreen) is REUSED, never re-implemented. LAYOUT ONLY: the
 * draft/attachment cross-device sync is owned by #3254 and is untouched here.
 *
 * Copy has two modes so each surface keeps its exact prior behaviour:
 * - `copyText` set → self-contained `CopyButton` (Notes, #3525).
 * - `onCopy` + `copyFeedback` → `BareButton` firing the caller's handler (the
 *   Prompt's `handleCopyPrompt`, which adds haptics + an error toast).
 *
 * Every button is a `BareButton` (the canonical `ghostStatic`/`bare`/
 * `tooltipOnDisabled` triple) styled entirely at this call site, matching the
 * densest existing consumer (`StatusBar.tsx`). All buttons preventDefault on
 * mousedown so tapping a tool never blurs the text field (load-bearing for the
 * Notes surface, whose move-line tools depend on the caret staying put).
 */
export interface PromptTextToolsProps {
  /** "down" = Prompt Field (Push Down to Notes); "up" = Notes Field (Push Up to Prompt). */
  direction: "down" | "up";
  disabled?: boolean;
  /** Whether the field has text — gates Copy / Move / Push / Delete. */
  hasContent?: boolean;
  // ── Copy ──────────────────────────────────────────────────────────
  /** Self-contained copy (Notes): render a `CopyButton` over this text. */
  copyText?: string;
  /** External copy handler (Prompt): render a `BareButton` firing this. */
  onCopy?: () => void;
  /** External copy feedback flag (Prompt copy mode only). */
  copyFeedback?: boolean;
  // ── Move lines ────────────────────────────────────────────────────
  onMoveLineUp?: () => void;
  canMoveLineUp?: boolean;
  onMoveLineDown?: () => void;
  canMoveLineDown?: boolean;
  // ── Push (down → notes, up → prompt) ──────────────────────────────
  onPush?: () => void;
  canPush?: boolean;
  // ── Pop out to a separate window (#3517 R1/R5) ────────────────────
  /**
   * Move the editor into its own browser window. Rendered immediately BEFORE
   * Expand, and ONLY when the host wires it — the host gates on the pop-out
   * being supported and `!isTouch`, so touch surfaces grow nothing (I3-R1).
   * Serves both the Prompt (R1) and Notes (R5) rows.
   */
  onPopOut?: () => void;
  // ── Expand fullscreen ─────────────────────────────────────────────
  onExpand?: () => void;
  // ── Attach (paperclip) ────────────────────────────────────────────
  onAttach?: () => void;
  attachmentCount?: number;
  hasInvalidFiles?: boolean;
  // ── Delete / clear ────────────────────────────────────────────────
  onDelete?: () => void;
}

const ICON_BTN_BASE =
  "flex h-8 w-8 items-center justify-center rounded-full transition-colors";

/** Enabled vs disabled color states shared by the neutral (non-destructive) tools. */
function neutralCls(enabled: boolean): string {
  return enabled
    ? "text-[var(--app-hint)] hover:text-[var(--app-link)] hover:bg-[var(--app-hover)]"
    : "text-[var(--app-hint)] disabled:opacity-30 cursor-not-allowed";
}

export function PromptTextTools(props: PromptTextToolsProps) {
  const {
    direction,
    disabled = false,
    hasContent = false,
    copyText,
    onCopy,
    copyFeedback = false,
    onMoveLineUp,
    canMoveLineUp = false,
    onMoveLineDown,
    canMoveLineDown = false,
    onPush,
    canPush = false,
    onPopOut,
    onExpand,
    onAttach,
    attachmentCount = 0,
    hasInvalidFiles = false,
    onDelete,
  } = props;

  const hasAttachments = attachmentCount > 0;
  const pushTitle =
    direction === "down"
      ? "Move message to session notes"
      : "Move notes to message input";
  const deleteTitle = direction === "down" ? "Clear prompt" : "Clear notes";
  const preventBlur = (e: ReactMouseEvent) => e.preventDefault();

  return (
    <div className="flex items-center gap-[var(--icon-btn-gap)] shrink-0">
      {/* Copy */}
      {copyText !== undefined ? (
        <CopyButton
          text={copyText}
          title="Copy to clipboard"
          copiedTitle="Copied!"
          iconClassName="h-4 w-4"
          copiedIconClassName="h-4 w-4 text-[var(--app-success)]"
          disabled={!hasContent || disabled}
          onMouseDown={preventBlur}
          className={`${ICON_BTN_BASE} p-0 font-normal ${neutralCls(hasContent && !disabled)}`}
        />
      ) : onCopy ? (
        <BareButton
          type="button"
          onClick={onCopy}
          onMouseDown={preventBlur}
          disabled={!hasContent || disabled}
          className={`${ICON_BTN_BASE} ${neutralCls(hasContent && !disabled)}`}
          title={copyFeedback ? "Copied!" : "Copy"}
        >
          {copyFeedback ? (
            <UiCheckIcon className="h-4 w-4 text-[var(--app-success)]" />
          ) : (
            <UiCopyIcon className="h-4 w-4" />
          )}
        </BareButton>
      ) : null}

      {/* Move line up */}
      {onMoveLineUp ? (
        <BareButton
          type="button"
          onClick={onMoveLineUp}
          onMouseDown={preventBlur}
          disabled={!canMoveLineUp || disabled}
          className={`${ICON_BTN_BASE} ${neutralCls(canMoveLineUp && !disabled)}`}
          title="Move line up"
        >
          <ChevronUpIcon className="h-4 w-4" />
        </BareButton>
      ) : null}

      {/* Move line down */}
      {onMoveLineDown ? (
        <BareButton
          type="button"
          onClick={onMoveLineDown}
          onMouseDown={preventBlur}
          disabled={!canMoveLineDown || disabled}
          className={`${ICON_BTN_BASE} ${neutralCls(canMoveLineDown && !disabled)}`}
          title="Move line down"
        >
          <ChevronDownIcon className="h-4 w-4" />
        </BareButton>
      ) : null}

      {/* Push — down to Notes / up to Prompt */}
      {onPush ? (
        <BareButton
          type="button"
          onClick={onPush}
          onMouseDown={preventBlur}
          disabled={!canPush || disabled}
          className={`${ICON_BTN_BASE} ${neutralCls(canPush && !disabled)}`}
          title={pushTitle}
        >
          {direction === "down" ? (
            <ChevronsDownIcon className="h-4 w-4" />
          ) : (
            <ChevronsUpIcon className="h-4 w-4" />
          )}
        </BareButton>
      ) : null}

      {/* Pop out to a separate window — immediately before Expand (#3517 R1).
          Rendered only when the host wires onPopOut (desktop, non-touch). */}
      {onPopOut ? (
        <BareButton
          type="button"
          onClick={onPopOut}
          onMouseDown={preventBlur}
          disabled={disabled}
          className={`${ICON_BTN_BASE} ${neutralCls(!disabled)}`}
          title="Pop out to a separate window"
        >
          <PopOutIcon className="h-4 w-4" />
        </BareButton>
      ) : null}

      {/* Expand to full screen */}
      {onExpand ? (
        <BareButton
          type="button"
          onClick={onExpand}
          onMouseDown={preventBlur}
          disabled={disabled}
          className={`${ICON_BTN_BASE} ${neutralCls(!disabled)}`}
          title="Expand to full screen"
        >
          <MaximizeIcon className="h-4 w-4" />
        </BareButton>
      ) : null}

      {/* Attach (paperclip) */}
      {onAttach ? (
        <BareButton
          type="button"
          onClick={onAttach}
          onMouseDown={preventBlur}
          disabled={disabled}
          className={`relative ${ICON_BTN_BASE} disabled:cursor-not-allowed disabled:opacity-50 ${
            hasAttachments && hasInvalidFiles
              ? "bg-red-500/20 text-red-500 hover:bg-red-500/30 hover:text-red-500"
              : hasAttachments
                ? "bg-[var(--app-link)]/20 text-[var(--app-link)] hover:bg-[var(--app-link)]/30 hover:text-[var(--app-link)]"
                : "text-[var(--app-hint)] hover:bg-[var(--app-hover)] hover:text-[var(--app-fg)]"
          }`}
          aria-label={
            hasAttachments
              ? `${attachmentCount} file${attachmentCount > 1 ? "s" : ""} attached - click to manage`
              : "Attach files"
          }
          title={
            hasAttachments
              ? `${attachmentCount} file${attachmentCount > 1 ? "s" : ""} attached - click to manage`
              : "Attach files"
          }
        >
          <PaperclipIcon />
          {hasAttachments ? (
            <span
              className={`absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[length:var(--text-caption-xs)] font-bold ${
                hasInvalidFiles
                  ? "bg-red-500 text-white"
                  : "bg-[var(--app-link)] text-[var(--app-bg)]"
              }`}
            >
              {attachmentCount}
            </span>
          ) : null}
        </BareButton>
      ) : null}

      {/* Delete / clear */}
      {onDelete ? (
        <BareButton
          type="button"
          onClick={onDelete}
          onMouseDown={preventBlur}
          disabled={!hasContent || disabled}
          className={`${ICON_BTN_BASE} ${
            hasContent && !disabled
              ? "text-[var(--app-hint)] hover:text-red-400 hover:bg-[var(--app-hover)]"
              : "text-[var(--app-hint)] disabled:opacity-30 cursor-not-allowed"
          }`}
          title={deleteTitle}
        >
          <TrashIcon className="h-4 w-4" />
        </BareButton>
      ) : null}
    </div>
  );
}
