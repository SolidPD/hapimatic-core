// SPDX-License-Identifier: AGPL-3.0-only
import { memo, useState, type CSSProperties } from "react";
import { HoverTooltip } from "@/components/ui/tooltip";
import type { StageCell, StageCellState } from "@/lib/pins/dashboards";

const STATE_STYLE: Record<StageCellState, CSSProperties> = {
  done: {
    backgroundColor: "color-mix(in srgb, var(--app-accent) 18%, transparent)",
  },
  current: {
    backgroundColor:
      "color-mix(in srgb, var(--status-cat-working) 30%, transparent)",
    boxShadow: "inset 0 0 0 1px var(--status-cat-working)",
  },
  waiting: {
    backgroundColor:
      "color-mix(in srgb, var(--status-cat-attention) 28%, transparent)",
    boxShadow: "inset 0 0 0 1px var(--status-cat-attention)",
  },
  todo: { filter: "grayscale(1)", opacity: 0.28 },
  // Ruling D3: an optional stage passed over reads dimmer than one to come.
  skipped: { filter: "grayscale(1)", opacity: 0.16 },
};

/**
 * #6454: a lane's eight Issue Workflow stages (mockup v6 `track()` :747-755,
 * `.trk` :216-221), fixed cells so the icons line up across lanes. Each cell
 * says its stage and state in a tooltip ("📝 researched: done").
 */
export const LaneStageTrack = memo(function LaneStageTrack(props: {
  cells: readonly StageCell[];
}) {
  // One tooltip for the track, naming the cell under the pointer (or the one
  // tapped), rather than eight per lane: a tooltip costs a mount (#6449).
  const [shown, setShown] = useState(0);
  const tooltip = props.cells[shown]?.tooltip ?? props.cells[0]?.tooltip ?? "";
  return (
    <HoverTooltip content={tooltip}>
      <span
        className="pins-track"
        role="list"
        aria-label="Issue Workflow stages"
      >
        {props.cells.map((cell, index) => (
          <span
            key={cell.stage}
            role="listitem"
            aria-label={cell.tooltip}
            data-state={cell.state}
            className={cell.state === "current" ? "animate-pulse" : undefined}
            style={STATE_STYLE[cell.state]}
            onPointerEnter={() => setShown(index)}
            onPointerDown={() => setShown(index)}
          >
            {cell.emoji}
          </span>
        ))}
      </span>
    </HoverTooltip>
  );
});
