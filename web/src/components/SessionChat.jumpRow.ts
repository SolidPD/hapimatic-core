// SPDX-License-Identifier: AGPL-3.0-only
// Whether SessionChat's floating jump row has somewhere to jump: the jump to
// top / bottom pair (scrolled up, or new messages below), a previous or next
// user message, or a bookmark. Moved out of SessionChat.tsx unchanged (#6606
// round 7) when #6617 brought that file to the Epic-0 1,500-line cap (#2077).
// SessionChat also hides the row while an MCP elicitation card is pending
// (#6606 J1, `isElicitationPending`): on a phone its buttons covered the card.
import type { ScrollState } from "@/components/AssistantChat/HappyThread";

export function jumpRowHasTarget(
  scrollState: Pick<ScrollState, "showJumpButton" | "newMessageCount"> | null,
  userNav: { totalCount: number },
  bookmarkNav: { totalCount: number }
): boolean {
  return (
    scrollState?.showJumpButton ||
    (scrollState?.newMessageCount ?? 0) > 0 ||
    userNav.totalCount > 1 ||
    bookmarkNav.totalCount > 0
  );
}
