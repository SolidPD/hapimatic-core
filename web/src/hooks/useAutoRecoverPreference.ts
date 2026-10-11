// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "@/api/client";
import { useAdminPreferences } from "@/hooks/useAdminPreferences";
import { useToast } from "@/components/Toast";

/**
 * Wraps the localStorage-backed "Auto-recover from API errors" MASTER admin
 * preference (owned by `useAdminPreferences`, issue #1040) with a
 * SERVER-AUTHORITATIVE mirror so the UI reflects the value the server-side
 * `autoRecoveryService` (epic #1231 sub-issue C / issue #1234) actually uses,
 * AND adds the per-class override map (#2487 Sub-Issue D).
 *
 * Server-authoritative reconcile (issue #2486 — supersedes the #1236
 * write-only-on-toggle mirror), extended for per-class overrides (#2487 D):
 * - On mount the hook READS the full server preference (`{ enabled,
 *   classOverrides }`). The prior design only ever WROTE on toggle, so a UI
 *   showing the localStorage default (`true`) never told the server anything —
 *   and a server resolving a different value silently disarmed the feature
 *   fleet-wide while the toggle read ON. The server is now the displayed truth;
 *   localStorage is a cache (for the MASTER only).
 * - No-flash first paint is preserved for the MASTER (#1040): display
 *   initializes from the synchronous localStorage value, then reconciles to the
 *   server value once the fetch resolves — adopting it AND writing it through to
 *   the localStorage cache so later offline reads (and the system-health icon
 *   that reads localStorage directly, above `AppContextProvider`) stay
 *   consistent.
 * - Per-class overrides are SERVER-AUTHORITATIVE ONLY — there is NO localStorage
 *   cache at class granularity, so `classOverrides` starts empty and
 *   `classesLoaded` gates the UI until the first server read resolves. This
 *   deliberately avoids the class-level default divergence #2486 fixed for the
 *   master.
 * - Every write sends the FULL preference object (belt-and-braces; the server's
 *   server-side merge in `PUT /preferences/auto-recover` is the backstop for a
 *   partial write from another client). The `userToggledRef` race guard is
 *   generalized to cover per-class writes, so a class toggle is not overwritten
 *   by an in-flight stale mount GET.
 * - Best-effort writes, silent-degrading reads (R3, refined by #2615): a failed
 *   mount READ still degrades silently to the localStorage master cache (the
 *   class list stays "not loaded") — harmless, the user has taken no action to
 *   contradict. A failed mirror WRITE now surfaces an error toast (#2615) so a
 *   failed opt-OUT under the default-ON posture (#2486) is visible rather than
 *   silently leaving the recovery service armed. Neither path rolls back the
 *   optimistic UI.
 *
 * `api` is threaded in as a parameter (matching `useSearchFilterPreferences`)
 * rather than read via `useAppContext` inside the hook. When `api === null` (the
 * above-context case) the hook does not fetch and the master falls back to the
 * localStorage value — no crash; the class list simply stays unloaded (it is
 * only rendered on the Preferences page, which is always below context).
 */
export function useAutoRecoverPreference(api: ApiClient | null): {
  enabled: boolean;
  setEnabled: (value: boolean) => void;
  classOverrides: Record<string, boolean>;
  classesLoaded: boolean;
  setClassOverride: (canonicalClass: string, value: boolean) => void;
} {
  const { prefs, setAutoRecoverFromApiErrors } = useAdminPreferences();
  const { showToast } = useToast();

  // The server-authoritative MASTER value once fetched. `null` = not yet known
  // (pre-fetch, fetch failure, or `api === null`) → display falls back to the
  // localStorage cache so there is no flash of the default on first paint.
  const [serverEnabled, setServerEnabled] = useState<boolean | null>(null);

  // Per-class overrides — server-authoritative, no localStorage cache. Empty
  // until the first server read resolves; `classesLoaded` gates the UI.
  const [classOverrides, setClassOverrides] = useState<Record<string, boolean>>(
    {}
  );
  const [classesLoaded, setClassesLoaded] = useState(false);

  // Once the user has toggled the master OR a class, a still in-flight mount
  // read MUST NOT clobber it with the stale pre-toggle server value — the
  // first-load race the authority flip introduces (#2486), generalized to cover
  // per-class writes (#2487 D).
  const userToggledRef = useRef(false);

  // Latest values, so the fire-and-forget writers can always send the FULL
  // object without re-creating callbacks on every state change.
  const enabledRef = useRef(prefs.autoRecoverFromApiErrors);
  const classOverridesRef = useRef(classOverrides);

  // Server READ on mount — the FULL `{ enabled, classOverrides }` object (the
  // fix for the write-only-on-toggle divergence, #2486). Best-effort: a failed
  // fetch degrades silently to the localStorage master cache (R3).
  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    void api
      .getAutoRecoverPreference()
      .then(pref => {
        // Skip if unmounted, or if the user already toggled (their action wins
        // over an in-flight read of the pre-toggle server value).
        if (cancelled || userToggledRef.current) return;
        setServerEnabled(pref.enabled);
        setClassOverrides(pref.classOverrides ?? {});
        setClassesLoaded(true);
      })
      .catch(() => {
        /* best-effort; keep the localStorage master, leave classes unloaded */
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  // Reconcile the localStorage MASTER cache to the server-authoritative value
  // once known (#2486 R2/R3). Converges in one extra render.
  useEffect(() => {
    if (serverEnabled === null) return;
    if (serverEnabled !== prefs.autoRecoverFromApiErrors) {
      setAutoRecoverFromApiErrors(serverEnabled);
    }
  }, [
    serverEnabled,
    prefs.autoRecoverFromApiErrors,
    setAutoRecoverFromApiErrors,
  ]);

  // Display MASTER: the server value once known, else the localStorage cache
  // (no-flash first paint; #1040 synchronous-initializer preserved).
  const enabled = serverEnabled ?? prefs.autoRecoverFromApiErrors;

  // Keep the "latest" refs current for the full-object writers.
  enabledRef.current = enabled;
  classOverridesRef.current = classOverrides;

  const putFull = useCallback(
    (next: { enabled: boolean; classOverrides: Record<string, boolean> }) => {
      if (!api) return;
      // Send the FULL preference object on every write (belt-and-braces; Task
      // 5's server-side merge is the backstop for partial writes from other
      // clients). Fire-and-forget; failures degrade silently per R3.
      const body =
        Object.keys(next.classOverrides).length > 0
          ? { enabled: next.enabled, classOverrides: next.classOverrides }
          : { enabled: next.enabled };
      void api.setAutoRecoverPreference(body).catch(() => {
        // #2615: the mirror write stays fire-and-forget (non-blocking, the #1236
        // R3 tradeoff), but a failure is no longer INVISIBLE — surface it so a
        // failed opt-OUT under the #2486 default-ON posture is not silently
        // ignored (the server key stays absent → readAutoRecoverPreference()
        // returns the default `true` → recovery stays ARMED against the user's
        // explicit intent).
        showToast(
          "Couldn't save your auto-recover preference — it may not have persisted.",
          { type: "error" }
        );
      });
    },
    [api, showToast]
  );

  const setEnabled = useCallback(
    (value: boolean) => {
      // Mark that the user acted so an in-flight mount read cannot clobber this.
      userToggledRef.current = true;
      setAutoRecoverFromApiErrors(value); // localStorage master cache (#1040)
      setServerEnabled(value); // optimistic
      putFull({ enabled: value, classOverrides: classOverridesRef.current });
    },
    [setAutoRecoverFromApiErrors, putFull]
  );

  const setClassOverride = useCallback(
    (canonicalClass: string, value: boolean) => {
      userToggledRef.current = true;
      const next = { ...classOverridesRef.current, [canonicalClass]: value };
      setClassOverrides(next); // optimistic
      putFull({ enabled: enabledRef.current, classOverrides: next });
    },
    [putFull]
  );

  return {
    enabled,
    setEnabled,
    classOverrides,
    classesLoaded,
    setClassOverride,
  };
}
