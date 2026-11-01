// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useMemo, useRef } from "react";
import type { ApiClient } from "@/api/client";
import type { ProviderId } from "@hapi/protocol";
import {
  AccountsUsageViewPreferenceSchema,
  type AccountsUsageViewPreference,
  type UsageViewId,
} from "@hapi/protocol/schemas";
import { useFederationSettings } from "./useFederationSettings";

/** The view a provider section shows when it has no saved choice. */
export const DEFAULT_USAGE_VIEW: UsageViewId = "bars";

/**
 * The Accounts page's per-provider usage view (#4467, epic #4460 G), stored in
 * the federation setting `accountsUsageView` so the choice follows the user to
 * every node.
 *
 * - An absent, invalid or unknown value reads as Bars.
 * - `setView` merges `{ ...current, [provider]: view }` before the PUT, because
 *   last-write-wins merges per KEY, not per provider. The merge reads
 *   `currentRef`, which the optimistic write updates, so two switches in one
 *   tick keep both entries.
 * - `ready` is false until a GET has returned the stored record. Until then
 *   `setView` does nothing, because a merge against the empty fallback would
 *   PUT a record holding only this provider and erase the others' choices on
 *   every node. A failed first GET heals on the next focus refetch.
 * - The switch is optimistic: the PUT awaits the peer fan-out (peers are posted
 *   in parallel, so up to ~5 s when one is unreachable), so it is never awaited.
 * - The view is re-read on window focus and visibility (ruling G-3 A).
 * - A `null` client reads Bars, is never ready and makes no request (the
 *   Session Configuration modal, #4600, will pass one for a non-Claude or
 *   API-key session).
 */
export function useAccountsUsageView(api: ApiClient | null): {
  viewFor: (provider: ProviderId) => UsageViewId;
  setView: (provider: ProviderId, view: UsageViewId) => void;
  /** True once the stored record has been read; the switcher waits for it. */
  ready: boolean;
} {
  const { view, setValue } = useFederationSettings(api, {
    refetchOnFocus: true,
  });
  const current = useMemo<AccountsUsageViewPreference>(() => {
    const parsed = AccountsUsageViewPreferenceSchema.safeParse(
      view?.values.accountsUsageView
    );
    return parsed.success ? parsed.data : {};
  }, [view]);
  const currentRef = useRef(current);
  currentRef.current = current;
  const ready = view != null;
  const readyRef = useRef(ready);
  readyRef.current = ready;

  const viewFor = useCallback(
    (provider: ProviderId): UsageViewId =>
      current[provider] ?? DEFAULT_USAGE_VIEW,
    [current]
  );

  const setView = useCallback(
    (provider: ProviderId, next: UsageViewId) => {
      if (!readyRef.current) return;
      const merged = { ...currentRef.current, [provider]: next };
      currentRef.current = merged;
      setValue("accountsUsageView", merged);
    },
    [setValue]
  );

  return { viewFor, setView, ready };
}
