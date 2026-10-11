// SPDX-License-Identifier: AGPL-3.0-only
import { useState, useEffect } from "react";

/**
 * Hook that manages iOS PWA keyboard viewport behavior.
 *
 * PROVEN MECHANISM (via diagnostic build v1.0.78-AO on iPhone 16 Pro):
 * When the iOS keyboard appears in PWA standalone mode, iOS scrolls the
 * page using window.scrollY (measured: 0 → 375). This creates a gap
 * between app content and keyboard.
 *
 * KEY FINDINGS:
 * - iOS uses window.scrollY to pan (not transform, not viewport offset)
 * - window.scrollTo(0, 0) successfully reverses the scroll
 * - visualViewport DOES update in PWA mode (vv.height: 874 → 471)
 * - visualViewport.height gives the exact usable area above keyboard
 *
 * STRATEGY:
 * 1. Listen to visualViewport resize events
 * 2. When keyboard opens (vv.height shrinks): scrollTo(0,0) to undo pan
 * 3. Set app height to vv.height so content fits above keyboard
 * 4. When keyboard closes (vv.height restores): reset to full height
 */
export interface KeyboardState {
  isOpen: boolean;
  keyboardHeight: number;
  /** The height the app should use (visualViewport.height when keyboard open) */
  viewportHeight: number | null;
}

export function useKeyboardPadding(): KeyboardState {
  const [state, setState] = useState<KeyboardState>({
    isOpen: false,
    keyboardHeight: 0,
    viewportHeight: null,
  });

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    // Track whether an input is focused (keyboard-triggering element)
    let inputFocused = false;
    const handleResize = () => {
      const fullHeight = window.innerHeight;
      const currentHeight = Math.round(vv.height);
      const diff = fullHeight - currentHeight;

      if (inputFocused && diff > 100) {
        // Keyboard is open — undo the iOS scroll pan
        window.scrollTo(0, 0);

        setState({
          isOpen: true,
          keyboardHeight: diff,
          viewportHeight: currentHeight,
        });
      } else if (diff < 50) {
        // Keyboard is closed or nearly closed
        setState({
          isOpen: false,
          keyboardHeight: 0,
          viewportHeight: null,
        });
      }
    };

    const handleScroll = () => {
      // Continuously counteract iOS scroll when keyboard is open
      if (inputFocused && window.scrollY > 0) {
        window.scrollTo(0, 0);
      }
    };

    const handleFocusIn = (e: FocusEvent) => {
      const t = e.target as Element;
      const tag = t.tagName?.toLowerCase();
      if (
        tag === "textarea" ||
        tag === "input" ||
        (t as HTMLElement).isContentEditable
      ) {
        inputFocused = true;

        // iOS may scroll before visualViewport fires resize
        // Proactively undo any scroll after a short delay
        setTimeout(() => {
          if (window.scrollY > 0) {
            window.scrollTo(0, 0);
          }
          // Trigger a manual check in case resize already fired
          handleResize();
        }, 300);
      }
    };

    const handleFocusOut = () => {
      setTimeout(() => {
        const active = document.activeElement;
        const tag = active?.tagName?.toLowerCase();
        const isInput =
          tag === "textarea" ||
          tag === "input" ||
          (active as HTMLElement)?.isContentEditable;
        if (!isInput) {
          inputFocused = false;
          setState({
            isOpen: false,
            keyboardHeight: 0,
            viewportHeight: null,
          });
        }
      }, 400);
    };

    vv.addEventListener("resize", handleResize);
    window.addEventListener("scroll", handleScroll, { passive: true });
    document.addEventListener("focusin", handleFocusIn);
    document.addEventListener("focusout", handleFocusOut);

    return () => {
      vv.removeEventListener("resize", handleResize);
      window.removeEventListener("scroll", handleScroll);
      document.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("focusout", handleFocusOut);
    };
  }, []);

  return state;
}
