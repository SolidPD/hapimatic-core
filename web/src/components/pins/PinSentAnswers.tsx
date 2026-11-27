// SPDX-License-Identifier: AGPL-3.0-only
/**
 * #6803 (R1): the Sent record on an open pin: what the operator sent on it that
 * did not settle it, read from the pin's own answer history, so it is the same
 * on every device and after a reload. A Submit that sends a note empties the
 * note box; this is where the words show instead.
 *
 * `PinDetail` renders it under the answer fields. `CopyWords` lives here, and
 * the Submit dialog's Not sent rows import it from here, because this file
 * imports `PinAnswerControls` and nothing that imports it back.
 */
import type { CSSProperties } from "react";
import { Check, Copy } from "lucide-react";
import type { Pin } from "@hapi/protocol";
import { HoverTooltipButton } from "@/components/ui/tooltip";
import { FadeTruncate } from "@/components/session/FadeTruncate";
import {
  PIN_ACTION_CLASS,
  PIN_ACTION_STYLE,
} from "@/components/pins/PinAnswerControls";
import { usePinsContext } from "@/components/pins/pinsShared";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import {
  formatPinTime,
  sentNotesAndQuestions,
  type SentRecord,
  type SentRecordKind,
} from "@/lib/pins/ledger";

const ICON: CSSProperties = { width: "12px", height: "12px" };

/** What each kind of record is called on its line. */
const KIND_WORDS: Record<SentRecordKind, string> = {
  note: "Note",
  question: "Question",
  ownAnswer: "Your own answer, changed nothing",
  noteBesideMoot: "Note beside an answer that changed nothing",
};

/** What Copy says it copies. */
const COPY_WORDS: Record<SentRecordKind, string> = {
  note: "Copy your note",
  question: "Copy your question",
  ownAnswer: "Copy your own answer",
  noteBesideMoot: "Copy your note",
};

/** Copy, without printing the words a second time (`CopyValueChip` shows its value). */
export function CopyWords(props: { text: string; label: string }) {
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

/** "Sent Nov 19, 1:19 AM · Note · to its Project Manager · revision 2". */
function sentLine(record: SentRecord, pin: Pin, zone: string): string {
  return [
    `Sent ${formatPinTime(record.at, zone)}`,
    KIND_WORDS[record.kind],
    record.deliveredTo !== undefined ? "to its Project Manager" : null,
    record.revision !== pin.revision ? `revision ${record.revision}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function PinSentAnswers(props: { pin: Pin }) {
  const { pin } = props;
  const { timeZone } = usePinsContext();
  const { records, older } = sentNotesAndQuestions(pin);
  if (records.length === 0) return null;
  return (
    <div className="mt-1.5" data-testid="pin-sent-answers">
      {records.map((record, index) => {
        const copyText = record.note
          ? `${record.words}\n\n${record.note}`
          : record.words;
        return (
          <div
            key={`${record.at}:${index}`}
            className="mb-1.5 rounded-md bg-[var(--app-subtle-bg)] px-2 py-1 text-[length:var(--text-caption)]"
          >
            <div className="whitespace-pre-wrap break-words text-[var(--app-fg)]">
              {record.words}
            </div>
            {record.note ? (
              <div className="mt-1 whitespace-pre-wrap break-words text-[var(--app-hint)]">
                {record.note}
              </div>
            ) : null}
            <div className="mt-1 flex min-w-0 items-center gap-1">
              <FadeTruncate className="flex-1 text-[var(--app-hint)]">
                {sentLine(record, pin, timeZone)}
              </FadeTruncate>
              <CopyWords text={copyText} label={COPY_WORDS[record.kind]} />
            </div>
          </div>
        );
      })}
      {older > 0 ? (
        <div className="text-[length:var(--text-caption)] text-[var(--app-hint)]">
          {`${older} older not shown`}
        </div>
      ) : null}
    </div>
  );
}
