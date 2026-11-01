// SPDX-License-Identifier: AGPL-3.0-only
import { ResetStamp } from "./ResetStamp";
import { UsageArc } from "./UsageArc";
import {
  columnResetText,
  usageGridStyle,
  type UsageColumn,
} from "./usageMeters";

/** The line under an arc: the shared reset text, with a relative time read as
 *  "… left" ("resets now" once due). */
export function relativeLine(col: UsageColumn, now?: number): string {
  const text = columnResetText(col, now);
  if (col.resetLabel || col.placeholder || !col.resetsAt || text === "") {
    return text;
  }
  return text === "now" ? "resets now" : `${text} left`;
}

/** The relative line, with " left" dropped in a column narrower than 4rem (a
 *  container query on the column), so five columns at 393px stay readable. */
function RelativeText({ text }: { text: string }) {
  if (!text.endsWith(" left")) return <>{text || " "}</>;
  return (
    <>
      {text.slice(0, -" left".length)}
      <span className="@max-[4rem]:hidden"> left</span>
    </>
  );
}

/**
 * The Arcs usage view (#4467 R2/R3): one column per meter on an equal grid,
 * each with its title above a semicircular arc, the relative time left below,
 * and the absolute reset beneath. Props are the contract #4600 renders outside
 * the Accounts page: `columns = buildUsageColumns(utilization, provider)`.
 */
export function ArcsView({
  columns,
  now,
}: {
  columns: UsageColumn[];
  now?: number;
}) {
  return (
    <div
      data-testid="usage-arcs"
      className="grid gap-2 py-2"
      style={usageGridStyle(columns.length)}
    >
      {columns.map(col => {
        const line = relativeLine(col, now);
        return (
          <div
            key={col.id}
            data-testid="usage-column"
            data-column-id={col.id}
            data-placeholder={col.placeholder ? "true" : undefined}
            className="@container flex min-w-0 flex-col items-center gap-1 text-center"
          >
            <span
              title={col.title}
              className={`w-full truncate text-[length:var(--text-caption)] leading-tight text-[var(--app-hint)]${
                col.placeholder ? " opacity-60" : ""
              }`}
            >
              {col.title}
            </span>
            <UsageArc pct={col.pct} />
            <span
              data-testid="usage-relative"
              className="w-full truncate text-[length:var(--text-caption)] leading-tight text-[var(--app-fg)]"
            >
              <RelativeText text={line} />
            </span>
            {col.resetsAt ? <ResetStamp resetsAt={col.resetsAt} /> : null}
          </div>
        );
      })}
    </div>
  );
}
