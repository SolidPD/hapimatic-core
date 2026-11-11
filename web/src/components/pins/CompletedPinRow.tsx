// SPDX-License-Identifier: AGPL-3.0-only
import { memo, useCallback, type CSSProperties } from "react";
import { Bot, Timer, User } from "lucide-react";
import { PinDetail } from "@/components/pins/PinDetail";
import {
  PIN_BOX_CLASS,
  PinDetailsToggle,
  PinIndicator,
  PinKindBadge,
  stopRowToggle,
  usePinsContext,
} from "@/components/pins/pinsShared";
import {
  completedAnswerText,
  completedChannel,
  completedReceipt,
  completedSummary,
  formatPinTime,
  settledAt,
  settlingAnswerNote,
  type PinViewModel,
} from "@/lib/pins/ledger";

const RECEIPT_ICON: CSSProperties = { width: "11px", height: "11px" };
// Mockup v6 :172-181. The grid, the recede (opacity, saturation, 11.5px
// type), and the narrow-screen columns live in index.css
// (`pins-completed-row`), because a hover and a media query cannot be inline.
// #6555: 28px, because the pin's box adds a 1px border above and below, so a
// collapsed completed pin is still 30px tall.
const ROW_STYLE: CSSProperties = { minHeight: "28px" };
const CELL = "min-w-0 truncate";

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
};

/**
 * #6449 (R13): a Completed row — receded, no star — whose answer, time,
 * channel, and receipt columns align across rows (`pins-completed-row` in
 * index.css; below 600px the time and channel columns collapse and hide, as
 * in mockup v6). Expanded: how and when it was completed, the note, and Text.
 * #6555: the pin is one rounded box (`PIN_BOX_CLASS`) around the row and its
 * detail. `pins-completed-row` stays on the row, so the row recedes and the
 * box's outline does not.
 */
export const CompletedPinRow = memo(function CompletedPinRow(
  props: CompletedPinRowProps
) {
  const { model, expanded, armed, onToggle, observe } = props;
  const { pin } = model;
  const toggle = useCallback(() => onToggle(pin.key), [onToggle, pin.key]);
  const register = useCallback(
    (element: HTMLDivElement | null) => observe(pin.key, element),
    [observe, pin.key]
  );
  const { timeZone } = usePinsContext();
  const answer = completedAnswerText(pin);
  const at = settledAt(pin);
  const time = formatPinTime(at, timeZone);
  const channel = completedChannel(pin);
  const note = settlingAnswerNote(pin);
  return (
    <div data-pin-box className={PIN_BOX_CLASS}>
      <div
        id={`pin-row-${pin.key}`}
        ref={armed ? undefined : register}
        onClick={toggle}
        className="pins-completed-row cursor-pointer items-center py-px pl-1.5 pr-0.5 text-[var(--app-hint)]"
        style={ROW_STYLE}
      >
        <PinKindBadge kind={pin.kind} armed={armed} />
        <span
          className={`${CELL} font-medium text-[var(--app-fg)]`}
          style={{ fontSize: "12px" }}
        >
          {pin.title}
        </span>
        <span onClick={stopRowToggle} className={CELL}>
          <PinIndicator
            armed={armed}
            label={answer === "—" ? "No answer on record" : answer}
            className="text-[var(--app-fg)]"
          >
            {answer}
          </PinIndicator>
        </span>
        <span onClick={stopRowToggle} className={`${CELL} pins-c-time`}>
          <PinIndicator armed={armed} label={`Completed ${time}`}>
            {time}
          </PinIndicator>
        </span>
        <span onClick={stopRowToggle} className={`${CELL} pins-c-via`}>
          <PinIndicator armed={armed} label={`Answered ${channel}`}>
            {channel}
          </PinIndicator>
        </span>
        <span onClick={stopRowToggle} className="flex min-w-0">
          <Receipt model={model} armed={armed} />
        </span>
        <span onClick={stopRowToggle} className="flex self-stretch">
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
          summary={
            <div className="text-[length:var(--text-body)] text-[var(--app-fg)]">
              <p>{completedSummary(pin, timeZone)}</p>
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
