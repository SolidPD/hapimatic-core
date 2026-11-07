// SPDX-License-Identifier: AGPL-3.0-only
import {
  Bar,
  BarChart,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { tokens } from "@/design/tokens";
import type { ThroughputLine } from "@/types/api";
import { costSeries, formatUsd } from "./format";

/**
 * Daily API-equivalent cost, stacked by category (issue #6164). Series colors
 * are the design system's ordinal chart tokens (cache read, cache write,
 * output — the same order as the token-usage widget) plus the muted token for
 * uncached input.
 */
export function ThroughputCostChart({ byDay }: { byDay: ThroughputLine[] }) {
  const data = costSeries(byDay);
  if (data.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center text-xs text-[var(--app-muted)]">
        No cost in this window.
      </div>
    );
  }
  return (
    <div className="h-56 w-full" data-testid="throughput-cost-chart">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <XAxis
            dataKey="day"
            tick={{ fontSize: 10 }}
            stroke="var(--app-muted)"
            interval="preserveStartEnd"
          />
          <YAxis
            tick={{ fontSize: 10 }}
            stroke="var(--app-muted)"
            width={44}
            tickFormatter={(v: number) => `$${Math.round(v)}`}
          />
          <Tooltip
            formatter={v => formatUsd(typeof v === "number" ? v : Number(v))}
            contentStyle={{
              background: "var(--app-bg)",
              border: "1px solid var(--app-border)",
              fontSize: 12,
            }}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Bar
            dataKey="cacheRead"
            name="Cache read"
            stackId="usd"
            fill={tokens.chart[1]}
          />
          <Bar
            dataKey="cacheWrite"
            name="Cache write"
            stackId="usd"
            fill={tokens.chart[2]}
          />
          <Bar
            dataKey="output"
            name="Output"
            stackId="usd"
            fill={tokens.chart[3]}
          />
          <Bar
            dataKey="input"
            name="Uncached input"
            stackId="usd"
            fill="var(--app-muted)"
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
