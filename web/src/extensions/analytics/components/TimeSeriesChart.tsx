// SPDX-License-Identifier: AGPL-3.0-only
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import type { TelemetryTimeseries } from "@/types/api";

interface TimeSeriesChartProps {
  buckets: TelemetryTimeseries["buckets"];
  interval: string;
  isLoading: boolean;
}

export function TimeSeriesChart({
  buckets,
  interval,
  isLoading,
}: TimeSeriesChartProps) {
  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center text-[var(--app-muted)]">
        Loading...
      </div>
    );
  }

  if (buckets.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-[var(--app-muted)]">
        No data for this time range
      </div>
    );
  }

  const formatLabel = (bucket: string): string => {
    if (interval === "hour") {
      // "2026-04-07T14:00:00Z" → "Apr 7 14:00"
      const d = new Date(bucket);
      return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${d.getHours()}:00`;
    }
    if (interval === "week") {
      return bucket; // "2026-W14"
    }
    // day: "2026-04-07" → "Apr 7"
    const d = new Date(bucket + "T00:00:00Z");
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };

  const data = buckets.map(b => ({
    label: formatLabel(b.bucket),
    count: b.count,
  }));

  return (
    <div className="h-64">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <XAxis
            dataKey="label"
            stroke="var(--app-muted)"
            fontSize={11}
            tick={{ fill: "var(--app-fg)" }}
          />
          <YAxis
            stroke="var(--app-muted)"
            fontSize={12}
            allowDecimals={false}
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
          />
          <Line
            type="monotone"
            dataKey="count"
            stroke="#5ae6ab"
            strokeWidth={2}
            dot={{ fill: "#5ae6ab", r: 3 }}
            activeDot={{ r: 5 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
