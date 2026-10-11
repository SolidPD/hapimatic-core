// SPDX-License-Identifier: AGPL-3.0-only
import type { TelemetryPeriodComparison } from "@/types/api";

interface ComparisonViewProps {
  comparison: TelemetryPeriodComparison[];
  isLoading: boolean;
  period1Label: string;
  period2Label: string;
}

export function ComparisonView({
  comparison,
  isLoading,
  period1Label,
  period2Label,
}: ComparisonViewProps) {
  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center text-[var(--app-muted)]">
        Loading...
      </div>
    );
  }

  if (comparison.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-[var(--app-muted)]">
        No data for selected periods
      </div>
    );
  }

  // Sort by absolute delta descending
  const sorted = [...comparison].sort(
    (a, b) => Math.abs(b.delta) - Math.abs(a.delta)
  );

  return (
    <div>
      <div className="mb-3 flex gap-4 text-xs text-[var(--app-muted)]">
        <span>
          <span className="mr-1 inline-block h-2 w-2 rounded-full bg-[var(--app-muted)]" />
          {period1Label}
        </span>
        <span>
          <span className="mr-1 inline-block h-2 w-2 rounded-full bg-[#5ae6ab]" />
          {period2Label}
        </span>
      </div>
      <div
        className="space-y-1.5 overflow-y-auto"
        style={{ maxHeight: "24rem" }}
      >
        {sorted.slice(0, 30).map(c => {
          const name = c.filePath.split("/").pop() ?? c.filePath;
          const maxCount = Math.max(c.period1Count, c.period2Count, 1);

          return (
            <div
              key={c.filePath}
              className="rounded-md bg-[var(--app-bg)] px-3 py-2"
            >
              <div className="flex items-center justify-between">
                <span
                  className="truncate text-xs text-[var(--app-fg)]"
                  title={c.filePath}
                >
                  {name}
                </span>
                <span
                  className={`text-xs font-medium ${
                    c.delta > 0
                      ? "text-red-400"
                      : c.delta < 0
                        ? "text-[#5ae6ab]"
                        : "text-[var(--app-muted)]"
                  }`}
                >
                  {c.delta > 0 ? "+" : ""}
                  {c.delta}
                  {c.deltaPercent !== null &&
                    ` (${c.deltaPercent > 0 ? "+" : ""}${c.deltaPercent.toFixed(0)}%)`}
                </span>
              </div>
              <div className="mt-1 space-y-0.5">
                <div className="flex items-center gap-2">
                  <div
                    className="h-1.5 rounded-full bg-[var(--app-muted)]"
                    style={{
                      width: `${(c.period1Count / maxCount) * 100}%`,
                      minWidth: c.period1Count > 0 ? "4px" : "0",
                    }}
                  />
                  <span className="min-w-[2rem] text-right text-[10px] text-[var(--app-muted)]">
                    {c.period1Count}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <div
                    className="h-1.5 rounded-full bg-[#5ae6ab]"
                    style={{
                      width: `${(c.period2Count / maxCount) * 100}%`,
                      minWidth: c.period2Count > 0 ? "4px" : "0",
                    }}
                  />
                  <span className="min-w-[2rem] text-right text-[10px] text-[var(--app-fg)]">
                    {c.period2Count}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
