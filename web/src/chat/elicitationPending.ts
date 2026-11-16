// SPDX-License-Identifier: AGPL-3.0-only
/**
 * #6606 round 1 (J1, the PM's narrow half): whether an MCP elicitation card (a
 * server's form or link request, tool `mcp_elicitation`) is pending in a chat.
 *
 * While one is and the session is active, `SessionChat` does not show its
 * floating jump row (`elicitationHidesJumpRow`, round 9, F8): on a phone the
 * row's buttons sat over the card's controls, and a tap meant for a checkbox
 * pressed "Previous user message". A card is pending exactly while its
 * request is in the agent state's `requests`; once it is answered it moves to
 * `completedRequests` and the row is back as before. On an inactive session
 * the row is shown even while a card is listed as pending, because its cards
 * are drawn disabled.
 */
import { MCP_ELICITATION_TOOL } from "@hapi/protocol";
import type { AgentState, Session } from "@/types/api";

export function isElicitationPending(
  agentState: AgentState | null | undefined
): boolean {
  return Object.values(agentState?.requests ?? {}).some(
    request => request?.tool === MCP_ELICITATION_TOOL
  );
}

/**
 * Whether `SessionChat` hides its jump row for an elicitation card: only while
 * the session is active (#6606 round 9, F8). After a disconnect the server
 * keeps the requests listed on the inactive session and its cards are drawn
 * disabled, so nothing there is answered, and the row is back.
 */
export function elicitationHidesJumpRow(
  session: Pick<Session, "active" | "agentState">
): boolean {
  return session.active && isElicitationPending(session.agentState);
}
