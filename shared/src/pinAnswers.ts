// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";
import { scanPinFences } from "./pinFence";
import { APPROVAL_TOKEN_PATTERN } from "./pins";

// The operator's pin answers as the agent receives them (issue #6450, epic #6446):
// one ordinary user message holding a summary line and a fenced
// `hapi_pin_answers` JSON block, schema `hapi_pin_answers/1`. The field names and
// order are the ones Matt's own Submit messages carried in the Nov 6 workshop
// (mockup v6 `payload()` / `submitMessage()`), so changing them is a version bump.
// Shared, because the server composes the message (the submission operation) and
// automatic picks (#6452) send the same one.
//
// ## Built to be read by any model
//
// Writing is strict and reading is loose: a v1 reader keeps working when a newer
// producer adds a field. Everything an agent wrote (option ids and labels) and
// everything the operator typed passes through `neutralizeApprovalTokens`, because
// the approval hook verifies a `USER-APPROVAL-` token found anywhere in a user
// message (`server/src/services/approvalTokens.ts`), and an agent knows its own
// pending token: carried in an option label, it would mint the agent's own
// approval on the operator's Submit. Pins never carry approvals (brief §C).
//
// ## Extending `hapi_pin_answers/1`
//
// A new optional field on an entry is the documented extension, not a version
// bump, because readers are loose: `automaticPick` (#6452), `savedTo` (#6453),
// `dismissed` with `title` (#6539) and `pinId` (#6574, placed right after `kind`)
// each arrived this way. Renaming, removing or re-ordering an existing field is a
// version bump.

export const PIN_ANSWERS_SCHEMA = "hapi_pin_answers/1";
export const PIN_ANSWERS_FENCE_LANGUAGE = "hapi_pin_answers";
/** Under the 50,000-character queued-message cap, so no later path refuses it for size. */
export const PIN_ANSWERS_MESSAGE_MAX_CHARS = 48_000;
/** Past this many pins the summary line names the rest as "and N more". */
export const PIN_ANSWERS_SUMMARY_MAX_ITEMS = 20;
const SUMMARY_TOKEN_MAX_CHARS = 40;

/**
 * The approval-token acceptor (`USER_APPROVAL_ACCEPT_REGEX`, server/src/services/
 * approvalTokens.ts), global for replacing. The server test pins the two together.
 */
const APPROVAL_TOKEN = new RegExp(APPROVAL_TOKEN_PATTERN.source, "g");
export const APPROVAL_TOKEN_REPLACEMENT = "[approval token removed]";

/** One review mark (K, #6457): a numbered point or box and the parts it covers. */
export type PinAnswerMark = {
  n: number;
  type: "point" | "box";
  parts: string[];
  at: { x: number; y: number; w?: number; h?: number };
  comment: string;
};

/**
 * An automatic pick (F, #6452). Its meaning depends on the message:
 * - in a message whose summary line starts `Pins automatic pick,`, the entry's
 *   `answer` was made automatically when the deadline at `at` passed;
 * - in a `Pins answers,` message (the operator's Submit), `{at, local}` says the
 *   operator moved the pick to `at`, and `{off: true}` that they turned it off.
 * Matt's own 7:13 PM message (mockup era) carried an answer and a move in one
 * entry; the server's Submit sends a move only on an entry without a resolving
 * answer, because the answer settles the pin and the move is then moot.
 */
export type PinAutomaticPick = { at: string; local: string } | { off: true };

/** One pin's entry. Only `pin`, `rev` and `kind` are always present. */
export type PinAnswersEntry = {
  pin: string;
  /** The revision the operator answered, which may be older than the pin's. */
  rev: number;
  kind: string;
  /**
   * #6574: the pin's server-owned ID, when it has one, so the agent can name the
   * pin to another session. An identity field like `pin`, `rev` and `kind`.
   */
  pinId?: string;
  /**
   * #6539: the operator dismissed this pin without answering it, and the pin is
   * closed. Such an entry carries no `answer`; it may carry a `note`.
   */
  dismissed?: true;
  /** The dismissed pin's title, so the agent need not look the key up. */
  title?: string;
  answer?: { choice: string; label: string };
  note?: string;
  questions?: string[];
  automaticPick?: PinAutomaticPick;
  marks?: PinAnswerMark[];
  steps?: { done: number; total: number };
  savedTo?: string;
};

export type PinAnswersBlock = {
  schema: typeof PIN_ANSWERS_SCHEMA;
  session: string;
  submittedAt: string;
  submittedLocal: string;
  pins: PinAnswersEntry[];
};

const PinAnswersEntrySchema = z
  .object({
    pin: z.string(),
    rev: z.number().int(),
    kind: z.string(),
    pinId: z.string().optional(),
    dismissed: z.literal(true).optional(),
    title: z.string().optional(),
    answer: z
      .object({ choice: z.string(), label: z.string() })
      .loose()
      .optional(),
    note: z.string().optional(),
    questions: z.array(z.string()).optional(),
    automaticPick: z
      .union([
        z.object({ at: z.string(), local: z.string() }).loose(),
        z.object({ off: z.literal(true) }).loose(),
      ])
      .optional(),
    marks: z
      .array(z.object({ n: z.number(), comment: z.string() }).loose())
      .optional(),
    steps: z
      .object({ done: z.number().int(), total: z.number().int() })
      .loose()
      .optional(),
    savedTo: z.string().optional(),
  })
  .loose();

/** Loose on purpose: see the header. */
export const PinAnswersBlockSchema = z
  .object({
    schema: z.literal(PIN_ANSWERS_SCHEMA),
    session: z.string(),
    submittedAt: z.string(),
    submittedLocal: z.string(),
    pins: z.array(PinAnswersEntrySchema),
  })
  .loose();

/** Replace every approval token in `text` with an inert marker. */
export function neutralizeApprovalTokens(text: string): string {
  return text.replace(APPROVAL_TOKEN, APPROVAL_TOKEN_REPLACEMENT);
}

/**
 * One option id as it may appear in the summary line: one line, no backticks,
 * no control characters, at most 40 characters. Option ids are unconstrained, so
 * one holding a newline and a fence would otherwise split the line or forge a
 * second block.
 */
export function summaryToken(text: string): string {
  const cleaned = neutralizeApprovalTokens(text)
    .replace(/[\p{Cc}`]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > SUMMARY_TOKEN_MAX_CHARS
    ? `${cleaned.slice(0, SUMMARY_TOKEN_MAX_CHARS - 1)}…`
    : cleaned;
}

const timeFormats = new Map<string, Intl.DateTimeFormat>();

function timeFormatFor(timeZone: string): Intl.DateTimeFormat {
  const cached = timeFormats.get(timeZone);
  if (cached) return cached;
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
  } catch {
    // An unknown zone must not fail a Submit: fall back to UTC, which every
    // runtime knows.
    return timeFormatFor("UTC");
  }
  timeFormats.set(timeZone, format);
  return format;
}

/**
 * "Fri Nov 6, 7:13 PM EST": built from the parts, never from `format()`, because
 * engines join them differently (iOS Safari wrote "Fri Nov 6 at 8:43 PM EST").
 */
export function formatPinAnswerTime(ms: number, timeZone: string): string {
  const parts: Record<string, string> = {};
  for (const part of timeFormatFor(timeZone).formatToParts(ms)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return `${parts.weekday} ${parts.month} ${parts.day}, ${parts.hour}:${parts.minute} ${parts.dayPeriod} ${parts.timeZoneName}`;
}

/** The entry as sent: keys in the contract's order, every text neutralized. */
function cleanEntry(entry: PinAnswersEntry): PinAnswersEntry {
  const out: PinAnswersEntry = {
    // The key is refused at creation when it carries a token; this is the
    // second layer, for a record written before that rule or by a newer peer.
    pin: neutralizeApprovalTokens(entry.pin),
    rev: entry.rev,
    kind: entry.kind,
    // #6574: the fourth identity field. The server mints it, but a record from a
    // newer peer is read loosely, so it is cleaned like the key.
    ...(entry.pinId !== undefined
      ? { pinId: neutralizeApprovalTokens(entry.pinId) }
      : {}),
  };
  if (entry.dismissed === true) out.dismissed = true;
  // #6539: the agent wrote the title, so it may carry a token like any label.
  if (entry.title !== undefined) {
    out.title = neutralizeApprovalTokens(entry.title);
  }
  if (entry.answer) {
    out.answer = {
      choice: neutralizeApprovalTokens(entry.answer.choice),
      label: neutralizeApprovalTokens(entry.answer.label),
    };
  }
  if (entry.note !== undefined) out.note = neutralizeApprovalTokens(entry.note);
  if (entry.questions && entry.questions.length > 0) {
    out.questions = entry.questions.map(neutralizeApprovalTokens);
  }
  if (entry.automaticPick) {
    out.automaticPick =
      "off" in entry.automaticPick
        ? { off: true }
        : { at: entry.automaticPick.at, local: entry.automaticPick.local };
  }
  if (entry.marks && entry.marks.length > 0) {
    out.marks = entry.marks.map(mark => ({
      ...mark,
      parts: mark.parts.map(neutralizeApprovalTokens),
      comment: neutralizeApprovalTokens(mark.comment),
    }));
  }
  if (entry.steps)
    out.steps = { done: entry.steps.done, total: entry.steps.total };
  // #6453: a derived savedTo is cut from an agent-written evidence path, which
  // may carry a token even though a key cannot.
  if (entry.savedTo !== undefined) {
    out.savedTo = neutralizeApprovalTokens(entry.savedTo);
  }
  // Only identity fields (pin, rev, kind and, when present, pinId) means nothing to send.
  if (Object.keys(out).length <= (out.pinId === undefined ? 3 : 4)) {
    throw new Error(
      `pin "${entry.pin}" has nothing to send; the caller drops such entries`
    );
  }
  return out;
}

/** `<key> (dismissed by you: <title>)`; a pin with no title drops the colon. */
function dismissedItem(entry: PinAnswersEntry): string {
  const title = entry.title === undefined ? "" : summaryToken(entry.title);
  return title === ""
    ? `${entry.pin} (dismissed by you)`
    : `${entry.pin} (dismissed by you: ${title})`;
}

export type PinAnswersMessageInput = {
  /** The id the agent knows itself by: the session's tag, else its id. */
  session: string;
  /** Epoch ms of the submission. */
  now: number;
  /** The zone the caller resolved (on the server: the Time Log zone, else the browser's, else the host's). */
  timeZone: string;
  entries: readonly PinAnswersEntry[];
  /**
   * An automatic pick the server made when a deadline passed (#6452): the summary
   * line says so, so neither the operator reading the chat nor the agent takes it
   * for the operator's answer. The block is unchanged.
   */
  automatic?: boolean;
};

export type PinAnswersMessage =
  | { ok: true; text: string; block: PinAnswersBlock }
  | { ok: false; reason: "empty" }
  | { ok: false; reason: "too_large"; length: number };

/**
 * The exact message: `Pins answers, <time>: <counts> (<item>, …)`, where an
 * item is `<key> (dismissed by you: <title>)` for a dismissal (#6539),
 * `<key> → <choice>` for an answer, `<key> (saved to <folder>)` for an
 * entry that carries only a save (#6453), or the bare `<key>` otherwise
 * (`Pins automatic pick, …` for an automatic pick, #6452),
 * a blank line, and the fenced block pretty-printed with two-space indent, which
 * can never close the fence early (every JSON line is indented or starts `{`/`}`).
 */
export function formatPinAnswersMessage(
  input: PinAnswersMessageInput
): PinAnswersMessage {
  if (input.entries.length === 0) return { ok: false, reason: "empty" };
  const pins = input.entries.map(cleanEntry);
  const local = formatPinAnswerTime(input.now, input.timeZone);
  // #6539: a dismissal is counted apart, and checked first. The server puts
  // `savedTo` on every entry of a pin with a saved folder, and a dismissed pin
  // must read "dismissed by you", never "saved to".
  const dismissed = pins.filter(entry => entry.dismissed === true).length;
  const answered = pins.filter(
    entry => entry.dismissed !== true && entry.answer
  ).length;
  const other = pins.length - answered - dismissed;
  const counts =
    `${answered} answer${answered === 1 ? "" : "s"}` +
    (dismissed > 0
      ? `, ${dismissed} dismissal${dismissed === 1 ? "" : "s"}`
      : "") +
    (other > 0 ? `, ${other} other update${other === 1 ? "" : "s"}` : "");
  const items = pins.map(entry =>
    entry.dismissed === true
      ? dismissedItem(entry)
      : entry.answer
        ? `${entry.pin} → ${summaryToken(entry.answer.choice)}`
        : entry.savedTo !== undefined
          ? `${entry.pin} (saved to ${summaryToken(entry.savedTo)})`
          : entry.pin
  );
  const shown = items.slice(0, PIN_ANSWERS_SUMMARY_MAX_ITEMS);
  const more = items.length - shown.length;
  const list = shown.join(", ") + (more > 0 ? `, and ${more} more` : "");
  const block: PinAnswersBlock = {
    schema: PIN_ANSWERS_SCHEMA,
    session: neutralizeApprovalTokens(input.session),
    submittedAt: new Date(input.now).toISOString(),
    submittedLocal: local,
    pins,
  };
  const heading = input.automatic ? "Pins automatic pick" : "Pins answers";
  const text =
    `${heading}, ${local}: ${counts} (${list})\n\n` +
    "```" +
    `${PIN_ANSWERS_FENCE_LANGUAGE}\n${JSON.stringify(block, null, 2)}\n` +
    "```";
  if (text.length > PIN_ANSWERS_MESSAGE_MAX_CHARS) {
    return { ok: false, reason: "too_large", length: text.length };
  }
  return { ok: true, text, block };
}

export type PinAnswersParse =
  | { ok: true; block: PinAnswersBlock }
  | {
      ok: false;
      reason: "no_block" | "unclosed" | "invalid_json" | "invalid_block";
    };

/**
 * Read the block back the way an agent would: the first closed
 * `hapi_pin_answers` fence (the `hapi_pin` scanner's nesting rules), parsed and
 * validated.
 */
export function parsePinAnswersMessage(text: string): PinAnswersParse {
  const scan = scanPinFences(text, {
    maxBlocks: 1,
    language: PIN_ANSWERS_FENCE_LANGUAGE,
  });
  const first = scan.blocks[0];
  if (!first) {
    return { ok: false, reason: scan.unclosed ? "unclosed" : "no_block" };
  }
  let json: unknown;
  try {
    json = JSON.parse(first.body);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  const parsed = PinAnswersBlockSchema.safeParse(json);
  return parsed.success
    ? { ok: true, block: parsed.data as unknown as PinAnswersBlock }
    : { ok: false, reason: "invalid_block" };
}
