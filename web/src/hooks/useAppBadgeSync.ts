// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect } from "react";
import { applyBadge, decideMirrorBadge } from "@/lib/pushBadge";

/**
 * Mirror the server unread count to the app badge (issue #4921 R7). Re-applies
 * on every successful fetch (`updatedAt`), not only when the count changes:
 * a push for an event that is not an inbox row sets the badge to 1 while the
 * count stays 0, and only re-writing the true count on the next fetch clears
 * it. Does nothing while the count is unknown (loading or errored), so a
 * guessed value is never written and the badge is never incremented locally.
 * A browser tab without the Badging API is a no-op.
 */
export function useAppBadgeSync(
  unreadCount: number | undefined,
  updatedAt?: number
): void {
  useEffect(() => {
    if (unreadCount === undefined) return;
    void applyBadge(
      typeof navigator === "undefined" ? null : navigator,
      decideMirrorBadge(unreadCount)
    );
  }, [unreadCount, updatedAt]);
}
