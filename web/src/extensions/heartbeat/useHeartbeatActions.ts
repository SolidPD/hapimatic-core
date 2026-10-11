// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import type { HeartbeatConfig } from "@/types/api";
import { queryKeys } from "@/lib/query-keys";

export function useHeartbeatMutations(api: ApiClient | null): {
  updateConfig: (updates: Partial<HeartbeatConfig>) => Promise<void>;
  updateInstructions: (content: string) => Promise<void>;
  deleteConfig: () => Promise<void>;
  isPending: boolean;
} {
  const queryClient = useQueryClient();

  const invalidateAll = async () => {
    await queryClient.invalidateQueries({
      queryKey: queryKeys.heartbeatConfig,
    });
    await queryClient.invalidateQueries({
      queryKey: queryKeys.heartbeatStatus,
    });
  };

  const configMutation = useMutation({
    mutationFn: async (updates: Partial<HeartbeatConfig>) => {
      if (!api) throw new Error("API unavailable");
      await api.updateHeartbeatConfig(updates);
    },
    onSuccess: () => void invalidateAll(),
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      if (!api) throw new Error("API unavailable");
      await api.deleteHeartbeatConfig();
    },
    onSuccess: () => void invalidateAll(),
  });

  const instructionsMutation = useMutation({
    mutationFn: async (content: string) => {
      if (!api) throw new Error("API unavailable");
      await api.updateHeartbeatInstructions(content);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.heartbeatInstructions,
      });
    },
  });

  return {
    updateConfig: configMutation.mutateAsync,
    updateInstructions: instructionsMutation.mutateAsync,
    deleteConfig: deleteMutation.mutateAsync,
    isPending:
      configMutation.isPending ||
      instructionsMutation.isPending ||
      deleteMutation.isPending,
  };
}
