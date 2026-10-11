// SPDX-License-Identifier: AGPL-3.0-only
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import type { TelemetryTokenEstimate } from "@/types/api";

interface TokenBudgetProps {
  estimates: TelemetryTokenEstimate[];
  isLoading: boolean;
}

/**
 * Measured skill context-load cost (issue #2154).
 *
 * Two things changed with the switch from estimated to measured data:
 *
 * The headline was an extrapolated *weekly* rate built from a constant
 * per-skill token figure. With real per-invocation measurements there is no
 * reason to extrapolate: the selected range is already the window the user
 * picked, so the total is summed over that window directly.
 *
 * And skills with no measurement in the window are now separated out instead of
 * being charted. Their cost is unknown, not zero — charting them at 0 would put
 * them at the bottom of the diet list, which is exactly backwards for a skill
 * nobody has measured yet.
 */
export function TokenBudget({ estimates, isLoading }: TokenBudgetProps) {
  const measured = estimates.filter(e => e.measured && e.tokensP50 !== null);
  const unmeasuredCount = estimates.length - measured.length;

  // Rank by total window cost (frequency x measured size) — the quantity a diet
  // actually reclaims. Per-load p50/p90 stay in the tooltip: that is what you
  // shrink, while this is what shrinking it is worth.
  const data = measured
    .map(e => ({
      name: e.filePath.split("/").pop() ?? e.filePath,
      fullPath: e.filePath,
      windowTokens: e.invocationCount * (e.tokensP50 ?? 0),
      invocations: e.invocationCount,
      tokensP50: e.tokensP50 ?? 0,
      tokensP90: e.tokensP90 ?? 0,
      sampleCount: e.sampleCount,
    }))
    .sort((a, b) => b.windowTokens - a.windowTokens)
    .slice(0, 20);

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center text-[var(--app-muted)]">
        Loading...
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-1 text-[var(--app-muted)]">
        <div>No measured token data yet</div>
        {unmeasuredCount > 0 && (
          <div className="text-[10px]">
            {unmeasuredCount} skill{unmeasuredCount === 1 ? "" : "s"} invoked
            but not yet measured
          </div>
        )}
      </div>
    );
  }

  const totalWindow = data.reduce((sum, d) => sum + d.windowTokens, 0);

  return (
    <div>
      <div className="mb-3 rounded-lg bg-[var(--app-bg)] p-3">
        <div className="text-xs text-[var(--app-muted)]">
          Measured Skill Token Cost
        </div>
        <div className="mt-1 text-xl font-semibold text-[var(--app-fg)]">
          {totalWindow.toLocaleString()} tokens
        </div>
        <div className="text-[10px] text-[var(--app-muted)]">
          Invocations x measured p50 injected size, over the selected range
          {unmeasuredCount > 0 && (
            <> &middot; {unmeasuredCount} not yet measured (excluded)</>
          )}
        </div>
      </div>
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" margin={{ left: 120 }}>
            <XAxis
              type="number"
              stroke="var(--app-muted)"
              fontSize={12}
              tickFormatter={v =>
                typeof v === "number" && v >= 1000
                  ? `${(v / 1000).toFixed(1)}k`
                  : String(v)
              }
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
              formatter={(value, _name, entry) => {
                const d = entry?.payload as (typeof data)[number] | undefined;
                const total =
                  typeof value === "number"
                    ? value.toLocaleString()
                    : String(value ?? 0);
                if (!d) return [`${total} tokens`, "Window Cost"];
                return [
                  `${total} tokens (p50 ${d.tokensP50.toLocaleString()} / p90 ${d.tokensP90.toLocaleString()} per load, n=${d.sampleCount})`,
                  "Window Cost",
                ];
              }}
              labelFormatter={(label: unknown) => {
                const s = String(label);
                const item = data.find(d => d.name === s);
                return item
                  ? `${item.fullPath} (${item.invocations} invocations)`
                  : s;
              }}
            />
            <Bar dataKey="windowTokens" fill="#a78bfa" radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
