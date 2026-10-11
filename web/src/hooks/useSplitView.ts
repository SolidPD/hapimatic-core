// SPDX-License-Identifier: AGPL-3.0-only
import { useState, useEffect, useCallback } from "react";
import { getStorageKey } from "@/lib/storage-keys";
import { SPLIT_MIN_WIDTH } from "@/lib/layout-thresholds";
import type { PaneView } from "@/components/SplitPaneContentView";

const SPLIT_VIEW_KEY = "hapi:splitView";
// Split-view eligibility width — the shared named threshold (720/800 live in one
// place per the #3029 layout-adaptation decision record; Sub-Issue E #3033).
const MIN_SPLIT_WIDTH = SPLIT_MIN_WIDTH;

/**
 * The value the split-view context provides. This hook is the engine; the type
 * lives here (its owner) and `split-view-context.tsx` re-uses it as the public
 * `SplitViewValue`. (#3280 extended it with the lifted pane state + exit paths.)
 */
export type SplitViewValue = {
  isSplit: boolean;
  canSplit: boolean;
  toggleSplit: () => void;
  /** Pane A's view (session-list is `{type:"list"}`). Lifted here for #3280. */
  paneAView: PaneView;
  /** Pane B's view (the rightmost pane). Lifted here for #3280. */
  paneBView: PaneView;
  /** Set a pane's view. Replaces SessionsPage's old route-local setter. */
  setPaneView: (pane: "A" | "B", view: PaneView) => void;
  /** Wordmark (R6): exit split + reset panes to the list; caller navigates home. */
  resetSplitView: () => void;
  /** Toggle-off (R7): exit split + reset panes; caller routes to pane B's view. */
  collapseToPaneB: () => void;
};

function canSplitViewport(): boolean {
  if (typeof window === "undefined") return false;
  return window.innerWidth >= MIN_SPLIT_WIDTH;
}

function persistSplit(next: boolean): void {
  try {
    localStorage.setItem(
      getStorageKey(SPLIT_VIEW_KEY),
      next ? "true" : "false"
    );
  } catch {
    // Ignore localStorage errors (private mode / disabled / full quota).
  }
}

/**
 * #3280 Task 1: restore the split preference on init (fixes the write-only bug —
 * `toggleSplit` wrote the key but `useState(false)` never read it, so split was
 * lost on every reload). Gated on the viewport width so a persisted `true` never
 * restores split below SPLIT_MIN_WIDTH (R9). Mirrors the `useAdminPreferences`
 * `readStored()` try/catch pattern.
 */
function readStoredSplit(): boolean {
  if (!canSplitViewport()) return false;
  try {
    return localStorage.getItem(getStorageKey(SPLIT_VIEW_KEY)) === "true";
  } catch {
    return false;
  }
}

/**
 * The split-view engine. Owns the shared split state for the whole app —
 * `SplitViewProvider` (split-view-context.tsx) is its sole consumer and provides
 * this value to the title-bar SplitScreen toggle (`BrandedFrame`) and the
 * session-list panes (`router.tsx` `SessionsPage`).
 *
 * #3280 (Split-view v2): pane view identity (`paneAView`/`paneBView`) is lifted
 * HERE — it was route-local `useState` in `SessionsPage`, so a full `/settings/*`
 * route unmounted `SessionsPage` and destroyed the pane state with it (the R5
 * "restore split on back" failure). Lifted, it is memory-resident for the SPA
 * session, so navigating to settings and back restores both panes' view identity.
 * Only `isSplit` is persisted to localStorage; pane contents live in memory.
 */
export function useSplitView(): SplitViewValue {
  const [isSplit, setIsSplit] = useState<boolean>(() => readStoredSplit());
  const [canSplit, setCanSplit] = useState<boolean>(() => canSplitViewport());
  const [paneAView, setPaneAView] = useState<PaneView>({ type: "list" });
  const [paneBView, setPaneBView] = useState<PaneView>({ type: "list" });

  // Listen for viewport width changes — force-collapse below the threshold (R9).
  useEffect(() => {
    if (typeof window === "undefined") return;

    const mql = window.matchMedia(`(min-width: ${MIN_SPLIT_WIDTH}px)`);

    const handleChange = (e: MediaQueryListEvent) => {
      setCanSplit(e.matches);
      if (!e.matches) {
        // Force-collapse when the viewport is no longer wide enough. The stored
        // preference is intentionally NOT cleared here — growing back wide and
        // reloading restores split. Panes reset so a later re-entry starts clean.
        setIsSplit(false);
        setPaneAView({ type: "list" });
        setPaneBView({ type: "list" });
      }
    };

    mql.addEventListener("change", handleChange);
    return () => mql.removeEventListener("change", handleChange);
  }, []);

  const toggleSplit = useCallback(() => {
    setIsSplit((prev: boolean) => {
      const next = !prev && canSplitViewport();
      persistSplit(next);
      return next;
    });
  }, []);

  const setPaneView = useCallback((pane: "A" | "B", view: PaneView) => {
    if (pane === "A") setPaneAView(view);
    else setPaneBView(view);
  }, []);

  // The single "exit split" mutation, shared by the two named exits below. It
  // clears BOTH panes so a subsequent re-entry into split never renders a stale
  // pane from a prior split session. The two exits differ ONLY in the caller's
  // navigation, so they intentionally share this one implementation:
  //   - resetSplitView (wordmark, R6): the caller's <Link to="/"> lands on the
  //     session list.
  //   - collapseToPaneB (toggle-off, R7): the caller reads `paneBView` first,
  //     then routes the surviving single view to it.
  const exitSplit = useCallback(() => {
    setIsSplit(false);
    setPaneAView({ type: "list" });
    setPaneBView({ type: "list" });
    persistSplit(false);
  }, []);

  return {
    isSplit,
    canSplit,
    toggleSplit,
    paneAView,
    paneBView,
    setPaneView,
    resetSplitView: exitSplit,
    collapseToPaneB: exitSplit,
  };
}
