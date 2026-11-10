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
//
// ## Bounded and linear
// The Stop hook runs this in the session wrapper, which also sends the 2 s
// keepalive, and Bun's regex engine backtracks: a naive `^(\w+\s?)+\?$` took over
// a second on 30 characters. So only the last 16 KiB is read, as at most 400
// lines, each sentence at most 400 characters; every pattern is a fixed phrase or
// a single bounded run, and signals are combined in code, never in one regex.
//
// ## What is not read
// Fenced code blocks (an agent showing a format), blockquotes (quoted text), inline
// code, and every line carrying an approval token or the `USER-APPROVAL REQUIRED`
// heading: an approval token is a native control the operator pastes, never a pin,
// and its block alone is not an ask. Pure and dependency-free, like pinFence.ts.

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
  /** The ask, as the operator would read it; empty for `none`. */
  excerpt: string;
  /** `normalizeForMatch(excerpt)`. */
  matchText: string;
};

/** A fence line's start, as pinFence.ts reads it; nothing follows the run. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const BLOCKQUOTE = /^ {0,3}>/;
const APPROVAL_TOKEN = /USER-APPROVAL-[A-Z2-9]{4}-[A-Z2-9]{4}/;
const APPROVAL_HEADING = /USER-APPROVAL REQUIRED/;
const INLINE_CODE = /`[^`\n]{0,400}`/g;
const HEADING_OR_BOLD = /^ {0,3}(?:#{1,6}[ \t]|\*\*)/;
const NEEDS_FROM_YOU = /\b(?:needs? from you|what i need from you)\b/i;
const NOTHING_NEEDED = /^[:\-—–\s]*(?:nothing|none|no new|no further|n\/a)\b/i;
const NEEDS_YOUR =
  /\bneeds? your (?:answers?|decisions?|go|approval|reply|input|call|rulings?|two messages|messages)\b/i;
const ASK_PHRASE =
  /\b(?:should i|shall i|do you want|would you like|want me to|ok to|okay to|okay with|ok with|go ahead|proceed|which (?:option|one|of these|would you|do you)|can you confirm|is (?:that|this|it) ok|approve)\b/i;
const CONSENT_IF =
  /\bif you (?:approve|want|would like|'d like|prefer|agree|confirm)\b/i;
const CONSENT_ACT = /\bI(?:'ll| will| can| could)\b/;
const ASK_STATEMENT =
  /\b(?:let me know|please confirm|reply with|your call|tell me (?:which|whether|if))\b/i;
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,2}[.)]|[A-Z]\d?[.)])[ \t]+\S/;
const OPTION_WORD = /\b(?:options?|choose|pick|recommend)/i;

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

type Line = { text: string; index: number };
type Hit = { signal: DecisionSignal; line: number; sentence?: string };

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

/** The lines a reader sees as prose: no fences, quotes, inline code or approval tokens. */
function proseLines(lines: string[]): Line[] {
  const kept: Line[] = [];
  let fence: string | null = null;
  lines.forEach((raw, index) => {
    const run = FENCE.exec(raw)?.[1];
    if (fence) {
      if (
        run &&
        run[0] === fence[0] &&
        run.length >= fence.length &&
        raw.slice(raw.indexOf(run) + run.length).trim() === ""
      ) {
        fence = null;
      }
      return;
    }
    if (run) {
      fence = run;
      return;
    }
    if (BLOCKQUOTE.test(raw)) return;
    if (APPROVAL_TOKEN.test(raw) || APPROVAL_HEADING.test(raw)) return;
    kept.push({ text: raw.replace(INLINE_CODE, "``"), index });
  });
  return kept;
}

/** A sentence capped at the unit size, keeping both ends. */
function bounded(unit: string): string {
  if (unit.length <= DECISION_SIGNAL_MAX_UNIT_CHARS) return unit;
  const half = DECISION_SIGNAL_MAX_UNIT_CHARS / 2;
  return `${unit.slice(0, half)} … ${unit.slice(-half)}`;
}

function sentencesOf(line: string): string[] {
  return line
    .split(/(?<=[.?!])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .map(bounded);
}

/** "Needs from you: nothing new" is a report, not an ask. */
function asksForSomething(line: string): boolean {
  const match = NEEDS_FROM_YOU.exec(line);
  if (!match) return false;
  let rest = line.slice(match.index + match[0].length).replace(/\*\*/g, "");
  const trimmed = rest.trimStart();
  if (trimmed.startsWith("(")) {
    const close = trimmed.indexOf(")");
    if (close > 0 && close < 200) rest = trimmed.slice(close + 1);
  }
  return !NOTHING_NEEDED.test(rest);
}

function findHits(kept: Line[]): Hit[] {
  const hits: Hit[] = [];
  for (const { text, index } of kept) {
    const lower = text.toLowerCase();
    if (
      HEADING_OR_BOLD.test(text) &&
      lower.slice(0, 80).includes("answer key")
    ) {
      hits.push({ signal: "answer_key", line: index });
    }
    if (asksForSomething(text))
      hits.push({ signal: "needs_from_you", line: index });
    if (NEEDS_YOUR.test(text)) hits.push({ signal: "needs_your", line: index });
    for (const sentence of sentencesOf(text)) {
      if (sentence.includes("?") && ASK_PHRASE.test(sentence)) {
        hits.push({ signal: "ask_question", line: index, sentence });
      }
      if (CONSENT_IF.test(sentence) && CONSENT_ACT.test(sentence)) {
        hits.push({ signal: "consent_offer", line: index, sentence });
      }
    }
  }
  return hits;
}

function findAmbiguous(kept: Line[]): Hit[] {
  const hits: Hit[] = [];
  let listItems = 0;
  let optionWord = false;
  for (const { text, index } of kept) {
    if (LIST_ITEM.test(text)) listItems++;
    if (OPTION_WORD.test(text)) optionWord = true;
    for (const sentence of sentencesOf(text)) {
      if (!sentence.includes("?") && ASK_STATEMENT.test(sentence)) {
        hits.push({ signal: "ask_statement", line: index, sentence });
      }
    }
    if (text.trimEnd().endsWith("?")) {
      hits.push({
        signal: "trailing_question",
        line: index,
        sentence: text.trim(),
      });
    }
  }
  if (listItems >= 2 && optionWord) {
    const last = kept.at(-1)?.index ?? 0;
    hits.push({ signal: "option_list", line: last });
  }
  return hits;
}

/** The ask as the operator would read it. */
function excerptFor(hit: Hit, lines: string[], kept: Line[]): string {
  if (hit.signal === "answer_key" || hit.signal === "needs_from_you") {
    return lines
      .slice(hit.line)
      .join("\n")
      .slice(0, DECISION_EXCERPT_BLOCK_CHARS)
      .trim();
  }
  if (hit.sentence) {
    const line = kept.find(l => l.index === hit.line)?.text ?? "";
    const sentences = sentencesOf(line);
    const at = sentences.indexOf(hit.sentence);
    const before = at > 0 ? `${sentences[at - 1]} ` : "";
    return `${before}${hit.sentence}`
      .slice(-DECISION_EXCERPT_SENTENCE_CHARS)
      .trim();
  }
  return lines.join("\n").slice(-DECISION_EXCERPT_SENTENCE_CHARS).trim();
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
  };
  if (typeof text !== "string" || text.trim() === "") return none;
  const lines = text
    .slice(-DECISION_SIGNAL_MAX_CHARS)
    .split(/\r?\n/)
    .slice(-DECISION_SIGNAL_MAX_LINES);
  const kept = proseLines(lines);
  const strong = findHits(kept);
  const hits = strong.length > 0 ? strong : findAmbiguous(kept);
  if (hits.length === 0) return none;
  const signals = SIGNAL_ORDER.filter(s => hits.some(h => h.signal === s));
  const best = hits.reduce((a, b) =>
    rank(b) < rank(a) || (rank(b) === rank(a) && b.line >= a.line) ? b : a
  );
  const excerpt = excerptFor(best, lines, kept);
  return {
    verdict: strong.length > 0 ? "decision" : "ambiguous",
    signals,
    excerpt,
    matchText: normalizeForMatch(excerpt),
  };
}
