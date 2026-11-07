// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import type { ApiClient } from "@/api/client";
import type { ThroughputBreakdownDim } from "@/types/api";
import {
  useThroughputBreakdown,
  type ThroughputRange,
} from "../../hooks/useThroughput";
import {
  formatCount,
  formatHours,
  formatPct,
  formatUsd,
  pillClass,
} from "./format";

const DIMS: Array<{ value: ThroughputBreakdownDim; label: string }> = [
  { value: "account", label: "Accounts" },
  { value: "session", label: "Sessions" },
  { value: "issue", label: "Issues" },
];

/**
 * Cost per account, session or issue (issue #6164), paged 200 rows at a time.
 * Accounts also show their weekly-quota use and runway.
 */
export function ThroughputBreakdownTable({
  api,
  range,
}: {
  api: ApiClient | null;
  range: ThroughputRange;
}) {
  const [dim, setDim] = useState<ThroughputBreakdownDim>("account");
  const [cursors, setCursors] = useState<string[]>([""]);
  const cursor = cursors[cursors.length - 1] ?? "";
  const { page, isLoading, error } = useThroughputBreakdown(
    api,
    dim,
    range,
    cursor
  );

  const pick = (next: ThroughputBreakdownDim) => {
    setDim(next);
    setCursors([""]);
  };
  return (
    <div>
      <div
        className="mb-3 flex flex-wrap gap-1"
        role="group"
        aria-label="Breakdown"
      >
        {DIMS.map(d => (
          <button
            key={d.value}
            type="button"
            onClick={() => pick(d.value)}
            className={pillClass(dim === d.value)}
            aria-pressed={dim === d.value}
          >
            {d.label}
          </button>
        ))}
      </div>
      {isLoading ? (
        <div className="py-6 text-center text-xs text-[var(--app-muted)]">
          Loading...
        </div>
      ) : error || !page ? (
        <div className="py-6 text-center text-xs text-[var(--app-muted)]">
          {error ?? "No data."}
        </div>
      ) : page.rows.length === 0 ? (
        <div className="py-6 text-center text-xs text-[var(--app-muted)]">
          Nothing in this window.
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-[var(--app-muted)]">
                <tr>
                  <th className="py-1 pr-2 font-medium">
                    {DIMS.find(d => d.value === dim)?.label.slice(0, -1)}
                  </th>
                  <th className="py-1 pr-2 text-right font-medium">Turns</th>
                  <th className="py-1 pr-2 text-right font-medium">Cost</th>
                  {dim === "account" ? (
                    <>
                      <th className="py-1 pr-2 text-right font-medium">
                        Weekly use
                      </th>
                      <th className="py-1 text-right font-medium">Runway</th>
                    </>
                  ) : null}
                </tr>
              </thead>
              <tbody className="text-[var(--app-fg)]">
                {page.rows.map(r => (
                  <tr
                    key={r.key}
                    className="border-t border-[var(--app-border)]"
                  >
                    <td
                      className="max-w-[12rem] truncate py-1 pr-2"
                      title={r.key}
                    >
                      {r.label ?? r.key}
                    </td>
                    <td className="py-1 pr-2 text-right">
                      {formatCount(r.turns)}
                    </td>
                    <td className="py-1 pr-2 text-right">
                      {formatUsd(r.usd.total)}
                    </td>
                    {dim === "account" ? (
                      <>
                        <td className="py-1 pr-2 text-right">
                          {r.quota?.utilization !== null &&
                          r.quota?.utilization !== undefined
                            ? `${Math.round(r.quota.utilization)}%`
                            : "—"}
                        </td>
                        <td className="py-1 text-right">
                          {formatHours(r.quota?.runwayHours)}
                        </td>
                      </>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-2 flex items-center justify-between text-xs text-[var(--app-muted)]">
            <span>
              {formatCount(page.total)} total
              {page.unattributedShare !== null
                ? ` · unattributed ${formatPct(page.unattributedShare)}`
                : ""}
            </span>
            <span className="flex gap-2">
              <button
                type="button"
                disabled={cursors.length <= 1}
                onClick={() => setCursors(c => c.slice(0, -1))}
                className="disabled:opacity-40"
              >
                Previous
              </button>
              <button
                type="button"
                disabled={!page.nextCursor}
                onClick={() =>
                  page.nextCursor && setCursors(c => [...c, page.nextCursor!])
                }
                className="disabled:opacity-40"
              >
                Next
              </button>
            </span>
          </div>
        </>
      )}
    </div>
  );
}
