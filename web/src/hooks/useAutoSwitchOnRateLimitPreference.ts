// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "@/api/client";
import { useAdminPreferences } from "@/hooks/useAdminPreferences";
import { useToast } from "@/components/Toast";

/**
 * Wraps the "Auto-switch account on rate limit" toggle (#3618) with a
 * SERVER-AUTHORITATIVE mirror so the UI reflects the value the server-side
 * `AutoSwitchOnRateLimitService` actually uses. Same server-authoritative
 * reconcile pattern as `useAutoRecoverPreference.ts` (issue #2486) but simpler —
 * a single `{ enabled }` boolean, no per-class overrides.
 *
 * - On mount the hook READS the server preference. A write-only-on-toggle mirror
 *   would let the UI display a state the server never heard, so the server is the
 *   displayed truth; localStorage (`useAdminPreferences.autoSwitchOnRateLimit`)
 *   is only the no-flash first-paint cache.
 * - No-flash: display initializes from the synchronous localStorage value, then
 *   reconciles to the server value once fetched (adopts it AND writes it through
 *   to the cache).
 * - Best-effort writes, silent-degrading reads. A failed mount READ degrades
 *   silently to the localStorage cache (the user has taken no action to
 *   contradict). A failed WRITE surfaces an error toast so a failed toggle is
 *   visible rather than silently leaving the switch service in a state the user
 *   did not choose.
 * - `api === null` (above-context case): no fetch; the value falls back to the
 *   localStorage cache. No crash.
 */
export function useAutoSwitchOnRateLimitPreference(api: ApiClient | null): {
  enabled: boolean;
  setEnabled: (value: boolean) => void;
} {
  const { prefs, setAutoSwitchOnRateLimit } = useAdminPreferences();
  const { showToast } = useToast();

  // The server-authoritative value once fetched. `null` = not yet known
  // (pre-fetch, fetch failure, or `api === null`) → display falls back to the
  // localStorage cache so there is no flash of the default on first paint.
  const [serverEnabled, setServerEnabled] = useState<boolean | null>(null);

  // Once the user toggles, a still in-flight mount read MUST NOT clobber it with
  // the stale pre-toggle server value (the first-load race, #2486).
  const userToggledRef = useRef(false);

  // Server READ on mount. Best-effort: a failed fetch degrades silently to the
  // localStorage cache.
  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    void api
      .getAutoSwitchOnRateLimitPreference()
      .then(pref => {
        if (cancelled || userToggledRef.current) return;
        setServerEnabled(pref.enabled);
      })
      .catch(() => {
        /* best-effort; keep the localStorage cache */
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  // Reconcile the localStorage cache to the server-authoritative value once known.
  useEffect(() => {
    if (serverEnabled === null) return;
    if (serverEnabled !== prefs.autoSwitchOnRateLimit) {
      setAutoSwitchOnRateLimit(serverEnabled);
    }
  }, [serverEnabled, prefs.autoSwitchOnRateLimit, setAutoSwitchOnRateLimit]);

  // Display: the server value once known, else the localStorage cache (no-flash).
  const enabled = serverEnabled ?? prefs.autoSwitchOnRateLimit;

  const setEnabled = useCallback(
    (value: boolean) => {
      // Mark that the user acted so an in-flight mount read cannot clobber this.
      userToggledRef.current = true;
      setAutoSwitchOnRateLimit(value); // localStorage cache
      setServerEnabled(value); // optimistic
      if (!api) return;
      void api
        .setAutoSwitchOnRateLimitPreference({ enabled: value })
        .catch(() => {
          showToast(
            "Couldn't save your auto-switch preference — it may not have persisted.",
            { type: "error" }
          );
        });
    },
    [api, setAutoSwitchOnRateLimit, showToast]
  );

  return { enabled, setEnabled };
}
