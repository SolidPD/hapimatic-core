// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { VoiceStatusResponse } from "@hapi/protocol/voice";
import { ApiError, type ApiClient } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";

/**
 * Voice input status (issue #4707). `null` means voice input is unavailable on
 * this node — the `builtin.voice-input` extension is disabled (404) — so the
 * mic button and the Settings section hide. Polls every second while an
 * install is running so the progress bar moves.
 */
export function useVoiceStatus(api: ApiClient | null): {
  status: VoiceStatusResponse | null;
  isLoading: boolean;
  refetch: () => Promise<unknown>;
} {
  const query = useQuery({
    queryKey: queryKeys.voiceStatus,
    queryFn: async (): Promise<VoiceStatusResponse | null> => {
      if (!api) return null;
      try {
        return await api.getVoiceStatus();
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    enabled: Boolean(api),
    staleTime: 30_000,
    retry: false,
    refetchInterval: q => (q.state.data?.state === "installing" ? 1000 : false),
  });
  return {
    status: query.data ?? null,
    isLoading: query.isLoading,
    refetch: query.refetch,
  };
}
