// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApiClient } from "@/api/client";
import type {
  PinsViewDirection,
  PinsViewFacet,
  PinsViewGroup,
  PinsViewPreference,
  PinsViewPreferenceMerge,
  PinsViewSort,
} from "@hapi/protocol/schemas";
import { useToast } from "@/components/Toast";
import { sparsePinsView } from "@/lib/pins/viewState";
import { useFederationSettings } from "./useFederationSettings";

/** This device's copy of the last defaults the server confirmed, for the
 *  first paint. */
export const PINS_VIEW_DEFAULTS_CACHE_KEY = "hapi:pinsViewDefaults:v1";

/** The toast after a save of a Pins default fails (#6526). Hedged, because a
 *  PUT can be stored and still lose its response. */
export const PINS_DEFAULTS_SAVE_FAILED =
  "Couldn't save your Pins defaults — they may not have persisted";

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

/**
 * #6526: the change as an RFC 7396 merge patch of only what the operator
 * picked; a removal is `null`. It maps the intent directly and never diffs
 * against the stored record: a diff cannot see a value this build cannot
 * read, so it could never clear one (KD2: clear means clear).
 */
function toMergePatch(patch: PinsViewDefaultsPatch): PinsViewPreferenceMerge {
  const merge: Record<string, unknown> = {};
  if (patch.filters === null) {
    merge.filters = null;
  } else if (patch.filters) {
    const filters: Record<string, string | null> = {};
    for (const [facet, value] of Object.entries(patch.filters)) {
      filters[facet] = value === undefined || value === "all" ? null : value;
    }
    merge.filters = filters;
  }
  for (const field of ["sort", "dir", "group"] as const) {
    if (field in patch) merge[field] = patch[field] ?? null;
  }
  return merge as PinsViewPreferenceMerge;
}

/**
 * #6451 (R6): the Pins tab's defaults, a federation setting (`pinsView`) so
 * they follow the operator to every node; modelled on `useAccountsUsageView`.
 *
 * - No flash on first paint: until the first GET returns, the defaults are this
 *   device's copy of the last ones the server confirmed. The copy is written
 *   only from a view the server returned (a GET, a refetch or a PUT response),
 *   never from an unsaved pick (#6526, `web/CLAUDE.md` "Frontend/Backend
 *   Preference Sync").
 * - `setDefaults` sends only the fields the operator changed, as a merge patch
 *   the server applies to the stored record (#6526), so a field this build
 *   cannot read survives the edit. Edits are queued one at a time, and the
 *   defaults shown include every queued edit.
 * - A failed save shows the last confirmed defaults again and the error toast
 *   {@link PINS_DEFAULTS_SAVE_FAILED}.
 * - `ready` is false until a GET has returned the stored record; until then
 *   `setDefaults` does nothing and the menus stay disabled.
 * - The returned `defaults` keeps its identity while its content is unchanged,
 *   so a focus refetch does not rebuild a Pins list that reads it.
 */
export function usePinsViewDefaults(api: ApiClient | null): {
  defaults: PinsViewPreference;
  ready: boolean;
  setDefaults: (patch: PinsViewDefaultsPatch) => void;
} {
  const { view, confirmedView, mergeValue } = useFederationSettings(api, {
    refetchOnFocus: true,
  });
  const { showToast } = useToast();
  const [cached] = useState(readCache);
  const shown = useMemo(
    () => (view ? sparsePinsView(view.values.pinsView) : null),
    [view]
  );
  const confirmed = useMemo(
    () =>
      confirmedView ? sparsePinsView(confirmedView.values.pinsView) : null,
    [confirmedView]
  );
  const ready = confirmedView != null;

  const resolved = shown ?? cached;
  const stableRef = useRef(resolved);
  if (JSON.stringify(stableRef.current) !== JSON.stringify(resolved)) {
    stableRef.current = resolved;
  }
  const defaults = stableRef.current;

  const readyRef = useRef(ready);
  readyRef.current = ready;

  // Reconcile the first-paint copy with what the server says (a GET or a
  // focus refetch); a save writes its own response in `setDefaults`.
  useEffect(() => {
    if (confirmed) writeCache(confirmed);
  }, [confirmed]);

  const setDefaults = useCallback(
    (patch: PinsViewDefaultsPatch) => {
      if (!readyRef.current) return;
      // The promise settles even after the page is left, so a pick is cached
      // when the operator navigates away before the response.
      void mergeValue("pinsView", toMergePatch(patch)).then(saved => {
        if (saved) writeCache(sparsePinsView(saved.values.pinsView));
        else showToast(PINS_DEFAULTS_SAVE_FAILED, { type: "error" });
      });
    },
    [mergeValue, showToast]
  );

  return { defaults, ready, setDefaults };
}
