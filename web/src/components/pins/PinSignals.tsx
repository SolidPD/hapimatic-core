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

/**
 * #6449: a pin row's signals (mockup v6 :154-162, :672-682) — blocking,
 * stakes, risk, the automatic-pick marker, and age — each an indicator with
 * its tooltip. One click-stopping wrapper keeps a tap on any of them (or on
 * its touch bubble) from toggling the row.
 */
export function PinSignals(props: {
  model: PinViewModel;
  ageLabel: string;
  ageTooltip: string;
  armed: boolean;
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
      className="inline-flex items-center gap-1.5 whitespace-nowrap text-[var(--app-hint)]"
      style={{ fontSize: "10.5px" }}
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
