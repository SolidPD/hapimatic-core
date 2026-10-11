// SPDX-License-Identifier: AGPL-3.0-only
import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { applyPalette } from "@/design/tokens";
import {
  DEFAULT_THEME_ID,
  getThemeById,
  THEMES,
  type Theme,
} from "@/design/themes";

/**
 * The runtime theme engine for Epic C (#1986, C1). Holds the active theme in
 * React state and applies its palette-source vars (via A1's `applyPalette`) so the
 * whole app re-themes with no per-component edits (R1/R2). Mounted at the app root
 * in `main.tsx` (wrapping the router, alongside `SplitViewProvider`) so the login
 * screen and C2's future picker are themed alike (R5).
 *
 * NAMING: the hook is `useThemeSelection()` — distinct from the existing
 * `web/src/hooks/useTheme.ts` dark-mode/color-scheme stub, which is orthogonal and
 * left untouched.
 *
 * PERSISTENCE: C1 is in-memory only. The `initialThemeId` prop is C3's (#1988)
 * seam — C3 will read a persisted choice from localStorage and pass it here, plus
 * add true cold-load pre-paint. C1 adds no storage.
 *
 * Follows the `web/src/lib/split-view-context.tsx` context+provider+throwing-hook
 * pattern; the apply-in-effect precedent is `web/src/hooks/useDensity.ts`, upgraded
 * to `useLayoutEffect` for pre-paint timing (no flash of the base theme — R4).
 */
export type ThemeSelectionValue = {
  activeThemeId: string;
  activeTheme: Theme;
  availableThemes: readonly Theme[];
  setActiveTheme: (id: string) => void;
};

const ThemeContext = createContext<ThemeSelectionValue | null>(null);

export function ThemeProvider({
  children,
  initialThemeId = DEFAULT_THEME_ID,
}: {
  children: ReactNode;
  initialThemeId?: string;
}) {
  const [activeThemeId, setActiveTheme] = useState(initialThemeId);
  // `getThemeById` returns a stable reference from THEMES for a given id, so
  // `activeTheme` only changes identity when `activeThemeId` changes.
  const activeTheme = getThemeById(activeThemeId);

  // useLayoutEffect (pre-paint) — write the active theme's palette-source vars
  // before the browser paints, so applying the initial (or a switched) theme never
  // flashes the base theme (R4). A single applyPalette re-resolves every var()
  // consumer downstream — no per-usage-site edit (R2).
  useLayoutEffect(() => {
    applyPalette(activeTheme.vars);
  }, [activeTheme]);

  const value = useMemo<ThemeSelectionValue>(
    () => ({
      activeThemeId,
      activeTheme,
      availableThemes: THEMES,
      setActiveTheme,
    }),
    [activeThemeId, activeTheme]
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useThemeSelection(): ThemeSelectionValue {
  const ctx = useContext(ThemeContext);
  if (ctx === null) {
    throw new Error("useThemeSelection must be used within a ThemeProvider");
  }
  return ctx;
}
