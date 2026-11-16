// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The kebab menu's notifications entry for one session (issue #6660). The
 * per-session mute used to be a bell in every session row; it is now the LAST
 * entry of the kebab menu under the session details, built here once and
 * appended by `SessionActionCluster`, so the list card and the session header
 * offer the same entry.
 *
 * Labels (the bell's #3150 tri-state, moved as it is):
 * - unmuted → "Mute notifications"
 * - muted   → "Unmute notifications"
 * - push off on this device → "Notifications globally disabled": still
 *   selectable, and selecting it shows that hint instead of toggling (the
 *   #3150 Q3 ruling; D3, ruled by the Pins PM, 2026-11-13).
 *
 * The device check runs while the menu is open (`menuOpen`), not once per row:
 * the cluster is mounted on every row even while its details are collapsed.
 * Until the first reading arrives the entry shows the mute label, and a select
 * in that window runs the check first, then toggles or hints.
 *
 * Plain `.ts` (no JSX): the icons are made with `createElement`.
 */
import { createElement, useCallback } from "react";
import { BellIcon, BellOffIcon } from "@/components/icons";
import { useToast } from "@/components/Toast";
import type { SessionKebabEntry } from "@/components/session/SessionKebabMenu";
import {
  checkGlobalNotificationsEnabled,
  useGlobalNotificationsEnabled,
} from "@/hooks/useGlobalNotificationsEnabled";
import {
  toggleMutedSession,
  useIsSessionMuted,
} from "@/hooks/useMutedSessions";

export const MUTE_ENTRY_KEY = "notifications";
export const GLOBALLY_DISABLED_LABEL = "Notifications globally disabled";
export const MUTE_NOT_SAVED_MESSAGE =
  "Couldn't save this session's mute setting — the browser's storage is full or turned off.";
export const MUTE_NOT_SYNCED_MESSAGE =
  "Saved, but the notification service didn't get it — reload the app to apply this session's mute setting.";

export function useSessionMuteEntry(
  sessionId: string,
  menuOpen: boolean
): SessionKebabEntry {
  const muted = useIsSessionMuted(sessionId);
  const globalEnabled = useGlobalNotificationsEnabled(menuOpen);
  const { showToast } = useToast();

  const onSelect = useCallback(() => {
    const act = (enabled: boolean) => {
      if (enabled) {
        const { stored, synced } = toggleMutedSession(sessionId);
        if (!stored) {
          showToast(MUTE_NOT_SAVED_MESSAGE, { type: "error" });
        } else {
          void synced.then(ok => {
            if (!ok) showToast(MUTE_NOT_SYNCED_MESSAGE, { type: "error" });
          });
        }
      } else {
        // #3150 Q3: inert under global-off — hint, never toggle.
        showToast(GLOBALLY_DISABLED_LABEL, { type: "info" });
      }
    };
    if (globalEnabled === null) {
      void checkGlobalNotificationsEnabled().then(act);
    } else {
      act(globalEnabled);
    }
  }, [globalEnabled, sessionId, showToast]);

  if (globalEnabled === false) {
    return {
      key: MUTE_ENTRY_KEY,
      label: GLOBALLY_DISABLED_LABEL,
      icon: createElement(BellIcon, {
        className: "h-4 w-4 text-[var(--app-hint)]",
      }),
      onSelect,
    };
  }
  return {
    key: MUTE_ENTRY_KEY,
    label: muted ? "Unmute notifications" : "Mute notifications",
    icon: createElement(muted ? BellIcon : BellOffIcon, {
      className: "h-4 w-4",
    }),
    onSelect,
  };
}
