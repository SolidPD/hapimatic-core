// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery, type FetchStatus } from "@tanstack/react-query";
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
 * Issue #6675 (closer review): `query.isLoading` is `isPending && isFetching`,
 * so a first fetch that TanStack's onlineManager paused (the device is offline)
 * read as "not loading" with no data and no error, and the views showed 0m and
 * "No time logged". A query that has never answered counts as loading while it
 * is fetching or paused; a disabled query (fetchStatus "idle") does not.
 */
function isAwaitingFirstAnswer(query: {
  isPending: boolean;
  fetchStatus: FetchStatus;
}): boolean {
  return query.isPending && query.fetchStatus !== "idle";
}

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
    isLoading: isAwaitingFirstAnswer(query),
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
    isLoading: isAwaitingFirstAnswer(query),
    error:
      query.error instanceof Error
        ? query.error.message
        : query.error
          ? "Failed to load project summary"
          : null,
  };
}

/**
 * Issue #1670 (Sub H1, PR-2): turns-derived daily buckets for a date range.
 *
 * The Time Log's read path: every view's totals come from this (issue #6675
 * retired the cutover gate that used to switch between this and the legacy
 * summaries). Bucketed server-side by per-namespace IANA-TZ local day.
 * `refetch` backs the views' Retry buttons.
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
  refetch: () => Promise<unknown>;
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
    isLoading: isAwaitingFirstAnswer(query),
    error:
      query.error instanceof Error
        ? query.error.message
        : query.error
          ? "Failed to load derived time log"
          : null,
    refetch: query.refetch,
  };
}
