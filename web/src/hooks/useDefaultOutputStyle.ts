// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "@/api/client";
import { useAdminPreferences } from "@/hooks/useAdminPreferences";

/**
 * Server-authoritative "default output style" preference (#2623, epic #2622
 * Sub-Issue A). Identical shape to `useChatSectionPrefs` for the `style` string:
 * a localStorage no-flash cache mirrored to the server value, following the
 * #2486 auto-recover pattern. #2626 (Sub-Issue D) consumes this value as the
 * Create-page default.
 *
 * Server-authoritative on load (localStorage is only a cache), reconcile-on-
 * mount + write-through, `userToggledRef` race guard, best-effort silent-
 * degrading writes (cosmetic pref). `api === null` → no fetch, cache fallback.
 */
export function useDefaultOutputStyle(api: ApiClient | null): {
  style: string;
  setStyle: (value: string) => void;
  adopt: (value: string) => void;
} {
  const { prefs, setDefaultOutputStyle } = useAdminPreferences();

  // Server-authoritative value once fetched. `null` = not yet known → cache.
  const [serverStyle, setServerStyle] = useState<string | null>(null);

  const userToggledRef = useRef(false);

  // Server READ on mount — best-effort.
  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    void api
      .getDefaultOutputStyle()
      .then(pref => {
        if (cancelled || userToggledRef.current) return;
        setServerStyle(pref.style);
      })
      .catch(() => {
        /* best-effort; keep the localStorage cache */
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  // Reconcile the cache to the server value once known (#2486).
  useEffect(() => {
    if (serverStyle === null) return;
    if (serverStyle !== prefs.defaultOutputStyle) {
      setDefaultOutputStyle(serverStyle);
    }
  }, [serverStyle, prefs.defaultOutputStyle, setDefaultOutputStyle]);

  // Display: server value once known, else the localStorage cache (no-flash).
  const style = serverStyle ?? prefs.defaultOutputStyle;

  const setStyle = useCallback(
    (value: string) => {
      userToggledRef.current = true;
      setDefaultOutputStyle(value); // localStorage cache
      setServerStyle(value); // optimistic
      if (api) {
        void api.setDefaultOutputStyle({ style: value }).catch(() => {
          /* fire-and-forget; cosmetic pref, silent-degrade on write failure */
        });
      }
    },
    [api, setDefaultOutputStyle]
  );

  // #2624 (B): adopt a server-side value WITHOUT writing back — used by the 🌐
  // inherit toggle (see useChatSectionPrefs.adopt for the LWW rationale).
  const adopt = useCallback(
    (value: string) => {
      userToggledRef.current = true;
      setDefaultOutputStyle(value); // localStorage cache
      setServerStyle(value);
    },
    [setDefaultOutputStyle]
  );

  return { style, setStyle, adopt };
}
