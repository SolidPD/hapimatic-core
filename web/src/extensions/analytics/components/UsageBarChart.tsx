// SPDX-License-Identifier: AGPL-3.0-only
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import type { TelemetrySummary } from "@/types/api";

interface UsageBarChartProps {
  summary: TelemetrySummary | null;
  isLoading: boolean;
}

export function UsageBarChart({ summary, isLoading }: UsageBarChartProps) {
  const data = (summary?.byFile ?? []).slice(0, 20).map(f => ({
    name: f.filePath.split("/").pop() ?? f.filePath,
    fullPath: f.filePath,
    count: f.count,
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
        No telemetry data yet
      </div>
    );
  }

  return (
    <div className="h-80">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ left: 120 }}>
          <XAxis type="number" stroke="var(--app-muted)" fontSize={12} />
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
            formatter={value => [
              typeof value === "number"
                ? value.toLocaleString()
                : String(value ?? 0),
              "Events",
            ]}
            labelFormatter={(label: unknown) => {
              const s = String(label);
              const item = data.find(d => d.name === s);
              return item?.fullPath ?? s;
            }}
          />
          <Bar dataKey="count" fill="#5ae6ab" radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
