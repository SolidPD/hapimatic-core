// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo, useState } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { useAppContext } from "@/lib/app-context";
import { useAppGoBack } from "@/hooks/useAppGoBack";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { useEmojiFavicon } from "@/hooks/useEmojiFavicon";
import { BarChart3 } from "lucide-react";
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
  const { startTime, comparisonPeriods } = useMemo(() => {
    const now = Date.now();
    const periodMs = selectedRange?.ms ?? 7 * 24 * 60 * 60 * 1000;
    return {
      startTime: selectedRange ? now - selectedRange.ms : undefined,
      comparisonPeriods: {
        period1Start: now - 2 * periodMs,
        period1End: now - periodMs,
        period2Start: now - periodMs,
        period2End: now,
      },
    };
  }, [selectedRange]);

  // ── MVP data hooks ──────────────────────────────────
  const { summary, isLoading: summaryLoading } = useTelemetrySummary(api, {
    fileType: fileType || undefined,
    startTime,
  });

  const { buckets, isLoading: timeseriesLoading } = useTelemetryTimeseries(
    api,
    { interval, startTime }
  );

  const { files, isLoading: filesLoading } = useTelemetryFiles(api, {
    fileType: fileType || undefined,
  });

  // ── Phase 2 data hooks ─────────────────────────────
  const { stats: durationStats, isLoading: durationLoading } =
    useTelemetryDurationStats(api, {
      fileType: fileType || undefined,
    });

  const { rates: outcomeRates, isLoading: outcomeLoading } =
    useTelemetryOutcomeRates(api, {
      fileType: fileType || undefined,
    });

  const { anomalies, isLoading: anomaliesLoading } = useTelemetryAnomalies(api);

  const { estimates: tokenEstimates, isLoading: tokensLoading } =
    useTelemetryTokenEstimates(api, {
      fileType: fileType || undefined,
      startTime,
    });

  const { sessions, isLoading: sessionsLoading } =
    useTelemetrySessionAggregates(api, { startTime });

  const { comparison, isLoading: comparisonLoading } = useTelemetryComparison(
    api,
    comparisonPeriods
  );

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

          {/* Tabs */}
          <Tabs.Root defaultValue="overview">
            <Tabs.List className="mb-4 flex gap-1 border-b border-[var(--app-border)]">
              {[
                { value: "overview", label: "Overview" },
                { value: "performance", label: "Performance" },
                { value: "intelligence", label: "Intelligence" },
                { value: "compare", label: "Compare" },
              ].map(tab => (
                <Tabs.Trigger
                  key={tab.value}
                  value={tab.value}
                  className="border-b-2 border-transparent px-3 py-2 text-xs font-medium text-[var(--app-muted)] transition-colors hover:text-[var(--app-fg)] data-[state=active]:border-[#5ae6ab] data-[state=active]:text-[#5ae6ab]"
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
          </Tabs.Root>
        </div>
      </div>
    </div>
  );
}
