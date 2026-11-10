// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect } from "react";
import { onFollowOffRequest } from "@/lib/threadScrollClaim";
import { recordEvent } from "@/lib/scrollCauseRecorder";

/**
 * #6453: the thread's side of `requestFollowOff` (`lib/threadScrollClaim.ts`). A navigator that
 * lands the view on a chosen spot asks the thread to stop following, and the thread treats the
 * request as a user scroll up: the direction becomes "up", so neither the near-bottom band nor the
 * at-bottom safety net turns follow back on until the reader scrolls down to the bottom, and
 * follow goes off through `setFollowing`, which updates its ref at once (the rule for a
 * user-intent change of mode, `docs/internal/architecture/chat-thread-scroll.md`).
 */
export function useFollowOffRequests(
  viewportRef: React.RefObject<HTMLElement | null>,
  directionRef: React.MutableRefObject<"up" | "down" | null>,
  setFollowing: (next: boolean) => void
): void {
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    return onFollowOffRequest(viewport, () => {
      directionRef.current = "up";
      setFollowing(false);
      recordEvent("follow-off-request", undefined, viewport);
    });
  }, [viewportRef, directionRef, setFollowing]);
}
