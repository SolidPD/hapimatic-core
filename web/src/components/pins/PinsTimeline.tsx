// SPDX-License-Identifier: AGPL-3.0-only
import { memo, useMemo, type CSSProperties } from "react";
import { HoverTooltipButton } from "@/components/ui/tooltip";
import { hasAutomaticPick } from "@/lib/pins/deadline";
import {
  formatPinInstant,
  type DeadlineOf,
  type PinViewModel,
} from "@/lib/pins/ledger";
import { buildTimeline, type TimelinePick } from "@/lib/pins/timeline";

/**
 * #6451 (R8, R9): the strip of upcoming automatic picks the calendar toggle
 * shows (mockup v6 `timeline` :823-845, `.tl` :107-114). It plots EVERY open
 * pin's pick, not the filtered list (KD7), because a filter must not hide an
 * automatic action; a click asks the page to reveal the pin's row. The
 * ticks, labels and tooltips all use `zone` (#6452), the Pins context's.
 */

const SMALL: CSSProperties = { fontSize: "10px" };
const TRACK: CSSProperties = { height: "30px", marginTop: "3px" };
const NOW_BAR: CSSProperties = {
  top: "-6px",
  left: 0,
  width: "2px",
  height: "32px",
};
const TICK: CSSProperties = { top: "-4px", width: "1px", height: "7px" };
const DOT: CSSProperties = {
  width: "11px",
  height: "11px",
  boxShadow:
    "0 0 0 3px color-mix(in srgb, var(--pins-timeline) 25%, transparent)",
};
const SHIFT = { start: "0", center: "-50%", end: "-100%" } as const;

function picksOf(
  models: readonly PinViewModel[],
  deadlineOf: DeadlineOf
): TimelinePick[] {
  const picks: TimelinePick[] = [];
  for (const model of models) {
    const { pin, ifUnanswered } = model;
    if (pin.status !== "open" || pin.kind === "dashboard") continue;
    if (!hasAutomaticPick(model) || !ifUnanswered) continue;
    const at = deadlineOf(pin);
    if (at === undefined) continue;
    const label = model.options.find(o => o.id === ifUnanswered.option)?.label;
    picks.push({
      key: pin.key,
      title: pin.title,
      option: label ? `${ifUnanswered.option}. ${label}` : ifUnanswered.option,
      at,
    });
  }
  return picks;
}

export const PinsTimeline = memo(function PinsTimeline(props: {
  models: readonly PinViewModel[];
  now: number;
  deadlineOf: DeadlineOf;
  zone: string;
  onGo: (key: string) => void;
}) {
  const { models, now, deadlineOf, zone, onGo } = props;
  const timeline = useMemo(
    () => buildTimeline({ picks: picksOf(models, deadlineOf), now, zone }),
    [models, now, deadlineOf, zone]
  );
  const { days, total, later } = timeline;
  const summary =
    total === 0
      ? "No automatic picks scheduled"
      : `${total} automatic pick${total === 1 ? "" : "s"} · next ${days} day${
          days === 1 ? "" : "s"
        }${later > 0 ? ` · ${later} later` : ""}`;
  return (
    <section
      aria-label="Timeline of automatic picks"
      className="mx-2 mt-1.5 rounded-md border bg-[var(--app-secondary-bg)] px-2 pb-1 pt-1.5"
      style={{
        borderColor:
          "color-mix(in srgb, var(--pins-timeline) 35%, transparent)",
      }}
    >
      <div
        className="flex justify-between text-[var(--app-hint)]"
        style={SMALL}
      >
        <span>Now</span>
        <span>{summary}</span>
        <span>+{days}d</span>
      </div>
      <div
        className="relative text-[var(--app-hint)]"
        style={{ ...SMALL, height: "13px" }}
      >
        {timeline.dayLabels.map(label => (
          <span
            key={label.x}
            className="absolute -translate-x-1/2"
            style={{ left: `${label.x}%` }}
          >
            {label.text}
          </span>
        ))}
      </div>
      <div
        className="relative border-t border-[var(--app-border)]"
        style={TRACK}
      >
        <span
          aria-hidden
          className="absolute bg-[var(--app-accent)]"
          style={NOW_BAR}
        />
        {timeline.ticks.map(tick => (
          <span
            key={tick.at}
            aria-hidden
            className="absolute bg-[var(--app-border)]"
            style={{ ...TICK, left: `${tick.x}%` }}
          />
        ))}
        {timeline.points.map(point => {
          const name = `${point.title} · picks ${point.option} ${formatPinInstant(point.at, zone)}`;
          return (
            <HoverTooltipButton
              key={point.key}
              type="button"
              content={name}
              aria-label={name}
              onClick={() => onGo(point.key)}
              className="absolute flex flex-col items-center gap-px whitespace-nowrap rounded-sm font-bold text-[var(--pins-timeline)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--pins-timeline)]"
              style={{
                top: "4px",
                left: `${point.x}%`,
                transform: `translateX(${SHIFT[point.anchor]})`,
                fontSize: "9.5px",
              }}
            >
              <i
                aria-hidden
                className="block rounded-full bg-[var(--pins-timeline)]"
                style={DOT}
              />
              {point.showLabel ? <span>{point.label}</span> : null}
            </HoverTooltipButton>
          );
        })}
      </div>
    </section>
  );
});
