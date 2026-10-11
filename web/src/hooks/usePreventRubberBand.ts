// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useCallback } from "react";

/**
 * Check if an element is a text input where iOS selection handles need to work.
 * Returns true for textarea, text-type inputs, and contenteditable elements.
 */
function isTextInput(el: HTMLElement | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag === "INPUT") {
    const type = (el as HTMLInputElement).type;
    return (
      type === "text" ||
      type === "search" ||
      type === "url" ||
      type === "email" ||
      type === "password" ||
      type === "tel"
    );
  }
  return el.isContentEditable;
}

/**
 * Prevents iOS rubber-banding on non-scrollable areas while allowing
 * designated scroll containers to scroll normally.
 *
 * The problem: iOS Safari/PWA allows "overscroll" rubber-banding even when
 * touch-action: none is set, because child elements with overflow properties
 * nullify the touch-action setting.
 *
 * The solution: Intercept touchmove events and:
 * 1. Prevent default on non-scrollable areas
 * 2. Allow scrolling in scrollable areas but prevent at boundaries
 * 3. Allow touchmove on text inputs for iOS selection handle dragging
 *
 * Source: https://pqina.nl/blog/how-to-prevent-scrolling-the-page-on-ios-safari
 */
export function usePreventRubberBand(
  containerRef: React.RefObject<HTMLElement | null>
) {
  const touchStartY = useRef(0);
  const scrollableElement = useRef<HTMLElement | null>(null);
  const touchOnInput = useRef(false);

  // Find the nearest scrollable ancestor of an element
  const findScrollableAncestor = useCallback(
    (element: HTMLElement | null): HTMLElement | null => {
      while (element && element !== containerRef.current) {
        // Elements with data-scrollable are explicitly marked as scroll containers
        // (e.g., floating popup overlays). Trust the attribute — use a lenient
        // scrollHeight check to avoid rounding-error false negatives.
        if (element.hasAttribute("data-scrollable")) {
          if (element.scrollHeight >= element.clientHeight) {
            return element;
          }
        }

        const style = window.getComputedStyle(element);
        const overflowY = style.overflowY;

        if (
          (overflowY === "auto" || overflowY === "scroll") &&
          element.scrollHeight > element.clientHeight
        ) {
          return element;
        }
        element = element.parentElement;
      }
      return null;
    },
    [containerRef]
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleTouchStart = (e: TouchEvent) => {
      touchStartY.current = e.touches[0].clientY;
      touchOnInput.current = isTextInput(e.target as HTMLElement);
      scrollableElement.current = findScrollableAncestor(
        e.target as HTMLElement
      );

      // If we found a scrollable element, ensure we're not at exact boundaries
      // This prevents the "pull past boundary" that triggers rubber-band
      const scrollEl = scrollableElement.current;
      if (scrollEl) {
        const { scrollTop, scrollHeight, clientHeight } = scrollEl;
        // Nudge away from top boundary
        if (scrollTop === 0) {
          scrollEl.scrollTop = 1;
        }
        // Nudge away from bottom boundary
        else if (scrollTop >= scrollHeight - clientHeight) {
          scrollEl.scrollTop = scrollHeight - clientHeight - 1;
        }
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      const scrollEl = scrollableElement.current;

      // If touch is NOT in a scrollable area, prevent it entirely
      // Exception: allow touchmove on text inputs so iOS selection handles work
      if (!scrollEl) {
        if (!touchOnInput.current) {
          e.preventDefault();
        }
        return;
      }

      // Touch is in a scrollable area - check if we're at boundaries
      const { scrollTop, scrollHeight, clientHeight } = scrollEl;
      const touchY = e.touches[0].clientY;
      const deltaY = touchY - touchStartY.current;
      const isScrollingUp = deltaY > 0; // finger moving down = scrolling up
      const isScrollingDown = deltaY < 0; // finger moving up = scrolling down

      const atTop = scrollTop <= 1;
      const atBottom = scrollTop >= scrollHeight - clientHeight - 1;

      // Prevent scroll if trying to go past boundaries
      // Exception: allow touchmove on text inputs so iOS selection handles work
      // (same guard as the non-scrollable path above)
      if ((atTop && isScrollingUp) || (atBottom && isScrollingDown)) {
        if (!touchOnInput.current) {
          e.preventDefault();
        }
      }
    };

    // Must use passive: false to be able to preventDefault
    container.addEventListener("touchstart", handleTouchStart, {
      passive: true,
    });
    container.addEventListener("touchmove", handleTouchMove, {
      passive: false,
    });

    return () => {
      container.removeEventListener("touchstart", handleTouchStart);
      container.removeEventListener("touchmove", handleTouchMove);
    };
  }, [containerRef, findScrollableAncestor]);
}
