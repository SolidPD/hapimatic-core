// SPDX-License-Identifier: AGPL-3.0-only
import type React from "react";
import { useCallback, useRef } from "react";

type UseDoubleTapOptions = {
  /** Called when a qualifying second tap lands within `threshold` ms. */
  onDoubleTap: (e: React.PointerEvent) => void;
  /** Max ms between the two taps to count as a double-tap. Default 300. */
  threshold?: number;
  /** When true, the handler is inert (no timestamps recorded, no callback). */
  disabled?: boolean;
};

type UseDoubleTapHandlers = {
  onPointerDown: React.PointerEventHandler;
};

/**
 * Detect a double-tap / double-click via **pointer events only**.
 *
 * A single physical tap on every modern touch browser (iOS Safari 13+ included)
 * fires BOTH `pointerdown` (t≈0) and `touchend` (t≈50–150 ms). Feeding a mixed
 * pointer+touch timestamp pool therefore either (a) fires `onDoubleTap` on a
 * SINGLE tap — the tap's own `touchend` lands inside the threshold its
 * `pointerdown` just opened — or (b) inflates the effective window to
 * `threshold + tap-duration`, so two deliberate taps false-toggle. Listening to
 * `pointerdown` ALONE unifies mouse, touch, and pen (exactly one event per
 * physical tap), which structurally rules out the single-tap misfire: two
 * distinct `pointerdown` events are required, one per tap sequence.
 *
 * Note: `e.preventDefault()` on `pointerdown` does NOT suppress iOS double-tap
 * zoom — the reliable suppression is `touch-action: manipulation` CSS on the
 * target element (Tailwind `touch-manipulation`). This hook only calls
 * `preventDefault()` on the qualifying second event for selection/gesture
 * hygiene.
 *
 * Modeled on the shape of `useLongPress` (ref-based timing, `useCallback`
 * handlers, `disabled` guard) — but NOT its mouse/touch event model.
 */
export function useDoubleTap(
  options: UseDoubleTapOptions
): UseDoubleTapHandlers {
  const { onDoubleTap, threshold = 300, disabled = false } = options;

  const lastTapRef = useRef(0);

  const onPointerDown = useCallback<React.PointerEventHandler>(
    e => {
      if (disabled) return;
      const now = Date.now();
      if (lastTapRef.current !== 0 && now - lastTapRef.current < threshold) {
        // Qualifying second tap. preventDefault() on the second event is
        // selection/gesture hygiene only (see JSDoc: it does NOT stop iOS zoom).
        e.preventDefault();
        // Reset to 0 so a third rapid tap starts a fresh count rather than
        // chaining into a triple-fire.
        lastTapRef.current = 0;
        onDoubleTap(e);
      } else {
        lastTapRef.current = now;
      }
    },
    [disabled, threshold, onDoubleTap]
  );

  return { onPointerDown };
}
