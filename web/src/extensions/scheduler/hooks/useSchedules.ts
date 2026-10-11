// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import type { ScheduledTask, TaskExecution } from "@/types/api";
import { queryKeys } from "@/lib/query-keys";

export function useSchedules(api: ApiClient | null): {
  schedules: ScheduledTask[];
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<unknown>;
} {
  const query = useQuery({
    queryKey: queryKeys.schedules,
    queryFn: async () => {
      if (!api) throw new Error("API unavailable");
      return await api.getSchedules();
    },
    enabled: Boolean(api),
  });

  return {
    schedules: query.data?.schedules ?? [],
    isLoading: query.isLoading,
    error:
      query.error instanceof Error
        ? query.error.message
        : query.error
          ? "Failed to load schedules"
          : null,
    refetch: query.refetch,
  };
}

export function useSchedule(
  api: ApiClient | null,
  id: string | null
): {
  schedule: ScheduledTask | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<unknown>;
} {
  const query = useQuery({
    queryKey: queryKeys.schedule(id ?? ""),
    queryFn: async () => {
      if (!api || !id) throw new Error("API unavailable");
      return await api.getSchedule(id);
    },
    enabled: Boolean(api) && Boolean(id),
  });

  return {
    schedule: query.data?.schedule ?? null,
    isLoading: query.isLoading,
    error:
      query.error instanceof Error
        ? query.error.message
        : query.error
          ? "Failed to load schedule"
          : null,
    refetch: query.refetch,
  };
}

export function useScheduleHistory(
  api: ApiClient | null,
  id: string | null
): {
  history: TaskExecution[];
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<unknown>;
} {
  const query = useQuery({
    queryKey: queryKeys.scheduleHistory(id ?? ""),
    queryFn: async () => {
      if (!api || !id) throw new Error("API unavailable");
      return await api.getScheduleHistory(id, 50);
    },
    enabled: Boolean(api) && Boolean(id),
  });

  return {
    history: query.data?.history ?? [],
    isLoading: query.isLoading,
    error:
      query.error instanceof Error
        ? query.error.message
        : query.error
          ? "Failed to load history"
          : null,
    refetch: query.refetch,
  };
}
