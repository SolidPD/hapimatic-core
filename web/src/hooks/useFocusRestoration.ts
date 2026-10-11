// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef } from "react";
import { isKeyboardInput } from "@/hooks/useKeyboardVisible";

/** Max background duration (ms) before we skip focus restoration */
const MAX_BACKGROUND_MS = 60_000;

/** Delay before attempting focus restoration (ms) */
const RESTORE_DELAY_MS = 150;

/**
 * Restores DOM focus to the previously-active text input when the PWA
 * returns to the foreground after an app switch (e.g., Wispr Flow
 * dictation activation).
 *
 * Limitations (iOS Safari PWA):
 * - The on-screen keyboard will NOT auto-appear — iOS requires a user
 *   gesture for that. But `document.activeElement` will be set and the
 *   cursor will be visible, reducing the workflow from 3 taps to 1.
 * - If the PWA was backgrounded for more than 60 seconds, restoration
 *   is skipped (iOS may have reclaimed memory / reloaded the page).
 */
export function useFocusRestoration(): void {
  const lastFocusedRef = useRef<HTMLElement | null>(null);
  const hiddenAtRef = useRef<number>(0);

  useEffect(() => {
    const handleFocusIn = (e: FocusEvent) => {
      const target = e.target as Element | null;
      if (target && isKeyboardInput(target)) {
        lastFocusedRef.current = target as HTMLElement;
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        hiddenAtRef.current = Date.now();
        return;
      }

      // visibilityState === "visible" — app foregrounded
      const saved = lastFocusedRef.current;
      if (!saved) return;

      // Guard: background too long — iOS may have reloaded the page
      const elapsed = Date.now() - hiddenAtRef.current;
      if (hiddenAtRef.current > 0 && elapsed > MAX_BACKGROUND_MS) {
        lastFocusedRef.current = null;
        return;
      }

      // Guard: element no longer in DOM (navigated away, component unmounted)
      if (!saved.isConnected) {
        lastFocusedRef.current = null;
        return;
      }

      // Small delay to let iOS settle after app switch
      setTimeout(() => {
        // Guard: user may have already tapped something else
        const active = document.activeElement;
        if (active && active !== document.body && active !== saved) {
          return;
        }

        // Guard: re-check isConnected after delay
        if (!saved.isConnected) {
          lastFocusedRef.current = null;
          return;
        }

        saved.focus({ preventScroll: true });
      }, RESTORE_DELAY_MS);
    };

    document.addEventListener("focusin", handleFocusIn);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      document.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);
}
