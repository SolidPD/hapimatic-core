// SPDX-License-Identifier: AGPL-3.0-only
// Decision signals: does an assistant message ask the operator to decide or do
// something? (issue #6455, epic #6446; design: docs/design/pins/design-brief.md
// "Missed decisions", F1 and D3). Hapimatic's Stop hook reads the final message
// with it before a Claude Code turn ends, and the turn-end detector (#6456)
// will run the same rules on stored messages, so the two defenses agree on what
// an ask is.
//
// ## Tuned for recall
// A false alarm costs the operator one tap; a miss costs a decision. So
// `ambiguous` (a trailing question, an option list, "let me know") still counts
// as a signal for the nudge, and only a plain report is `none`. The rules were
// calibrated on 10,837 real end-of-turn messages (#6455 research): they catch
// answer keys, "Needs from you" lists, mid-paragraph questions and consent offers
// ("If you approve the write, I can …"), and skip "Needs from you: nothing new".
// Rules version 2 (#6527) was measured on a further 2,695 messages: it reads an
// option list only from the message's last list run, and drops a weak ask when
// the message says nothing is asked.
//
// ## Bounded and linear
// The Stop hook runs this in the session wrapper, which also sends the 2 s
// keepalive, and Bun's regex engine backtracks: a naive `^(\w+\s?)+\?$` took over
// a second on 30 characters. So only the last 16 KiB is read, as at most 400
// lines, each sentence at most 400 characters; every pattern is a fixed phrase or
// a single bounded run, and signals are combined in code, never in one regex.
// When the text is longer than what is read, the lines before it are scanned
// only for the fence and note-block state at the cut, one anchored test a line.
//
// ## What is not read
// Fenced code blocks (an agent showing a format), blockquotes (quoted text), inline
// code, double-quoted spans (a pin's title, a hook's words: someone else's text),
// the Explanatory output style's note blocks, the pin count line, and every line
// carrying an approval token or the `USER-APPROVAL REQUIRED` heading: an approval
// token is a native control the operator pastes, never a pin, and its block alone
// is not an ask. Excerpts still show the message's own text, inline code and
// quotes kept. Pure and dependency-free, like pinFence.ts.

/** Only the end of a message is read; asks sit at the end. */
export const DECISION_SIGNAL_MAX_CHARS = 16 * 1024;
/** Lines read from that tail, at most. */
export const DECISION_SIGNAL_MAX_LINES = 400;
/** A longer sentence keeps its first and last half of this. */
export const DECISION_SIGNAL_MAX_UNIT_CHARS = 400;
/** The excerpt kept for a heading-led ask (an answer key, a needs list). */
export const DECISION_EXCERPT_BLOCK_CHARS = 1200;
/** The excerpt kept for a sentence-level ask. */
export const DECISION_EXCERPT_SENTENCE_CHARS = 600;
/** A long weak ask keeps the first this-many characters of its first line. */
export const DECISION_EXCERPT_HEAD_CHARS = 300;
/** `askTexts` keeps the last this-many strong asks. */
export const DECISION_ASK_TEXTS_MAX = 8;
/**
 * The rules' version: #6455's were 1, #6527's are 2. The turn-end detector
 * (#6456) records it; the turn-end route's answer does not carry it.
 */
export const DECISION_SIGNAL_RULES_VERSION = 2;
/**
 * The pin count line Hapimatic's primer asks agents to write (#6458),
 * "📌 N open (M new: <titles>)", also after a list marker, in bold or backticks,
 * or with the emoji's variation selector. It points at pins; it is not an ask.
 */
export const PIN_COUNT_LINE_PATTERN =
  /^ {0,3}(?:[-*+][ \t]+)?(?:\*\*|`)?\u{1F4CC}\uFE0F?[ \t]{0,3}(?:\*\*)?\d{1,4}(?:\*\*)? open\b/u;

export type DecisionVerdict = "decision" | "ambiguous" | "none";

export type DecisionSignal =
  | "answer_key"
  | "needs_from_you"
  | "needs_your"
  | "ask_question"
  | "consent_offer"
  | "ask_statement"
  | "trailing_question"
  | "option_list";

export type DecisionSignals = {
  verdict: DecisionVerdict;
  /** Every kind found, strongest first (`SIGNAL_ORDER`). */
  signals: DecisionSignal[];
  /** The ask, as the operator would read it (raw text); empty for `none`. */
  excerpt: string;
  /**
   * `normalizeForMatch` of the strongest ask's own text: its sentence, its line
   * (`needs_your`), its block (answer key, needs list), or for `ambiguous` the
   * uncut ask tail. Not the excerpt, which may hold the sentence before it.
   */
  matchText: string;
  /**
   * For `decision`: each strong ask's own text, normalized as `matchText` is,
   * the last `DECISION_ASK_TEXTS_MAX` in message order. Empty otherwise.
   */
  askTexts: readonly string[];
  /** True when the message held more strong asks than `askTexts` keeps. */
  askTextsCut: boolean;
  /**
   * The raw text of the last sentence that ends with `?` within the strongest
   * ask's own text (for `ambiguous`, within the uncut ask tail); null when none.
   * Read from the match text, so a `?` in a quote, a code span or a URL is not one.
   */
  question: string | null;
};

/** A fence line's start, as pinFence.ts reads it; nothing follows the run. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const BLOCKQUOTE = /^ {0,3}>/;
const HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const APPROVAL_TOKEN = /USER-APPROVAL-[A-Z2-9]{4}-[A-Z2-9]{4}/;
const APPROVAL_HEADING = /USER-APPROVAL REQUIRED/;
const INLINE_CODE = /`[^`\n]{0,400}`/g;
/** Someone else's words (a pin title, a hook's reason, a prompt), not the agent's ask. */
const QUOTED = /"[^"\n]{0,300}"|\u201c[^\u201d\n]{0,300}\u201d/g;
/** The Explanatory output style's note block: an opener line, then a rule line closes it. */
const NOTE_OPEN = /^ {0,3}`?\u2605 Insight\b/;
const NOTE_CLOSE = /^ {0,3}`?\u2500{10,}`?[ \t]{0,8}$/;
/** How far a note opener looks for its closer, and a cut slice for a closer. */
const NOTE_MAX_LINES = 40;
const HEADING_OR_BOLD = /^ {0,3}(?:#{1,6}[ \t]|\*\*)/;
const NEEDS_FROM_YOU =
  /\b(?:needs? from you|what i need from you|decisions? (?:for|from) you|yours to (?:rule|decide|pick|choose|answer))\b/gi;
const NOTHING_NEEDED = /^[:\-—–\s]*(?:nothing|none|no new|no further|n\/a)\b/i;
/** "Nothing is …", "No decision for you": the phrase reports that nothing is asked. */
const NOTHING_BEFORE = /\b(?:nothing|no|none)\b[^.?!]{0,40}$/i;
/** The agent says outright that nothing is asked: a weak ask before it is then not one. */
const NOTHING_ASKED =
  /\b(?:nothing (?:needs|is needed from|is waiting on|for) you|(?:needs?|what i need) from you[:\s*]{0,8}(?:nothing|none|n\/a)\b|no (?:decision|action|answer) (?:is )?needed from you)/i;
const NEEDS_YOUR =
  /\bneeds? your (?:answers?|decisions?|go|approval|reply|input|call|rulings?|two messages|messages|picks?|choice|word|sign-off)\b/gi;
/** "needs your D1 or D2": an option id, case-sensitive so "needs your go2" is not one. */
const NEEDS_YOUR_ID = /\b[Nn]eeds? your [A-Z]{1,3}\d{1,2}\b/g;
/** At most this many matches of one phrase are read on a line. */
const MATCHES_PER_LINE = 8;
const ASK_PHRASE =
  /\b(?:should i|shall i|do you want|would you like|want me to|ok to|okay to|okay with|ok with|go ahead|proceed|which (?:option|one|of these|would you|do you)|can you confirm|is (?:that|this|it) ok|approve)\b/i;
const CONSENT_IF =
  /\bif you (?:approve|want|would like|'d like|prefer|agree|confirm)\b/i;
const CONSENT_ACT = /\bI(?:'ll| will| can| could)\b/;
/** Weak asks. "your choice" is weak: "per your choice, I …" reports a past one. */
const ASK_STATEMENT =
  /\b(?:let me know|please confirm|reply with|your call|your choice|tell me (?:which|whether|if))\b|\breply (?:with )?""/i;
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,2}[.)]|[A-Z]\d?[.)])[ \t]+\S/;
const INDENTED = /^[ \t]{2,}\S/;
const OPTION_WORD =
  /\b(?:options?|choices?|choose|pick|recommend(?:s|ed|ation)?)\b/i;
/** An item that labels itself an option: "- **Option 2:** …", "1. A1 (recommended): …". */
const OPTION_ITEM =
  /^ {0,3}(?:[-*+]|\d{1,2}[.)]|[A-Z]\d?[.)])[ \t]+(?:\*\*)?(?:[Oo]ptions? (?:[A-Z]|\d{1,2})\b|[^\n]{0,80}\((?:[Rr]ecommended|[Mm]y [Rr]ecommendation)\))/;
/** The lead-in and trailer searches look at this many non-blank lines. */
const LIST_PROSE_LOOK = 3;
const SENTENCE_BREAK = /(?<=[.?!])\s+/g;

/** Strongest first: the excerpt comes from the strongest kind, the latest one. */
const SIGNAL_ORDER: readonly DecisionSignal[] = [
  "answer_key",
  "needs_from_you",
  "needs_your",
  "ask_question",
  "consent_offer",
  "ask_statement",
  "trailing_question",
  "option_list",
];

/** A blanked span: `[at, end)` in the match text, `[rawAt, rawEnd)` in the raw line. */
type Span = { at: number; end: number; rawAt: number; rawEnd: number };
/** A kept line: `text` is the match text, `raw` the line as written. */
type Line = { text: string; raw: string; index: number; spans: Span[] };
/** A sentence of a line's match text: `[start, end)` in `text`, `unit` capped for matching. */
type Sentence = { start: number; end: number; unit: string };
type Hit = {
  signal: DecisionSignal;
  line: number;
  sentence?: Sentence;
  /** The raw sentence, for sentence-level hits. */
  raw?: string;
};

function rank(hit: Hit): number {
  return SIGNAL_ORDER.indexOf(hit.signal);
}

/** Lowercase, drop emphasis and backticks, collapse whitespace. Keeps `_ - : .`, which keys use. */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/\*\*|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** `text` with each `pattern` match replaced by `mark`, and the replaced spans. */
function blankSpans(
  text: string,
  pattern: RegExp,
  mark: string
): { text: string; spans: Span[] } {
  const spans: Span[] = [];
  let out = "";
  let from = 0;
  for (const match of text.matchAll(pattern)) {
    out += text.slice(from, match.index);
    spans.push({
      at: out.length,
      end: out.length + mark.length,
      rawAt: match.index,
      rawEnd: match.index + match[0].length,
    });
    out += mark;
    from = match.index + match[0].length;
  }
  return { text: out + text.slice(from), spans };
}

/**
 * A match-text position mapped to its source position through the blanked
 * spans, which are in order with unchanged text between them: past a span a
 * position moves by that span's `rawEnd - end`, so one binary search finds it.
 */
function sourceAt(spans: readonly Span[], pos: number): number {
  let lo = 0;
  let hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (spans[mid]!.end <= pos) lo = mid + 1;
    else hi = mid;
  }
  const last = spans[lo - 1];
  return last ? pos + last.rawEnd - last.end : pos;
}

/**
 * The match text of a raw line: inline code becomes "``", then quoted spans
 * become `""`, so a "." inside a quoted title cannot split a sentence. The spans
 * map each blanked part back to `raw`.
 */
function blankLine(raw: string): { text: string; spans: Span[] } {
  const code = blankSpans(raw, INLINE_CODE, "``");
  const quoted = blankSpans(code.text, QUOTED, '""');
  if (quoted.spans.length === 0) return code;
  const spans: Span[] = quoted.spans.map(q => ({
    at: q.at,
    end: q.end,
    rawAt: sourceAt(code.spans, q.rawAt),
    rawEnd: sourceAt(code.spans, q.rawEnd),
  }));
  // Code-text positions to match-text positions: the quote spans, inverted.
  const toMatch: Span[] = quoted.spans.map(q => ({
    at: q.rawAt,
    end: q.rawEnd,
    rawAt: q.at,
    rawEnd: q.end,
  }));
  // A code span inside a quote went with the quote; one outside it stays. Both
  // lists are in order, so one pass skips each quote that ends before a span.
  let next = 0;
  for (const c of code.spans) {
    while (next < quoted.spans.length && quoted.spans[next]!.rawEnd < c.end)
      next++;
    const around = quoted.spans[next];
    if (around && around.rawAt <= c.at) continue;
    const shift = sourceAt(toMatch, c.at);
    spans.push({
      at: shift,
      end: shift + (c.end - c.at),
      rawAt: c.rawAt,
      rawEnd: c.rawEnd,
    });
  }
  spans.sort((a, b) => a.at - b.at);
  return { text: quoted.text, spans };
}

/** `line.text.slice(start, end)` as the message wrote it. */
function rawSlice(line: Line, start: number, end: number): string {
  return line.raw.slice(sourceAt(line.spans, start), sourceAt(line.spans, end));
}

/** A sentence capped at the unit size, keeping both ends. */
function bounded(unit: string): string {
  if (unit.length <= DECISION_SIGNAL_MAX_UNIT_CHARS) return unit;
  const half = DECISION_SIGNAL_MAX_UNIT_CHARS / 2;
  return `${unit.slice(0, half)} … ${unit.slice(-half)}`;
}

/** The sentences of a match text, each trimmed, with its position. */
function sentencesOf(text: string): Sentence[] {
  const sentences: Sentence[] = [];
  const push = (from: number, to: number): void => {
    let start = from;
    let end = to;
    while (start < end && /\s/.test(text[start]!)) start++;
    while (end > start && /\s/.test(text[end - 1]!)) end--;
    if (end > start)
      sentences.push({ start, end, unit: bounded(text.slice(start, end)) });
  };
  let from = 0;
  for (const match of text.matchAll(SENTENCE_BREAK)) {
    push(from, match.index);
    from = match.index + match[0].length;
  }
  push(from, text.length);
  return sentences;
}

/** The lines the classifier reads, and the lines before them that set its state. */
type Window = {
  /** The read lines; hit and kept indexes count from the first. */
  lines: string[];
  /** Lines before `lines` that are known, scanned only for state. */
  before: string[];
  /** The text was cut and its start is unknown: only a slice was given. */
  sliceOnly: boolean;
};

/**
 * The read window: the last 16 KiB as at most 400 lines. A cut 16 KiB slice's
 * first line is partial and is dropped, unless it is the only line.
 */
function readWindow(text: string): Window {
  let head = "";
  let body = text;
  const sliceOnly = text.length === DECISION_SIGNAL_MAX_CHARS;
  if (text.length >= DECISION_SIGNAL_MAX_CHARS) {
    const from = text.length - DECISION_SIGNAL_MAX_CHARS;
    const newline = text.indexOf("\n", from);
    if (newline >= 0) {
      head = text.slice(0, newline);
      body = text.slice(newline + 1);
    } else {
      const lineStart = text.lastIndexOf("\n", from - 1) + 1;
      head = lineStart > 0 ? text.slice(0, lineStart - 1) : "";
      body = text.slice(from);
    }
  }
  const all = body.split(/\r?\n/);
  const extra = Math.max(0, all.length - DECISION_SIGNAL_MAX_LINES);
  const known = sliceOnly || head === "" ? [] : head.split(/\r?\n/);
  return {
    lines: all.slice(extra),
    before: [...known, ...all.slice(0, extra)],
    sliceOnly,
  };
}

/**
 * For each line, the index of the next later line that closes a note block or is
 * a heading, so a note opener finds its closer in one step.
 */
function nextNoteStops(lines: readonly string[]): {
  next: Int32Array;
  close: Uint8Array;
} {
  const next = new Int32Array(lines.length).fill(-1);
  const close = new Uint8Array(lines.length);
  let stop = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    next[i] = stop;
    const raw = lines[i]!;
    if (NOTE_CLOSE.test(raw)) {
      close[i] = 1;
      stop = i;
    } else if (HEADING.test(raw)) {
      stop = i;
    }
  }
  return { next, close };
}

/**
 * The lines a reader sees as prose: no fences, quotes, note blocks, count lines
 * or approval tokens, with inline code and quoted spans blanked in `text`.
 */
function proseLines(window: Window): Line[] {
  const all = [...window.before, ...window.lines];
  const first = window.before.length;
  const { next, close } = nextNoteStops(all);
  const kept: Line[] = [];
  let fence: string | null = null;
  // Lines up to and including `skipTo` are inside a note block (or, for a cut
  // slice, before the first fence's closer or a note block's closer).
  let skipTo = -1;
  let skipToFence = false;
  if (window.sliceOnly) {
    let markers = 0;
    for (const raw of all) if (FENCE.test(raw)) markers++;
    if (markers % 2 === 1) {
      // The slice starts inside a fence: its first marker closes it.
      skipToFence = true;
    } else {
      for (let i = 0; i < Math.min(all.length, NOTE_MAX_LINES); i++) {
        const raw = all[i]!;
        if (NOTE_OPEN.test(raw) || HEADING.test(raw)) break;
        if (close[i]) {
          skipTo = i;
          break;
        }
      }
    }
  }
  for (let i = 0; i < all.length; i++) {
    const raw = all[i]!;
    if (i <= skipTo) continue;
    const run = FENCE.exec(raw)?.[1];
    if (skipToFence) {
      if (run) skipToFence = false;
      continue;
    }
    if (fence) {
      if (
        run &&
        run[0] === fence[0] &&
        run.length >= fence.length &&
        raw.slice(raw.indexOf(run) + run.length).trim() === ""
      ) {
        fence = null;
      }
      continue;
    }
    if (run) {
      fence = run;
      continue;
    }
    if (NOTE_OPEN.test(raw)) {
      // Skip through the closer when one comes within reach; else only the opener,
      // so an unclosed note cannot swallow a later ask.
      const stop = next[i]!;
      if (stop >= 0 && close[stop] && stop - i <= NOTE_MAX_LINES) skipTo = stop;
      continue;
    }
    if (i < first) continue;
    if (BLOCKQUOTE.test(raw)) continue;
    if (PIN_COUNT_LINE_PATTERN.test(raw)) continue;
    if (APPROVAL_TOKEN.test(raw) || APPROVAL_HEADING.test(raw)) continue;
    const { text, spans } = blankLine(raw);
    kept.push({ text, raw, index: i - first, spans });
  }
  return kept;
}

/** Whether a match at `at` is preceded, in its sentence, by "nothing", "no" or "none". */
function negatedBefore(line: string, at: number): boolean {
  return NOTHING_BEFORE.test(line.slice(Math.max(0, at - 40), at));
}

/** The first `MATCHES_PER_LINE` matches of a global pattern on a line. */
function matchesOf(pattern: RegExp, line: string): RegExpExecArray[] {
  const found: RegExpExecArray[] = [];
  pattern.lastIndex = 0;
  for (
    let match = pattern.exec(line);
    match && found.length < MATCHES_PER_LINE;
    match = pattern.exec(line)
  ) {
    found.push(match);
  }
  pattern.lastIndex = 0;
  return found;
}

/** "Needs from you: nothing new" and "Nothing is open for you" are reports, not asks. */
function asksForSomething(line: string): boolean {
  for (const match of matchesOf(NEEDS_FROM_YOU, line)) {
    if (negatedBefore(line, match.index)) continue;
    let rest = line.slice(match.index + match[0].length).replace(/\*\*/g, "");
    const trimmed = rest.trimStart();
    if (trimmed.startsWith("(")) {
      const close = trimmed.indexOf(")");
      if (close > 0 && close < 200) rest = trimmed.slice(close + 1);
    }
    if (!NOTHING_NEEDED.test(rest)) return true;
  }
  return false;
}

/** "needs your pick", unless "Nothing here needs your sign-off". */
function needsYour(line: string): boolean {
  return [NEEDS_YOUR, NEEDS_YOUR_ID].some(pattern =>
    matchesOf(pattern, line).some(match => !negatedBefore(line, match.index))
  );
}

function sentenceHit(
  signal: DecisionSignal,
  line: Line,
  sentence: Sentence
): Hit {
  return {
    signal,
    line: line.index,
    sentence,
    raw: rawSlice(line, sentence.start, sentence.end),
  };
}

function findHits(kept: Line[]): Hit[] {
  const hits: Hit[] = [];
  for (const line of kept) {
    const { text, index } = line;
    const lower = text.toLowerCase();
    if (
      HEADING_OR_BOLD.test(text) &&
      lower.slice(0, 80).includes("answer key")
    ) {
      hits.push({ signal: "answer_key", line: index });
    }
    if (asksForSomething(text))
      hits.push({ signal: "needs_from_you", line: index });
    if (needsYour(text)) hits.push({ signal: "needs_your", line: index });
    for (const sentence of sentencesOf(text)) {
      if (sentence.unit.includes("?") && ASK_PHRASE.test(sentence.unit)) {
        hits.push(sentenceHit("ask_question", line, sentence));
      }
      if (CONSENT_IF.test(sentence.unit) && CONSENT_ACT.test(sentence.unit)) {
        hits.push(sentenceHit("consent_offer", line, sentence));
      }
    }
  }
  return hits;
}

/**
 * The message's last run of 2+ list items: [first, last] positions in `kept`.
 * Blank lines and indented continuations may sit between items; a removed line
 * (a fence, a quote, a note block) between them breaks the run.
 */
function lastListRun(kept: Line[]): [number, number] | null {
  let end = -1;
  for (let i = kept.length - 1; i >= 0; i--) {
    if (LIST_ITEM.test(kept[i]!.text)) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  let start = end;
  for (let i = end - 1; i >= 0; i--) {
    if (kept[i + 1]!.index - kept[i]!.index > 1) break;
    const t = kept[i]!.text;
    if (LIST_ITEM.test(t)) {
      start = i;
      continue;
    }
    if (t.trim() === "" || INDENTED.test(t)) continue;
    break;
  }
  let items = 0;
  for (let i = start; i <= end; i++) if (LIST_ITEM.test(kept[i]!.text)) items++;
  return items >= 2 ? [start, end] : null;
}

/** The nearest non-blank, non-item line from `from` going `step`, within a few lines. */
function nearestProse(
  kept: Line[],
  from: number,
  step: -1 | 1,
  skipIndented: boolean
): Line | undefined {
  for (
    let i = from, seen = 0;
    i >= 0 && i < kept.length && seen < LIST_PROSE_LOOK;
    i += step
  ) {
    const t = kept[i]!.text;
    if (t.trim() === "") continue;
    if (skipIndented && INDENTED.test(t)) continue;
    seen++;
    if (!LIST_ITEM.test(t)) return kept[i];
  }
  return undefined;
}

function findAmbiguous(kept: Line[]): Hit[] {
  const hits: Hit[] = [];
  for (const line of kept) {
    for (const sentence of sentencesOf(line.text)) {
      if (!sentence.unit.includes("?") && ASK_STATEMENT.test(sentence.unit)) {
        hits.push(sentenceHit("ask_statement", line, sentence));
      }
    }
    if (line.text.trimEnd().endsWith("?")) {
      const start = line.text.length - line.text.trimStart().length;
      const end = line.text.trimEnd().length;
      hits.push(
        sentenceHit("trailing_question", line, {
          start,
          end,
          unit: line.text.slice(start, end),
        })
      );
    }
  }
  const run = lastListRun(kept);
  if (run) {
    const lead = nearestProse(kept, run[0] - 1, -1, false);
    const trail = nearestProse(kept, run[1] + 1, 1, true);
    let optionItem = false;
    for (let i = run[0]; i <= run[1] && !optionItem; i++)
      optionItem = OPTION_ITEM.test(kept[i]!.text);
    if (
      (lead && OPTION_WORD.test(lead.text)) ||
      (trail && OPTION_WORD.test(trail.text)) ||
      optionItem
    ) {
      hits.push({ signal: "option_list", line: (lead ?? kept[run[0]]!).index });
    }
  }
  return hits;
}

/**
 * `text`'s last `max` characters, starting at a word: a cut that lands mid-word
 * moves forward to the next whitespace, however far; with none, it starts "…".
 */
function tailAtWord(text: string, max: number): string {
  if (text.length <= max) return text.trim();
  const cut = text.slice(-max);
  if (/\s/.test(text[text.length - max - 1]!)) return cut.trim();
  const space = cut.search(/\s/);
  if (space < 0) return `…${cut.slice(1)}`;
  return cut.slice(space).trim();
}

/** `text`'s first `max` characters, ending at a word, or ending "…". */
function headAtWord(text: string, max: number): string {
  if (text.length <= max) return text.trim();
  const cut = text.slice(0, max);
  if (/\s/.test(text[max]!)) return cut.trim();
  const space = cut.search(/\s\S*$/);
  if (space <= 0) return `${cut.slice(0, -1)}…`;
  return cut.slice(0, space).trim();
}

/** A block hit's own lines: its line through the next blank or heading line. */
function blockEnd(lines: readonly string[], from: number): number {
  let end = from + 1;
  while (
    end < lines.length &&
    lines[end]!.trim() !== "" &&
    !HEADING.test(lines[end]!)
  )
    end++;
  return end;
}

function isBlock(hit: Hit): boolean {
  return hit.signal === "answer_key" || hit.signal === "needs_from_you";
}

/** A strong hit's own text: its sentence, its block, or its line. */
function ownText(hit: Hit, lines: readonly string[], kept: Line[]): string {
  if (isBlock(hit)) {
    return lines
      .slice(hit.line, blockEnd(lines, hit.line))
      .join("\n")
      .slice(0, DECISION_EXCERPT_BLOCK_CHARS);
  }
  if (hit.raw !== undefined) return hit.raw;
  return kept.find(l => l.index === hit.line)?.raw ?? "";
}

/** The raw text of the last sentence ending with `?` in the given kept lines. */
function lastQuestion(
  lines: readonly Line[],
  within?: { line: number; sentence: Sentence }
): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    const sentences =
      within && within.line === line.index
        ? [within.sentence]
        : sentencesOf(line.text);
    for (let j = sentences.length - 1; j >= 0; j--) {
      const s = sentences[j]!;
      if (line.text.slice(s.start, s.end).endsWith("?")) {
        return rawSlice(line, s.start, s.end).trim();
      }
    }
  }
  return null;
}

/** The ask as the operator would read it, from the raw lines (inline code and quotes kept). */
function excerptFor(hit: Hit, lines: readonly string[], kept: Line[]): string {
  if (isBlock(hit)) {
    return lines
      .slice(hit.line)
      .join("\n")
      .slice(0, DECISION_EXCERPT_BLOCK_CHARS)
      .trim();
  }
  const line = kept.find(l => l.index === hit.line);
  if (!line) return "";
  if (hit.sentence) {
    const sentences = sentencesOf(line.text);
    const at = sentences.findIndex(s => s.start === hit.sentence!.start);
    const from = at > 0 ? sentences[at - 1]!.start : hit.sentence.start;
    return tailAtWord(
      rawSlice(line, from, hit.sentence.end),
      DECISION_EXCERPT_SENTENCE_CHARS
    );
  }
  return tailAtWord(line.raw, DECISION_EXCERPT_SENTENCE_CHARS);
}

/**
 * A weak ask's excerpt: the ask tail when it fits; else its first line's head,
 * " … ", and the tail's end, so a question above long options survives.
 */
function tailExcerpt(tail: string, firstLine: string): string {
  if (tail.length <= DECISION_EXCERPT_BLOCK_CHARS) return tail.trim();
  const head = headAtWord(firstLine, DECISION_EXCERPT_HEAD_CHARS);
  const rest = DECISION_EXCERPT_BLOCK_CHARS - head.length - 3;
  return `${head} … ${tailAtWord(tail, rest)}`;
}

/**
 * Classify an assistant message. `decision` and `ambiguous` are both asks for the
 * nudge; `ambiguous` is what #6456's small-model step judges. Total: never throws.
 */
export function classifyDecisionSignals(text: string): DecisionSignals {
  const none: DecisionSignals = {
    verdict: "none",
    signals: [],
    excerpt: "",
    matchText: "",
    askTexts: [],
    askTextsCut: false,
    question: null,
  };
  if (typeof text !== "string" || text.trim() === "") return none;
  const window = readWindow(text);
  const { lines } = window;
  const kept = proseLines(window);
  const strong = findHits(kept);
  let hits = strong;
  if (strong.length === 0) {
    hits = findAmbiguous(kept);
    // A "nothing needs you" line at or after the last weak ask withdraws it; one
    // above a later ask (one lane reporting, the next one asking) does not.
    const last = Math.max(-1, ...hits.map(h => h.line));
    if (
      hits.length > 0 &&
      kept.some(l => l.index >= last && NOTHING_ASKED.test(l.text))
    ) {
      hits = [];
    }
  }
  if (hits.length === 0) return none;
  const signals = SIGNAL_ORDER.filter(s => hits.some(h => h.signal === s));
  const best = hits.reduce((a, b) =>
    rank(b) < rank(a) || (rank(b) === rank(a) && b.line >= a.line) ? b : a
  );
  if (strong.length === 0) {
    const from = Math.min(...hits.map(h => h.line));
    const tailLines = kept.filter(l => l.index >= from);
    const tail = tailLines.map(l => l.raw).join("\n");
    return {
      verdict: "ambiguous",
      signals,
      excerpt: tailExcerpt(tail, tailLines[0]?.raw ?? ""),
      matchText: normalizeForMatch(tail),
      askTexts: [],
      askTextsCut: false,
      question: lastQuestion(tailLines),
    };
  }
  const ordered = [...strong].sort(
    (a, b) =>
      a.line - b.line || (a.sentence?.start ?? -1) - (b.sentence?.start ?? -1)
  );
  const allAsks = [
    ...new Set(ordered.map(h => normalizeForMatch(ownText(h, lines, kept)))),
  ];
  const askTexts = allAsks.slice(-DECISION_ASK_TEXTS_MAX);
  const ownLines = isBlock(best)
    ? kept.filter(
        l => l.index >= best.line && l.index < blockEnd(lines, best.line)
      )
    : kept.filter(l => l.index === best.line);
  return {
    verdict: "decision",
    signals,
    excerpt: excerptFor(best, lines, kept),
    matchText: normalizeForMatch(ownText(best, lines, kept)),
    askTexts,
    askTextsCut: allAsks.length > askTexts.length,
    question: lastQuestion(
      ownLines,
      best.sentence ? { line: best.line, sentence: best.sentence } : undefined
    ),
  };
}
