// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "@/api/client";
import type {
  FederationSettingKey,
  FederationSettingsView,
} from "@hapi/protocol/schemas";

/**
 * Issue #2624 (Sub-Issue B) — the browser 🌐 engine for federation-global
 * settings. Hydrates the per-key view (effective value, inherit flag,
 * provenance) from `GET /preferences/federation-settings` on mount, and flips
 * a key's 🌐 flag via `PUT /preferences/federation-settings/:key` — the ONLY
 * path that toggles inherit. Each PUT responds with the fresh view (re-adopted
 * effective values included), which replaces the local one; the Preferences
 * page then pushes re-adopted values into A's value hooks via their
 * non-writing `adopt` (a plain setter would re-PUT the value as a fresh
 * GLOBAL write — wrong under LWW when a peer's global is newer).
 *
 * Structural kin of the Create-page defaults engine (hydrate-on-mount,
 * optimistic update, server-authoritative reconcile). The PUT is immediate
 * rather than debounced: a 🌐 toggle is a discrete boolean action (no
 * keystroke stream to coalesce), matching the ToggleRow/auto-recover
 * precedent — and an immediate PUT can never be lost to an unmount the way a
 * pending debounce can. The `epoch` guard drops any stale response (mount
 * hydrate or an older PUT) that resolves after a newer toggle.
 */
export function useFederationSettings(api: ApiClient | null): {
  /** True once the mount hydrate settled (success OR degrade). */
  hydrated: boolean;
  /** The latest server view; null before hydration or with no api. */
  view: FederationSettingsView | null;
  /** Per-key 🌐 state; defaults to ON (R2) before hydration. */
  inheritFor: (key: FederationSettingKey) => boolean;
  /** Flip a key's 🌐 flag (optimistic; server view adopted on response). */
  setInherit: (key: FederationSettingKey, inherit: boolean) => void;
  /**
   * #4613: set a key's VALUE (optimistic; server view adopted on response). For
   * keys with no dedicated A-value hook (e.g. `timeLogTimezone`) this is the ONLY
   * write path — the PUT follows the key's current inherit flag server-side
   * (global write while inheriting, local override otherwise). Same epoch-guard as
   * `setInherit`, so a stale response can never clobber a newer edit.
   */
  setValue: (key: FederationSettingKey, value: unknown) => void;
} {
  const [view, setView] = useState<FederationSettingsView | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const epochRef = useRef(0);
  const apiRef = useRef(api);
  apiRef.current = api;

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    const epoch = epochRef.current;
    void api
      .getFederationSettings()
      .then(fresh => {
        if (cancelled || epochRef.current !== epoch) return;
        setView(fresh);
        setHydrated(true);
      })
      .catch(() => {
        // Degrade: toggles render the all-inheriting default (R2); a toggle
        // still PUTs and adopts the response, self-healing the view.
        if (!cancelled) setHydrated(true);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const inheritFor = useCallback(
    (key: FederationSettingKey) => view?.inheritFlags[key] !== false,
    [view]
  );

  const setInherit = useCallback(
    (key: FederationSettingKey, inherit: boolean) => {
      epochRef.current += 1;
      const epoch = epochRef.current;
      // Optimistic flip so the 🌐 icon answers instantly — even BEFORE the
      // mount hydrate resolves (synthesize a minimal view then; the epoch
      // guard already drops the late hydrate so it cannot clobber this).
      setView(prev =>
        prev
          ? { ...prev, inheritFlags: { ...prev.inheritFlags, [key]: inherit } }
          : { values: {}, inheritFlags: { [key]: inherit }, provenance: {} }
      );
      const client = apiRef.current;
      if (!client) return;
      void client
        .putFederationSetting(key, { inherit })
        .then(fresh => {
          if (epochRef.current !== epoch) return; // superseded by a newer toggle
          setView(fresh);
        })
        .catch(() => {
          /* best-effort: the optimistic flag stays; the next hydrate reconciles */
        });
    },
    []
  );

  const setValue = useCallback((key: FederationSettingKey, value: unknown) => {
    epochRef.current += 1;
    const epoch = epochRef.current;
    // Optimistic value update so the control reflects the pick immediately.
    setView(prev =>
      prev
        ? { ...prev, values: { ...prev.values, [key]: value } }
        : { values: { [key]: value }, inheritFlags: {}, provenance: {} }
    );
    const client = apiRef.current;
    if (!client) return;
    void client
      .putFederationSetting(key, { value })
      .then(fresh => {
        if (epochRef.current !== epoch) return; // superseded by a newer edit
        setView(fresh);
      })
      .catch(() => {
        /* best-effort: the optimistic value stays; the next hydrate reconciles */
      });
  }, []);

  return { hydrated, view, inheritFor, setInherit, setValue };
}
