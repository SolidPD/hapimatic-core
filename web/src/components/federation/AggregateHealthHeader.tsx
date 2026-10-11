// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Federation-route-internal presentational component (issue #1792).
 *
 * Single consumer by design: `web/src/routes/settings/federation.tsx`. It lives in
 * `components/federation/` alongside the shared federation primitives; its single
 * import site is intentional, not accidental dead code — a future "single-use"
 * audit should treat it as federation-internal.
 */
import type {
  FederationHealthAggregate,
  FederationHealthSeverity,
} from "@hapi/protocol";
import { FederationStatusDot } from "./FederationStatusDot";
import { SegmentedToggle } from "@/components/ui/SegmentedToggle";

/** The Tier-1 filter-tab selection (R3). "degraded" = degraded|warning|critical. */
export type NodeFilter = "all" | "healthy" | "degraded" | "offline";

/** Per-bucket node counts shown as pill chips (R1). */
export type FederationStatusCounts = {
  healthy: number;
  /** degraded + warning + critical (the non-healthy, non-offline bucket). */
  degraded: number;
  offline: number;
};

const SEVERITY_LABEL: Record<FederationHealthSeverity, string> = {
  healthy: "Healthy",
  degraded: "Degraded",
  warning: "Warning",
  critical: "Critical",
};

const DIMENSIONS: { key: "cpu" | "ram" | "disk" | "latency"; label: string }[] =
  [
    { key: "cpu", label: "CPU" },
    { key: "ram", label: "RAM" },
    { key: "disk", label: "Disk" },
    { key: "latency", label: "Lat" },
  ];

const FILTER_TABS: { key: NodeFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "healthy", label: "Healthy" },
  { key: "degraded", label: "Degraded" },
  { key: "offline", label: "Offline" },
];

type AggregateHealthHeaderProps = {
  aggregate: FederationHealthAggregate | null;
  counts: FederationStatusCounts;
  totalNodes: number;
  openAlertsCount: number;
  lastSampleAt: number | null;
  metricsUnavailable: boolean;
  activeFilter: NodeFilter;
  onFilterChange: (filter: NodeFilter) => void;
};

function formatLastSample(ts: number | null): string | null {
  if (!ts) return null;
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return "updated just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `updated ${hours}h ago`;
  return `updated ${Math.floor(hours / 24)}d ago`;
}

/**
 * Tier-1 aggregate federation health header (issue #1037, R1–R4).
 *
 * Renders the worst-case severity badge (R2 — displayed AS-IS, never averaged),
 * the per-dimension worst-case row, the per-status node count pills, the open
 * alerts count, and the chip-style filter tabs. When `metricsUnavailable`, a
 * non-blocking banner is shown above a placeholder "Unknown" severity (R12).
 */
export function AggregateHealthHeader({
  aggregate,
  counts,
  totalNodes,
  openAlertsCount,
  lastSampleAt,
  metricsUnavailable,
  activeFilter,
  onFilterChange,
}: AggregateHealthHeaderProps) {
  // R2: display worstCaseSeverity AS-IS. No client averaging or numeric score.
  const worst = aggregate?.worstCaseSeverity ?? null;
  const worstLabel = worst ? SEVERITY_LABEL[worst] : "Unknown";
  const lastSampleText = formatLastSample(lastSampleAt);

  return (
    <section
      data-testid="federation-aggregate-header"
      className="flex flex-col gap-3 border-b border-[var(--app-border)] px-4 py-3"
    >
      {metricsUnavailable && (
        <div
          data-testid="federation-metrics-unavailable"
          className="rounded-md bg-[var(--app-secondary-bg)] px-3 py-2 text-[length:var(--text-body-dense)] text-[var(--app-hint)]"
        >
          Federation metrics are unavailable right now — showing node identity
          only.
        </div>
      )}

      {/* Worst-case severity headline (the categorical "health score"). */}
      <div className="flex items-center gap-3">
        <FederationStatusDot
          status={worst ?? "offline"}
          size="lg"
          data-testid="federation-worst-dot"
          label={`worst-case severity ${worstLabel}`}
        />
        <div className="flex min-w-0 flex-col">
          <span
            className={
              /* design-tokens-allow: 16px is above the dense type-scale ladder (tops at 14px label-strong); text-base would inject a 1.5rem line-height (R6 forbids line-height change) — D2 px-floor exception precedent (#3358) */ "text-[16px] font-semibold text-[var(--app-fg)]"
            }
          >
            {worstLabel}
          </span>
          <span className="text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
            Worst-case across {totalNodes} node{totalNodes === 1 ? "" : "s"}
            {lastSampleText ? ` · ${lastSampleText}` : ""}
          </span>
        </div>
      </div>

      {/* Per-dimension worst-case row. */}
      {aggregate && (
        <div
          data-testid="federation-per-dimension"
          className="flex flex-wrap gap-3"
        >
          {DIMENSIONS.map(dim => {
            const sev = aggregate.perDimensionWorstCase[dim.key];
            return (
              <span
                key={dim.key}
                className="flex items-center gap-1.5 text-[length:var(--text-body-dense)] text-[var(--app-hint)]"
              >
                <FederationStatusDot
                  status={sev}
                  size="sm"
                  label={`${dim.label} ${sev}`}
                />
                {dim.label}
              </span>
            );
          })}
        </div>
      )}

      {/* Per-status count pills + open alerts count. */}
      <div className="flex flex-wrap items-center gap-2">
        <span
          data-testid="federation-count-healthy"
          className="rounded-full bg-[var(--app-secondary-bg)] px-2.5 py-1 text-[length:var(--text-body-dense)] text-[var(--app-fg)]"
        >
          {counts.healthy} healthy
        </span>
        <span
          data-testid="federation-count-degraded"
          className="rounded-full bg-[var(--app-secondary-bg)] px-2.5 py-1 text-[length:var(--text-body-dense)] text-[var(--app-fg)]"
        >
          {counts.degraded} degraded
        </span>
        <span
          data-testid="federation-count-offline"
          className="rounded-full bg-[var(--app-secondary-bg)] px-2.5 py-1 text-[length:var(--text-body-dense)] text-[var(--app-fg)]"
        >
          {counts.offline} offline
        </span>
        <span
          data-testid="federation-open-alerts"
          className="rounded-full bg-[var(--app-secondary-bg)] px-2.5 py-1 text-[length:var(--text-body-dense)] text-[var(--app-fg)]"
        >
          {openAlertsCount} alert{openAlertsCount === 1 ? "" : "s"}
        </span>
      </div>

      {/* Filter control (R3) — shared SegmentedToggle (A4 / #1980, KD-4). The
          per-segment `federation-filter-{key}` testids are preserved via
          testIdPrefix; the ARIA role migrates from tablist to radiogroup (a
          single-select filter is more correctly a radiogroup than a tablist). */}
      <SegmentedToggle<NodeFilter>
        options={FILTER_TABS.map(tab => ({ value: tab.key, label: tab.label }))}
        value={activeFilter}
        onChange={onFilterChange}
        ariaLabel="Filter nodes"
        testIdPrefix="federation-filter"
        className="flex-wrap"
      />
    </section>
  );
}
