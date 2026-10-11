// SPDX-License-Identifier: AGPL-3.0-only
import { createContext, useContext, type ReactNode } from "react";
import { useSplitView, type SplitViewValue } from "@/hooks/useSplitView";

/**
 * Shared split-view state, lifted out of the per-component `useSplitView()` hook
 * so the top-bar SplitScreen toggle (`BrandedFrame`, #1043) and the session-list
 * panes (`router.tsx`) drive ONE source of truth.
 *
 * `useSplitView()` returns a fresh `useState`-backed value per call — two callers
 * would get two independent `isSplit` values, so a top-bar button calling the hook
 * directly would be a disconnected toggle. `SplitViewProvider` calls the hook once
 * and provides its result; both the root-route component (`App`) and the child
 * routes consume the same instance via `useSplitViewContext()`.
 *
 * Follows the existing `app-context.tsx` provider pattern.
 */
// #3280: the value shape (extended with the lifted pane state + the reset/collapse
// exit paths) lives with its engine in `useSplitView`; re-exported here so
// consumers can keep importing `SplitViewValue` from the context module.
export type { SplitViewValue };

const SplitViewContext = createContext<SplitViewValue | null>(null);

export function SplitViewProvider({ children }: { children: ReactNode }) {
  // The single canonical split-view state instance for the whole app.
  // `useSplitView` is unchanged — it becomes this provider's internal engine.
  const value = useSplitView();
  return (
    <SplitViewContext.Provider value={value}>
      {children}
    </SplitViewContext.Provider>
  );
}

export function useSplitViewContext(): SplitViewValue {
  const ctx = useContext(SplitViewContext);
  if (ctx === null) {
    throw new Error(
      "useSplitViewContext must be used within a SplitViewProvider"
    );
  }
  return ctx;
}
