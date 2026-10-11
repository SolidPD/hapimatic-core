// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AccountUsage } from "@hapi/protocol";
import type { ApiClient } from "@/api/client";
import type { AccountUsageResponse } from "@/types/api";
import { queryKeys } from "@/lib/query-keys";

/**
 * Set/clear an account's nickname (epic #1855 follow-up).
 *
 * PATCHes /api/accounts/:uuid/nickname, with an optimistic patch of the
 * accountUsage query so the new label shows instantly. The server clears its
 * usage TTL cache on write, so the onSettled refetch returns the fresh nickname
 * (no revert flicker). Rolls back on error.
 */
export function useSetAccountNickname(api: ApiClient | null): {
  setNickname: (uuid: string, nickname: string) => Promise<void>;
  isPending: boolean;
} {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: async (vars: { uuid: string; nickname: string }) => {
      if (!api) throw new Error("API unavailable");
      await api.setAccountNickname(vars.uuid, vars.nickname);
    },
    onMutate: async (vars: { uuid: string; nickname: string }) => {
      await qc.cancelQueries({ queryKey: queryKeys.accountUsage });
      const prev = qc.getQueryData<AccountUsageResponse>(
        queryKeys.accountUsage
      );
      const next = vars.nickname.trim() || undefined;
      qc.setQueryData<AccountUsageResponse>(queryKeys.accountUsage, old =>
        old
          ? {
              ...old,
              usage: old.usage.map((a: AccountUsage) =>
                a.accountUuid === vars.uuid ? { ...a, nickname: next } : a
              ),
            }
          : old
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(queryKeys.accountUsage, ctx.prev);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.accountUsage });
      // #3621: also invalidate the accounts (labels) query — the chip-label key
      // [...queryKeys.accounts, "labels"] (useAccountLabels) shares the
      // queryKeys.accounts prefix and was previously left stale for up to 60s
      // after a nickname edit, so chips did not refresh live. In scope because the
      // monogram editor reuses this save path.
      void qc.invalidateQueries({ queryKey: queryKeys.accounts });
    },
  });
  return {
    setNickname: (uuid, nickname) => mutation.mutateAsync({ uuid, nickname }),
    isPending: mutation.isPending,
  };
}
