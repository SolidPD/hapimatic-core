// SPDX-License-Identifier: AGPL-3.0-only
import { useLayoutEffect, useRef, useState } from "react";
import { LEVEL_COLOR, usageLevel } from "../UsageBar";
import {
  chipCompact,
  columnResetText,
  usageGridStyle,
  type UsageColumn,
} from "./usageMeters";

/** The compact chip's separator: a middle dot between thin spaces, so a
 *  five-column card at 393px still fits "Cr · 103%" (#4467). */
const COMPACT_SEP = "\u2009·\u2009";

/**
 * The Chips usage view (#4467 R4): one chip per meter on the same column grid
 * as Arcs, so chips line up under one another across accounts. Each reads bold
 * name · percentage · relative reset. Below `CHIP_COMPACT_BELOW_PX` per column
 * (measured on the first column) the name abbreviates and the chip takes two
 * rows: "5h · 31%" over "2h 14m". Props are the contract #4600 renders outside
 * the Accounts page: `columns = buildUsageColumns(utilization, provider)`.
 */
export function ChipsView({
  columns,
  now,
}: {
  columns: UsageColumn[];
  now?: number;
}) {
  const firstRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);

  useLayoutEffect(() => {
    const cell = firstRef.current;
    if (!cell) return;
    const update = () => setCompact(chipCompact(cell.clientWidth));
    update();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    ro.observe(cell);
    return () => ro.disconnect();
  }, [columns.length]);

  return (
    <div
      data-testid="usage-chips"
      data-compact={compact ? "true" : "false"}
      className={`grid py-2 ${compact ? "gap-1" : "gap-1.5"}`}
      style={usageGridStyle(columns.length)}
    >
      {columns.map((col, i) => {
        const color =
          col.pct == null
            ? "var(--app-hint)"
            : LEVEL_COLOR[usageLevel(col.pct)];
        const pct = col.pct == null ? "—" : `${Math.round(col.pct)}%`;
        const reset = columnResetText(col, now);
        const name = compact ? col.shortTitle : col.title;
        return (
          <div
            key={col.id}
            ref={i === 0 ? firstRef : undefined}
            data-testid="usage-chip"
            data-column-id={col.id}
            data-placeholder={col.placeholder ? "true" : undefined}
            title={col.title}
            className={`min-w-0 rounded-md bg-[var(--app-subtle-bg)] py-1 leading-tight text-[var(--app-hint)] ${
              compact
                ? "px-1 text-[length:var(--text-caption-xs)]"
                : "px-1.5 text-[length:var(--text-caption)]"
            }${col.placeholder ? " opacity-60" : ""}`}
          >
            {compact ? (
              <>
                <div className="truncate">
                  <span className="font-bold text-[var(--app-fg)]">{name}</span>
                  {COMPACT_SEP}
                  <span
                    className="font-semibold tabular-nums"
                    style={{ color }}
                  >
                    {pct}
                  </span>
                </div>
                <div className="truncate">{reset || " "}</div>
              </>
            ) : (
              <div className="truncate">
                <span className="font-bold text-[var(--app-fg)]">{name}</span>
                {" · "}
                <span className="font-semibold tabular-nums" style={{ color }}>
                  {pct}
                </span>
                {reset ? ` · ${reset}` : ""}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
