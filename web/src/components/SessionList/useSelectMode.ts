// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "@tanstack/react-router";

/**
 * Select Mode — ephemeral multi-select over the Session List (#3292, epic #3285 S7).
 *
 * A "small store" (self-contained hook) shared by three surfaces that all live under
 * `SessionsPage`: the Control Bar's Select button (`renderPaneToolbar`), the Session
 * cards (`SessionListContainer` → `SessionItem`), and the Select-Mode Chip Row. The
 * Select button and the cards are siblings (toolbar vs `<SessionList>`), so the state
 * cannot live in `SessionListContainer` — it lives in the `SessionsPage` instance that
 * calls this hook and is threaded down as props.
 *
 * NEVER persisted (taxonomy: "ephemeral"). Exits on:
 *  - Select button tap  → `toggleSelectMode()` (or `exitSelectMode()`)
 *  - web/app refresh    → a reload discards all React state (nothing to wire)
 *  - App Wordmark tap   → the wordmark is a TanStack `<Link to="/">` (redirects to
 *    /sessions). When already on /sessions that resolves to the SAME mounted route, so
 *    plain local state would NOT reset. We subscribe to the router's `onResolved` event
 *    (mirrors `main.tsx:145`) and clear on any navigation while active. #3292 forbids
 *    editing `BrandedFrame.tsx` (the wordmark's `<Link>`; #3033 collision), so this
 *    subscription is the only compliant exit path. Search/filter/sort prefs are
 *    server-synced (`useSearchFilterPreferences`, NOT URL params), so typing never
 *    triggers a navigation — a keystroke can never spuriously exit Select Mode.
 */
export type SelectModeState = {
  selectMode: boolean;
  selectedIds: ReadonlySet<string>;
  /** Toggle Select Mode on/off; turning it off clears the selection. */
  toggleSelectMode: () => void;
  /** Force-exit Select Mode and clear the selection (idempotent). */
  exitSelectMode: () => void;
  /** Toggle one card's membership in the selection. */
  toggleSelect: (id: string) => void;
  /** Replace the selection with exactly `ids` (the "All" chip). */
  selectAll: (ids: string[]) => void;
  /** Clear the selection but stay in Select Mode (the "None" chip). */
  selectNone: () => void;
};

export function useSelectMode(): SelectModeState {
  const router = useRouter();
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set<string>()
  );

  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelectedIds(new Set());
  }, []);

  const toggleSelectMode = useCallback(() => {
    setSelectMode(prev => {
      if (prev) setSelectedIds(new Set());
      return !prev;
    });
  }, []);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback((ids: string[]) => {
    setSelectedIds(new Set(ids));
  }, []);

  const selectNone = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  // Wordmark-exit: while Select Mode is active, ANY resolved navigation clears it.
  // The wordmark's same-route `/` → `/sessions` navigation is the case plain local
  // state misses; navigating AWAY unmounts SessionsPage (state gone anyway). We only
  // subscribe while active, so a resolved navigation → exit → unsubscribe (via the
  // effect's cleanup on the `selectMode` dependency change).
  useEffect(() => {
    // `router.subscribe` always exists on the real TanStack router; the shared
    // test mock (`web/src/test/setup.ts`) omits it, so guard for that environment.
    if (!selectMode || typeof router.subscribe !== "function") return;
    const unsubscribe = router.subscribe("onResolved", () => {
      exitSelectMode();
    });
    return unsubscribe;
  }, [selectMode, router, exitSelectMode]);

  return {
    selectMode,
    selectedIds,
    toggleSelectMode,
    exitSelectMode,
    toggleSelect,
    selectAll,
    selectNone,
  };
}
