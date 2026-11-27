// SPDX-License-Identifier: AGPL-3.0-only
import { memo, useCallback, useState, type CSSProperties } from "react";
import { Bot, RotateCcw, Timer, User } from "lucide-react";
import { FadeTruncate } from "@/components/session/FadeTruncate";
import { PinActionButton } from "@/components/pins/PinAnswerControls";
import { PinDetail } from "@/components/pins/PinDetail";
import { PinIdControl } from "@/components/pins/PinIdControl";
import { HoverTooltipButton } from "@/components/ui/tooltip";
import { pinReopenErrorMessage } from "@/hooks/queries/usePins";
import { ACTION_COLLAPSE_RANK } from "@/lib/pins/actionRowFit";
import {
  PIN_BOX_CLASS,
  PinDetailsToggle,
  PinIndicator,
  PinKindBadge,
  stopRowToggle,
  usePinsContext,
  useTitleWraps,
} from "@/components/pins/pinsShared";
import {
  COMPLETED_NO_ANSWER,
  completedAnswerText,
  completedChannel,
  completedReceipt,
  completedSummary,
  formatPinTime,
  settledAt,
  settlingAnswerNote,
  settlingAnswerWords,
  supersededView,
  type PinViewModel,
} from "@/lib/pins/ledger";

const RECEIPT_ICON: CSSProperties = { width: "11px", height: "11px" };
const ACTION_ICON: CSSProperties = { width: "14px", height: "14px" };
/** #6456 (R8): the operator's Reopen on a superseded pin. */
export const REOPEN_TOOLTIP = "Put this pin back in Action Items";
// Mockup v6 :172-181. The grid, the recede (opacity, saturation, 11.5px
// type), and the narrow-screen columns live in index.css
// (`pins-completed-row`), because a hover and a media query cannot be inline.
// #6555: 28px, because the pin's box adds a 1px border above and below, so a
// collapsed completed pin is still 30px tall.
const ROW_STYLE: CSSProperties = { minHeight: "28px" };
const CELL = "min-w-0 truncate";
const TITLE_STYLE: CSSProperties = { fontSize: "12px" };

function Receipt(props: { model: PinViewModel; armed: boolean }) {
  const receipt = completedReceipt(props.model.pin);
  // Withdrawn and Dismissed carry no glyph: no one answered them.
  const Icon =
    receipt.tone === "you"
      ? User
      : receipt.tone === "auto"
        ? Timer
        : receipt.label === "Agent"
          ? Bot
          : null;
  const toneClass =
    receipt.tone === "you"
      ? "text-[var(--app-accent)]"
      : receipt.tone === "auto"
        ? "border border-dashed text-[var(--status-warn)]"
        : "text-[var(--app-hint)]";
  const toneStyle: CSSProperties =
    receipt.tone === "you"
      ? {
          backgroundColor:
            "color-mix(in srgb, var(--app-accent) 14%, transparent)",
        }
      : receipt.tone === "auto"
        ? {
            backgroundColor:
              "color-mix(in srgb, var(--status-warn) 14%, transparent)",
            borderColor:
              "color-mix(in srgb, var(--status-warn) 60%, transparent)",
          }
        : { backgroundColor: "var(--app-subtle-bg)" };
  return (
    <PinIndicator
      armed={props.armed}
      label={receipt.tooltip}
      className={`inline-flex items-center gap-0.5 justify-self-start rounded-full px-1.5 font-bold ${toneClass}`}
      style={{ height: "18px", fontSize: "10px", ...toneStyle }}
    >
      {Icon ? <Icon style={RECEIPT_ICON} aria-hidden /> : null}
      {receipt.label}
    </PinIndicator>
  );
}

export type CompletedPinRowProps = {
  model: PinViewModel;
  expanded: boolean;
  armed: boolean;
  onToggle: (key: string) => void;
  observe: (key: string, element: Element | null) => void;
  /** #6555: where the pin is shown; the chat card passes `"chat"`. */
  mode?: "tab" | "chat";
  /** #6456 (R8): reopen a superseded pin; without it there is no Reopen. */
  onReopen?: (key: string) => Promise<unknown>;
  /**
   * #6456 (R10): find a pin by its ID (the Pins tab's search). Without it the
   * settling pin's ID in the sentence is tap to copy.
   */
  onFindPin?: (pinId: string) => void;
};

/**
 * #6456 (R10): the summary sentence, with the settling pin's ID as a link: in
 * the Pins tab it finds that pin, elsewhere it copies the ID. The reason is
 * agent text, so it is rendered as plain text, never markdown.
 */
function SummaryLine(props: {
  text: string;
  pinId: string | null;
  onFindPin?: (pinId: string) => void;
}) {
  const { text, pinId, onFindPin } = props;
  const at = pinId ? text.indexOf(pinId) : -1;
  if (!pinId || at < 0) return <p>{text}</p>;
  return (
    <p>
      {text.slice(0, at)}
      {onFindPin ? (
        <HoverTooltipButton
          type="button"
          content="Find this pin"
          aria-label={`Find pin ${pinId}`}
          onClick={() => onFindPin(pinId)}
          className="inline font-mono text-[length:var(--text-caption)] text-[var(--app-link)] underline"
        >
          {pinId}
        </HoverTooltipButton>
      ) : (
        <PinIdControl pinId={pinId} form="text" />
      )}
      {text.slice(at + pinId.length)}
    </p>
  );
}

/** #6456 (R8): Reopen, and the server's refusal when it says no. */
function useReopenAction(
  pinKey: string,
  onReopen: ((key: string) => Promise<unknown>) | undefined
) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!onReopen) return { button: null, error: null };
  const button = (
    <PinActionButton
      rank={ACTION_COLLAPSE_RANK.dismiss}
      content={REOPEN_TOOLTIP}
      // To the right: above would cover the "Superseded by …" line just over it.
      side="right"
      aria-busy={pending}
      disabled={pending}
      onClick={() => {
        setPending(true);
        setError(null);
        onReopen(pinKey)
          .catch((failure: unknown) => setError(pinReopenErrorMessage(failure)))
          .finally(() => setPending(false));
      }}
      icon={<RotateCcw style={ACTION_ICON} aria-hidden />}
      label="Reopen"
    />
  );
  return { button, error };
}

/**
 * #6449 (R13): a Completed row — receded, no star — whose answer, time,
 * channel, and receipt columns align across rows (`pins-completed-row` in
 * index.css; below 600px the time and channel columns collapse and hide, as
 * in mockup v6). Expanded: how and when it was completed, the note, and Text.
 * #6555: the pin is one rounded box (`PIN_BOX_CLASS`) around the row and its
 * detail. `pins-completed-row` stays on the row, so the row recedes and the
 * box's outline does not.
 * #6739 (TITLE-D): collapsed, the title fades at its edge; expanded, a title
 * that does not fit one line wraps whole, as an open pin's does, and the other
 * cells keep the first line. Below 600px (Pins PM ruling E2) the wrapped title
 * takes the row's width and the answer, time, channel, and receipt move to the
 * line below it (`pins-completed-row[data-title-wraps]` in index.css).
 */
export const CompletedPinRow = memo(function CompletedPinRow(
  props: CompletedPinRowProps
) {
  const { model, expanded, armed, onToggle, observe, onFindPin } = props;
  const { pin } = model;
  const superseded = supersededView(pin);
  const reopen = useReopenAction(
    pin.key,
    superseded ? props.onReopen : undefined
  );
  const toggle = useCallback(() => onToggle(pin.key), [onToggle, pin.key]);
  const register = useCallback(
    (element: HTMLDivElement | null) => observe(pin.key, element),
    [observe, pin.key]
  );
  const { timeZone } = usePinsContext();
  const answer = completedAnswerText(pin);
  // #6456 (Pins PM O1): a row with no answer has no answer cell, and its title
  // takes that column (`pins-completed-row[data-no-answer]` in index.css).
  const noAnswer = answer === COMPLETED_NO_ANSWER;
  const at = settledAt(pin);
  const time = formatPinTime(at, timeZone);
  const channel = completedChannel(pin);
  const note = settlingAnswerNote(pin);
  const words = settlingAnswerWords(pin);
  // Keyed on the title and `expanded` only: the row is memoized and gets no clock.
  const { cellRef, wraps } = useTitleWraps<HTMLSpanElement>(
    expanded,
    pin.title
  );
  // While the title wraps, each other cell keeps the first line's 28 px.
  const firstLine = wraps ? " h-7 items-center" : "";
  const firstLineText = wraps ? " leading-7" : "";
  return (
    <div data-pin-box className={PIN_BOX_CLASS}>
      <div
        id={`pin-row-${pin.key}`}
        ref={armed ? undefined : register}
        onClick={toggle}
        data-title-wraps={wraps ? "" : undefined}
        data-no-answer={noAnswer ? "" : undefined}
        className={`pins-completed-row cursor-pointer ${
          wraps ? "items-start" : "items-center"
        } py-px pl-1.5 pr-0.5 text-[var(--app-hint)]`}
        style={ROW_STYLE}
      >
        <PinKindBadge
          kind={pin.kind}
          armed={armed}
          className={wraps ? "h-7 items-center" : undefined}
        />
        {/* #6458 (TITLE-D): the title fades at its edge, never an ellipsis. Its
            12 px size sits on the cell, because FadeTruncate sets its own style. */}
        <span
          ref={cellRef}
          className={`pins-c-title flex min-w-0${wraps ? " py-1.5 leading-4" : ""}`}
          style={TITLE_STYLE}
        >
          {wraps ? (
            <span
              data-pin-title-text=""
              className="min-w-0 whitespace-normal font-medium text-[var(--app-fg)] [overflow-wrap:anywhere]"
            >
              {pin.title}
            </span>
          ) : (
            <FadeTruncate
              data-pin-title-text=""
              className="font-medium text-[var(--app-fg)]"
            >
              {pin.title}
            </FadeTruncate>
          )}
        </span>
        {noAnswer ? null : (
          <span
            onClick={stopRowToggle}
            className={`${CELL} pins-c-ans${firstLineText}`}
          >
            <PinIndicator
              armed={armed}
              label={answer}
              className="text-[var(--app-fg)]"
            >
              {answer}
            </PinIndicator>
          </span>
        )}
        <span
          onClick={stopRowToggle}
          className={`${CELL} pins-c-time${firstLineText}`}
        >
          <PinIndicator armed={armed} label={`Completed ${time}`}>
            {time}
          </PinIndicator>
        </span>
        <span
          onClick={stopRowToggle}
          className={`${CELL} pins-c-via${firstLineText}`}
        >
          <PinIndicator armed={armed} label={`Answered ${channel}`}>
            {channel}
          </PinIndicator>
        </span>
        <span
          onClick={stopRowToggle}
          className={`pins-c-receipt flex min-w-0${firstLine}`}
        >
          <Receipt model={model} armed={armed} />
        </span>
        <span
          onClick={stopRowToggle}
          className={`pins-c-toggle ${wraps ? "flex h-7" : "flex self-stretch"}`}
        >
          <PinDetailsToggle
            pinKey={pin.key}
            expanded={expanded}
            armed={armed}
            onToggle={toggle}
          />
        </span>
      </div>
      {expanded ? (
        <PinDetail
          model={model}
          mode={props.mode}
          actions={reopen.button}
          summary={
            <div className="text-[length:var(--text-body)] text-[var(--app-fg)]">
              <SummaryLine
                text={completedSummary(pin, timeZone)}
                pinId={superseded?.ref ?? null}
                onFindPin={onFindPin}
              />
              {reopen.error ? (
                <p
                  role="status"
                  className="mt-1 text-[length:var(--text-body-dense)] text-[var(--status-warn)]"
                >
                  {reopen.error}
                </p>
              ) : null}
              {/* #6803: the operator's own words, whole. */}
              {words ? (
                <p className="mt-1 whitespace-pre-wrap">{words}</p>
              ) : null}
              {note ? (
                <p className="mt-1 whitespace-pre-wrap text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
                  {note}
                </p>
              ) : null}
            </div>
          }
        />
      ) : null}
    </div>
  );
});
