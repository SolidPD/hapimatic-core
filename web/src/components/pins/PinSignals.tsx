// SPDX-License-Identifier: AGPL-3.0-only
import type { CSSProperties } from "react";
import { CircleAlert, Lock, Timer, TimerOff } from "lucide-react";
import { automaticPickState } from "@/lib/pins/deadline";
import { formatPinInstant, type PinViewModel } from "@/lib/pins/ledger";
import {
  PinIndicator,
  RISK_META,
  STAKES_META,
  stopRowToggle,
  usePinsContext,
} from "@/components/pins/pinsShared";

// Exact sizes from mockup v6 (:154-162), inline like the View Picker's.
const SIGNAL_ICON: CSSProperties = { width: "11px", height: "11px" };
const STAKES_DOT: CSSProperties = {
  width: "7px",
  height: "7px",
  borderRadius: "50%",
};
const RISK_BARS: CSSProperties = { height: "9px", gap: "1px" };
const RISK_BAR_HEIGHTS = ["4px", "6.5px", "9px"];
const SIGNALS_STYLE: CSSProperties = { fontSize: "10.5px" };
// #6458 (TITLE-D): the row's copy while the title wraps. It keeps its grid
// column at no width, so the chevron stays in its own column, and is hidden
// from sight and from screen readers; the facts line shows the signals.
const STOWED_STYLE: CSSProperties = {
  ...SIGNALS_STYLE,
  width: 0,
  overflow: "hidden",
  visibility: "hidden",
};

/**
 * #6449: a pin row's signals (mockup v6 :154-162, :672-682) — blocking,
 * stakes, risk, the automatic-pick marker, and age — each an indicator with
 * its tooltip. One click-stopping wrapper keeps a tap on any of them (or on
 * its touch bubble) from toggling the row. #6458 (TITLE-D): `stowed` is the
 * row's copy while an expanded pin's title wraps; the pin's facts line then
 * shows the signals.
 */
export function PinSignals(props: {
  model: PinViewModel;
  ageLabel: string;
  ageTooltip: string;
  armed: boolean;
  stowed?: boolean;
}) {
  const { model, ageLabel, ageTooltip, armed } = props;
  const { pin } = model;
  const stakes = STAKES_META[pin.stakes];
  const risk = RISK_META[pin.risk];
  const { timeZone } = usePinsContext();
  // #6452: the marker follows the pick's state, as the detail line does.
  const pick = automaticPickState(model);
  return (
    <span
      onClick={stopRowToggle}
      data-pin-signals=""
      aria-hidden={props.stowed ? true : undefined}
      className="inline-flex items-center gap-1.5 whitespace-nowrap text-[var(--app-hint)]"
      style={props.stowed ? STOWED_STYLE : SIGNALS_STYLE}
    >
      {pin.blocking ? (
        <PinIndicator
          armed={armed}
          label="Blocks a session's work until you answer"
          className="inline-flex text-[var(--status-hot)]"
        >
          <CircleAlert style={SIGNAL_ICON} aria-hidden />
        </PinIndicator>
      ) : null}
      <PinIndicator
        armed={armed}
        label={`Stakes: ${stakes?.label ?? pin.stakes}`}
        className="inline-flex items-center"
      >
        <i
          style={{
            ...STAKES_DOT,
            backgroundColor: stakes?.color ?? "var(--app-border)",
          }}
        />
      </PinIndicator>
      <PinIndicator
        armed={armed}
        label={`Risk: ${risk?.label ?? pin.risk}`}
        className="inline-flex items-end"
        style={RISK_BARS}
      >
        {RISK_BAR_HEIGHTS.map((height, index) => (
          <i
            key={height}
            className="rounded-full"
            style={{
              width: "2.5px",
              height,
              backgroundColor:
                risk && index < risk.level ? risk.color : "var(--app-border)",
            }}
          />
        ))}
      </PinIndicator>
      {pick.kind === "armed" ? (
        <PinIndicator
          armed={armed}
          label={`Picks ${pick.option} automatically at ${formatPinInstant(pick.at, timeZone)}`}
          className="inline-flex text-[var(--status-warn)]"
        >
          <Timer style={SIGNAL_ICON} aria-hidden />
        </PinIndicator>
      ) : pick.kind === "off" ? (
        <PinIndicator
          armed={armed}
          label="Automatic pick is off: waits for you"
          className="inline-flex"
        >
          <TimerOff style={SIGNAL_ICON} aria-hidden />
        </PinIndicator>
      ) : pick.kind === "unsupported" ? (
        <PinIndicator
          armed={armed}
          label="Waits for you: this session's node cannot make automatic picks yet"
          className="inline-flex"
        >
          <Lock style={SIGNAL_ICON} aria-hidden />
        </PinIndicator>
      ) : model.options.length > 0 ? (
        <PinIndicator
          armed={armed}
          label="Waits for you: no automatic pick"
          className="inline-flex"
        >
          <Lock style={SIGNAL_ICON} aria-hidden />
        </PinIndicator>
      ) : null}
      {ageLabel ? (
        <PinIndicator armed={armed} label={ageTooltip} className="tabular-nums">
          {ageLabel}
        </PinIndicator>
      ) : null}
    </span>
  );
}
