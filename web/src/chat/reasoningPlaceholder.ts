// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Shared sentinel for the "reasoning hidden by Claude" affordance (#3147, #3156).
 *
 * Claude extended-thinking TEXT is withheld by the Anthropic subscription/OAuth
 * stream-json path — thinking blocks arrive as signature-only stubs
 * (`{thinking:"", signature:"…"}`). `normalizeAgent` substitutes this fixed
 * placeholder so the unified reasoning category still renders (instead of an empty
 * section). It is app-generated, NOT model content — so the collapsed reasoning
 * preview can render it as a single compacted line (#3156 R5-1), while REAL
 * reasoning (Codex thinking) keeps its multi-line preview.
 *
 * Exported as a single source of truth so `normalizeAgent` (the producer) and
 * `ReasoningGroup` (the consumer) agree on the exact string without duplicating
 * it. Identity is by value — `ReasoningGroup` matches this constant to decide the
 * one-line compact treatment.
 */
export const REASONING_HIDDEN_BY_CLAUDE =
  "_Reasoning hidden by Claude — thinking text is not exposed on this streaming path (only an encrypted signature is returned)._";

/**
 * #4046: the sentinel's plain-text form for the collapsed preview, which renders
 * raw text, not markdown. Derived from the sentinel (drops the wrapping `_…_`
 * emphasis) so the two strings cannot drift.
 */
export const REASONING_HIDDEN_BY_CLAUDE_PREVIEW =
  REASONING_HIDDEN_BY_CLAUDE.slice(1, -1);

/**
 * True when a reasoning part's text is the app-generated hidden-by-Claude
 * placeholder (vs real model reasoning text). Tolerant of `undefined`/`null` so
 * callers can pass a possibly-absent `part.text` directly.
 */
export function isHiddenReasoningText(
  text: string | undefined | null
): boolean {
  return text === REASONING_HIDDEN_BY_CLAUDE;
}

/**
 * #3177: the in-thread ACTIVITY placeholder — a synthetic reasoning block appended
 * at the thread tail whenever the user is waiting (send-time optimistic, or a
 * running turn whose tail is quiet). It is app-generated, NOT model content, and
 * is independent of every chat-section preference (R6).
 *
 * `THINKING_PLACEHOLDER_ID` is the one stable block id shared by the producer
 * (`useThinkingPlaceholder`) and `reconcileChatBlocks`, so the placeholder keeps
 * its identity across renders while it lives.
 *
 * The part TEXT carries the label behind a fixed prefix, because `ReasoningGroup`
 * sees assistant-ui PARTS, not ChatBlocks — the prefix identifies the placeholder
 * and the remainder is the label to render ("thinking…", "working…", …).
 */
export const THINKING_PLACEHOLDER_ID = "synthetic-thinking-placeholder";

// U+2060 (word joiner) makes the prefix impossible to type as model output.
export const THINKING_PLACEHOLDER_PREFIX = "\u2060hapi-activity:";

/** Builds the placeholder part text for a given label. */
export function thinkingPlaceholderText(label: string): string {
  return `${THINKING_PLACEHOLDER_PREFIX}${label}`;
}

/** True when a reasoning part's text is the #3177 activity placeholder. */
export function isThinkingPlaceholderText(
  text: string | undefined | null
): boolean {
  return (
    typeof text === "string" && text.startsWith(THINKING_PLACEHOLDER_PREFIX)
  );
}

/** The label a placeholder part should render ("" for non-placeholder text). */
export function thinkingPlaceholderLabel(
  text: string | undefined | null
): string {
  return isThinkingPlaceholderText(text)
    ? (text as string).slice(THINKING_PLACEHOLDER_PREFIX.length)
    : "";
}

/** True when an assistant-ui message part is the #3177 activity placeholder. */
export function isThinkingPlaceholderPart(
  part: { type?: string; text?: string } | undefined
): boolean {
  return part?.type === "reasoning" && isThinkingPlaceholderText(part.text);
}
