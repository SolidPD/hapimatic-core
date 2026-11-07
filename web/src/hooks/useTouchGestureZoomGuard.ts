// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect } from "react";
import { usePlatform } from "./usePlatform";

const GESTURE_EVENTS = ["gesturestart", "gesturechange", "gestureend"] as const;

/**
 * Cancels Safari's pinch-zoom gesture events on touch-primary devices only (#6213).
 *
 * Browser zoom and pinch-zoom are never cancelled: Ctrl/Cmd + `=` `-` `0`,
 * Ctrl+wheel and trackpad pinch (Chromium delivers it as Ctrl+wheel) all reach
 * the browser, so this hook installs no `keydown` or `wheel` listener. The
 * blanket block it replaces came with upstream tiann/hapi's initial commit
 * (`b4654acb9`) and blocked keyboard, Ctrl+wheel and trackpad-pinch zoom in
 * desktop browsers.
 *
 * On a touch-primary device (`usePlatform().isTouch`, `(pointer: coarse)`) the
 * gesture events stay cancelled, so the iPhone and iPad PWA keep their native-app
 * feel. On a non-touch device (macOS Safari with a trackpad) nothing is cancelled.
 * `web/index.html`'s `maximum-scale=1, user-scalable=no` is unchanged; desktop
 * browsers ignore it.
 */
export function useTouchGestureZoomGuard(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;

    const preventDefault = (event: Event) => {
      event.preventDefault();
    };

    for (const type of GESTURE_EVENTS) {
      document.addEventListener(type, preventDefault, { passive: false });
    }
    return () => {
      for (const type of GESTURE_EVENTS) {
        document.removeEventListener(type, preventDefault);
      }
    };
  }, [enabled]);
}

/**
 * The app-wide zoom policy mounted by `App` (#6213): Safari pinch gestures are
 * cancelled on touch-primary devices only. This is the one place to change that
 * decision (for example, to allow pinch in iOS Safari tabs, gate on an
 * installed-PWA check instead of `isTouch`).
 */
export function useBrowserZoomPolicy(): void {
  const { isTouch } = usePlatform();
  useTouchGestureZoomGuard(isTouch);
}
