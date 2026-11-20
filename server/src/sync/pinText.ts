// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Text the server writes into its own pins (issue #6455): mirrored prompts and
 * Detected pins quote what an agent or a tool call said, so every such field
 * passes through the same scrub and the same length cap. A title is never cut
 * (#6739, TITLE-D): {@link serverPinTitle} picks it, and only a body is cut
 * ({@link capPinBody}).
 */
import {
  neutralizeApprovalTokens,
  PIN_SERVER_TITLE_MAX_CHARS,
  PIN_TITLE_MAX_CHARS,
  scrubTranscriptSecrets,
  splitPinSentences,
} from "@hapi/protocol";

/** `text` cut to `max` characters, ending in an ellipsis when it was cut. */
export function capPinText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * The one scrubber for every pin field the server writes and for Submit's
 * record and message (`pinSubmission.ts`), #6458 Task 11c (#6530). It is built
 * on `scrubTranscriptSecrets`, because `scrubSecretTokens` alone has no rule
 * for GitHub tokens (`ghp_…`), AWS keys (`AKIA…`) or `CLI_API_TOKEN=` values,
 * which tool calls and prompts quote. Callers scrub before they cap
 * (`capPinText`), so a secret cut by the cap cannot slip past its pattern. The
 * generic `sk-` rule is the one both scrubbers already applied (#4512 tracks
 * its false positives).
 *
 * Approval tokens are neutralized first, because the transcript scrub masks
 * the same acceptor shape as `USER-APPROVAL-[REDACTED]`, which would keep the
 * prefix in the text and leave nothing for the pin wording
 * (`[approval token removed]`) to replace.
 */
export function cleanPinText(text: string): string {
  return scrubTranscriptSecrets(neutralizeApprovalTokens(text));
}

/** A span's filler: as long as the span, with no sentence punctuation. */
const blankSpan = (span: string): string => "x".repeat(span.length);

/**
 * The title-blanking rules: each match in a line is replaced with filler of the
 * same length, so `splitPinSentences` sees no sentence boundary inside it and
 * every position still lines up with the original line.
 */
const TITLE_BLANKS: ReadonlyArray<
  readonly [RegExp, (match: string, ...groups: string[]) => string]
> = [
  // An inline code span, quotes and periods inside it included.
  [/`[^`\n]*`/g, blankSpan],
  // A double-quoted span, straight or curly. The curly opener is excluded
  // inside the span too, so a run of openers stays linear.
  [/"[^"\n]*"/g, blankSpan],
  [/“[^“”\n]*”/g, blankSpan],
  // The period after a bare number ("1.", "2."): a list item, not a sentence
  // end. Only the period is blanked, so the space before it still breaks.
  [/(^|\s)(\d+)\./g, (_match, before, digits) => `${before}${digits}x`],
];

/**
 * The sentences of one line, for a pin title (#6739). The boundary is the
 * classifier's own (`splitPinSentences`, #6738: no break after "e.g.", "i.e.",
 * "vs.", "cf.", "approx.", "Mr.", "Mrs.", "Ms." or "Dr."), with title-only guards
 * on top: inline code spans, double-quoted spans, and the period after a bare
 * number are blanked before the split, so a title keeps "`git commit -m "a. b"`",
 * a quoted question, and "1. Rebase the branch" in one sentence. Each sentence is
 * found again in the blanked line and cut from the original, so the code and the
 * quotes stay as they were written. This module holds no sentence regex of its
 * own. (`Intl.Segmenter` is no option: on Bun 1.4.4 it splits after "e.g.".)
 */
export function titleSentences(line: string): string[] {
  let blanked = line;
  for (const [pattern, fill] of TITLE_BLANKS) {
    blanked = blanked.replace(pattern, fill);
  }
  const sentences: string[] = [];
  let from = 0;
  for (const sentence of splitPinSentences(blanked)) {
    const at = blanked.indexOf(sentence, from);
    if (at < 0) continue;
    sentences.push(line.slice(at, at + sentence.length));
    from = at + sentence.length;
  }
  return sentences;
}

/**
 * Whether a title sentence is a question: it ends in "?", optionally followed by
 * closing quotes, brackets or `*`. A "?" inside a URL ("/x?a=1") is not one.
 */
export function isQuestionSentence(sentence: string): boolean {
  return /\?["'”’)*]*$/.test(sentence.trim());
}

/**
 * The title the server writes into its own pin (#6739, TITLE-D: an expanded pin
 * shows its whole title, never cut). `clean` must already be scrubbed with
 * {@link cleanPinText}, because the title is measured and shortened here: a scrub
 * after it could lengthen it past the limit or leave part of a secret.
 *
 * Whitespace is collapsed to single spaces. A text that fits
 * {@link PIN_TITLE_MAX_CHARS} is returned whole, its period included. A longer
 * `"prose"` text (an ask, a question) becomes one complete sentence of it: its
 * last question sentence that fits 200, else its first sentence when that fits
 * 200, else that first sentence whole; the sentence drops one final period,
 * because a title is a standalone phrase. A `"quote"` (a command line, a path, a
 * terminal or MCP message) is kept whole. A pick of at most
 * {@link PIN_SERVER_TITLE_MAX_CHARS} is returned; past it, `null`, and the writer
 * stores its fixed label with the whole text in the pin's body (ruling RV-1).
 * Nothing here cuts a title.
 */
export function serverPinTitle(
  clean: string,
  source: "prose" | "quote"
): string | null {
  const text = clean.replace(/\s+/g, " ").trim();
  if (text.length <= PIN_TITLE_MAX_CHARS) return text;
  let pick = text;
  if (source === "prose") {
    const sentences = titleSentences(text);
    const fits = (s: string): boolean => s.length <= PIN_TITLE_MAX_CHARS;
    const question = sentences.filter(isQuestionSentence).filter(fits).at(-1);
    pick = question ?? sentences[0] ?? text;
    if (/[^.]\.$/.test(pick)) pick = pick.slice(0, -1);
  }
  return pick.length <= PIN_SERVER_TITLE_MAX_CHARS ? pick : null;
}

/**
 * A pin's body text (a context or a plain text, never a title) cut to `max`
 * characters at a word and marked "…" (#6739, R7). The cut never leaves half of
 * a surrogate pair. A title is never cut: past its limit the writer stores its
 * fixed label instead ({@link serverPinTitle}).
 */
export function capPinBody(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, Math.max(0, max - 1));
  if (!/\s/.test(text[cut.length] ?? "")) {
    const space = cut.search(/\s\S*$/);
    if (space > 0) cut = cut.slice(0, space);
  }
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

/**
 * The longest cut of `body` (by {@link capPinBody}, at most `max` characters)
 * for which `build` returns a pin, with whether it was cut; null when even the
 * shortest cut is refused. `build` returns null for a pin its schema refuses: the
 * 32 KiB content limit counts the bytes of the whole pin, so the fit is found by
 * parsing, not by counting characters.
 */
export function fitPinBody<T>(
  body: string,
  max: number,
  build: (body: string) => T | null
): { pin: T; cut: boolean } | null {
  if (body.length <= max) {
    const whole = build(body);
    if (whole !== null) return { pin: whole, cut: false };
  }
  let lo = 1;
  let hi = Math.min(body.length - 1, max);
  let best: T | null = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const pin = build(capPinBody(body, mid));
    if (pin !== null) {
      best = pin;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best === null ? null : { pin: best, cut: true };
}
