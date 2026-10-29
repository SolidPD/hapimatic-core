// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Parse the parent's ranked report (#4469 Task 5, R5): the review prompt asks
 * the parent to end its reply with
 *   { "ranking": [{ "id", "rank", "testExitCode"?, "summary" }] }
 * in a fenced json block. Only the parent's reply to its NEWEST review
 * request is read, and its newest ranking-shaped block decides: when it
 * cannot be read the view says so, and never shows an older ranking as
 * current. A json block that is not a ranking (no `ranking` key) is skipped,
 * so a later parent turn without a ranking does not hide one.
 * Hand-written guards: the web package has no schema library.
 */
import type { DecryptedMessage } from "@/types/api";
import { agentTextBlocksAfter } from "./peerReply";
import { REVIEW_PROMPT_MARKER } from "./reviewPrompt";

export type RankedEntry = {
  id: string;
  rank: number;
  testExitCode?: number;
  summary: string;
};

export type RankedReport = {
  entries: RankedEntry[];
  /** The agent-text block the ranking came from. */
  blockId: string;
};

/** What the parent's newest ranking-shaped block says. */
export type RankedReading =
  | { kind: "none" }
  | { kind: "ranked"; report: RankedReport }
  | {
      kind: "unreadable";
      /** Why it could not be read, for the view. */
      reason: string;
      blockId: string;
    };

/** A fence's opening line: its backticks and its info string. */
const FENCE_OPEN = /^(`{3,})([^`]*)$/;

/** Fences that can hold the ranking: json, its dialects, or no language. */
const JSON_FENCE_LANGUAGES = new Set(["", "json", "jsonc", "json5"]);

export type JsonBlock = {
  body: string;
  /** False for a fence still open when the text ends (a cut-off reply). */
  closed: boolean;
  /** The fence names json, jsonc or json5 (not an untagged fence). */
  tagged: boolean;
};

/**
 * The json-capable fenced blocks in `text`, in order. Fences in other
 * languages are stepped over, so their closing line never opens a block.
 */
export function jsonBlocks(text: string): JsonBlock[] {
  const blocks: JsonBlock[] = [];
  let fence: string | null = null;
  let collect = false;
  let tagged = false;
  let body: string[] = [];
  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    if (fence === null) {
      const open = FENCE_OPEN.exec(trimmed);
      if (open) {
        fence = open[1] ?? "```";
        const language = (open[2] ?? "").trim().split(/\s+/)[0] ?? "";
        collect = JSON_FENCE_LANGUAGES.has(language.toLowerCase());
        tagged = language !== "";
        body = [];
      }
      continue;
    }
    if (trimmed.length >= fence.length && /^`+$/.test(trimmed)) {
      if (collect) {
        blocks.push({ body: body.join("\n"), closed: true, tagged });
      }
      fence = null;
      continue;
    }
    body.push(raw);
  }
  if (fence !== null && collect) {
    blocks.push({ body: body.join("\n"), closed: false, tagged });
  }
  return blocks;
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

/** A peer id as the view quotes it: bounded, so a long id cannot flood it. */
function quoteId(id: string): string {
  return JSON.stringify(id.length > 40 ? `${id.slice(0, 40)}…` : id);
}

/**
 * Validate a parsed ranking against the peers that were reviewed: the
 * entries, or the reason the ranking cannot be used. A `testExitCode` that is
 * not a whole number is dropped (not reported) rather than failing the rank.
 */
export function toRankedEntries(
  value: unknown,
  reviewedIds: ReadonlySet<string>
): { entries: RankedEntry[] } | { reason: string } {
  if (typeof value !== "object" || value === null) {
    return { reason: "it is not a JSON object" };
  }
  const ranking = (value as { ranking?: unknown }).ranking;
  if (!Array.isArray(ranking)) {
    return { reason: '"ranking" is not a list' };
  }
  if (ranking.length === 0) return { reason: "the ranking is empty" };
  const entries: RankedEntry[] = [];
  const seen = new Set<string>();
  for (const [index, item] of ranking.entries()) {
    const at = `entry ${index + 1}`;
    if (typeof item !== "object" || item === null) {
      return { reason: `${at} is not an object` };
    }
    const { id, rank, testExitCode, summary } = item as Record<string, unknown>;
    if (typeof id !== "string") return { reason: `${at} has no peer id` };
    if (!reviewedIds.has(id)) {
      return { reason: `${at} names an unknown peer ${quoteId(id)}` };
    }
    if (seen.has(id)) {
      return { reason: `${at} ranks peer ${quoteId(id)} a second time` };
    }
    seen.add(id);
    if (!isInteger(rank) || rank < 1) {
      return { reason: `${at} has no whole-number rank of 1 or more` };
    }
    if (typeof summary !== "string") return { reason: `${at} has no summary` };
    entries.push(
      isInteger(testExitCode)
        ? { id, rank, testExitCode, summary }
        : { id, rank, summary }
    );
  }
  return { entries };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A json block meant as a ranking: `{ value }` to validate, or `{ reason }`
 * when it is a ranking that cannot be read — cut off, not JSON, or a bare
 * list of entries. Null for any other block (no `ranking` in it). An
 * untagged fence counts only when it looks like JSON, so plain text that
 * mentions a ranking (a `git log` line, say) never hides a valid one.
 */
function rankingShaped(
  block: JsonBlock
): { value: unknown } | { reason: string } | null {
  const looksLikeJson =
    block.tagged ||
    /^\s*[[{]/.test(block.body) ||
    block.body.includes('"ranking"');
  const mentionsRanking = looksLikeJson && /\branking\b/i.test(block.body);
  if (!block.closed) {
    return mentionsRanking ? { reason: "its JSON block is cut off" } : null;
  }
  let value: unknown;
  try {
    value = JSON.parse(block.body);
  } catch {
    return mentionsRanking ? { reason: "its JSON does not parse" } : null;
  }
  if (Array.isArray(value)) {
    return value.some(item => isObject(item) && "rank" in item)
      ? { reason: 'it is a bare list, not { "ranking": [...] }' }
      : null;
  }
  return isObject(value) && "ranking" in value ? { value } : null;
}

/** The review prompt's first line marks the start of a review request. */
function isReviewRequest(userText: string): boolean {
  return userText.trimStart().startsWith(REVIEW_PROMPT_MARKER);
}

/**
 * The parent's newest ranking-shaped block since its newest review request,
 * read: `ranked`, `unreadable` (with the reason), or `none` when the parent
 * has not ranked since. With no review request in `messages` (it scrolled
 * out of the window), every reply is searched. `reviewedIds` are the peers
 * the view knows; a ranking naming any other id is unreadable.
 */
export function parseRankedReport(
  messages: readonly DecryptedMessage[],
  reviewedIds: Iterable<string>
): RankedReading {
  const ids = new Set(reviewedIds);
  const blocks = agentTextBlocksAfter(messages, isReviewRequest);
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (!block) continue;
    const candidates = jsonBlocks(block.text);
    for (let j = candidates.length - 1; j >= 0; j -= 1) {
      const candidate = candidates[j];
      const shaped = candidate ? rankingShaped(candidate) : null;
      if (!shaped) continue;
      if ("reason" in shaped) {
        return { kind: "unreadable", reason: shaped.reason, blockId: block.id };
      }
      const result = toRankedEntries(shaped.value, ids);
      return "entries" in result
        ? {
            kind: "ranked",
            report: { entries: result.entries, blockId: block.id },
          }
        : { kind: "unreadable", reason: result.reason, blockId: block.id };
    }
  }
  return { kind: "none" };
}
