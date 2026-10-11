// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect } from "react";
import { useThemeSelection } from "@/design/ThemeProvider";
import { persistThemeId } from "@/design/themePersistence";

/**
 * C3 (#1988) persist-on-change bridge. A pure side-effect component: it subscribes
 * to C1's (#1986) theme context via `useThemeSelection()` and writes the active
 * theme id to localStorage whenever it changes, then renders nothing.
 *
 * This is how C3 reacts to a theme switch WITHOUT modifying C1's provider (R5): C1
 * deliberately omitted an `onThemeChange` callback ("C3 reads `activeThemeId` from
 * context in its own persist-effect"), so the bridge CONSUMES the context instead.
 * Mounted as the first child of `<ThemeProvider>` in `main.tsx`. The first-mount
 * effect writes back the just-read initial id — a harmless idempotent no-op (no
 * skip-first ref needed).
 *
 * Pattern: `web/src/hooks/useDensity.ts` (an effect reacting to a pref value; here
 * the value is sourced from C1's context instead of `useAdminPreferences`).
 */
export function ThemePersistenceBridge(): null {
  const { activeThemeId } = useThemeSelection();

  useEffect(() => {
    persistThemeId(activeThemeId);
  }, [activeThemeId]);

  return null;
}
