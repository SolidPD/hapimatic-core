// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import type {
  ErrorLogEntry,
  ErrorLogFiltersParam,
  ErrorLogStatsResponse,
} from "@/types/api";
import { queryKeys } from "@/lib/query-keys";

export function useErrorLogs(
  api: ApiClient | null,
  filters?: ErrorLogFiltersParam
): {
  entries: ErrorLogEntry[];
  count: number;
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<unknown>;
} {
  const query = useQuery({
    queryKey: queryKeys.errorLogs({
      severity: filters?.severity,
      source: filters?.source,
      startTime: filters?.startTime,
    }),
    queryFn: async () => {
      if (!api) throw new Error("API unavailable");
      return await api.getErrorLogs(filters);
    },
    enabled: Boolean(api),
    refetchInterval: 30_000,
  });

  return {
    entries: query.data?.entries ?? [],
    count: query.data?.count ?? 0,
    isLoading: query.isLoading,
    error:
      query.error instanceof Error
        ? query.error.message
        : query.error
          ? "Failed to load error logs"
          : null,
    refetch: query.refetch,
  };
}

export function useErrorLogStats(api: ApiClient | null): {
  bySeverity: Record<string, number>;
  isLoading: boolean;
  refetch: () => Promise<unknown>;
} {
  const query = useQuery({
    queryKey: queryKeys.errorLogStats,
    queryFn: async () => {
      if (!api) throw new Error("API unavailable");
      return await api.getErrorLogStats();
    },
    enabled: Boolean(api),
    refetchInterval: 60_000,
  });

  return {
    bySeverity:
      (query.data as ErrorLogStatsResponse | undefined)?.bySeverity ?? {},
    isLoading: query.isLoading,
    refetch: query.refetch,
  };
}
