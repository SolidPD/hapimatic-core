// SPDX-License-Identifier: AGPL-3.0-only
import type { TelemetryOutcomeRate } from "@/types/api";

interface OutcomeRatesProps {
  rates: TelemetryOutcomeRate[];
  isLoading: boolean;
}

export function OutcomeRates({ rates, isLoading }: OutcomeRatesProps) {
  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center text-[var(--app-muted)]">
        Loading...
      </div>
    );
  }

  if (rates.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-[var(--app-muted)]">
        No outcome data yet
      </div>
    );
  }

  // Only show files that have some non-zero outcome data
  const filtered = rates.filter(
    r => r.successCount + r.failureCount + r.errorCount + r.blockCount > 0
  );

  // Sort by failure rate descending
  const sorted = [...filtered].sort((a, b) => b.failureRate - a.failureRate);

  return (
    <div className="space-y-2 overflow-y-auto" style={{ maxHeight: "24rem" }}>
      {sorted.slice(0, 25).map(r => {
        const name = r.filePath.split("/").pop() ?? r.filePath;
        const isHighFailure = r.failureRate > 0.1;
        const total =
          r.successCount +
          r.failureCount +
          r.errorCount +
          r.skipCount +
          r.blockCount;

        return (
          <div key={r.filePath} className="rounded-md bg-[var(--app-bg)] p-3">
            <div className="flex items-center justify-between">
              <span
                className="truncate text-xs font-medium text-[var(--app-fg)]"
                title={r.filePath}
              >
                {name}
              </span>
              {isHighFailure && (
                <span className="ml-2 rounded bg-red-500/20 px-1.5 py-0.5 text-[10px] font-medium text-red-400">
                  {(r.failureRate * 100).toFixed(1)}% fail
                </span>
              )}
            </div>
            {/* Stacked bar */}
            <div className="mt-1.5 flex h-2 overflow-hidden rounded-full bg-[var(--app-secondary-bg)]">
              {r.successCount > 0 && (
                <div
                  className="bg-[#5ae6ab]"
                  style={{ width: `${(r.successCount / total) * 100}%` }}
                  title={`Success: ${r.successCount}`}
                />
              )}
              {r.failureCount > 0 && (
                <div
                  className="bg-[#ef4444]"
                  style={{ width: `${(r.failureCount / total) * 100}%` }}
                  title={`Failure: ${r.failureCount}`}
                />
              )}
              {r.errorCount > 0 && (
                <div
                  className="bg-[#f97316]"
                  style={{ width: `${(r.errorCount / total) * 100}%` }}
                  title={`Error: ${r.errorCount}`}
                />
              )}
              {r.blockCount > 0 && (
                <div
                  className="bg-[#fbbf24]"
                  style={{ width: `${(r.blockCount / total) * 100}%` }}
                  title={`Blocked: ${r.blockCount}`}
                />
              )}
              {r.skipCount > 0 && (
                <div
                  className="bg-[#6b7280]"
                  style={{ width: `${(r.skipCount / total) * 100}%` }}
                  title={`Skip: ${r.skipCount}`}
                />
              )}
            </div>
            <div className="mt-1 flex gap-3 text-[10px] text-[var(--app-muted)]">
              <span>{r.totalCount} total</span>
              {r.successCount > 0 && <span>{r.successCount} ok</span>}
              {r.failureCount > 0 && (
                <span className="text-red-400">{r.failureCount} fail</span>
              )}
              {r.errorCount > 0 && (
                <span className="text-orange-400">{r.errorCount} err</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
