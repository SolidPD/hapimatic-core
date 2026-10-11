// SPDX-License-Identifier: AGPL-3.0-only
import { useState, useEffect } from "react";

/**
 * Detects if the app is running on an iPad in a multitasking/windowed mode
 * where iPadOS traffic light controls (close/minimize/maximize) overlay
 * the top-left corner of the PWA window.
 *
 * Detection logic:
 * 1. iPad: UA contains "iPad" OR ("Macintosh" + maxTouchPoints > 1) for iPadOS 13+
 * 2. Standalone PWA: display-mode: standalone OR navigator.standalone
 * 3. Non-full-screen: innerWidth < screen.width (traffic lights visible)
 *
 * Re-evaluates on window resize (user can enter/exit Split View dynamically).
 */

function isIPad(): boolean {
  const ua = navigator.userAgent;
  // Direct iPad UA string, or iPadOS 13+ which reports as Macintosh
  return (
    ua.includes("iPad") ||
    (ua.includes("Macintosh") && navigator.maxTouchPoints > 1)
  );
}

function isStandalonePWA(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function isMultitasking(): boolean {
  return window.innerWidth < window.screen.width;
}

function detect(): boolean {
  if (typeof window === "undefined") return false;
  return isIPad() && isStandalonePWA() && isMultitasking();
}

export function useIPadMultitasking(): boolean {
  const [active, setActive] = useState<boolean>(() => detect());

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleResize = () => {
      setActive(detect());
    };

    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  return active;
}

/**
 * Full-screen thread gutter `top` on iPad multitasking (#4004). The window-control
 * pill spans ~10–33px below the thread-area top and ~17–65px from its left edge
 * (measured from the operator's on-device photo, calibrated on the 24px gutter).
 * One 30px icon cell would leave ≤1px clearance, so shift 1.5 cells (45px) past
 * the gutter's base `top-1`.
 */
export const IPAD_FULLSCREEN_GUTTER_TOP = "calc(0.25rem + 45px)";

/**
 * Horizontal inset that clears the same top-left window-control pill on iPad
 * multitasking (#130/#259/#556): the pill spans ~17–65px from the left edge, so
 * top-bar content shifts 75px. Inline-style px, never a Tailwind `[Npx]` class.
 */
export const IPAD_WINDOW_CONTROLS_INSET_X = "75px";
