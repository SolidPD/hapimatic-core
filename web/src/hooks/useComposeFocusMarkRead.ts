// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useRef } from "react";
import type { Session } from "@/types/api";

type NeedsReviewOverride = "read" | "unread" | null;

type ReviewableSession = Pick<
  Session,
  "id" | "updatedAt" | "active" | "thinking" | "needsReviewOverride"
>;

export type ComposeFocusMarkReadOptions = {
  session: ReviewableSession | null | undefined;
  checkNeedsReview: (
    sessionId: string,
    updatedAt: number,
    active: boolean,
    thinking: boolean,
    needsReviewOverride?: NeedsReviewOverride
  ) => boolean;
  markAsSeen: (sessionId: string, updatedAt: number) => void;
  setNeedsReviewOverride: (override: NeedsReviewOverride) => Promise<void>;
};

/**
 * Compose-field engagement marks an orange session read (#279, #4536).
 *
 * Focusing or pressing the chat composer or the fullscreen prompt editor of a
 * session that needs review marks it seen in this tab (every view, same render)
 * and sets the server `needsReviewOverride` to "read", so other devices and
 * nodes agree and a non-content `updatedAt` bump (a thinking edge, a metadata or
 * agent-state write) cannot turn it orange again. The server clears "read" only
 * when genuinely new assistant content arrives. A session that does not need
 * review is left alone: no server write.
 */
export function useComposeFocusMarkRead({
  session,
  checkNeedsReview,
  markAsSeen,
  setNeedsReviewOverride,
}: ComposeFocusMarkReadOptions): () => Promise<void> | undefined {
  // One tap fires pointerdown then focus, both before the next render; the key
  // makes that pair write once. It is held only while the write is in flight,
  // because a "read" write does not change updatedAt: a later "Mark unread" on
  // the same updatedAt must be markable read again.
  const inFlightKeyRef = useRef<string | null>(null);

  return useCallback(() => {
    if (!session) return;
    const override = session.needsReviewOverride ?? null;
    if (
      !checkNeedsReview(
        session.id,
        session.updatedAt,
        session.active,
        session.thinking,
        override
      )
    ) {
      return;
    }
    const key = `${session.id}:${session.updatedAt}:${override ?? "none"}`;
    if (inFlightKeyRef.current === key) return;
    inFlightKeyRef.current = key;
    markAsSeen(session.id, session.updatedAt);
    const release = () => {
      if (inFlightKeyRef.current === key) inFlightKeyRef.current = null;
    };
    // A failed write is re-thrown. The mutation rolls the optimistic "read"
    // back, and the focus and pointerdown handlers ignore the returned promise,
    // so the rejection reaches the global unhandled-rejection reporter
    // (main.tsx), as the pre-#4536 call did. A rolled-back "unread" shows
    // orange again at once, so the next tap writes again. With no override the
    // local stamp keeps this tab green, so the write is tried again only once
    // the session needs review again (new content or an updatedAt bump).
    return setNeedsReviewOverride("read").then(release, (error: unknown) => {
      release();
      throw error;
    });
  }, [session, checkNeedsReview, markAsSeen, setNeedsReviewOverride]);
}
