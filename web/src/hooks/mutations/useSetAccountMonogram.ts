// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AccountMonogram } from "@hapi/protocol";
import type { ApiClient } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";

/**
 * Set/clear an account's monogram override — the chip's letter + color (issue #3621).
 *
 * PATCHes /api/accounts/:uuid/monogram, then on settle invalidates
 * `queryKeys.accounts` — the PREFIX of the chip-label query
 * `[...queryKeys.accounts, "labels"]` (`useAccountLabels`) — so every AccountChip
 * surface re-reads the new override without a reload (R6, D11 Option A).
 *
 * Unlike `useSetAccountNickname`, there is deliberately NO optimistic patch of
 * `queryKeys.accountUsage`: the `AccountUsage` rows carry no monogram field, so
 * that patch would be dead code. The override rides the labels query only (D11
 * Option A) — the server clears its usage TTL cache on write, and the accounts
 * query refetch returns the fresh override.
 */
export function useSetAccountMonogram(api: ApiClient | null): {
  setMonogram: (uuid: string, monogram: AccountMonogram) => Promise<void>;
  isPending: boolean;
} {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: async (vars: { uuid: string; monogram: AccountMonogram }) => {
      if (!api) throw new Error("API unavailable");
      await api.setAccountMonogram(vars.uuid, vars.monogram);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.accounts });
    },
  });
  return {
    setMonogram: (uuid, monogram) => mutation.mutateAsync({ uuid, monogram }),
    isPending: mutation.isPending,
  };
}
