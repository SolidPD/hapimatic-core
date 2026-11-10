// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApiClient } from "@/api/client";
import type {
  PinsViewDirection,
  PinsViewFacet,
  PinsViewFilters,
  PinsViewGroup,
  PinsViewPreference,
  PinsViewSort,
} from "@hapi/protocol/schemas";
import { sparsePinsView } from "@/lib/pins/viewState";
import { useFederationSettings } from "./useFederationSettings";

/** This device's copy of the last defaults read, for the first paint. */
export const PINS_VIEW_DEFAULTS_CACHE_KEY = "hapi:pinsViewDefaults:v1";

/**
 * A change to the defaults: a facet set to "all" and a field set to null are
 * removed, so they fall back to the built-in view; `filters: null` removes
 * every facet.
 */
export type PinsViewDefaultsPatch = {
  filters?: Partial<Record<PinsViewFacet, string>> | null;
  sort?: PinsViewSort | null;
  dir?: PinsViewDirection | null;
  group?: PinsViewGroup | null;
};

function readCache(): PinsViewPreference {
  try {
    const raw = localStorage.getItem(PINS_VIEW_DEFAULTS_CACHE_KEY);
    return raw ? sparsePinsView(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

function writeCache(value: PinsViewPreference): void {
  try {
    localStorage.setItem(PINS_VIEW_DEFAULTS_CACHE_KEY, JSON.stringify(value));
  } catch {
    // Full or disabled storage: the next load reads the server instead.
  }
}

function applyPatch(
  current: PinsViewPreference,
  patch: PinsViewDefaultsPatch
): PinsViewPreference {
  const next: Record<string, unknown> = { ...current };
  if (patch.filters === null) {
    delete next.filters;
  } else if (patch.filters) {
    const filters: Record<string, string> = { ...current.filters };
    for (const [facet, value] of Object.entries(patch.filters)) {
      if (value === undefined || value === "all") delete filters[facet];
      else filters[facet] = value;
    }
    next.filters = filters as Partial<PinsViewFilters>;
  }
  for (const field of ["sort", "dir", "group"] as const) {
    if (!(field in patch)) continue;
    if (patch[field] === null) delete next[field];
    else next[field] = patch[field];
  }
  return sparsePinsView(next);
}

/**
 * #6451 (R6): the Pins tab's defaults, a federation setting (`pinsView`) so
 * they follow the operator to every node; modelled on `useAccountsUsageView`.
 *
 * - No flash on first paint: until the first GET returns, the defaults are this
 *   device's copy of the last ones read, which the server value then replaces
 *   and rewrites (`web/CLAUDE.md`, "Frontend/Backend Preference Sync").
 * - `setDefaults` merges into the current record (`currentRef`, which the
 *   optimistic write updates, so two edits in one tick keep both) because
 *   last-write-wins merges per KEY, not per field.
 * - `ready` is false until a GET has returned the stored record. Until then
 *   `setDefaults` does nothing: a merge against the fallback would erase the
 *   other fields on every node.
 * - The returned `defaults` keeps its identity while its content is unchanged,
 *   so a focus refetch does not rebuild a Pins list that reads it.
 */
export function usePinsViewDefaults(api: ApiClient | null): {
  defaults: PinsViewPreference;
  ready: boolean;
  setDefaults: (patch: PinsViewDefaultsPatch) => void;
} {
  const { view, setValue } = useFederationSettings(api, {
    refetchOnFocus: true,
  });
  const [cached] = useState(readCache);
  const server = useMemo(
    () => (view ? sparsePinsView(view.values.pinsView) : null),
    [view]
  );
  const ready = view != null;

  const resolved = server ?? cached;
  const stableRef = useRef(resolved);
  if (JSON.stringify(stableRef.current) !== JSON.stringify(resolved)) {
    stableRef.current = resolved;
  }
  const defaults = stableRef.current;

  const currentRef = useRef(defaults);
  currentRef.current = defaults;
  const readyRef = useRef(ready);
  readyRef.current = ready;

  // Reconcile the first-paint copy with what the server says.
  useEffect(() => {
    if (server) writeCache(server);
  }, [server]);

  const setDefaults = useCallback(
    (patch: PinsViewDefaultsPatch) => {
      if (!readyRef.current) return;
      const merged = applyPatch(currentRef.current, patch);
      currentRef.current = merged;
      setValue("pinsView", merged);
    },
    [setValue]
  );

  return { defaults, ready, setDefaults };
}
