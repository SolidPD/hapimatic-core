// SPDX-License-Identifier: AGPL-3.0-only
// One or more HTML comments at the very start of the text, each occupying whole
// lines, plus the blank lines around them:
// - `(?:(?!-->)[\s\S])*` keeps a comment body from spanning `-->`, so the text
//   between two comments on one line ("<!-- a --> visible <!-- b -->") is never
//   swallowed — that line simply does not match.
// - Only whole comment lines and blank lines are consumed, so the first content
//   line keeps its indentation (an indented code block stays a code block).
const LEADING_COMMENTS =
  /^(?:[ \t]*\r?\n)*(?:[ \t]*<!--(?:(?!-->)[\s\S])*-->[ \t]*(?:\r?\n|$)(?:[ \t]*\r?\n)*)+/;

/**
 * Display text for a user turn that begins with machine-marker HTML comments
 * (e.g. the PM relay marker `<!-- pm-relay -->` on its own first line):
 * returns the text after them, or `null` when the turn does not begin with a
 * whole-line comment — or is nothing but comments — so the caller renders it
 * verbatim.
 *
 * Leading-only on purpose: a comment the user quotes mid-text is content, not
 * a marker. And not `skipHtml` / a markdown plugin: that would also drop the
 * inline HTML CommonMark sees in ordinary prose (e.g. `Array<string>`).
 * Display-only — the stored and indexed text stays verbatim.
 */
export function stripLeadingHtmlComments(text: string): string | null {
  const match = text.match(LEADING_COMMENTS);
  if (!match) return null;
  const rest = text.slice(match[0].length);
  return rest.trim() === "" ? null : rest;
}

// Friendly names for the machine markers the orchestration tooling emits, keyed
// by the marker's first token, lowercased: loop-cron's tick marker, the PM relay
// and the peer-session status report.
const MARKER_LABELS: Record<string, string> = {
  loop_cron_tick: "Loop tick",
  "pm-relay": "PM relay",
  "peer-session": "Peer report",
};

export type LeadingHtmlCommentMarker = {
  /** Short name shown in place of the stripped marker. */
  label: string;
  /** The first stripped comment, verbatim (e.g. with the loop id). */
  raw: string;
};

/**
 * The label for the marker that `stripLeadingHtmlComments` would strip, or
 * `null` exactly when it strips nothing, so a label is never shown for text
 * that renders verbatim. Known markers get a friendly name; any other comment
 * is labeled with its first token, or "Note" when it has none.
 */
export function leadingHtmlCommentMarker(
  text: string
): LeadingHtmlCommentMarker | null {
  if (stripLeadingHtmlComments(text) === null) return null;
  // The first comment in the text is the leading one: the strip matched, so
  // only whitespace can precede it.
  const raw = text.match(/<!--(?:(?!-->)[\s\S])*-->/)?.[0] ?? "";
  const token = raw.match(/^<!--\s*([A-Za-z][\w-]*)/)?.[1];
  const label = token ? (MARKER_LABELS[token.toLowerCase()] ?? token) : "Note";
  return { label, raw };
}
