// SPDX-License-Identifier: AGPL-3.0-only
// Per-session notification mute state (issue #87).
//
// Keyed on the port-scoped `hapi:notify:mutedSessions` key, and every change is
// mirrored into the service-worker preferences cache so an already-registered
// service worker honours the mute without a page reload.
//
// Issue #6660: every reader binds ONE shared store
// (`subscribeMutedSessions` / `getMutedSessionsSnapshot` in
// notificationPreferences) instead of keeping its own copy. With a copy per
// instance, a toggle built from a stale copy dropped mutes made elsewhere: two
// rows muting two sessions left only the second muted. A toggle now reads the
// stored set fresh, so it can never undo another reader's change.
import { useCallback, useSyncExternalStore } from "react";
import {
  getMutedSessionsSnapshot,
  readMutedSessions,
  subscribeMutedSessions,
  syncPreferencesToCache,
  writeMutedSessions,
} from "@/lib/notificationPreferences";

export type MuteToggleResult = { stored: boolean; synced: Promise<boolean> };

export type UseMutedSessions = {
  mutedSessions: ReadonlySet<string>;
  isMuted: (sessionId: string) => boolean;
  toggleMuted: (sessionId: string) => void;
};

/**
 * Flip one session's mute from the stored set, persist it once, and mirror it
 * into the service-worker cache once. No React state is involved, so nothing
 * runs inside a state updater (which React may call twice).
 *
 * Returns whether the stored set now holds the new state (`stored`) and the
 * service-worker cache sync (`synced`, false when that write failed).
 * `writeMutedSessions` ignores a refused write (storage full or turned off), so
 * the set is read back to let the caller tell the user rather than leave the
 * mute silently unsaved; a failed sync leaves the service worker on the old set
 * until the next sync, so the caller can tell the user that too.
 */
export function toggleMutedSession(sessionId: string): MuteToggleResult {
  const next = readMutedSessions();
  const muting = !next.has(sessionId);
  if (muting) {
    next.add(sessionId);
  } else {
    next.delete(sessionId);
  }
  writeMutedSessions(next);
  // Serialized inside syncPreferencesToCache, so two rapid toggles cannot land
  // an older snapshot last.
  const synced = syncPreferencesToCache();
  return { stored: readMutedSessions().has(sessionId) === muting, synced };
}

export function useMutedSessions(): UseMutedSessions {
  const mutedSessions = useSyncExternalStore(
    subscribeMutedSessions,
    getMutedSessionsSnapshot,
    getMutedSessionsSnapshot
  );

  const isMuted = useCallback(
    (sessionId: string) => mutedSessions.has(sessionId),
    [mutedSessions]
  );

  return { mutedSessions, isMuted, toggleMuted: toggleMutedSession };
}

/**
 * Whether one session is muted. The snapshot is a boolean, so a toggle of
 * another session does not re-render this caller (#6660: the hook runs in every
 * session row's kebab cluster).
 */
export function useIsSessionMuted(sessionId: string): boolean {
  const read = useCallback(
    () => getMutedSessionsSnapshot().has(sessionId),
    [sessionId]
  );
  return useSyncExternalStore(subscribeMutedSessions, read, read);
}
