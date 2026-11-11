// SPDX-License-Identifier: AGPL-3.0-only
import { memo, useCallback, type CSSProperties, type ReactNode } from "react";
import { Check, Star } from "lucide-react";
import { isReservedPinKey } from "@hapi/protocol";
import { tokens } from "@/design/tokens";
import { PinDetail } from "@/components/pins/PinDetail";
import { PinSignals } from "@/components/pins/PinSignals";
import { ReservedPinPill } from "@/components/pins/ReservedPinParts";
import {
  PIN_BOX_CLASS,
  PIN_PILL_CLASS as PILL_CLASS,
  PIN_PILL_STYLE as PILL_STYLE,
  PinDetailsToggle,
  PinIndicator,
  PinKindBadge,
  PinTipButton,
  stopRowToggle,
  usePinsContext,
} from "@/components/pins/pinsShared";
import {
  isPinNew,
  mootNotice,
  mootSentence,
  recommendedOption,
  stagedIsStale,
  stepsSent,
  type PinViewModel,
} from "@/lib/pins/ledger";
import { useStagedPin, useStepTicks } from "@/lib/pins/staging";

// Mockup v6 :144-169, with the session list's 32px chevron box (the issue
// names it; the mockup drew 26px). #6555: 32px, because the pin's box adds a
// 1px border above and below, so a collapsed pin is still 34px tall.
const ROW_STYLE: CSSProperties = {
  gridTemplateColumns: "18px 18px minmax(0, 1fr) auto auto 32px",
  minHeight: "32px",
};
const STAR_ICON: CSSProperties = { width: "13px", height: "13px" };
const NEW_DOT: CSSProperties = {
  width: "6px",
  height: "6px",
  borderRadius: "50%",
  marginRight: "5px",
  verticalAlign: "2px",
  backgroundColor: "var(--view-accent-pins)",
};
const CHECK_ICON: CSSProperties = { width: "10px", height: "10px" };
const STALE_STYLE: CSSProperties = {
  ...PILL_STYLE,
  boxShadow: "0 0 0 1.5px var(--status-warn)",
};
const FILLED =
  "border-transparent bg-[var(--app-accent)] text-[var(--palette-accent-fg)]";

/**
 * The answer pill (mockup v6 :683-687): the staged choice with a check (a warning
 * outline when the pin changed since), a Moot warning for an operator answer
 * that changed nothing, a steps count (the larger of what the server has and the
 * local ticks), or
 * the recommendation.
 */
function AnswerPill(props: { model: PinViewModel; armed: boolean }) {
  const { model, armed } = props;
  const { pin } = model;
  const { sessionId, via } = usePinsContext();
  const staged = useStagedPin(sessionId, pin.key);
  const { checked } = useStepTicks(
    sessionId,
    pin,
    model.steps.map(step => step.id),
    via
  );
  const stale = stagedIsStale(staged, pin);
  const staleLabel = staged
    ? `You chose on revision ${staged.rev}; this pin is now revision ${pin.revision}`
    : "";
  if (pin.kind === "steps" && model.steps.length > 0) {
    const total = model.steps.length;
    const done = Math.min(total, Math.max(stepsSent(pin), checked.size));
    return (
      <PinIndicator
        armed={armed}
        label={stale ? staleLabel : `${done} of ${total} steps done`}
        className={`${PILL_CLASS} ${
          done === total
            ? FILLED
            : "border-[var(--app-border)] text-[var(--app-hint)]"
        }`}
        style={stale ? STALE_STYLE : PILL_STYLE}
      >
        {done}/{total}
      </PinIndicator>
    );
  }
  if (staged?.choice !== undefined) {
    const choice = `${staged.choice}${staged.label ? `. ${staged.label}` : ""}`;
    return (
      <PinIndicator
        armed={armed}
        label={
          stale
            ? `You chose ${staged.choice} on revision ${staged.rev}; this pin is now revision ${pin.revision}`
            : `Your answer: ${choice}`
        }
        className={`${PILL_CLASS} ${FILLED}`}
        style={stale ? STALE_STYLE : PILL_STYLE}
      >
        {staged.choice}
        <Check style={CHECK_ICON} aria-hidden />
      </PinIndicator>
    );
  }
  const moot = mootNotice(pin);
  if (moot) {
    return (
      <PinIndicator
        armed={armed}
        label={mootSentence(moot)}
        className={`${PILL_CLASS} text-[var(--status-warn)]`}
        style={{ ...PILL_STYLE, borderColor: "var(--status-warn)" }}
      >
        Moot
      </PinIndicator>
    );
  }
  const recommended = recommendedOption(model);
  if (!recommended) return null;
  return (
    <PinIndicator
      armed={armed}
      label={`Recommended: ${recommended.id}. ${recommended.label}`}
      className={`${PILL_CLASS} text-[var(--app-accent)]`}
      style={{
        ...PILL_STYLE,
        borderColor: "color-mix(in srgb, var(--app-accent) 45%, transparent)",
      }}
    >
      {recommended.id}★
    </PinIndicator>
  );
}

export type PinRowProps = {
  model: PinViewModel;
  expanded: boolean;
  /** The age from the Ledger's per-minute clock, and its tooltip. */
  ageLabel: string;
  ageTooltip: string;
  /** Whether the row is near the screen and renders its tooltips. */
  armed: boolean;
  onToggle: (key: string) => void;
  onStar: (key: string, starred: boolean) => void;
  /** Registers the row with the list's one IntersectionObserver. */
  observe: (key: string, element: Element | null) => void;
  /** Extra actions in the expanded pin (a slot; G adds links). */
  actions?: ReactNode;
  /**
   * #6454: the row's element id. Keys are unique only per session, so a row of
   * another session's pin (a Project Manager's lane box) passes
   * `pin-row-<sessionId>-<key>`; the default keeps `pin-row-<key>`.
   */
  rowId?: string;
  /**
   * #6555: where the pin is shown. The chat card passes `"chat"`, so a pin's
   * detail there offers no button that leads to the chat it is already in.
   */
  mode?: "tab" | "chat";
};

/**
 * #6449: one Action Items row on one line at 393px (R6): star, kind, the New
 * dot and title, signals, the answer pill, and the details chevron. The title
 * and the chevron toggle the pin in place (R7); the star and every indicator
 * sit in click-stopping wrappers, so a tap shows a tooltip without toggling.
 * #6555: the pin is one rounded box (`PIN_BOX_CLASS`) that holds the row and,
 * when it is open, its detail. The row keeps the element id and the observer
 * ref, because a reveal scrolls the row, not the whole box, to the centre.
 * Memoized: the list passes the pin's cached view model and primitives with
 * stable handlers.
 */
export const PinRow = memo(function PinRow(props: PinRowProps) {
  const { model, expanded, armed, onToggle, onStar, observe } = props;
  const { pin } = model;
  const isNew = isPinNew(pin);
  const toggle = useCallback(() => onToggle(pin.key), [onToggle, pin.key]);
  const register = useCallback(
    (element: HTMLDivElement | null) => observe(pin.key, element),
    [observe, pin.key]
  );
  return (
    <div data-pin-box className={PIN_BOX_CLASS}>
      <div
        id={props.rowId ?? `pin-row-${pin.key}`}
        ref={armed ? undefined : register}
        className={`grid items-center gap-x-1.5 px-0.5 py-0.5 ${
          expanded ? "bg-[var(--app-subtle-bg)]" : "hover:bg-[var(--app-hover)]"
        }`}
        style={ROW_STYLE}
      >
        <span onClick={stopRowToggle} className="flex">
          <PinTipButton
            armed={armed}
            type="button"
            tooltip={
              pin.starred
                ? "Starred: kept at the top. Click to unstar"
                : "Star to keep it at the top"
            }
            aria-label={pin.starred ? "Unstar pin" : "Star pin"}
            aria-pressed={pin.starred}
            onClick={() => onStar(pin.key, !pin.starred)}
            className="grid place-items-center"
            style={{
              width: "18px",
              height: "28px",
              color: pin.starred
                ? tokens.pins.star
                : "color-mix(in srgb, var(--app-hint) 70%, transparent)",
            }}
          >
            <Star
              style={STAR_ICON}
              fill={pin.starred ? "currentColor" : "none"}
              aria-hidden
            />
          </PinTipButton>
        </span>
        <PinKindBadge kind={pin.kind} armed={armed} />
        <div
          onClick={toggle}
          className="min-w-0 cursor-pointer truncate text-[length:var(--text-body)] font-semibold text-[var(--app-fg)]"
        >
          {isNew ? (
            <span onClick={stopRowToggle}>
              <PinIndicator
                armed={armed}
                label="New: not opened since it last changed"
                className="inline-block"
                style={NEW_DOT}
              >
                {null}
              </PinIndicator>
            </span>
          ) : null}
          {pin.title}
        </div>
        <PinSignals
          model={model}
          ageLabel={props.ageLabel}
          ageTooltip={props.ageTooltip}
          armed={armed}
        />
        <span onClick={stopRowToggle} className="flex justify-end">
          {isReservedPinKey(pin.key) ? (
            <ReservedPinPill pin={pin} armed={armed} />
          ) : (
            <AnswerPill model={model} armed={armed} />
          )}
        </span>
        <PinDetailsToggle
          pinKey={pin.key}
          expanded={expanded}
          armed={armed}
          onToggle={toggle}
        />
      </div>
      {expanded ? (
        <PinDetail model={model} actions={props.actions} mode={props.mode} />
      ) : null}
    </div>
  );
});
