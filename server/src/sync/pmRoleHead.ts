// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #6918 (R5): "this session is a project manager", decided from the
 * server's own message log only.
 *
 * Among the session's first 60 HAPI messages (seq ascending), a user-role
 * message created at or after the session's own `createdAt` must begin, after
 * leading whitespace, with `/project-manager-role` followed by whitespace or the
 * end, or with the anchored framing `<command-message>…</command-message>`
 * (optional) `<command-name>/project-manager-role</command-name>`. This is a
 * start-anchored subset of the session sweep's own rule (rp1-home#3393 §1.2
 * item 1), never wider. A branch is never a manager: on the pty, tmux and local
 * launchers a fork can replay the PM's history into the branch's own log.
 *
 * Not read, by ruling (D1, D7): the JSONL transcript, `turns.transcript_path`,
 * `metadata.sessionRole`, the session name, any marker file. A read error means
 * "not a manager" (fail-open toward "kept").
 */
import type { StoredMessage } from "../store/types";

/** The sweep's window: the first 60 messages of the session's log. */
export const PM_ROLE_HEAD_WINDOW = 60;

const PLAIN_INVOCATION = /^\s*\/project-manager-role(?=\s|$)/;
const FRAMED_INVOCATION =
  /^\s*(?:<command-message>[^<]*<\/command-message>\s*)?<command-name>\s*\/project-manager-role\s*<\/command-name>/;

export type PmRoleHeadDeps = {
  getMessagesAfter: (
    sessionId: string,
    afterSeq: number,
    limit: number
  ) => StoredMessage[];
};

export type PmRoleHeadSession = {
  id: string;
  createdAt: number;
  parentRelationship?: "branch" | "spawn" | null;
  /** Kept when a parent delete nulls parentRelationship (dissolveChildSessions). */
  branchCreatedAt?: number | null;
};

/**
 * A branch, including one whose parent was deleted: dissolveChildSessions
 * nulls `parentRelationship` but keeps `branchCreatedAt` (review F1).
 */
function isBranch(session: PmRoleHeadSession): boolean {
  return (
    session.parentRelationship === "branch" ||
    (session.branchCreatedAt !== null && session.branchCreatedAt !== undefined)
  );
}

/**
 * The text of a user-role message: `content.content.text` when the inner
 * content is an object, the inner string when it is a string; null otherwise
 * (an agent message, a tool result, an event).
 */
export function userTextOf(content: unknown): string | null {
  if (!content || typeof content !== "object") return null;
  const record = content as { role?: unknown; content?: unknown };
  if (record.role !== "user") return null;
  const inner = record.content;
  if (typeof inner === "string") return inner;
  if (inner && typeof inner === "object") {
    const text = (inner as { type?: unknown; text?: unknown }).text;
    if (
      typeof text === "string" &&
      (inner as { type?: unknown }).type === "text"
    ) {
      return text;
    }
  }
  return null;
}

/** True when the text begins with a start-anchored PM invocation. */
export function isProjectManagerInvocation(text: string): boolean {
  return PLAIN_INVOCATION.test(text) || FRAMED_INVOCATION.test(text);
}

/**
 * Evaluated fresh at each call (one indexed query, LIMIT 60): a late arrival
 * is inserted in time order and bumps every later seq (#952), so the window is
 * not fixed once written.
 */
export function isProjectManager(
  session: PmRoleHeadSession,
  deps: PmRoleHeadDeps
): boolean {
  if (isBranch(session)) return false;
  try {
    const messages = deps.getMessagesAfter(session.id, 0, PM_ROLE_HEAD_WINDOW);
    for (const message of messages.slice(0, PM_ROLE_HEAD_WINDOW)) {
      // A forged, back-dated CLI-socket write could land at seq 1; only a
      // message created at or after the session itself counts.
      if (!(message.createdAt >= session.createdAt)) continue;
      const text = userTextOf(message.content);
      if (text !== null && isProjectManagerInvocation(text)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * A per-process check that caches a POSITIVE answer only: once a session has
 * been seen as a manager it stays one for this process. A negative answer is
 * never cached: the invocation itself can still arrive (a late write is
 * inserted in time order), so a "no" now may be a "yes" at the next spawn.
 */
export function createPmRoleHeadCheck(
  deps: PmRoleHeadDeps
): (session: PmRoleHeadSession) => boolean {
  const managers = new Set<string>();
  return session => {
    if (isBranch(session)) return false;
    if (managers.has(session.id)) return true;
    const manager = isProjectManager(session, deps);
    if (manager) managers.add(session.id);
    return manager;
  };
}
