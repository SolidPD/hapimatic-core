// SPDX-License-Identifier: AGPL-3.0-only
import type { ThroughputLine, ThroughputSummary } from "@/types/api";

/** Display helpers for the Throughput tab (issue #6164). */

export function formatUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `$${v.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatPct(v: number | null | undefined, places = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(places)}%`;
}

export function formatCount(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return v.toLocaleString("en-US");
}

/** Tokens as 999 / 12K / 3.4M / 1.2B. */
export function formatTokens(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${Math.round(v / 1e3)}K`;
  return String(Math.round(v));
}

export function formatHours(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${v.toFixed(1)} h`;
}

/** The class of a selectable pill button (a breakdown dimension, a digest week). */
export function pillClass(active: boolean): string {
  return `rounded-full px-3 py-1 text-xs font-medium transition-colors ${
    active
      ? "bg-accent text-[var(--palette-accent-fg)]"
      : "bg-[var(--app-bg)] text-[var(--app-muted)] hover:text-[var(--app-fg)]"
  }`;
}

/** One day of the stacked cost chart (USD by series). */
export interface CostPoint {
  day: string;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  input: number;
}

/**
 * Daily cost in the chart's four series: cache read, cache writes (1-hour,
 * 5-minute and unknown-TTL together), output and uncached input.
 */
export function costSeries(byDay: readonly ThroughputLine[]): CostPoint[] {
  return [...byDay]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map(l => ({
      day: l.key.slice(5),
      cacheRead: l.usd.cacheRead,
      cacheWrite: l.usd.write1h + l.usd.write5m + l.usd.writeUnknown,
      output: l.usd.output,
      input: l.usd.input,
    }));
}

/** The cost split rows (category, USD, share of the total). */
export function costSplit(
  usd: ThroughputSummary["totals"]["usd"]
): Array<{ label: string; usd: number; share: number | null }> {
  const share = (v: number) => (usd.total > 0 ? v / usd.total : null);
  return [
    { label: "Cache read", usd: usd.cacheRead },
    { label: "1-hour cache write", usd: usd.write1h },
    { label: "5-minute cache write", usd: usd.write5m },
    { label: "Cache write, TTL unknown", usd: usd.writeUnknown },
    { label: "Output", usd: usd.output },
    { label: "Uncached input", usd: usd.input },
  ].map(r => ({ ...r, share: share(r.usd) }));
}

/** Human labels for the stage and source keys the rollups use. */
const LABELS: Record<string, string> = {
  none: "No issue stage",
  subagent: "Sub-agents",
  background_agent: "Background agents",
  ledger: "Ledger",
  recovered: "Recovered (no ledger tokens)",
  background: "Background agents",
  person: "A person",
  pm_peer: "PM or a peer session",
  scheduled_tick: "A scheduled tick",
  background_task: "A background task",
  tool_wait: "Waiting on a tool",
  unknown: "Unknown",
};

export function labelOf(key: string): string {
  return LABELS[key] ?? key;
}
