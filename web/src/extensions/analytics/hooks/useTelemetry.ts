// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import { ApiError, type ApiClient } from "@/api/client";
import type {
  TelemetryAnomaly,
  TelemetryDurationStats,
  TelemetryFile,
  TelemetryOutcomeRate,
  TelemetryPeriodComparison,
  TelemetrySessionAggregate,
  TelemetrySummary,
  TelemetryTimeseries,
  TelemetryTokenEstimate,
} from "@/types/api";
import { queryKeys } from "@/lib/query-keys";

/**
 * A failed telemetry query (issue #6516): its message and the API's typed
 * `code`. A 503 from the Analytics routes carries `telemetry_unavailable`,
 * `telemetry_busy` or `telemetry_timeout`, which the page names.
 */
export interface TelemetryFailure {
  message: string;
  code: string | null;
  /**
   * The query still holds an earlier success's results. After a failed
   * refetch TanStack Query keeps the old `data`, so the panel shows those
   * older figures, not its empty state (#6516 A-3).
   */
  hasData: boolean;
}

/** `data` is the query's `data`: required, so every hook says whether it has any. */
export function telemetryFailure(
  error: unknown,
  data: unknown
): TelemetryFailure | null {
  if (!error) return null;
  return {
    message: error instanceof Error ? error.message : String(error),
    code: error instanceof ApiError ? (error.code ?? null) : null,
    hasData: data !== undefined,
  };
}

export function useTelemetrySummary(
  api: ApiClient | null,
  filters?: { fileType?: string; startTime?: number; endTime?: number }
): {
  summary: TelemetrySummary | null;
  isLoading: boolean;
  failure: TelemetryFailure | null;
  error: string | null;
} {
  const query = useQuery({
    queryKey: queryKeys.telemetrySummary(filters?.fileType, filters?.startTime),
    queryFn: async ({ signal }) => {
      if (!api) throw new Error("API unavailable");
      return await api.getTelemetrySummary(filters, signal);
    },
    enabled: Boolean(api),
    refetchInterval: 60_000,
  });

  return {
    summary: query.data ?? null,
    isLoading: query.isLoading,
    failure: telemetryFailure(query.error, query.data),
    error:
      query.error instanceof Error
        ? query.error.message
        : query.error
          ? "Failed to load telemetry summary"
          : null,
  };
}

export function useTelemetryTimeseries(
  api: ApiClient | null,
  params: {
    filePath?: string;
    interval: string;
    startTime?: number;
    endTime?: number;
  }
): {
  buckets: TelemetryTimeseries["buckets"];
  isLoading: boolean;
  failure: TelemetryFailure | null;
  error: string | null;
} {
  const query = useQuery({
    queryKey: queryKeys.telemetryTimeseries(params.interval, params.filePath),
    queryFn: async ({ signal }) => {
      if (!api) throw new Error("API unavailable");
      return await api.getTelemetryTimeseries(params, signal);
    },
    enabled: Boolean(api),
    refetchInterval: 60_000,
  });

  return {
    buckets: query.data?.buckets ?? [],
    isLoading: query.isLoading,
    failure: telemetryFailure(query.error, query.data),
    error:
      query.error instanceof Error
        ? query.error.message
        : query.error
          ? "Failed to load telemetry timeseries"
          : null,
  };
}

export function useTelemetryFiles(
  api: ApiClient | null,
  filters?: { fileType?: string }
): {
  files: TelemetryFile[];
  isLoading: boolean;
  failure: TelemetryFailure | null;
  error: string | null;
} {
  const query = useQuery({
    queryKey: queryKeys.telemetryFiles(filters?.fileType),
    queryFn: async ({ signal }) => {
      if (!api) throw new Error("API unavailable");
      return await api.getTelemetryFiles(filters, signal);
    },
    enabled: Boolean(api),
    refetchInterval: 60_000,
  });

  return {
    files: query.data?.files ?? [],
    isLoading: query.isLoading,
    failure: telemetryFailure(query.error, query.data),
    error:
      query.error instanceof Error
        ? query.error.message
        : query.error
          ? "Failed to load telemetry files"
          : null,
  };
}

export function useTelemetryDurationStats(
  api: ApiClient | null,
  filters?: { fileType?: string }
): {
  stats: TelemetryDurationStats[];
  isLoading: boolean;
  failure: TelemetryFailure | null;
} {
  const query = useQuery({
    queryKey: queryKeys.telemetryDurationStats(filters?.fileType),
    queryFn: async ({ signal }) => {
      if (!api) throw new Error("API unavailable");
      return await api.getTelemetryDurationStats(filters, signal);
    },
    enabled: Boolean(api),
    refetchInterval: 60_000,
  });

  return {
    stats: query.data?.stats ?? [],
    isLoading: query.isLoading,
    failure: telemetryFailure(query.error, query.data),
  };
}

export function useTelemetryOutcomeRates(
  api: ApiClient | null,
  filters?: { fileType?: string }
): {
  rates: TelemetryOutcomeRate[];
  isLoading: boolean;
  failure: TelemetryFailure | null;
} {
  const query = useQuery({
    queryKey: queryKeys.telemetryOutcomeRates(filters?.fileType),
    queryFn: async ({ signal }) => {
      if (!api) throw new Error("API unavailable");
      return await api.getTelemetryOutcomeRates(filters, signal);
    },
    enabled: Boolean(api),
    refetchInterval: 60_000,
  });

  return {
    rates: query.data?.rates ?? [],
    isLoading: query.isLoading,
    failure: telemetryFailure(query.error, query.data),
  };
}

export function useTelemetryAnomalies(api: ApiClient | null): {
  anomalies: TelemetryAnomaly[];
  isLoading: boolean;
  failure: TelemetryFailure | null;
} {
  const query = useQuery({
    queryKey: queryKeys.telemetryAnomalies(),
    queryFn: async ({ signal }) => {
      if (!api) throw new Error("API unavailable");
      return await api.getTelemetryAnomalies(undefined, signal);
    },
    enabled: Boolean(api),
    refetchInterval: 60_000,
  });

  return {
    anomalies: query.data?.anomalies ?? [],
    isLoading: query.isLoading,
    failure: telemetryFailure(query.error, query.data),
  };
}

export function useTelemetryComparison(
  api: ApiClient | null,
  periods: {
    period1Start: number;
    period1End: number;
    period2Start: number;
    period2End: number;
  } | null
): {
  comparison: TelemetryPeriodComparison[];
  isLoading: boolean;
  failure: TelemetryFailure | null;
} {
  const query = useQuery({
    queryKey: periods
      ? queryKeys.telemetryComparison(
          periods.period1Start,
          periods.period1End,
          periods.period2Start,
          periods.period2End
        )
      : ["telemetry-comparison-disabled"],
    queryFn: async ({ signal }) => {
      if (!api || !periods) throw new Error("API unavailable");
      return await api.getTelemetryComparison(periods, signal);
    },
    enabled: Boolean(api) && Boolean(periods),
  });

  return {
    comparison: query.data?.comparison ?? [],
    isLoading: query.isLoading,
    failure: telemetryFailure(query.error, query.data),
  };
}

export function useTelemetryTokenEstimates(
  api: ApiClient | null,
  filters?: { fileType?: string; startTime?: number }
): {
  estimates: TelemetryTokenEstimate[];
  isLoading: boolean;
  failure: TelemetryFailure | null;
} {
  const query = useQuery({
    queryKey: queryKeys.telemetryTokenEstimates(
      filters?.fileType,
      filters?.startTime
    ),
    queryFn: async ({ signal }) => {
      if (!api) throw new Error("API unavailable");
      return await api.getTelemetryTokenEstimates(filters, signal);
    },
    enabled: Boolean(api),
    refetchInterval: 60_000,
  });

  return {
    estimates: query.data?.estimates ?? [],
    isLoading: query.isLoading,
    failure: telemetryFailure(query.error, query.data),
  };
}

export function useTelemetrySessionAggregates(
  api: ApiClient | null,
  filters?: { startTime?: number }
): {
  sessions: TelemetrySessionAggregate[];
  isLoading: boolean;
  failure: TelemetryFailure | null;
} {
  const query = useQuery({
    queryKey: queryKeys.telemetrySessionAggregates(filters?.startTime),
    queryFn: async ({ signal }) => {
      if (!api) throw new Error("API unavailable");
      return await api.getTelemetrySessionAggregates(filters, signal);
    },
    enabled: Boolean(api),
    refetchInterval: 60_000,
  });

  return {
    sessions: query.data?.sessions ?? [],
    isLoading: query.isLoading,
    failure: telemetryFailure(query.error, query.data),
  };
}
