// SPDX-License-Identifier: AGPL-3.0-only
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useBlocker } from "@tanstack/react-router";
import type { Session } from "@/types/api";
import { registerBackInterceptor } from "@/hooks/useAppGoBack";
import { getStorageKey } from "@/lib/storage-keys";
import {
  useThreadFullscreen,
  THREAD_FULLSCREEN_STORAGE_BASE,
} from "@/lib/thread-fullscreen-context";
import {
  computeEffectiveSessionView,
  hasConsumedOpenRedirect,
  isSessionViewAvailable,
} from "@/lib/session-view";

/**
 * Full-screen chat-thread page mode (#3638). Extracted from `SessionChat` as a
 * standalone hook (SessionChat is at the 1500-line ESLint cap, and the state
 * machine is a cohesive, independently-testable unit).
 *
 * `isFullscreen` is the LOCAL authoritative state that drives the chrome
 * SessionChat renders (ViewPicker / SessionHeader / info strip), the local
 * dock-collapse override (X2), the Back interceptor + blocker (X1) and per-device
 * persistence (X4). The app-bar hide is a SEPARATE lifted flag
 * (`useThreadFullscreen`) set here in SINGLE VIEW only — the one surface
 * SessionChat cannot reach on its own.
 */
export interface FullscreenOverride {
  promptCollapsed?: boolean;
  notesCollapsed?: boolean;
  tokenUsageCollapsed?: boolean;
  detailsCollapsed?: boolean;
  /** The Background Agents breakout inside the Context widget (2026-10-05). */
  backgroundAgentsCollapsed?: boolean;
}

export interface ThreadFullscreenMode {
  isFullscreen: boolean;
  toggleFullscreen: () => void;
  exitFullscreen: () => void;
  /** X2 local dock-collapse override: only the user's in-place deviations. */
  fullscreenOverride: FullscreenOverride | null;
  setFullscreenOverride: Dispatch<SetStateAction<FullscreenOverride | null>>;
  /** R3: SessionNotes' pop-out window open state (pop-out guard). */
  notesPopoutActive: boolean;
  setNotesPopoutActive: (active: boolean) => void;
}

export function useThreadFullscreenMode(params: {
  session: Session;
  inSplitPane?: boolean;
}): ThreadFullscreenMode {
  const { session, inSplitPane } = params;
  const { setThreadFullscreen } = useThreadFullscreen();
  const [isFullscreen, setIsFullscreen] = useState(false);
  // X2 (trust-critical): holds ONLY the user's in-place deviations from
  // all-collapsed. It has NO write path to the synced collapse state, so
  // entering / exiting / expanding in full-screen never PUTs the server state.
  const [fullscreenOverride, setFullscreenOverride] =
    useState<FullscreenOverride | null>(null);
  const [notesPopoutActive, setNotesPopoutActive] = useState(false);

  const persistFullscreen = useCallback((on: boolean) => {
    try {
      localStorage.setItem(
        getStorageKey(THREAD_FULLSCREEN_STORAGE_BASE),
        on ? "1" : "0"
      );
    } catch {
      // localStorage unavailable/full — the in-memory state still drives the UI.
    }
  }, []);

  const enterFullscreen = useCallback(() => {
    setIsFullscreen(true);
    setFullscreenOverride(null); // all docks collapsed by default (mockup panel D)
    // Split view: the app bar is shared by both panes — never lift the flag (R7).
    if (!inSplitPane) setThreadFullscreen(true);
    persistFullscreen(true);
  }, [inSplitPane, setThreadFullscreen, persistFullscreen]);

  const exitFullscreen = useCallback(() => {
    setIsFullscreen(false);
    setFullscreenOverride(null);
    if (!inSplitPane) setThreadFullscreen(false);
    persistFullscreen(false);
  }, [inSplitPane, setThreadFullscreen, persistFullscreen]);

  const toggleFullscreen = useCallback(() => {
    if (isFullscreen) exitFullscreen();
    else enterFullscreen();
  }, [isFullscreen, enterFullscreen, exitFullscreen]);

  // Clear the lifted app-bar flag if the consumer unmounts while full-screen
  // (a route change / view switch / back-to-list) so the app bar is never left
  // stranded hidden. Single view only — split view never set it.
  useEffect(() => {
    return () => {
      if (!inSplitPane) setThreadFullscreen(false);
    };
  }, [inSplitPane, setThreadFullscreen]);

  // X1: intercept the in-app Back paths (Telegram BackButton, app-bar arrow,
  // edge-swipe — all route through useAppGoBack) while full-screen; exit the mode
  // instead of leaving the session. No history push, so nothing to consume.
  useEffect(() => {
    if (!isFullscreen) return;
    return registerBackInterceptor(() => {
      if (!isFullscreen) return false;
      exitFullscreen();
      return true;
    });
  }, [isFullscreen, exitFullscreen]);

  // X1 (browser/PWA OS Back): TanStack useBlocker intercepts the router's own
  // history listener without pushing anything — no entry to consume, no
  // double-Back hole. Returning true blocks the navigate; we exit full-screen.
  useBlocker({
    shouldBlockFn: () => {
      if (!isFullscreen) return false;
      exitFullscreen();
      return true;
    },
    enableBeforeUnload: false,
  });

  // X1 (desktop keyboard): Escape exits full-screen — the keyboard equivalent of
  // Back. Mobile has no Escape key, so this is inherently desktop-only. Two
  // guards keep it from stealing an Escape another surface owns: `defaultPrevented`
  // (the composer preventDefaults Escape when its suggestion list is open or the
  // thread is running — HappyComposer.tsx) and an open-dialog check (the
  // prompt/notes full-screen editors and the config modal are Radix Dialogs that
  // close themselves on Escape). Only a bare Escape in the page mode exits it.
  useEffect(() => {
    if (!isFullscreen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (
        typeof document !== "undefined" &&
        document.querySelector('[role="dialog"]')
      ) {
        return; // an open modal owns this Escape (Radix closes it)
      }
      exitFullscreen();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isFullscreen, exitFullscreen]);

  // X4: restore the per-device full-screen flag on mount / session change, but
  // ONLY after the open-redirect has settled — a pending redirect to a non-chat
  // view would otherwise flash full-screen and arm Back for a component about to
  // unmount. Restore goes through enterFullscreen so the interceptor + blocker
  // are armed exactly as a tap would arm them (otherwise the first Back on a
  // restored session would navigate away — R4).
  const restoredForSessionRef = useRef<string | null>(null);
  useEffect(() => {
    const sid = session.id;
    if (restoredForSessionRef.current === sid) return;
    if (!hasConsumedOpenRedirect(sid)) {
      const ev = computeEffectiveSessionView(session, sid);
      if (ev !== "chat" && isSessionViewAvailable(ev, session)) {
        // A non-chat open-redirect is pending — defer until it settles.
        return;
      }
    }
    restoredForSessionRef.current = sid;
    let on = false;
    try {
      on =
        localStorage.getItem(getStorageKey(THREAD_FULLSCREEN_STORAGE_BASE)) ===
        "1";
    } catch {
      on = false;
    }
    if (on) {
      enterFullscreen();
    } else {
      // Ensure a session opened with the flag off is never stuck full-screen
      // from a prior session; no persist (the flag is already off).
      setIsFullscreen(false);
      setFullscreenOverride(null);
      if (!inSplitPane) setThreadFullscreen(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, enterFullscreen]);

  return {
    isFullscreen,
    toggleFullscreen,
    exitFullscreen,
    fullscreenOverride,
    setFullscreenOverride,
    notesPopoutActive,
    setNotesPopoutActive,
  };
}
