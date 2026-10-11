// SPDX-License-Identifier: AGPL-3.0-only
import type { TelemetryAnomaly } from "@/types/api";

interface AnomalyDetectorProps {
  anomalies: TelemetryAnomaly[];
  isLoading: boolean;
}

export function AnomalyDetector({
  anomalies,
  isLoading,
}: AnomalyDetectorProps) {
  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center text-[var(--app-muted)]">
        Loading...
      </div>
    );
  }

  if (anomalies.length === 0) {
    return (
      <div className="flex h-40 flex-col items-center justify-center text-[var(--app-muted)]">
        <svg
          className="mb-2 h-8 w-8"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
        <span className="text-sm">No anomalies detected</span>
        <span className="mt-1 text-xs">
          All files within 3x standard deviation of 7-day baseline
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {anomalies.map(a => {
        const name = a.filePath.split("/").pop() ?? a.filePath;
        const severity =
          a.zScore > 5 ? "critical" : a.zScore > 4 ? "high" : "elevated";
        const severityColor = {
          critical: "text-red-400 bg-red-500/20",
          high: "text-orange-400 bg-orange-500/20",
          elevated: "text-yellow-400 bg-yellow-500/20",
        }[severity];

        return (
          <div key={a.filePath} className="rounded-lg bg-[var(--app-bg)] p-3">
            <div className="flex items-center justify-between">
              <span
                className="truncate text-xs font-medium text-[var(--app-fg)]"
                title={a.filePath}
              >
                {name}
              </span>
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${severityColor}`}
              >
                {severity} ({a.zScore.toFixed(1)}x)
              </span>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
              <div>
                <div className="text-[var(--app-muted)]">Today</div>
                <div className="font-medium text-[var(--app-fg)]">
                  {a.count}
                </div>
              </div>
              <div>
                <div className="text-[var(--app-muted)]">Baseline</div>
                <div className="font-medium text-[var(--app-fg)]">
                  {a.baselineMean.toFixed(1)}
                </div>
              </div>
              <div>
                <div className="text-[var(--app-muted)]">Std Dev</div>
                <div className="font-medium text-[var(--app-fg)]">
                  {a.baselineStddev.toFixed(1)}
                </div>
              </div>
            </div>
            <div className="mt-1 text-[10px] text-[var(--app-muted)]">
              {a.fileType} — {a.date}
            </div>
          </div>
        );
      })}
    </div>
  );
}
