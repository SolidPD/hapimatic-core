// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
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

export function useTelemetrySummary(
  api: ApiClient | null,
  filters?: { fileType?: string; startTime?: number; endTime?: number }
): {
  summary: TelemetrySummary | null;
  isLoading: boolean;
  error: string | null;
} {
  const query = useQuery({
    queryKey: queryKeys.telemetrySummary(filters?.fileType, filters?.startTime),
    queryFn: async () => {
      if (!api) throw new Error("API unavailable");
      return await api.getTelemetrySummary(filters);
    },
    enabled: Boolean(api),
    refetchInterval: 60_000,
  });

  return {
    summary: query.data ?? null,
    isLoading: query.isLoading,
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
  error: string | null;
} {
  const query = useQuery({
    queryKey: queryKeys.telemetryTimeseries(params.interval, params.filePath),
    queryFn: async () => {
      if (!api) throw new Error("API unavailable");
      return await api.getTelemetryTimeseries(params);
    },
    enabled: Boolean(api),
    refetchInterval: 60_000,
  });

  return {
    buckets: query.data?.buckets ?? [],
    isLoading: query.isLoading,
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
  error: string | null;
} {
  const query = useQuery({
    queryKey: queryKeys.telemetryFiles(filters?.fileType),
    queryFn: async () => {
      if (!api) throw new Error("API unavailable");
      return await api.getTelemetryFiles(filters);
    },
    enabled: Boolean(api),
    refetchInterval: 60_000,
  });

  return {
    files: query.data?.files ?? [],
    isLoading: query.isLoading,
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
} {
  const query = useQuery({
    queryKey: queryKeys.telemetryDurationStats(filters?.fileType),
    queryFn: async () => {
      if (!api) throw new Error("API unavailable");
      return await api.getTelemetryDurationStats(filters);
    },
    enabled: Boolean(api),
    refetchInterval: 60_000,
  });

  return { stats: query.data?.stats ?? [], isLoading: query.isLoading };
}

export function useTelemetryOutcomeRates(
  api: ApiClient | null,
  filters?: { fileType?: string }
): {
  rates: TelemetryOutcomeRate[];
  isLoading: boolean;
} {
  const query = useQuery({
    queryKey: queryKeys.telemetryOutcomeRates(filters?.fileType),
    queryFn: async () => {
      if (!api) throw new Error("API unavailable");
      return await api.getTelemetryOutcomeRates(filters);
    },
    enabled: Boolean(api),
    refetchInterval: 60_000,
  });

  return { rates: query.data?.rates ?? [], isLoading: query.isLoading };
}

export function useTelemetryAnomalies(api: ApiClient | null): {
  anomalies: TelemetryAnomaly[];
  isLoading: boolean;
} {
  const query = useQuery({
    queryKey: queryKeys.telemetryAnomalies(),
    queryFn: async () => {
      if (!api) throw new Error("API unavailable");
      return await api.getTelemetryAnomalies();
    },
    enabled: Boolean(api),
    refetchInterval: 60_000,
  });

  return {
    anomalies: query.data?.anomalies ?? [],
    isLoading: query.isLoading,
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
    queryFn: async () => {
      if (!api || !periods) throw new Error("API unavailable");
      return await api.getTelemetryComparison(periods);
    },
    enabled: Boolean(api) && Boolean(periods),
  });

  return {
    comparison: query.data?.comparison ?? [],
    isLoading: query.isLoading,
  };
}

export function useTelemetryTokenEstimates(
  api: ApiClient | null,
  filters?: { fileType?: string; startTime?: number }
): {
  estimates: TelemetryTokenEstimate[];
  isLoading: boolean;
} {
  const query = useQuery({
    queryKey: queryKeys.telemetryTokenEstimates(
      filters?.fileType,
      filters?.startTime
    ),
    queryFn: async () => {
      if (!api) throw new Error("API unavailable");
      return await api.getTelemetryTokenEstimates(filters);
    },
    enabled: Boolean(api),
    refetchInterval: 60_000,
  });

  return {
    estimates: query.data?.estimates ?? [],
    isLoading: query.isLoading,
  };
}

export function useTelemetrySessionAggregates(
  api: ApiClient | null,
  filters?: { startTime?: number }
): {
  sessions: TelemetrySessionAggregate[];
  isLoading: boolean;
} {
  const query = useQuery({
    queryKey: queryKeys.telemetrySessionAggregates(filters?.startTime),
    queryFn: async () => {
      if (!api) throw new Error("API unavailable");
      return await api.getTelemetrySessionAggregates(filters);
    },
    enabled: Boolean(api),
    refetchInterval: 60_000,
  });

  return {
    sessions: query.data?.sessions ?? [],
    isLoading: query.isLoading,
  };
}
