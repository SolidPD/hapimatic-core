// SPDX-License-Identifier: AGPL-3.0-only
import type { WaitClass } from "@hapi/protocol";

/**
 * What woke a session after a post-idle cache rewrite (issue #6164, A1 — R4).
 *
 * Evidence first, first match wins:
 *   1. Transcript markers on the opening prompt — Claude Code's own
 *      `turnOrigin: "task_notification"` / `origin.kind: "task-notification"`,
 *      a `<task-notification>` prompt, or such a notification dequeued from the
 *      prompt queue ≤ 2 s before the prompt → `background_task`;
 *      `<!-- LOOP_CRON_TICK` → `scheduled_tick`; `<!-- pm-relay -->` /
 *      `<!-- peer-session report -->` → `pm_peer`.
 *   2. The server's `messages.content.meta.sentFrom` for programmatic senders:
 *      scheduler / heartbeat / watchdog → `scheduled_tick`; handoff /
 *      auto-recovery / system-notice / self-update → `unknown`.
 *   3. `meta.origin.sessionId` set → `pm_peer` (a session-to-session send).
 *   4. `meta.sentFrom` webapp / telegram-bot → `person`.
 *   5. Otherwise `unknown` — never a default `person`.
 *
 * An intra-turn gap (the model waiting on a tool) is always `tool_wait`.
 */

export interface OpeningEvidence {
  /** The opening prompt's text (classification only — never stored). */
  promptText: string | null;
  /** The prompt entry's `turnOrigin` (newer Claude Code builds). */
  turnOrigin: string | null;
  /** The prompt entry's `origin.kind` (newer Claude Code builds). */
  originKind: string | null;
  /** A `<task-notification>` left the prompt queue ≤ 2 s before the prompt. */
  taskNotificationDequeued: boolean;
}

/** The server-stamped provenance of the delivered message. */
export interface ServerProvenance {
  sentFrom: string | null;
  originSessionId: string | null;
}

const SCHEDULED_SENT_FROM: ReadonlySet<string> = new Set([
  "scheduler",
  "heartbeat",
  "watchdog",
  "pin-deadline", // #6452: an automatic pick fired by a pin's deadline
]);
const UNKNOWN_SENT_FROM: ReadonlySet<string> = new Set([
  "handoff",
  "auto-recovery",
  "system-notice",
  "self-update",
]);
const PERSON_SENT_FROM: ReadonlySet<string> = new Set([
  "webapp",
  "telegram-bot",
]);

export const TASK_NOTIFICATION_MARKER = "<task-notification>";
export const LOOP_CRON_MARKER = "<!-- LOOP_CRON_TICK";
const PM_MARKERS = ["<!-- pm-relay -->", "<!-- peer-session report -->"];

/** The class for a gap inside one turn (waiting on a tool). */
export const INTRA_TURN_CLASS: WaitClass = "tool_wait";

export function classifyOpening(
  evidence: OpeningEvidence,
  server: ServerProvenance | null
): WaitClass {
  const text = evidence.promptText ?? "";
  if (
    evidence.turnOrigin === "task_notification" ||
    evidence.originKind === "task-notification" ||
    text.includes(TASK_NOTIFICATION_MARKER) ||
    evidence.taskNotificationDequeued
  ) {
    return "background_task";
  }
  if (text.includes(LOOP_CRON_MARKER)) return "scheduled_tick";
  if (PM_MARKERS.some(m => text.includes(m))) return "pm_peer";
  if (server) {
    const sentFrom = server.sentFrom;
    if (sentFrom && SCHEDULED_SENT_FROM.has(sentFrom)) return "scheduled_tick";
    if (sentFrom && UNKNOWN_SENT_FROM.has(sentFrom)) return "unknown";
    if (server.originSessionId) return "pm_peer";
    if (sentFrom && PERSON_SENT_FROM.has(sentFrom)) return "person";
  }
  return "unknown";
}
