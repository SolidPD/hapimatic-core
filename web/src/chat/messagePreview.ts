// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Markdown-safe first-line preview for a collapsed chat section (#2990, S3, R5).
 *
 * When a Claude response or user message is manually collapsed, its body is
 * replaced by a one-row preview so a thread of collapsed sections still reads as
 * an outline of the conversation. That preview is rendered as PLAIN TEXT (never
 * through a markdown renderer), so this helper strips the common inline/block
 * markdown constructs first — otherwise a first line like `## Heading` or
 * `**bold**` would leak literal `#`/`*` tokens (the "broken half-rendered
 * markdown" R5 forbids).
 *
 * Pure + exhaustively unit-tested; both message renderers share this one
 * implementation (KD1) so the preview derivation cannot drift between them.
 * House style: a pure, colocated-tested policy function (cf. `presentation.ts`).
 */

/**
 * Strip common markdown constructs from a SINGLE line, leaving readable plain
 * text. Order matters: block markers (heading/quote/list) are removed from the
 * line start first, then inline constructs (images/links/code/emphasis), then
 * any stray leftover marker characters.
 */
function stripMarkdownLine(line: string): string {
  let s = line;
  // Fenced-code delimiter line (```lang) → drop entirely; the caller filters the
  // resulting empty line out, so a code block's fence never becomes the preview.
  s = s.replace(/^\s*```.*$/, "");
  // ATX heading markers: leading #'s + the space after them.
  s = s.replace(/^\s{0,3}#{1,6}\s+/, "");
  // Blockquote marker.
  s = s.replace(/^\s{0,3}>\s?/, "");
  // Unordered (-, *, +) or ordered (1. / 1)) list marker.
  s = s.replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/, "");
  // Images: keep the alt text. Run before links (same bracket shape).
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Inline links: keep the link text, drop the target.
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Inline code spans: keep the code, drop the backticks.
  s = s.replace(/`([^`]+)`/g, "$1");
  // Bold / bold-italic (** or __) then italic (* or _) — keep the inner text.
  s = s.replace(/(\*\*|__)(.*?)\1/g, "$2");
  s = s.replace(/(\*|_)(.*?)\1/g, "$2");
  // Strikethrough.
  s = s.replace(/~~(.*?)~~/g, "$1");
  // Any leftover unpaired emphasis / code / strikethrough markers.
  s = s.replace(/[`*_~]/g, "");
  return s;
}

/**
 * Derive a plain-text preview of a message's first `maxLines` non-empty line(s).
 *
 * - Strips markdown so the preview is clean plain text (R5).
 * - Skips blank/whitespace-only lines so the preview starts at real content.
 * - Joins the taken lines with a single space and appends an ellipsis when more
 *   non-empty content follows (so the row signals "there is more below").
 * - Returns `""` for empty/whitespace-only/markdown-only input; the caller
 *   substitutes its own fallback (e.g. an attachment count).
 *
 * Visual overflow of a long single line is handled by the row's CSS `truncate`;
 * this helper only guarantees the text is plain and starts at real content.
 */
export function messagePreview(text: string, maxLines = 1): string {
  if (!text) return "";
  const limit = Math.max(1, Math.floor(maxLines));
  const nonEmpty = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map(line => stripMarkdownLine(line).trim())
    .filter(line => line.length > 0);
  if (nonEmpty.length === 0) return "";
  const taken = nonEmpty.slice(0, limit);
  const preview = taken.join(" ");
  return nonEmpty.length > taken.length ? `${preview}…` : preview;
}
