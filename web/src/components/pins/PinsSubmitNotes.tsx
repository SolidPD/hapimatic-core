// SPDX-License-Identifier: AGPL-3.0-only
/**
 * #6768: the Submit dialog's Not sent rows, and the words they keep. Out of
 * `PinsSubmitDialog.tsx` so it stays under the `max-lines` guard (#2077).
 */
import type { CSSProperties } from "react";
import { MessageCircleQuestion, X } from "lucide-react";
import type { PinSubmissionResult } from "@hapi/protocol";
import { HoverTooltipButton } from "@/components/ui/tooltip";
import { FadeTruncate } from "@/components/session/FadeTruncate";
import {
  PIN_ACTION_CLASS,
  PIN_ACTION_STYLE,
} from "@/components/pins/PinAnswerControls";
import type { HeldStaged } from "@/lib/pins/submission";
import { useStagedPin } from "@/lib/pins/staging";
import { overLimitReason } from "@/lib/pins/textLimit";
import { keepsStaged } from "./pinsSubmitRecovery";
import { CopyWords } from "./PinSentAnswers";

const ICON: CSSProperties = { width: "12px", height: "12px" };
/** #6768 R7: why a held choice was left out of the Submit. */
export const HELD_TEXT = "your note is empty";
/** #6969 (E1): why a pin was left for the next Submit. */
export const MESSAGE_FULL_TEXT =
  "too long to go with the others; it goes in your next Submit";

/**
 * #6969 (R-4): why a long note waits when the session's list could not be read,
 * so its note limit is not known; never a number the counter did not show.
 */
export function noteLimitUnreadText(limit: number): string {
  return `this session's note limit could not be read, so a note over ${limit.toLocaleString("en-US")} waits`;
}

/** Why Submit held a pin back (#6768 R7, #6969 R3 and E1). */
export function heldReasonText(row: HeldStaged): string {
  switch (row.reason) {
    case "note_empty":
      return HELD_TEXT;
    case "note_too_long":
      return row.unread
        ? noteLimitUnreadText(row.limit)
        : overLimitReason(row.over, row.limit, "note");
    case "write_in_too_long":
      return overLimitReason(row.over, row.limit, "answer");
    case "message_full":
      return MESSAGE_FULL_TEXT;
  }
}

/**
 * The pins a Submit will not send: each dropped row with the server's reason,
 * then each held pin (#6768 R7, #6969). A dropped pin whose staged entry carries a
 * note or questions shows them under its row (R6), except an entry the Submit
 * keeps staged (`keepsStaged`), which goes again with its note. In the empty
 * phase Clear these forgets every row, so a kept row shows its words there,
 * with Copy and no Clear of its own. #6969: a pin held for a text over its
 * limit, or for a full message, shows its whole words the same way, with Copy
 * and Clear, because the operator shortens them or forgets them here. The pin
 * is still open, so its Clear forgets only the words it names and keeps the
 * choice staged (ruling B2), and the dialog checks again at once.
 */
export function DroppedRows(props: {
  sessionId: string;
  rows: readonly PinSubmissionResult[];
  held?: readonly HeldStaged[];
  titleOf: (key: string) => string;
  /** Forget one pin's staged entry, releasing any pick it held. */
  onClear: (key: string) => void;
  /** Forget a held pin's words (B2), then check again (#6969 review F1). */
  onClearHeld: (key: string) => void;
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
        {held.map(row =>
          row.reason === "note_empty" ? (
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
          ) : (
            <li
              key={`held:${row.key}`}
              className="border-b border-[var(--app-divider)]"
            >
              {/* The reason is a sentence; where it does not fit beside a
                  12rem title (a phone, and the long reasons at any width), it
                  goes under the title and wraps, rather than cutting the title
                  to a few letters or running past the edge (#6969). */}
              <div className="flex min-h-7 flex-wrap items-center gap-x-1.5">
                <FadeTruncate className="min-w-[min(12rem,100%)] flex-1">
                  {props.titleOf(row.key)}
                </FadeTruncate>
                <span className="min-w-0 text-[var(--status-warn)]">
                  {heldReasonText(row)}
                </span>
              </div>
              <UnsentNote
                sessionId={props.sessionId}
                pinKey={row.key}
                onClear={props.onClearHeld}
              />
            </li>
          )
        )}
      </ul>
    </div>
  );
}

/**
 * #6768 R6 (ruling 1A): the note and questions staged on a pin the Submit cannot
 * send. They stay on this device, shown in full, until the operator copies
 * them somewhere or clears them; nothing forgets them for him. Reads the live
 * entry, so a Clear, or an edit made elsewhere, shows at once. #6969 (R-2): a
 * question typed but not added is shown too, put in Copy, and named in Clear,
 * so Clear never forgets words the row did not show.
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
  // #6803 (R11): write-in words are kept like a note, chosen or a draft.
  const writeIn = entry?.writeIn?.trim() ? entry.writeIn : undefined;
  const draft = entry?.questionDraft?.trim() ? entry.questionDraft : undefined;
  if (!writeIn && !note && questions.length === 0 && !draft) return null;
  const what = joinWords([
    writeIn
      ? entry?.writeInChosen === true
        ? "own answer"
        : "draft answer"
      : null,
    note ? "note" : null,
    questions.length > 0 ? "questions" : null,
    draft ? "draft question" : null,
  ]);
  const words = [writeIn, note, ...questions, draft]
    .filter(Boolean)
    .join("\n\n");
  return (
    <div className="mb-1.5 rounded-md bg-[var(--app-subtle-bg)] px-2 py-1 text-[length:var(--text-caption)]">
      {writeIn ? (
        <div
          data-testid="unsent-writein-text"
          className="whitespace-pre-wrap break-words text-[var(--app-fg)]"
        >
          {writeIn}
        </div>
      ) : null}
      {note ? (
        <div
          data-testid="unsent-note-text"
          className={`whitespace-pre-wrap break-words text-[var(--app-fg)]${
            writeIn ? " mt-1" : ""
          }`}
        >
          {note}
        </div>
      ) : null}
      {questions.length > 0 || draft ? (
        <ul className={note || writeIn ? "mt-1 grid gap-0.5" : "grid gap-0.5"}>
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
          {draft ? (
            <li
              data-testid="unsent-question-draft"
              className="flex items-start gap-1 text-[var(--app-fg)]"
            >
              <MessageCircleQuestion
                style={ICON}
                className="mt-0.5 shrink-0 text-[var(--app-hint)]"
                aria-hidden
              />
              <span className="min-w-0 whitespace-pre-wrap break-words">
                <span className="text-[var(--app-hint)]">
                  Draft, not added:{" "}
                </span>
                {draft}
              </span>
            </li>
          ) : null}
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

/** #6969 (review F2): the words that say a sent pin's typed question stays. */
export const SENT_DRAFT_TEXT =
  "Your question was not added, so it is not sent: ";

/**
 * #6969 (closer review F2): a question typed on a pin this Submit sends, but
 * not added. Sending can close the pin, and Ask shows only on an open pin, so
 * the draft is named here, in full and with Copy, before Send. Reads the live
 * entry, so adding the question or clearing it shows at once.
 */
export function SentDraftQuestion(props: {
  sessionId: string;
  pinKey: string;
}) {
  const draft = useStagedPin(props.sessionId, props.pinKey)?.questionDraft;
  if (!draft?.trim()) return null;
  return (
    <div className="mt-0.5 flex min-w-0 items-start gap-1 text-[length:var(--text-caption)]">
      <span
        data-testid="sent-question-draft"
        className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[var(--app-fg)]"
      >
        <span className="text-[var(--status-warn)]">{SENT_DRAFT_TEXT}</span>
        {draft}
      </span>
      <CopyWords text={draft} label="Copy your draft question" />
    </div>
  );
}

/** "own answer", "own answer and note", "draft answer, note, and questions". */
function joinWords(parts: readonly (string | null)[]): string {
  const words = parts.filter((part): part is string => part !== null);
  if (words.length <= 2) return words.join(" and ");
  return `${words.slice(0, -1).join(", ")}, and ${words.at(-1)}`;
}
