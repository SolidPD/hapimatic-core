// SPDX-License-Identifier: AGPL-3.0-only
/**
 * #6768: the Submit dialog's Not sent rows, and the words they keep. Out of
 * `PinsSubmitDialog.tsx` so it stays under the `max-lines` guard (#2077).
 */
import type { CSSProperties } from "react";
import { Check, Copy, MessageCircleQuestion, X } from "lucide-react";
import type { PinSubmissionResult } from "@hapi/protocol";
import { HoverTooltipButton } from "@/components/ui/tooltip";
import { FadeTruncate } from "@/components/session/FadeTruncate";
import {
  PIN_ACTION_CLASS,
  PIN_ACTION_STYLE,
} from "@/components/pins/PinAnswerControls";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import type { HeldStaged } from "@/lib/pins/submission";
import { useStagedPin } from "@/lib/pins/staging";
import { keepsStaged } from "./pinsSubmitRecovery";

const ICON: CSSProperties = { width: "12px", height: "12px" };
/** #6768 R7: why a held choice was left out of the Submit. */
export const HELD_TEXT = "your note is empty";

/**
 * The pins a Submit will not send: each dropped row with the server's reason,
 * then each held choice (#6768 R7). A dropped pin whose staged entry carries a
 * note or questions shows them under its row (R6), except an entry the Submit
 * keeps staged (`keepsStaged`), which goes again with its note. In the empty
 * phase Clear these forgets every row, so a kept row shows its words there,
 * with Copy and no Clear of its own.
 */
export function DroppedRows(props: {
  sessionId: string;
  rows: readonly PinSubmissionResult[];
  held?: readonly HeldStaged[];
  titleOf: (key: string) => string;
  /** Forget one pin's staged entry, releasing any pick it held. */
  onClear: (key: string) => void;
  /** The empty phase: Clear these forgets kept rows too (#6768 review 1e09b712). */
  forgetsKept?: boolean;
}) {
  const held = props.held ?? [];
  if (props.rows.length === 0 && held.length === 0) return null;
  return (
    <div className="mt-2">
      <div className="text-[length:var(--text-caption)] font-semibold uppercase tracking-wide text-[var(--app-hint)]">
        Not sent
      </div>
      <ul>
        {props.rows.map((row, index) => (
          <li
            key={`${row.key}:${index}`}
            className="border-b border-[var(--app-divider)]"
          >
            <div className="flex min-h-7 items-center gap-1.5">
              <FadeTruncate className="flex-1">
                {props.titleOf(row.key)}
              </FadeTruncate>
              <span className="shrink-0 text-[var(--app-hint)]">
                {row.reason ?? "dropped"}
              </span>
            </div>
            {keepsStaged(row) && !props.forgetsKept ? null : (
              <UnsentNote
                sessionId={props.sessionId}
                pinKey={row.key}
                onClear={keepsStaged(row) ? undefined : props.onClear}
              />
            )}
          </li>
        ))}
        {held.map(row => (
          <li
            key={`held:${row.key}`}
            className="flex min-h-7 items-center gap-1.5 border-b border-[var(--app-divider)]"
          >
            <FadeTruncate className="flex-1">
              {props.titleOf(row.key)}
            </FadeTruncate>
            <span className="shrink-0 text-[var(--status-warn)]">
              {HELD_TEXT}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * #6768 R6 (ruling 1A): the note and questions staged on a pin the Submit cannot
 * send. They stay on this device, shown in full, until the operator copies
 * them somewhere or clears them; nothing forgets them for him. Reads the live
 * entry, so a Clear, or an edit made elsewhere, shows at once.
 */
export function UnsentNote(props: {
  sessionId: string;
  pinKey: string;
  /** Absent: no Clear, because the entry is not this row's to forget. */
  onClear?: (key: string) => void;
}) {
  const entry = useStagedPin(props.sessionId, props.pinKey);
  const note = entry?.note?.trim() ? entry.note : undefined;
  const questions = entry?.questions ?? [];
  if (!note && questions.length === 0) return null;
  const what =
    note && questions.length > 0
      ? "note and questions"
      : note
        ? "note"
        : "questions";
  const words = [note, ...questions].filter(Boolean).join("\n\n");
  return (
    <div className="mb-1.5 rounded-md bg-[var(--app-subtle-bg)] px-2 py-1 text-[length:var(--text-caption)]">
      {note ? (
        <div
          data-testid="unsent-note-text"
          className="whitespace-pre-wrap break-words text-[var(--app-fg)]"
        >
          {note}
        </div>
      ) : null}
      {questions.length > 0 ? (
        <ul className={note ? "mt-1 grid gap-0.5" : "grid gap-0.5"}>
          {questions.map((question, index) => (
            <li
              key={`${index}:${question}`}
              className="flex items-start gap-1 text-[var(--app-fg)]"
            >
              <MessageCircleQuestion
                style={ICON}
                className="mt-0.5 shrink-0 text-[var(--app-hint)]"
                aria-hidden
              />
              <span className="min-w-0 whitespace-pre-wrap break-words">
                {question}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-1 flex min-w-0 items-center gap-1">
        <FadeTruncate className="flex-1 text-[var(--app-hint)]">
          Kept on this device
        </FadeTruncate>
        <CopyWords text={words} label={`Copy your ${what}`} />
        {props.onClear ? (
          <HoverTooltipButton
            type="button"
            content={`Forget your ${what} on this device`}
            aria-label={`Clear your ${what}`}
            onClick={() => props.onClear?.(props.pinKey)}
            className={`shrink-0 ${PIN_ACTION_CLASS}`}
            style={PIN_ACTION_STYLE}
          >
            <X style={ICON} aria-hidden />
            Clear
          </HoverTooltipButton>
        ) : null}
      </div>
    </div>
  );
}

/** Copy, without printing the words a second time (`CopyValueChip` shows its value). */
function CopyWords(props: { text: string; label: string }) {
  const { copied, copy } = useCopyToClipboard();
  return (
    <HoverTooltipButton
      type="button"
      content={props.label}
      aria-label={props.label}
      // `copy` runs in the click itself: the iOS fallback needs the gesture.
      onClick={() => {
        void copy(props.text);
      }}
      className={`shrink-0 ${PIN_ACTION_CLASS}`}
      style={PIN_ACTION_STYLE}
    >
      {copied ? (
        <Check style={ICON} className="text-[var(--status-ok)]" aria-hidden />
      ) : (
        <Copy style={ICON} aria-hidden />
      )}
      Copy
    </HoverTooltipButton>
  );
}
