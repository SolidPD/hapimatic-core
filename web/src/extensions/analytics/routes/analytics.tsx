// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo, useState } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { useAppContext } from "@/lib/app-context";
import { useAppGoBack } from "@/hooks/useAppGoBack";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { useEmojiFavicon } from "@/hooks/useEmojiFavicon";
import { AlertTriangle, BarChart3 } from "lucide-react";
import { BackIcon } from "@/components/icons";
import { TitleChip } from "@/components/settings/SettingsSectionHeader";
import {
  useTelemetrySummary,
  useTelemetryTimeseries,
  useTelemetryFiles,
  useTelemetryDurationStats,
  useTelemetryOutcomeRates,
  useTelemetryAnomalies,
  useTelemetryComparison,
  useTelemetryTokenEstimates,
  useTelemetrySessionAggregates,
  type TelemetryFailure,
} from "../hooks/useTelemetry";
import { UsageOverview } from "../components/UsageOverview";
import { UsageBarChart } from "../components/UsageBarChart";
import { TimeSeriesChart } from "../components/TimeSeriesChart";
import { TypeDistribution } from "../components/TypeDistribution";
import { FileTable } from "../components/FileTable";
import { DurationHistogram } from "../components/DurationHistogram";
import { OutcomeRates } from "../components/OutcomeRates";
import { AnomalyDetector } from "../components/AnomalyDetector";
import { TokenBudget } from "../components/TokenBudget";
import { SessionProfiles } from "../components/SessionProfiles";
import { ComparisonView } from "../components/ComparisonView";
import { ThroughputPanel } from "../components/throughput/ThroughputPanel";

const TIME_RANGES: Array<{ label: string; value: string; ms: number }> = [
  { label: "24h", value: "24h", ms: 24 * 60 * 60 * 1000 },
  { label: "7d", value: "7d", ms: 7 * 24 * 60 * 60 * 1000 },
  { label: "30d", value: "30d", ms: 30 * 24 * 60 * 60 * 1000 },
  { label: "90d", value: "90d", ms: 90 * 24 * 60 * 60 * 1000 },
];

const FILE_TYPES = [
  { label: "All", value: "" },
  { label: "Hooks", value: "hook" },
  { label: "Skills", value: "skill" },
  { label: "Agents", value: "agent" },
];

const INTERVALS = [
  { label: "Hour", value: "hour" },
  { label: "Day", value: "day" },
  { label: "Week", value: "week" },
];

/**
 * The causes a 503 from the Analytics routes names (issue #6516), most
 * serious first: when several queries fail, the notice names the worst.
 */
const TELEMETRY_FAILURE_CAUSES: Array<[code: string, text: string]> = [
  [
    "telemetry_unavailable",
    "The Analytics query worker is unavailable on this server.",
  ],
  ["telemetry_timeout", "An Analytics query took too long."],
  ["telemetry_busy", "The server is busy with other Analytics queries."],
];

function TelemetryFailureNotice(props: {
  failures: TelemetryFailure[];
  total: number;
}) {
  const { failures, total } = props;
  const named = TELEMETRY_FAILURE_CAUSES.find(([code]) =>
    failures.some(f => f.code === code)
  );
  const title = named ? named[1] : failures[0].message;
  // A failed first load leaves its panel on the empty state; a failed refetch
  // keeps the earlier results on screen (TanStack Query keeps `data`), so the
  // copy counts the two apart (#6516 A-3).
  const stale = failures.filter(f => f.hasData).length;
  const empty = failures.length - stale;
  const panels =
    stale === 0
      ? "their panels show no data."
      : empty === 0
        ? "their panels show older results."
        : `${empty} ${empty === 1 ? "panel shows" : "panels show"} no data and ${stale} ${stale === 1 ? "shows" : "show"} older results.`;
  // A compact alert row (the CapacityNotice shape), not a centred StatePanel:
  // it sits above the tabs, so every line it takes pushes the panels down.
  return (
    <div
      role="alert"
      data-testid="analytics-telemetry-failure"
      className="mb-3 flex items-start gap-1.5 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-[length:var(--text-caption)] leading-snug text-red-400"
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>
        {title} {failures.length} of {total} Analytics queries failed; {panels}
      </span>
    </div>
  );
}

export default function AnalyticsPage(props?: { onBack?: () => void }) {
  const { api } = useAppContext();
  const defaultGoBack = useAppGoBack();
  const goBack = props?.onBack ?? defaultGoBack;
  useDocumentTitle("Analytics - Hapimatic");
  useEmojiFavicon(null);

  const [timeRange, setTimeRange] = useState("7d");
  const [fileType, setFileType] = useState("");
  const [interval, setInterval] = useState("day");

  const selectedRange = TIME_RANGES.find(r => r.value === timeRange);

  // issue #1924: sample the wall clock only when the selected range changes,
  // so the telemetry query keys (which embed startTime + comparison-period
  // bounds) stay stable across unrelated re-renders and don't drive an
  // infinite refetch loop. selectedRange is a stable dependency for a fixed
  // timeRange (find over a module-level constant array).
  const { startTime, comparisonPeriods, throughputRange } = useMemo(() => {
    const now = Date.now();
    const periodMs = selectedRange?.ms ?? 7 * 24 * 60 * 60 * 1000;
    return {
      startTime: selectedRange ? now - selectedRange.ms : undefined,
      // Issue #6164: the Throughput tab's window (the server snaps it to whole
      // UTC days); sampled with the same clock so its query keys stay stable.
      throughputRange: { from: now - periodMs, to: now },
      comparisonPeriods: {
        period1Start: now - 2 * periodMs,
        period1End: now - periodMs,
        period2Start: now - periodMs,
        period2End: now,
      },
    };
  }, [selectedRange]);

  // ── MVP data hooks ──────────────────────────────────
  const {
    summary,
    isLoading: summaryLoading,
    failure: summaryFailure,
  } = useTelemetrySummary(api, {
    fileType: fileType || undefined,
    startTime,
  });

  const {
    buckets,
    isLoading: timeseriesLoading,
    failure: timeseriesFailure,
  } = useTelemetryTimeseries(api, { interval, startTime });

  const {
    files,
    isLoading: filesLoading,
    failure: filesFailure,
  } = useTelemetryFiles(api, {
    fileType: fileType || undefined,
  });

  // ── Phase 2 data hooks ─────────────────────────────
  const {
    stats: durationStats,
    isLoading: durationLoading,
    failure: durationFailure,
  } = useTelemetryDurationStats(api, {
    fileType: fileType || undefined,
  });

  const {
    rates: outcomeRates,
    isLoading: outcomeLoading,
    failure: outcomeFailure,
  } = useTelemetryOutcomeRates(api, {
    fileType: fileType || undefined,
  });

  const {
    anomalies,
    isLoading: anomaliesLoading,
    failure: anomaliesFailure,
  } = useTelemetryAnomalies(api);

  const {
    estimates: tokenEstimates,
    isLoading: tokensLoading,
    failure: tokensFailure,
  } = useTelemetryTokenEstimates(api, {
    fileType: fileType || undefined,
    startTime,
  });

  const {
    sessions,
    isLoading: sessionsLoading,
    failure: sessionsFailure,
  } = useTelemetrySessionAggregates(api, { startTime });

  const {
    comparison,
    isLoading: comparisonLoading,
    failure: comparisonFailure,
  } = useTelemetryComparison(api, comparisonPeriods);

  // Issue #6516: name the cause of any failed telemetry query; the panels
  // whose queries succeeded keep rendering below the notice.
  const failures = [
    summaryFailure,
    timeseriesFailure,
    filesFailure,
    durationFailure,
    outcomeFailure,
    anomaliesFailure,
    tokensFailure,
    sessionsFailure,
    comparisonFailure,
  ].filter((f): f is TelemetryFailure => Boolean(f));

  const prevLabel = `Previous ${selectedRange?.label ?? "7d"}`;
  const currLabel = `Current ${selectedRange?.label ?? "7d"}`;

  const btnClass = (active: boolean) =>
    `px-3 py-1 rounded-full text-xs font-medium transition-colors ${
      active
        ? "bg-accent text-[var(--palette-accent-fg)]"
        : "bg-[var(--app-secondary-bg)] text-[var(--app-muted)] hover:text-[var(--app-fg)]"
    }`;

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 z-10 bg-[var(--app-bg)]">
          <div className="mx-auto flex w-full max-w-content items-center justify-between px-3 py-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={goBack}
                className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
              >
                <BackIcon className="h-5 w-5" />
              </button>
              <TitleChip icon={BarChart3} accent="#60a5fa" />
              <h1 className="min-w-0 truncate text-lg font-bold text-[var(--app-fg)]">
                Analytics
              </h1>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="mx-auto w-full max-w-content px-3 pb-4">
          {/* Filters */}
          <div className="mb-4 flex flex-wrap gap-4">
            <div className="flex items-center gap-1">
              <span className="mr-1 text-xs text-[var(--app-muted)]">
                Range:
              </span>
              {TIME_RANGES.map(r => (
                <button
                  key={r.value}
                  type="button"
                  onClick={() => setTimeRange(r.value)}
                  className={btnClass(timeRange === r.value)}
                >
                  {r.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1">
              <span className="mr-1 text-xs text-[var(--app-muted)]">
                Type:
              </span>
              {FILE_TYPES.map(t => (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => setFileType(t.value)}
                  className={btnClass(fileType === t.value)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {failures.length > 0 && (
            <TelemetryFailureNotice failures={failures} total={9} />
          )}

          {/* Tabs */}
          <Tabs.Root defaultValue="overview">
            {/* Scrolls on its own at phone width (five tabs pass 393px), so
                opening a tab never scrolls the whole page sideways (#6164). */}
            <Tabs.List className="mb-4 flex gap-1 overflow-x-auto border-b border-[var(--app-border)] scrollbar-none">
              {[
                { value: "overview", label: "Overview" },
                { value: "performance", label: "Performance" },
                { value: "intelligence", label: "Intelligence" },
                { value: "compare", label: "Compare" },
                { value: "throughput", label: "Throughput" },
              ].map(tab => (
                <Tabs.Trigger
                  key={tab.value}
                  value={tab.value}
                  className="shrink-0 whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-xs font-medium text-[var(--app-muted)] transition-colors hover:text-[var(--app-fg)] data-[state=active]:border-[#5ae6ab] data-[state=active]:text-[#5ae6ab]"
                >
                  {tab.label}
                </Tabs.Trigger>
              ))}
            </Tabs.List>

            {/* Overview Tab (existing MVP content) */}
            <Tabs.Content value="overview" className="space-y-6">
              <section>
                <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-[var(--app-muted)]">
                  Overview
                </h2>
                <UsageOverview summary={summary} isLoading={summaryLoading} />
              </section>

              <div className="grid gap-6 lg:grid-cols-2">
                <section className="rounded-lg bg-[var(--app-secondary-bg)] p-4">
                  <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-[var(--app-muted)]">
                    Top Files
                  </h2>
                  <UsageBarChart summary={summary} isLoading={summaryLoading} />
                </section>

                <section className="rounded-lg bg-[var(--app-secondary-bg)] p-4">
                  <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-[var(--app-muted)]">
                    Type Distribution
                  </h2>
                  <TypeDistribution
                    summary={summary}
                    isLoading={summaryLoading}
                  />
                </section>
              </div>

              <section className="rounded-lg bg-[var(--app-secondary-bg)] p-4">
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-sm font-medium uppercase tracking-wider text-[var(--app-muted)]">
                    Activity Over Time
                  </h2>
                  <div className="flex gap-1">
                    {INTERVALS.map(i => (
                      <button
                        key={i.value}
                        type="button"
                        onClick={() => setInterval(i.value)}
                        className={btnClass(interval === i.value)}
                      >
                        {i.label}
                      </button>
                    ))}
                  </div>
                </div>
                <TimeSeriesChart
                  buckets={buckets}
                  interval={interval}
                  isLoading={timeseriesLoading}
                />
              </section>

              <section>
                <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-[var(--app-muted)]">
                  All Files
                </h2>
                <FileTable files={files} isLoading={filesLoading} />
              </section>
            </Tabs.Content>

            {/* Performance Tab */}
            <Tabs.Content value="performance" className="space-y-6">
              <div className="grid gap-6 lg:grid-cols-2">
                <section className="rounded-lg bg-[var(--app-secondary-bg)] p-4">
                  <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-[var(--app-muted)]">
                    Duration Histogram (P50 / P95 / P99)
                  </h2>
                  <DurationHistogram
                    stats={durationStats}
                    isLoading={durationLoading}
                  />
                </section>

                <section className="rounded-lg bg-[var(--app-secondary-bg)] p-4">
                  <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-[var(--app-muted)]">
                    Outcome Rates
                  </h2>
                  <OutcomeRates
                    rates={outcomeRates}
                    isLoading={outcomeLoading}
                  />
                </section>
              </div>
            </Tabs.Content>

            {/* Intelligence Tab */}
            <Tabs.Content value="intelligence" className="space-y-6">
              <section className="rounded-lg bg-[var(--app-secondary-bg)] p-4">
                <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-[var(--app-muted)]">
                  Anomaly Detection
                </h2>
                <AnomalyDetector
                  anomalies={anomalies}
                  isLoading={anomaliesLoading}
                />
              </section>

              <div className="grid gap-6 lg:grid-cols-2">
                <section className="rounded-lg bg-[var(--app-secondary-bg)] p-4">
                  <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-[var(--app-muted)]">
                    Token Budget
                  </h2>
                  <TokenBudget
                    estimates={tokenEstimates}
                    isLoading={tokensLoading}
                  />
                </section>

                <section className="rounded-lg bg-[var(--app-secondary-bg)] p-4">
                  <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-[var(--app-muted)]">
                    Session Profiles
                  </h2>
                  <SessionProfiles
                    sessions={sessions}
                    isLoading={sessionsLoading}
                  />
                </section>
              </div>
            </Tabs.Content>

            {/* Compare Tab */}
            <Tabs.Content value="compare" className="space-y-6">
              <section className="rounded-lg bg-[var(--app-secondary-bg)] p-4">
                <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-[var(--app-muted)]">
                  Before / After Comparison
                </h2>
                <p className="mb-3 text-xs text-[var(--app-muted)]">
                  Comparing the previous {selectedRange?.label ?? "7d"} period
                  against the current {selectedRange?.label ?? "7d"}. Positive
                  delta (red) = increased usage. Negative delta (green) =
                  decreased usage.
                </p>
                <ComparisonView
                  comparison={comparison}
                  isLoading={comparisonLoading}
                  period1Label={prevLabel}
                  period2Label={currLabel}
                />
              </section>
            </Tabs.Content>

            {/* Throughput Tab (issue #6164) — its queries run only while open */}
            <Tabs.Content value="throughput">
              <ThroughputPanel api={api} range={throughputRange} />
            </Tabs.Content>
          </Tabs.Root>
        </div>
      </div>
    </div>
  );
}
