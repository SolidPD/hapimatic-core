// SPDX-License-Identifier: AGPL-3.0-only
import { unwrapRoleWrappedRecordEnvelope } from "@hapi/protocol/messages";

/**
 * #2026: content classifier for the manual "needs-review" override clear.
 *
 * Returns `true` IFF `content` represents a genuinely new *assistant text answer*
 * the user would want to review. This is the ONE signal the server uses to clear
 * a manual "read" override — replacing the old, over-broad `thinking:true→false`
 * trigger that fired on every SDK `result` (including empty-bounce / autonomous
 * cycles) and every tmux/pty tool-use boundary (see
 * `sessionCache.handleSessionAlive` and the issue-#2026 directive).
 *
 * The function is TOTAL and never throws (it guards every property access via
 * `isObject`), because it runs on the hot `message-received` path over arbitrary
 * persisted message content.
 *
 * The traversal mirrors `server/src/sync/todos.ts`
 * (`unwrapRoleWrappedRecordEnvelope` → role check → classify `record.content` via
 * an `output`→`assistant`→`message.content[]` block walk) on the identical input
 * (`event.message.content` / `msg.content`), so the two stay consistent.
 */

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

/**
 * A Claude SDK `output` assistant record's content blocks, or `null` when the
 * record is not a user-facing answer. Shared by the needs-review classifier and
 * the `hapi_pin` extractor (#6448), so the two apply one set of exclusions.
 */
function claudeAssistantBlocks(
  content: Record<string, unknown>
): unknown[] | null {
  if (content.type !== "output") return null;

  const data = isObject(content.data) ? content.data : null;
  if (!data) return null;

  // A meta / compact-summary / subagent-narration record carries assistant text
  // but is NOT the user-facing answer — excluding it here keeps the #2162
  // meta-chip contract (a synthetic Stop-hook message must not clear "read") and
  // matches web parity (`web/src/chat/normalizeAgent.ts` `isSkippableAgentContent`
  // / the `isMeta` chip marker). These flags ride the raw SDK JSONL line, i.e.
  // `content.data` (`cli/src/api/apiSession.ts`).
  if (
    data.isMeta === true ||
    data.isCompactSummary === true ||
    data.isSidechain === true
  ) {
    return null;
  }

  if (data.type !== "assistant") return null;

  const message = isObject(data.message) ? data.message : null;
  if (!message) return null;

  return Array.isArray(message.content) ? message.content : null;
}

/**
 * Claude SDK `output` assistant record → `true` iff it carries a non-empty
 * visible text block.
 */
function isNewClaudeAssistantText(content: Record<string, unknown>): boolean {
  const blocks = claudeAssistantBlocks(content);
  if (!blocks) return false;

  // Require at least one non-empty text block. An assistant message with only
  // `tool_use` blocks is an intra-turn tool boundary, not a new answer (R1).
  for (const block of blocks) {
    if (!isObject(block)) continue;
    if (block.type !== "text") continue;
    if (typeof block.text === "string" && block.text.trim() !== "") {
      return true;
    }
  }

  return false;
}

/**
 * Codex assistant record → `true` iff it is a non-empty text *message*.
 *
 * Codex assistant text is `data.type === "message"` with a string `data.message`
 * (`web/src/chat/normalizeAgent.ts` codex branch). Codex tool-calls
 * (`data.type === "tool-call"`), reasoning (`data.type === "reasoning"`), plans,
 * and system events are NOT user-facing answers. ACP reuses the same `codex`
 * envelope, so there is no third branch.
 */
function isNewCodexAssistantText(content: Record<string, unknown>): boolean {
  const message = codexAssistantMessage(content);
  return message !== null && message.trim() !== "";
}

/** A Codex/ACP assistant record's message text, or `null` when it is not one. */
function codexAssistantMessage(
  content: Record<string, unknown>
): string | null {
  if (content.type !== "codex") return null;

  const data = isObject(content.data) ? content.data : null;
  if (!data) return null;

  // Subagent narration is not the user-facing answer (same principle as the
  // Claude-path `isSidechain` exclusion). Harmless when the field is absent.
  if (data.isSidechain === true) return null;

  return data.type === "message" && typeof data.message === "string"
    ? data.message
    : null;
}

/** The inner content of an agent/assistant record, or `null` for anything else. */
function assistantRecordContent(
  content: unknown
): Record<string, unknown> | null {
  const record = unwrapRoleWrappedRecordEnvelope(content);
  if (!record) return null;

  // Only assistant/agent records represent a model answer. A user text send has
  // role "user"; `unwrapRoleWrappedRecordEnvelope` returns whatever role the
  // envelope carries.
  if (record.role !== "agent" && record.role !== "assistant") return null;

  if (!isObject(record.content) || typeof record.content.type !== "string") {
    return null;
  }
  return record.content;
}

/**
 * @param content the stored message content — `event.message.content` on a
 *   `message-received` event (equivalently `msg.content`), which is a
 *   role-wrapped `{ role, content, meta }` envelope.
 */
export function isNewUserFacingAssistantContent(content: unknown): boolean {
  const inner = assistantRecordContent(content);
  if (!inner) return false;
  return isNewClaudeAssistantText(inner) || isNewCodexAssistantText(inner);
}

/** One user-facing assistant text unit, as stored. */
export type AssistantText = {
  text: string;
  /**
   * True for a Claude text block, which is always a whole block. False for a
   * `codex`-envelope message, which this record alone cannot place: Codex
   * stores whole messages there, but an ACP agent stores each
   * `agent_message_chunk` as its own record in the same envelope. The fence
   * reader tells them apart by the session's flavor.
   */
  complete: boolean;
};

/**
 * #6448: every non-empty user-facing assistant text in a stored record, for the
 * `hapi_pin` fence reader. The same exclusions as
 * {@link isNewUserFacingAssistantContent}: user records, meta, compact-summary
 * and sidechain records yield nothing. The compact-summary exclusion matters: a
 * summary that repeats a fence would otherwise revise an open pin, or reopen a
 * withdrawn one. Total: never throws.
 */
export function extractUserFacingAssistantTexts(
  content: unknown
): AssistantText[] {
  const inner = assistantRecordContent(content);
  if (!inner) return [];

  const blocks = claudeAssistantBlocks(inner);
  if (blocks) {
    const texts: AssistantText[] = [];
    for (const block of blocks) {
      if (!isObject(block) || block.type !== "text") continue;
      if (typeof block.text === "string" && block.text.trim() !== "") {
        texts.push({ text: block.text, complete: true });
      }
    }
    return texts;
  }

  const message = codexAssistantMessage(inner);
  return message !== null && message.trim() !== ""
    ? [{ text: message, complete: false }]
    : [];
}
