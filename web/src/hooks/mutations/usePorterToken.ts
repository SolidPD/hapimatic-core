// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import type { PorterTokenResponse, PorterTokenStatus } from "@/types/porter";
import { queryKeys } from "@/lib/query-keys";

/**
 * The tokenized one-liner export (issue #3446, epic #3445 Sub A):
 *
 *   - `mint`   — `POST /api/porter/token` → a {@link PorterTokenResponse} with the
 *     copyable `fetchUrl`/`uploadUrl`. "New link" re-mints (a second `mint.mutate`).
 *   - `status` — polls `GET /api/porter/token/:token/status` for the last-minted
 *     token. The plan summary flows to the browser HERE (not over the curl
 *     channel), so a `received` status carries `plan`. Polling is the FALLBACK;
 *     the primary wake-up is the `porter-token-received` SSE event, which the card
 *     turns into an immediate `status.refetch()`. Polling STOPS once the token
 *     resolves to `received`/`expired` so an idle card is not perpetually chatty.
 */
export function usePorterToken(api: ApiClient | null) {
  const mint = useMutation<PorterTokenResponse, Error, void>({
    mutationFn: async () => {
      if (!api) throw new Error("No API client");
      return await api.mintPorterToken();
    },
  });

  const token = mint.data?.token;

  const status = useQuery<PorterTokenStatus>({
    queryKey: queryKeys.porterTokenStatus(token ?? "none"),
    queryFn: async () => {
      if (!api || !token) throw new Error("No token");
      return await api.getPorterTokenStatus(token);
    },
    enabled: Boolean(api && token),
    refetchInterval: query => {
      const s = query.state.data?.state;
      return s === "received" || s === "expired" ? false : 4000;
    },
    staleTime: 0,
    retry: false,
  });

  return { mint, status, token };
}
