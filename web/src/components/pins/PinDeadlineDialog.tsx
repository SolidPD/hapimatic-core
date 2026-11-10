// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type ReactNode } from "react";
import {
  PIN_DEADLINE_MAX_AHEAD_MS,
  PIN_DEADLINE_MIN_LEAD_MS,
  pinDeadlineAfterMs,
} from "@hapi/protocol";
import type { ApiClient } from "@/api/client";
import { useToast } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/Input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { HoverTooltipButton } from "@/components/ui/tooltip";
import {
  pinDeadlineErrorMessage,
  useSetPinDeadline,
} from "@/hooks/queries/usePins";
import { formatCountdown, type AutomaticPickState } from "@/lib/pins/deadline";
import type { PinViewModel } from "@/lib/pins/ledger";
import { useMinuteNow } from "@/lib/pins/useMinuteNow";
import { cn } from "@/lib/utils";
import {
  formatZonedWhen,
  instantToZonedInput,
  nextWeekdayAt,
  wallTimeOn,
  zonedInputToInstant,
} from "@/lib/pins/zoneTime";

/**
 * #6452 (R6, R7, R8): the dialog that moves, stops, or restarts a pin's
 * automatic pick (mockup v6 `renderDeadline`, :879-890). Every time is shown
 * and read in the Pins zone (`PinsContext.timeZone`), never the device's: the
 * exact field converts with `zonedInputToInstant`, because the scheduler form's
 * conversion reads the device zone and shifts an edited time by its offset.
 */

const HOUR_MS = 60 * 60 * 1000;
const MOVES: ReadonlyArray<{ label: string; ms: number; what: string }> = [
  { label: "−1 h", ms: -HOUR_MS, what: "an hour earlier" },
  { label: "+1 h", ms: HOUR_MS, what: "an hour later" },
  { label: "+4 h", ms: 4 * HOUR_MS, what: "four hours later" },
  { label: "+1 day", ms: 24 * HOUR_MS, what: "a day later" },
  { label: "+1 week", ms: 7 * 24 * HOUR_MS, what: "a week later" },
];

/** Why an instant cannot be a pick time, or null: the server's own range. */
export function deadlineRangeProblem(at: number, now: number): string | null {
  if (at < now + PIN_DEADLINE_MIN_LEAD_MS) {
    return "That is under a minute from now";
  }
  if (at > now + PIN_DEADLINE_MAX_AHEAD_MS) {
    return "That is more than a year from now";
  }
  return null;
}

type Draft = { off: boolean; at: number };

export type PinDeadlineDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  api: ApiClient | null;
  sessionId: string;
  model: PinViewModel;
  /** The pick as the dialog opens: armed at a time, or turned off. */
  state: Extract<AutomaticPickState, { kind: "armed" | "off" }>;
  timeZone: string;
  /** Tests inject the clock; the dialog reads it on every render. */
  now?: () => number;
};

export function PinDeadlineDialog(props: PinDeadlineDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        className="max-w-lg"
        description="Change when the session picks this pin's option for you"
      >
        <DialogHeader>
          <DialogTitle>Automatic pick</DialogTitle>
        </DialogHeader>
        {/* Mounted only while open, so each opening starts from the pin. */}
        <DeadlineForm {...props} />
      </DialogContent>
    </Dialog>
  );
}

function DeadlineForm(props: PinDeadlineDialogProps) {
  const { model, state, timeZone: zone } = props;
  useMinuteNow(); // re-render each minute, so the countdown and limits move
  const clock = props.now ?? Date.now;
  const now = clock();
  const afterMs = pinDeadlineAfterMs(model.ifUnanswered?.after ?? "");
  const [initial] = useState<Draft>(() =>
    state.kind === "armed"
      ? { off: false, at: state.at }
      : { off: true, at: now + afterMs }
  );
  const [draft, setDraft] = useState<Draft>(initial);
  const { setDeadline, isPending } = useSetPinDeadline(
    props.api,
    props.sessionId
  );
  const { showToast } = useToast();

  const target =
    state.label === state.option
      ? state.option
      : `${state.option}. ${state.label}`;
  const changed =
    draft.off !== initial.off || (!draft.off && draft.at !== initial.at);
  const tomorrow = wallTimeOn(now, zone, { addDays: 1, hour: 9 });
  const monday = nextWeekdayAt(now, zone, 1, 9);

  // Each time control turns the pick on at the time it names.
  const choose = (at: number) => setDraft({ off: false, at });

  const save = async () => {
    if (isPending || !changed) return;
    if (!draft.off) {
      // Checked again at Save: the dialog may have stayed open a while.
      const problem = deadlineRangeProblem(draft.at, clock());
      if (problem) {
        showToast(`${problem}: choose another time`, { type: "error" });
        return;
      }
    }
    try {
      await setDeadline(
        model.pin.key,
        draft.off ? { off: true } : { at: new Date(draft.at).toISOString() }
      );
      showToast(
        draft.off
          ? "Automatic pick off: the pin waits for you"
          : `Automatic pick at ${formatZonedWhen(draft.at, zone)}`,
        { type: "success" }
      );
      props.onOpenChange(false);
    } catch (error) {
      showToast(pinDeadlineErrorMessage(error), { type: "error" });
    }
  };

  return (
    <div className="mt-2 text-[length:var(--text-body)]">
      <p className="text-[var(--app-hint)]">
        If you haven&rsquo;t answered &ldquo;{model.pin.title}&rdquo;, the
        session picks <b className="text-[var(--app-fg)]">{target}</b> at:
      </p>
      <p className="mt-1 text-[length:var(--text-label-strong)] font-bold tabular-nums">
        {draft.off ? "Off: waits for you" : formatZonedWhen(draft.at, zone)}
      </p>
      {draft.off ? null : (
        <p className="text-[var(--status-warn)] tabular-nums">
          in {formatCountdown(draft.at, now)}
        </p>
      )}

      <Label>Move it by</Label>
      <div className="flex flex-wrap gap-1.5">
        {MOVES.map(move => (
          <Chip
            key={move.label}
            tooltip={`Move the pick ${move.what}`}
            problem={deadlineRangeProblem(draft.at + move.ms, now)}
            onPick={() => choose(draft.at + move.ms)}
          >
            {move.label}
          </Chip>
        ))}
      </div>

      <Label>Jump to</Label>
      <div className="flex flex-wrap gap-1.5">
        <Chip
          tooltip={`Pick at ${formatZonedWhen(tomorrow, zone)}`}
          problem={deadlineRangeProblem(tomorrow, now)}
          onPick={() => choose(tomorrow)}
        >
          Tomorrow 9 AM
        </Chip>
        <Chip
          tooltip={`Pick at ${formatZonedWhen(monday, zone)}`}
          problem={deadlineRangeProblem(monday, now)}
          onPick={() => choose(monday)}
        >
          Next Monday 9 AM
        </Chip>
      </div>

      <Label htmlFor="pin-deadline-exact">Exact date and time</Label>
      <Input
        id="pin-deadline-exact"
        type="datetime-local"
        value={instantToZonedInput(draft.at, zone)}
        min={instantToZonedInput(now + PIN_DEADLINE_MIN_LEAD_MS, zone)}
        max={instantToZonedInput(now + PIN_DEADLINE_MAX_AHEAD_MS, zone)}
        onChange={event => {
          const at = zonedInputToInstant(event.target.value, zone);
          if (at !== null) choose(at);
        }}
        className="w-full tabular-nums"
      />
      <p className="mt-1 text-[length:var(--text-caption)] text-[var(--app-hint)]">
        Times in {zone}
      </p>

      <div className="mt-3 flex items-center gap-2">
        <HoverTooltipButton
          type="button"
          content={
            draft.off
              ? "Turn the pick back on, the pin's own time from now"
              : "Never pick automatically: the pin waits for you"
          }
          onClick={() =>
            setDraft(
              draft.off
                ? { off: false, at: now + afterMs }
                : { ...draft, off: true }
            )
          }
          className="min-w-0 truncate text-left text-[length:var(--text-body-dense)] text-[var(--app-link)] hover:underline"
        >
          {draft.off ? "Turn automatic pick on" : "Turn automatic pick off"}
        </HoverTooltipButton>
        <span className="flex-1" />
        <Button
          type="button"
          variant="secondary"
          onClick={() => props.onOpenChange(false)}
          disabled={isPending}
        >
          Cancel
        </Button>
        <Button
          type="button"
          onClick={() => void save()}
          disabled={!changed || isPending}
          tooltipOnDisabled
          title={changed ? undefined : "Nothing has changed"}
        >
          {isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

function Label(props: { children: ReactNode; htmlFor?: string }) {
  return (
    <label
      htmlFor={props.htmlFor}
      className="mb-1 mt-3 block text-[length:var(--text-caption)] font-semibold text-[var(--app-hint)]"
    >
      {props.children}
    </label>
  );
}

/**
 * A preset time control. One out of range stays focusable, with its reason in
 * the tooltip, and does nothing (`aria-disabled`, as `Button`'s inert state).
 */
function Chip(props: {
  children: ReactNode;
  tooltip: string;
  problem: string | null;
  onPick: () => void;
}) {
  const { problem } = props;
  return (
    <HoverTooltipButton
      type="button"
      content={problem ?? props.tooltip}
      aria-disabled={problem ? true : undefined}
      onClick={problem ? undefined : props.onPick}
      className={cn(
        "rounded-md border border-[var(--app-border)] px-2 py-1 text-xs tabular-nums transition-colors",
        problem
          ? "cursor-not-allowed text-[var(--app-hint)] opacity-50"
          : "text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]"
      )}
    >
      {props.children}
    </HoverTooltipButton>
  );
}
