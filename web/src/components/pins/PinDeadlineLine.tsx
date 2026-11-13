// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type CSSProperties } from "react";
import { CalendarClock, Timer, TimerOff } from "lucide-react";
import { PinDeadlineDialog } from "@/components/pins/PinDeadlineDialog";
import { usePinsContext } from "@/components/pins/pinsShared";
import { HoverTooltipButton } from "@/components/ui/tooltip";
import {
  automaticPickState,
  formatCountdown,
  type AutomaticPickState,
} from "@/lib/pins/deadline";
import type { PinViewModel } from "@/lib/pins/ledger";
import { useStagedPin } from "@/lib/pins/staging";
import { useMinuteNow } from "@/lib/pins/useMinuteNow";
import { cn } from "@/lib/utils";
import { formatPickTime } from "@/lib/pins/zoneTime";

/**
 * #6452 (R9): the automatic-pick line at the end of an open decision pin's
 * detail (mockup v6 `deadlineBar`, `.deadline` :308-314), on one row: what it
 * will pick and when, then a button that opens the deadline dialog. Nothing
 * for a pin with no pick, or from a node built before #6452. #6539 (R12):
 * while a dismissal is staged the button is inert, because staging turned the
 * pick off to hold it and re-arming it here would undo the hold; Undo is the
 * way back.
 */
export function PinDeadlineLine(props: { model: PinViewModel }) {
  const state = automaticPickState(props.model);
  if (state.kind !== "armed" && state.kind !== "off") return null;
  return <Line model={props.model} state={state} />;
}

const ICON: CSSProperties = { width: "13px", height: "13px" };
/** Why the button does nothing while a dismissal is staged. */
export const DEADLINE_HELD_TOOLTIP = "Undo turns the automatic pick back on";
const ARMED_FILL: CSSProperties = {
  background: "color-mix(in srgb, var(--status-warn) 9%, transparent)",
};

// Its own minute clock, so only this line re-renders as the countdown moves:
// never the row (memoized) or the view model (cached by pin).
function Line(props: {
  model: PinViewModel;
  state: Extract<AutomaticPickState, { kind: "armed" | "off" }>;
}) {
  const { model, state } = props;
  const { api, sessionId, timeZone } = usePinsContext();
  const now = useMinuteNow();
  const [open, setOpen] = useState(false);
  const armed = state.kind === "armed";
  const Icon = armed ? Timer : TimerOff;
  const held = useStagedPin(sessionId, model.pin.key)?.dismiss === true;
  return (
    <>
      <div
        className={cn(
          "mt-2 flex flex-nowrap items-center gap-1.5 rounded-md px-2 py-1 text-[length:var(--text-body-dense)]",
          armed
            ? "text-[var(--app-fg)]"
            : "bg-[var(--app-subtle-bg)] text-[var(--app-hint)]"
        )}
        style={armed ? ARMED_FILL : undefined}
      >
        <Icon
          style={ICON}
          className={cn("flex-none", armed && "text-[var(--status-warn)]")}
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate">
          {armed ? (
            <>
              Auto-picks <b>{state.option}</b>
              {state.at <= now ? (
                <>
                  {" · "}
                  <b className="text-[var(--status-warn)]">due now</b>
                </>
              ) : (
                <>
                  {/* As short as names the moment, so the row fits a phone. */}
                  {` ${formatPickTime(state.at, now, timeZone)} · `}
                  <b className="tabular-nums text-[var(--status-warn)]">
                    {formatCountdown(state.at, now)}
                  </b>
                </>
              )}
            </>
          ) : (
            "Automatic pick is off · waits for you"
          )}
        </span>
        {/* Inert, not `disabled`: a disabled button shows no tooltip, and the
            tooltip is what says why (the `ui/button.tsx` #3462 pattern). */}
        <HoverTooltipButton
          type="button"
          content={
            held
              ? DEADLINE_HELD_TOOLTIP
              : armed
                ? "Move or turn off this pin's automatic pick"
                : "Set a time for this pin's automatic pick"
          }
          aria-disabled={held || undefined}
          onClick={held ? undefined : () => setOpen(true)}
          className="inline-flex h-6 flex-none items-center gap-1 whitespace-nowrap rounded-md border border-[var(--app-border)] px-2 text-xs font-semibold text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
        >
          <CalendarClock
            style={{ width: "12px", height: "12px" }}
            aria-hidden
          />
          {armed ? "Change…" : "Set…"}
        </HoverTooltipButton>
      </div>
      {open && !held ? (
        <PinDeadlineDialog
          open
          onOpenChange={setOpen}
          api={api}
          sessionId={sessionId}
          model={model}
          state={state}
          timeZone={timeZone}
        />
      ) : null}
    </>
  );
}
