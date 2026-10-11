// SPDX-License-Identifier: AGPL-3.0-only
import { useState, useEffect } from "react";

/**
 * Helper to determine if an element triggers the on-screen keyboard.
 * Based on: https://martijnhols.nl/blog/how-to-detect-the-on-screen-keyboard-in-ios-safari
 */
export function isKeyboardInput(element: Element): boolean {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  // Check for contenteditable
  if (
    element.hasAttribute("contenteditable") &&
    element.getAttribute("contenteditable") !== "false"
  ) {
    return true;
  }

  // Check for input types that trigger keyboard
  const tagName = element.tagName.toLowerCase();
  if (tagName === "textarea") {
    return true;
  }

  if (tagName === "input") {
    const inputElement = element as HTMLInputElement;
    const type = inputElement.type?.toLowerCase() || "text";
    // These input types trigger the on-screen keyboard
    const keyboardTypes = [
      "text",
      "password",
      "email",
      "number",
      "tel",
      "url",
      "search",
      "date",
      "datetime-local",
      "month",
      "time",
      "week",
    ];
    return keyboardTypes.includes(type);
  }

  return false;
}

/**
 * Detects whether the iOS virtual keyboard is likely visible using focus events.
 *
 * IMPORTANT: This hook uses focus/blur event monitoring instead of visualViewport
 * dimension comparisons. The visualViewport API is unreliable in iOS Safari PWA:
 * - 600-700ms delays before viewport dimensions update
 * - window.innerHeight may not update at all in WKWebView
 * - Timing issues make dimension-based detection unreliable
 *
 * Focus-based detection is the recommended approach per authoritative sources:
 * - https://martijnhols.nl/blog/how-to-detect-the-on-screen-keyboard-in-ios-safari
 * - Multiple Stack Overflow answers and GitHub issues confirm this approach
 *
 * Limitations:
 * - Cannot detect if keyboard is dismissed via the "Done" button without blur
 * - External keyboards won't trigger this (but that's usually desired behavior)
 */
export function useKeyboardVisible(): boolean {
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);

  useEffect(() => {
    // focusin/focusout bubble, unlike focus/blur
    const handleFocusIn = (e: FocusEvent) => {
      if (e.target && isKeyboardInput(e.target as Element)) {
        setIsKeyboardVisible(true);
      }
    };

    const handleFocusOut = (e: FocusEvent) => {
      if (e.target && isKeyboardInput(e.target as Element)) {
        // Small delay to handle focus moving between inputs
        // Without this, switching between inputs would briefly show keyboard as hidden
        setTimeout(() => {
          const activeElement = document.activeElement;
          if (!activeElement || !isKeyboardInput(activeElement)) {
            setIsKeyboardVisible(false);
          }
        }, 400);
      }
    };

    document.addEventListener("focusin", handleFocusIn);
    document.addEventListener("focusout", handleFocusOut);

    // Check initial state (in case an input is already focused on mount)
    const activeElement = document.activeElement;
    if (activeElement && isKeyboardInput(activeElement)) {
      setIsKeyboardVisible(true);
    }

    return () => {
      document.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("focusout", handleFocusOut);
    };
  }, []);

  return isKeyboardVisible;
}
