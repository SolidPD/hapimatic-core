// SPDX-License-Identifier: AGPL-3.0-only
// Per-session notification mute state (issue #87).
//
// Set-based localStorage hook, shaped after `useExpandedSessions`
// (SessionList/expandState.ts) but keyed on the port-scoped
// `hapi:notify:mutedSessions` key and — unlike the expand hook — mirroring every
// change into the service-worker preferences cache so an already-registered
// service worker honours the mute without a page reload.
import { useCallback, useState } from "react";
import {
  readMutedSessions,
  writeMutedSessions,
  syncPreferencesToCache,
} from "@/lib/notificationPreferences";

export type UseMutedSessions = {
  mutedSessions: Set<string>;
  isMuted: (sessionId: string) => boolean;
  toggleMuted: (sessionId: string) => void;
};

export function useMutedSessions(): UseMutedSessions {
  const [mutedSessions, setMutedSessions] =
    useState<Set<string>>(readMutedSessions);

  const isMuted = useCallback(
    (sessionId: string) => mutedSessions.has(sessionId),
    [mutedSessions]
  );

  const toggleMuted = useCallback((sessionId: string) => {
    setMutedSessions(prev => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      // Persist to localStorage, then mirror into the SW preferences cache. The
      // sync is serialized inside syncPreferencesToCache, so two rapid toggles
      // cannot land an older snapshot last.
      writeMutedSessions(next);
      void syncPreferencesToCache();
      return next;
    });
  }, []);

  return { mutedSessions, isMuted, toggleMuted };
}
