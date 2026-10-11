// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import type {
  TimeLogEntry,
  TimeLogDailySummary,
  TimeLogProjectGroupedSummary,
  TimeLogWeeklySummary,
  TimeLogFilters,
  DerivedDailyBucket,
} from "@/types/api";
import { queryKeys } from "@/lib/query-keys";

/**
 * Hook for fetching time log entries with optional filters
 */
export function useTimeLogs(
  api: ApiClient | null,
  filters?: TimeLogFilters,
  enabled = true
): {
  entries: TimeLogEntry[];
  total: number;
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<unknown>;
} {
  const query = useQuery({
    queryKey: queryKeys.timeLogs({
      date: filters?.startDate,
      projectDirectory: filters?.projectDirectory,
    }),
    queryFn: async () => {
      if (!api) {
        throw new Error("API unavailable");
      }
      return await api.getTimeLogs(filters);
    },
    enabled: Boolean(api) && enabled,
  });

  return {
    entries: query.data?.entries ?? [],
    total: query.data?.total ?? 0,
    isLoading: query.isLoading,
    error:
      query.error instanceof Error
        ? query.error.message
        : query.error
          ? "Failed to load time logs"
          : null,
    refetch: query.refetch,
  };
}

/**
 * Hook for fetching daily summary
 */
export function useTimeLogDailySummary(
  api: ApiClient | null,
  date?: string,
  enabled = true
): {
  summary: TimeLogDailySummary | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<unknown>;
} {
  const query = useQuery({
    queryKey: queryKeys.timeLogDailySummary(date),
    queryFn: async () => {
      if (!api) {
        throw new Error("API unavailable");
      }
      return await api.getTimeLogDailySummary(date);
    },
    enabled: Boolean(api) && enabled,
  });

  return {
    summary: query.data ?? null,
    isLoading: query.isLoading,
    error:
      query.error instanceof Error
        ? query.error.message
        : query.error
          ? "Failed to load summary"
          : null,
    refetch: query.refetch,
  };
}

/**
 * Hook for fetching distinct project directories
 */
export function useTimeLogProjects(
  api: ApiClient | null,
  enabled = true
): {
  projects: string[];
  isLoading: boolean;
  error: string | null;
} {
  const query = useQuery({
    queryKey: queryKeys.timeLogProjects,
    queryFn: async () => {
      if (!api) {
        throw new Error("API unavailable");
      }
      return await api.getTimeLogProjects();
    },
    enabled: Boolean(api) && enabled,
  });

  return {
    projects: query.data?.projects ?? [],
    isLoading: query.isLoading,
    error:
      query.error instanceof Error
        ? query.error.message
        : query.error
          ? "Failed to load projects"
          : null,
  };
}

/**
 * Hook for fetching weekly summary
 */
export function useTimeLogWeeklySummary(
  api: ApiClient | null,
  startDate: string,
  enabled = true
): {
  summary: TimeLogWeeklySummary | null;
  isLoading: boolean;
  error: string | null;
} {
  const query = useQuery({
    queryKey: ["time-log-weekly-summary", startDate],
    queryFn: async () => {
      if (!api) {
        throw new Error("API unavailable");
      }
      return await api.getTimeLogWeeklySummary(startDate);
    },
    enabled: Boolean(api) && Boolean(startDate) && enabled,
  });

  return {
    summary: query.data ?? null,
    isLoading: query.isLoading,
    error:
      query.error instanceof Error
        ? query.error.message
        : query.error
          ? "Failed to load weekly summary"
          : null,
  };
}

/**
 * Hook for fetching project-grouped summary for a date range
 */
export function useTimeLogProjectGrouped(
  api: ApiClient | null,
  startDate: string,
  endDate: string,
  enabled = true
): {
  summary: TimeLogProjectGroupedSummary | null;
  isLoading: boolean;
  error: string | null;
} {
  const query = useQuery({
    queryKey: queryKeys.timeLogProjectGrouped(startDate, endDate),
    queryFn: async () => {
      if (!api) {
        throw new Error("API unavailable");
      }
      return await api.getTimeLogProjectGrouped(startDate, endDate);
    },
    enabled: Boolean(api) && Boolean(startDate) && Boolean(endDate) && enabled,
  });

  return {
    summary: query.data ?? null,
    isLoading: query.isLoading,
    error:
      query.error instanceof Error
        ? query.error.message
        : query.error
          ? "Failed to load project summary"
          : null,
  };
}

/**
 * Issue #1670 (Sub H1, PR-2): the cutover-status dormancy gate.
 *
 * Single source of truth for the read-switch, the CSV source, and which
 * clock-control set renders. Polls every 60s — the gate flips when Sub-G's
 * parity green streak is reached OR when the operator cutover override is set
 * (#2247: server-side `timelogCutover.force`; `forced` is passed through for
 * consumers that want to label the forced state). Defaults to `false` (legacy
 * path) while loading or on error, so the dormant state is fail-safe.
 */
export function useTimelogCutoverStatus(api: ApiClient | null): {
  ready: boolean;
  forced: boolean;
  isLoading: boolean;
} {
  const query = useQuery({
    queryKey: queryKeys.timeLogCutoverStatus,
    queryFn: async () => {
      if (!api) {
        throw new Error("API unavailable");
      }
      return await api.getTimelogCutoverStatus();
    },
    enabled: Boolean(api),
    refetchInterval: 60_000,
    staleTime: 60_000,
  });

  return {
    ready: query.data?.ready ?? false,
    forced: query.data?.forced ?? false,
    isLoading: query.isLoading,
  };
}

/**
 * Issue #1670 (Sub H1, PR-2): TS-derived daily buckets for a date range.
 *
 * The gated read path — the modal sources its headline totals from this when
 * the cutover gate is green (else the legacy summaries). Bucketed server-side by
 * per-namespace IANA-TZ local day.
 */
export function useDerivedTimeLog(
  api: ApiClient | null,
  startDate: string,
  endDate: string,
  enabled = true
): {
  buckets: DerivedDailyBucket[];
  isLoading: boolean;
  error: string | null;
} {
  const query = useQuery({
    queryKey: queryKeys.timeLogDerived(startDate, endDate),
    queryFn: async () => {
      if (!api) {
        throw new Error("API unavailable");
      }
      return await api.getDerivedTimeLog(startDate, endDate);
    },
    enabled: Boolean(api) && Boolean(startDate) && Boolean(endDate) && enabled,
  });

  return {
    buckets: query.data?.buckets ?? [],
    isLoading: query.isLoading,
    error:
      query.error instanceof Error
        ? query.error.message
        : query.error
          ? "Failed to load derived time log"
          : null,
  };
}
