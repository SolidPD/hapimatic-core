// SPDX-License-Identifier: AGPL-3.0-only

/**
 * #5195 — the code points the import review must never render raw.
 *
 * An imported value (a hook command, an MCP command or arg, an executable
 * setting, a script preview) is text the commit writes and Claude Code later
 * runs. An invisible or direction-changing code point in that text makes the
 * review read differently from what runs: U+202E reverses the characters that
 * follow it (Trojan Source, CVE-2021-42574), U+200B hides a word boundary, and
 * U+00A0 looks like a space that a shell does not split on. The review renders
 * each such code point as a visible `U+XXXX` token instead.
 *
 * A "hidden" code point is any code point in Cc (controls), Cf (format), Cs (a
 * lone surrogate), Zl / Zp (line and paragraph separators), the
 * Default_Ignorable_Code_Point and Bidi_Control properties, or Zs other than
 * U+0020 SPACE. The set is deliberately broad for a review of executable
 * values: a variation selector or zero width joiner inside an emoji is also
 * tokenized, because visibility outweighs prettiness here.
 *
 * Out of scope: homoglyphs (a Cyrillic letter that looks like a Latin one).
 * Ordinary non-ASCII text, such as accented Latin, CJK, or an emoji base
 * character, is shown as itself.
 *
 * Multi-line text (a script preview, a pretty-printed JSON value) passes
 * `multiline`: there a line feed and a tab are layout the reader sees, so they
 * render as themselves. Everywhere else, such as a single-line command, a line
 * feed is a hidden second line and is tokenized. A carriage return is
 * tokenized either way (a CRLF script fails on Linux).
 *
 * This file is the single source of the set. It writes every hidden code point
 * as an escape, never as a literal character.
 */

const HIDDEN =
  /^(?:[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\p{Bidi_Control}]|(?! )\p{Zs})$/u;

/** Unicode names for the commonest hidden code points, used as a token's title. */
const NAMES: Readonly<Record<string, string>> = {
  "U+0009": "CHARACTER TABULATION",
  "U+000A": "LINE FEED",
  "U+000D": "CARRIAGE RETURN",
  "U+00A0": "NO-BREAK SPACE",
  "U+00AD": "SOFT HYPHEN",
  "U+061C": "ARABIC LETTER MARK",
  "U+200B": "ZERO WIDTH SPACE",
  "U+200C": "ZERO WIDTH NON-JOINER",
  "U+200D": "ZERO WIDTH JOINER",
  "U+200E": "LEFT-TO-RIGHT MARK",
  "U+200F": "RIGHT-TO-LEFT MARK",
  "U+202A": "LEFT-TO-RIGHT EMBEDDING",
  "U+202B": "RIGHT-TO-LEFT EMBEDDING",
  "U+202C": "POP DIRECTIONAL FORMATTING",
  "U+202D": "LEFT-TO-RIGHT OVERRIDE",
  "U+202E": "RIGHT-TO-LEFT OVERRIDE",
  "U+2060": "WORD JOINER",
  "U+2066": "LEFT-TO-RIGHT ISOLATE",
  "U+2067": "RIGHT-TO-LEFT ISOLATE",
  "U+2068": "FIRST STRONG ISOLATE",
  "U+2069": "POP DIRECTIONAL ISOLATE",
  "U+FEFF": "ZERO WIDTH NO-BREAK SPACE",
};

/** Line feed and tab: layout, not hidden, in multi-line text. */
const LAYOUT: ReadonlySet<string> = new Set([
  String.fromCharCode(10),
  String.fromCharCode(9),
]);

export interface HiddenCharsOptions {
  /** Treat line feed and tab as layout (see the header). */
  multiline?: boolean;
}

const hiddenIn = (ch: string, opts: HiddenCharsOptions | undefined): boolean =>
  !(opts?.multiline && LAYOUT.has(ch)) && isHiddenCodePoint(ch);

export type TextSegment =
  | { kind: "text"; text: string }
  | { kind: "hidden"; label: string; name?: string };

/** Whether one code point is hidden (see the header for the set). */
export function isHiddenCodePoint(ch: string): boolean {
  return HIDDEN.test(ch);
}

/** A code point written as `U+XXXX`, at least four hex digits (`U+E0041`). */
export function codePointLabel(ch: string): string {
  const cp = ch.codePointAt(0) ?? 0;
  return `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
}

/**
 * Splits a string into runs of visible text and one segment per hidden code
 * point. Iterates by code point, so a supplementary character is one segment
 * and a lone surrogate is one hidden segment.
 */
export function splitHiddenChars(
  s: string,
  opts?: HiddenCharsOptions
): TextSegment[] {
  const out: TextSegment[] = [];
  let run = "";
  for (const ch of s) {
    if (!hiddenIn(ch, opts)) {
      run += ch;
      continue;
    }
    if (run !== "") {
      out.push({ kind: "text", text: run });
      run = "";
    }
    const label = codePointLabel(ch);
    const name = NAMES[label];
    out.push(
      name === undefined
        ? { kind: "hidden", label }
        : { kind: "hidden", label, name }
    );
  }
  if (run !== "") out.push({ kind: "text", text: run });
  return out;
}

/** Whether a string contains any hidden code point. */
export function hasHiddenChars(s: string, opts?: HiddenCharsOptions): boolean {
  for (const ch of s) if (hiddenIn(ch, opts)) return true;
  return false;
}
