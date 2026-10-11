// SPDX-License-Identifier: AGPL-3.0-only
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * Lifted "the chat thread is in full-screen page mode" flag (#3638).
 *
 * `SessionChat` owns the authoritative full-screen state locally (it drives the
 * chrome it renders itself — ViewPicker, SessionHeader, the info strip — plus the
 * local dock-collapse override, the Back interceptor, and per-device persistence).
 * The ONE surface `SessionChat` cannot reach on its own is the BrandedFrame app
 * bar (rendered from `App.tsx`, OUTSIDE the route Outlet). This context lifts a
 * single boolean up so `BrandedFrame` can drop the app-bar content while keeping
 * the AppShell safe-area band — operator ruling D1=(a), single view only.
 *
 * `SessionChat` sets this to `true` on enter / `false` on exit ONLY in single
 * view; in split view the app bar is shared by both panes and is never hidden, so
 * `SessionChat` leaves this untouched.
 */
/**
 * Base key for the PER-DEVICE full-screen preference (#3638, X4). Passed through
 * `getStorageKey` (port-scoped) by both writers — `SessionChat` (toggle/restore)
 * and `ViewPicker` (D2 clear on a non-chat view switch) — so the two never drift
 * on a magic string. Value is `"1"` / `"0"`; never synced to the server.
 */
export const THREAD_FULLSCREEN_STORAGE_BASE = "hapi:threadFullscreen";

interface ThreadFullscreenValue {
  threadFullscreen: boolean;
  setThreadFullscreen: (v: boolean) => void;
}

const DEFAULT_VALUE: ThreadFullscreenValue = {
  threadFullscreen: false,
  setThreadFullscreen: () => {},
};

const ThreadFullscreenContext = createContext<ThreadFullscreenValue | null>(
  null
);

export function ThreadFullscreenProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [threadFullscreen, setThreadFullscreenState] = useState(false);
  const setThreadFullscreen = useCallback(
    (v: boolean) => setThreadFullscreenState(v),
    []
  );
  const value = useMemo(
    () => ({ threadFullscreen, setThreadFullscreen }),
    [threadFullscreen, setThreadFullscreen]
  );
  return (
    <ThreadFullscreenContext.Provider value={value}>
      {children}
    </ThreadFullscreenContext.Provider>
  );
}

/**
 * Non-throwing (deliberately unlike `useSplitViewContext`, which throws): both
 * `BrandedFrame` and `SessionChat` read/write this flag, and both are rendered
 * WITHOUT the provider in their unit tests (`BrandedFrame.test.tsx`,
 * `SessionChat.test.tsx`) and in the pre-auth/loading/error BrandedFrame mounts
 * in `App.tsx`. A missing provider degrades to "not full-screen" + a no-op setter
 * — the correct fallback: the app-bar hide simply never fires, while chrome-hiding
 * inside `SessionChat` continues to run off `SessionChat`'s own local state.
 */
export function useThreadFullscreen(): ThreadFullscreenValue {
  return useContext(ThreadFullscreenContext) ?? DEFAULT_VALUE;
}
