// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useRef } from "react";
import { usePlatform } from "./usePlatform";

type UseSwipeBackOptions = {
  /** Callback when swipe-back gesture completes */
  onSwipeBack: () => void;
  /** Whether the gesture is enabled (default: true) */
  enabled?: boolean;
  /** Max distance from left edge to start swipe (default: 30px) */
  edgeThreshold?: number;
  /** Min swipe distance to trigger navigation (default: 100px) */
  swipeThreshold?: number;
};

type UseSwipeBackReturn = {
  /** Touch event handlers to attach to container */
  handlers: {
    onTouchStart: React.TouchEventHandler;
    onTouchMove: React.TouchEventHandler;
    onTouchEnd: React.TouchEventHandler;
  };
  /** Current swipe progress (0-1) for visual feedback */
  progress: number;
};

/**
 * Hook for edge-swipe-to-go-back gesture on mobile devices.
 * Only triggers when swipe starts from the left edge of the screen.
 */
export function useSwipeBack(options: UseSwipeBackOptions): UseSwipeBackReturn {
  const {
    onSwipeBack,
    enabled = true,
    edgeThreshold = 30,
    swipeThreshold = 100,
  } = options;

  const { isTouch, haptic } = usePlatform();

  // Refs to track gesture state without re-renders
  const isTrackingRef = useRef(false);
  const startXRef = useRef(0);
  const startYRef = useRef(0);
  const currentXRef = useRef(0);
  const directionLockedRef = useRef<"horizontal" | "vertical" | null>(null);
  const startTimeRef = useRef(0);

  // Progress state for visual feedback (kept simple - no animation frame needed)
  const progressRef = useRef(0);

  const onTouchStart = useCallback<React.TouchEventHandler>(
    e => {
      // Only work on touch devices when enabled
      if (!enabled || !isTouch) return;

      const touch = e.touches[0];
      const startX = touch.clientX;

      // Only track if started near left edge
      if (startX > edgeThreshold) {
        isTrackingRef.current = false;
        return;
      }

      isTrackingRef.current = true;
      startXRef.current = startX;
      startYRef.current = touch.clientY;
      currentXRef.current = startX;
      directionLockedRef.current = null;
      startTimeRef.current = Date.now();
      progressRef.current = 0;
    },
    [enabled, isTouch, edgeThreshold]
  );

  const onTouchMove = useCallback<React.TouchEventHandler>(
    e => {
      if (!isTrackingRef.current) return;

      const touch = e.touches[0];
      const deltaX = touch.clientX - startXRef.current;
      const deltaY = touch.clientY - startYRef.current;

      // Determine direction lock on first significant movement
      if (directionLockedRef.current === null) {
        const absX = Math.abs(deltaX);
        const absY = Math.abs(deltaY);

        if (absX > 10 || absY > 10) {
          if (absX > absY * 1.5) {
            // Horizontal swipe - lock and prevent scroll
            directionLockedRef.current = "horizontal";
          } else {
            // Vertical or diagonal - abort tracking
            directionLockedRef.current = "vertical";
            isTrackingRef.current = false;
            progressRef.current = 0;
            return;
          }
        }
      }

      // Only process horizontal swipes going right
      if (directionLockedRef.current !== "horizontal") return;
      if (deltaX < 0) {
        // Swiping left, abort
        isTrackingRef.current = false;
        progressRef.current = 0;
        return;
      }

      // Prevent vertical scrolling while swiping
      e.preventDefault();

      currentXRef.current = touch.clientX;
      progressRef.current = Math.min(1, deltaX / swipeThreshold);
    },
    [swipeThreshold]
  );

  const onTouchEnd = useCallback<React.TouchEventHandler>(() => {
    if (!isTrackingRef.current) return;

    const deltaX = currentXRef.current - startXRef.current;
    const elapsed = Date.now() - startTimeRef.current;

    // Calculate velocity (px/ms)
    const velocity = deltaX / elapsed;

    // Trigger if threshold met OR fast swipe (velocity > 0.5 px/ms)
    const shouldTrigger =
      deltaX >= swipeThreshold || (deltaX > 50 && velocity > 0.5);

    if (shouldTrigger && directionLockedRef.current === "horizontal") {
      haptic.impact("light");
      onSwipeBack();
    }

    // Reset state
    isTrackingRef.current = false;
    directionLockedRef.current = null;
    progressRef.current = 0;
  }, [swipeThreshold, haptic, onSwipeBack]);

  return {
    handlers: {
      onTouchStart,
      onTouchMove,
      onTouchEnd,
    },
    progress: progressRef.current,
  };
}
