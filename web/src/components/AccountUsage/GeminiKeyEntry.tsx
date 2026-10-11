// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import { ApiKeyRegistrationCard } from "@/components/ApiKeyRegistrationCard";
import { useApiKeys } from "@/hooks/queries/useApiKeys";
import { queryKeys } from "@/lib/query-keys";

/**
 * GeminiKeyEntry — the Gemini (Google) provider section's in-app "Add account"
 * surface (issue #3807, epic #3345, Task 1).
 *
 * Reuses the existing secure entry card (`ApiKeyRegistrationCard`) with a fixed
 * `gemini` descriptor: the raw key is typed into the card's `type="password"`
 * input and posted ONCE to this node's local vault (`POST /api/api-keys`) — it
 * never passes through the model, the transcript, the UI, or a server log
 * (R1). The card shows only the server's `maskedKey` after entry; this wrapper
 * never renders a key value in the provider row.
 *
 * LOCAL-node only (R4): the vault write is `POST /api/api-keys` (there is no
 * federation key-persistence receiver until #1996), so this entry always
 * targets THIS node's vault. A peer node's Gemini row shows the #3806 host-side
 * instruction instead (rendered by the caller).
 *
 * Display-only until #3362 (R1): the #3806 reader reports `keySource:"vault"`
 * once a key is stored, but spawn-time vault→env injection is #3362's — so a
 * stored key is not yet consumed by new sessions. The wrapper says so once a
 * key is bound.
 *
 * Refresh (R5): `ApiKeyRegistrationCard`'s mutation invalidates
 * `queryKeys.apiKeys` only, so the #3806 provider section (fed by
 * `queryKeys.providerAuthState`) would not flip to `bound` after an add. This
 * wrapper watches the live vault via `useApiKeys` and invalidates
 * `providerAuthState` on the unbound→bound transition (skipping the first
 * render, so mounting an already-bound section never triggers a spurious
 * refetch).
 */
export function GeminiKeyEntry({ api }: { api: ApiClient | null }) {
  const queryClient = useQueryClient();
  const { data: keys = [] } = useApiKeys(api);
  // The reader prefers a `gemini` vault entry, falling back to `google` — mirror
  // both here so the bound signal matches what the #3806 section reports.
  const bound = keys.some(
    k => k.provider === "gemini" || k.provider === "google"
  );

  const prevBound = useRef(bound);
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      prevBound.current = bound;
      return;
    }
    if (bound !== prevBound.current) {
      prevBound.current = bound;
      // Only the unbound→bound edge (a fresh add) needs to refresh the section.
      if (bound) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.providerAuthState,
        });
      }
    }
  }, [bound, queryClient]);

  return (
    <div className="flex flex-col gap-2" data-testid="gemini-key-entry">
      <ApiKeyRegistrationCard
        api={api}
        descriptor={{ provider: "gemini", label: "Gemini" }}
      />
      {bound && (
        <p
          className="text-[length:var(--text-caption)] text-[var(--app-hint)]"
          data-testid="gemini-key-entry-pending-note"
        >
          Stored — used by new sessions once vault injection (#3362) is enabled.
        </p>
      )}
    </div>
  );
}
