// SPDX-License-Identifier: AGPL-3.0-only
import { getSessionName } from "../notifications/sessionInfo";
import type { Session } from "../sync/syncEngine";
import type { PushPayload } from "./pushService";

// One shape for every session-scoped Web Push (issue #4921 R4): the banner
// title is the session (emoji + name), the body is the event, tapping opens
// the session, and the tag is per kind and session so a repeat replaces that
// session's banner while different sessions stack.

export type SessionPushInput = {
  /** The notification kind (or a legacy producer's own kind), for the tag. */
  kind: string;
  /**
   * The service worker's `data.type`. Keep each producer's existing string:
   * `getPreferenceKeyForType` maps `permission-request`, `question`, `ready`,
   * `error` and `stall-detected` to the user's per-type toggles (a changed
   * string silently bypasses its toggle). `heartbeat`, `scheduled-task` and
   * `ceiling-breach` have no toggle and always display.
   */
  type: string;
  sessionId: string;
  sessionTitle: string | null | undefined;
  sessionEmoji?: string | null;
  /** The event text, shown as the banner body. */
  body: string;
};

/** Build a session-scoped push payload. An empty title falls back to the id prefix. */
export function buildSessionPushPayload(input: SessionPushInput): PushPayload {
  const name = input.sessionTitle || input.sessionId.slice(0, 8);
  const prefix = input.sessionEmoji ? `${input.sessionEmoji} ` : "";
  return {
    title: `${prefix}${name}`,
    body: input.body,
    tag: `${input.kind}:${input.sessionId}`,
    data: {
      type: input.type,
      sessionId: input.sessionId,
      url: `/sessions/${input.sessionId}`,
    },
  };
}

/** `buildSessionPushPayload` for a live session: its display name and emoji. */
export function buildSessionPushPayloadFromSession(
  session: Session,
  kind: string,
  type: string,
  body: string
): PushPayload {
  return buildSessionPushPayload({
    kind,
    type,
    sessionId: session.id,
    sessionTitle: getSessionName(session),
    sessionEmoji: session.emoji,
    body,
  });
}
