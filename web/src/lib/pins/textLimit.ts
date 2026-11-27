// SPDX-License-Identifier: AGPL-3.0-only
/**
 * #6969: how close a Pins text box is to its limit, and what the operator is
 * told. No Pins text box cuts text for length (R1), so a dictated or pasted
 * note past the limit stays whole in the box; this is what says so, under the
 * box (R2) and in the Submit dialog's Not sent row (R3).
 *
 * Length is `String.length`, the UTF-16 code units Zod's `.max()` counts, so the
 * counter and the server agree on every character (an emoji counts two).
 *
 * React-free and Zod-free, like `staging.ts` and `noteDrafts.ts`: the boxes it
 * serves sit in the chat, which is in the main bundle.
 */

/** Which box: the note, the operator's own answer (write-in), or a question. */
export type TextLimitWhat = "note" | "answer" | "question";

export type TextLimitLevel = "hint" | "warn" | "over";

export type TextLimitState = {
  /** From 80% of the limit; below it the box shows nothing (D3). */
  show: boolean;
  /** `hint` from 80%, `warn` from 95%, `over` past the limit. */
  level: TextLimitLevel;
  /** Characters still free; 0 at and past the limit. */
  left: number;
  /** Characters past the limit; 0 at and under it. */
  over: number;
};

/** A count as the operator reads it: "10,000". */
function count(n: number): string {
  return n.toLocaleString("en-US");
}

/** "1 character", "312 characters". */
function characters(n: number): string {
  return `${count(n)} ${n === 1 ? "character" : "characters"}`;
}

/**
 * Where `length` stands against `limit` (a positive whole number). The two
 * thresholds are compared in whole numbers (`length * 5 >= limit * 4`), so
 * 80% of 2,048 (1,638.4) shows from 1,639 with no rounding to argue about.
 */
export function textLimitState(length: number, limit: number): TextLimitState {
  const over = Math.max(0, length - limit);
  const left = Math.max(0, limit - length);
  const level: TextLimitLevel =
    over > 0 ? "over" : length * 20 >= limit * 19 ? "warn" : "hint";
  return { show: length * 5 >= limit * 4, level, left, over };
}

const SHORTEN: Record<TextLimitWhat, string> = {
  note: "shorten the note to send it",
  answer: "shorten your answer to send it",
  question: "shorten the question to add it",
};

/**
 * The counter's one line: "1,812 characters left", or past the limit
 * "312 characters over the limit; shorten the note to send it".
 */
export function textLimitText(
  state: TextLimitState,
  what: TextLimitWhat
): string {
  return state.over > 0
    ? `${characters(state.over)} over the limit; ${SHORTEN[what]}`
    : `${characters(state.left)} left`;
}

/** The counter's tooltip, built from the limit, so it always names the real number. */
export function textLimitTooltip(limit: number, what: TextLimitWhat): string {
  switch (what) {
    case "note":
      return `A note holds up to ${characters(limit)}. Past that, Submit holds it until it fits`;
    case "answer":
      return `Your own answer holds up to ${characters(limit)}. A longer explanation fits in the note`;
    case "question":
      return `A question holds up to ${characters(limit)}`;
  }
}

const WHOSE: Record<TextLimitWhat, string> = {
  note: "your note",
  answer: "your own answer",
  question: "your question",
};

/**
 * Why Submit held a pin (R3): "your note is 312 characters over the 10,000
 * limit".
 */
export function overLimitReason(
  over: number,
  limit: number,
  what: TextLimitWhat
): string {
  return `${WHOSE[what]} is ${characters(over)} over the ${count(limit)} limit`;
}
