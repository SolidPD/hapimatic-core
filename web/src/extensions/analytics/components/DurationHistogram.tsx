// SPDX-License-Identifier: AGPL-3.0-only
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import type { TelemetryDurationStats } from "@/types/api";

interface DurationHistogramProps {
  stats: TelemetryDurationStats[];
  isLoading: boolean;
}

export function DurationHistogram({
  stats,
  isLoading,
}: DurationHistogramProps) {
  const data = stats
    .filter(s => s.avgMs !== null)
    .slice(0, 20)
    .map(s => ({
      name: s.filePath.split("/").pop() ?? s.filePath,
      fullPath: s.filePath,
      p50: s.p50Ms !== null ? Math.round(s.p50Ms) : 0,
      p95: s.p95Ms !== null ? Math.round(s.p95Ms) : 0,
      p99: s.p99Ms !== null ? Math.round(s.p99Ms) : 0,
      avg: s.avgMs !== null ? Math.round(s.avgMs) : 0,
      samples: s.sampleCount,
    }));

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center text-[var(--app-muted)]">
        Loading...
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-[var(--app-muted)]">
        No duration data yet — hooks need to report completion events
      </div>
    );
  }

  return (
    <div className="h-80">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ left: 120 }}>
          <XAxis
            type="number"
            stroke="var(--app-muted)"
            fontSize={12}
            unit="ms"
          />
          <YAxis
            type="category"
            dataKey="name"
            width={110}
            stroke="var(--app-muted)"
            fontSize={11}
            tick={{ fill: "var(--app-fg)" }}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "var(--app-secondary-bg)",
              border: "1px solid var(--app-border)",
              borderRadius: "8px",
              color: "var(--app-fg)",
            }}
            formatter={(value, name) => [
              `${typeof value === "number" ? value.toLocaleString() : String(value ?? 0)}ms`,
              String(name).toUpperCase(),
            ]}
            labelFormatter={(label: unknown) => {
              const s = String(label);
              const item = data.find(d => d.name === s);
              return item ? `${item.fullPath} (${item.samples} samples)` : s;
            }}
          />
          <ReferenceLine x={100} stroke="#ef4444" strokeDasharray="3 3" />
          <Bar dataKey="p50" fill="#5ae6ab" radius={[0, 2, 2, 0]} />
          <Bar dataKey="p95" fill="#fbbf24" radius={[0, 2, 2, 0]} />
          <Bar dataKey="p99" fill="#ef4444" radius={[0, 2, 2, 0]} />
        </BarChart>
      </ResponsiveContainer>
      <div className="mt-2 flex items-center justify-center gap-4 text-xs text-[var(--app-muted)]">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-[#5ae6ab]" />
          P50
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-[#fbbf24]" />
          P95
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-[#ef4444]" />
          P99
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-0.5 bg-[#ef4444]" />
          100ms threshold
        </span>
      </div>
    </div>
  );
}
