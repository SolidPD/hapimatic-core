// SPDX-License-Identifier: AGPL-3.0-only
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from "recharts";
import type { TelemetrySummary } from "@/types/api";

const TYPE_COLORS: Record<string, string> = {
  hook: "#5ae6ab",
  skill: "#60a5fa",
  agent: "#fb923c",
};

interface TypeDistributionProps {
  summary: TelemetrySummary | null;
  isLoading: boolean;
}

export function TypeDistribution({
  summary,
  isLoading,
}: TypeDistributionProps) {
  const data = (summary?.byType ?? []).map(t => ({
    name: t.fileType.charAt(0).toUpperCase() + t.fileType.slice(1) + "s",
    value: t.count,
    type: t.fileType,
  }));

  if (isLoading) {
    return (
      <div className="flex h-48 items-center justify-center text-[var(--app-muted)]">
        Loading...
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center text-[var(--app-muted)]">
        No data
      </div>
    );
  }

  return (
    <div className="flex items-center gap-4">
      <div className="h-48 w-48 flex-shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy="50%"
              innerRadius={40}
              outerRadius={70}
              strokeWidth={0}
            >
              {data.map(entry => (
                <Cell
                  key={entry.type}
                  fill={TYPE_COLORS[entry.type] ?? "#888"}
                />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{
                backgroundColor: "var(--app-secondary-bg)",
                border: "1px solid var(--app-border)",
                borderRadius: "8px",
                color: "var(--app-fg)",
              }}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div className="flex flex-col gap-2">
        {data.map(entry => (
          <div key={entry.type} className="flex items-center gap-2">
            <div
              className="h-3 w-3 rounded-full"
              style={{
                backgroundColor: TYPE_COLORS[entry.type] ?? "#888",
              }}
            />
            <span className="text-sm text-[var(--app-fg)]">
              {entry.name}: {entry.value.toLocaleString()}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
