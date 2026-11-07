// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useRef } from "react";
import type { ApiClient } from "@/api/client";
import { useAdminPreferences } from "@/hooks/useAdminPreferences";
import { useToast } from "@/components/Toast";
import {
  isClaudePermissionMode,
  type PermissionMode,
} from "@hapi/protocol/modes";

/**
 * The node's default spawn permission mode (#6218, ruling D2-a), with a
 * SERVER-AUTHORITATIVE mirror. The server value is what every spawn that names no
 * posture starts in — API and MCP spawns included — so it is the displayed truth;
 * `useAdminPreferences.defaultSpawnPermissionMode` is only the no-flash cache the
 * Create page and the fan-out dialog read. Same reconcile pattern as
 * `useAutoSelectOptimalAccountPreference.ts` (#3611):
 *
 * - On mount it READS the server value and writes it through to the cache once,
 *   so a device's stale cached mode (for example YOLO from before #6218) is
 *   replaced by the node's actual default. The displayed value is the cache, so
 *   a pick made in another tab shows here too.
 * - On a change it updates the cache optimistically and PUTs the server value; a
 *   failed write surfaces an error toast. A failed READ degrades silently to the
 *   cache.
 * - `api === null`: no fetch; the value is the cache.
 *
 * The stored value is Claude-tier vocabulary (`CLAUDE_PERMISSION_MODES`); each
 * harness maps it with `resolveDefaultSpawnPermissionMode`.
 */
export function useDefaultSpawnPermissionModePreference(
  api: ApiClient | null
): {
  mode: PermissionMode;
  setMode: (value: PermissionMode) => void;
} {
  const { prefs, setDefaultSpawnPermissionMode } = useAdminPreferences();
  const { showToast } = useToast();

  // Once the user picks a mode, an in-flight mount read must not clobber it with
  // the stale pre-change server value (the first-load race, #2486).
  const userChangedRef = useRef(false);

  // Read the server value and write it through to the cache ONCE per fetch. The
  // display then follows the cache, so a change made in another tab (which also
  // PUT the server) is adopted here through the cross-tab storage bridge rather
  // than overwritten — a reconcile effect that re-wrote the cache whenever it
  // differed from this tab's fetched value ping-ponged between two tabs.
  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    // Inside a promise chain so a client without the method (an older test
    // double) rejects into the catch rather than throwing out of the effect.
    void Promise.resolve()
      .then(() => api.getDefaultSpawnPermissionModePreference())
      .then(pref => {
        if (cancelled || userChangedRef.current) return;
        // Adopt only a recognizable mode; anything else keeps the cache.
        if (isClaudePermissionMode(pref?.mode)) {
          setDefaultSpawnPermissionMode(pref.mode);
        }
      })
      .catch(() => {
        /* best-effort; keep the localStorage cache */
      });
    return () => {
      cancelled = true;
    };
  }, [api, setDefaultSpawnPermissionMode]);

  const mode = prefs.defaultSpawnPermissionMode;

  const setMode = useCallback(
    (value: PermissionMode) => {
      userChangedRef.current = true;
      setDefaultSpawnPermissionMode(value);
      // The server stores Claude-tier vocabulary only; Settings offers only
      // those modes, so a non-Claude value never reaches here in practice.
      if (!api || !isClaudePermissionMode(value)) return;
      void Promise.resolve()
        .then(() =>
          api.setDefaultSpawnPermissionModePreference({ mode: value })
        )
        .catch(() => {
          showToast(
            "Couldn't save the default spawn permission mode — it may not have persisted.",
            { type: "error" }
          );
        });
    },
    [api, setDefaultSpawnPermissionMode, showToast]
  );

  return { mode, setMode };
}
