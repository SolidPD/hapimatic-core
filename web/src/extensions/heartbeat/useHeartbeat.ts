// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import type {
  HeartbeatConfig,
  HeartbeatHistoryEntry,
  HeartbeatStatus,
} from "@/types/api";
import { queryKeys } from "@/lib/query-keys";

export function useHeartbeatConfig(
  api: ApiClient | null,
  enabled = true
): {
  config: HeartbeatConfig | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<unknown>;
} {
  const query = useQuery({
    queryKey: queryKeys.heartbeatConfig,
    queryFn: async () => {
      if (!api) throw new Error("API unavailable");
      return await api.getHeartbeatConfig();
    },
    enabled: Boolean(api) && enabled,
  });

  return {
    config: query.data?.config ?? null,
    isLoading: query.isLoading,
    error:
      query.error instanceof Error
        ? query.error.message
        : query.error
          ? "Failed to load heartbeat config"
          : null,
    refetch: query.refetch,
  };
}

export function useHeartbeatStatus(
  api: ApiClient | null,
  enabled = true
): {
  status: HeartbeatStatus | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<unknown>;
} {
  const query = useQuery({
    queryKey: queryKeys.heartbeatStatus,
    queryFn: async () => {
      if (!api) throw new Error("API unavailable");
      return await api.getHeartbeatStatus();
    },
    enabled: Boolean(api) && enabled,
    refetchInterval: 30_000, // Refresh status every 30s
  });

  return {
    status: query.data ?? null,
    isLoading: query.isLoading,
    error:
      query.error instanceof Error
        ? query.error.message
        : query.error
          ? "Failed to load heartbeat status"
          : null,
    refetch: query.refetch,
  };
}

export function useHeartbeatHistory(
  api: ApiClient | null,
  enabled = true
): {
  history: HeartbeatHistoryEntry[];
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<unknown>;
} {
  const query = useQuery({
    queryKey: queryKeys.heartbeatHistory,
    queryFn: async () => {
      if (!api) throw new Error("API unavailable");
      return await api.getHeartbeatHistory();
    },
    enabled: Boolean(api) && enabled,
  });

  return {
    history: query.data?.history ?? [],
    isLoading: query.isLoading,
    error:
      query.error instanceof Error
        ? query.error.message
        : query.error
          ? "Failed to load heartbeat history"
          : null,
    refetch: query.refetch,
  };
}

export function useHeartbeatInstructions(
  api: ApiClient | null,
  enabled = true
): {
  content: string;
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<unknown>;
} {
  const query = useQuery({
    queryKey: queryKeys.heartbeatInstructions,
    queryFn: async () => {
      if (!api) throw new Error("API unavailable");
      return await api.getHeartbeatInstructions();
    },
    enabled: Boolean(api) && enabled,
  });

  return {
    content: query.data?.content ?? "",
    isLoading: query.isLoading,
    error:
      query.error instanceof Error
        ? query.error.message
        : query.error
          ? "Failed to load heartbeat instructions"
          : null,
    refetch: query.refetch,
  };
}
