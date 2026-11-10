// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The turn check (issue #6455, epic #6446; design D4 and "nudge the agent, then
 * pin it anyway"): does a turn end on an ask that no pin covers?
 *
 * - `checkNudge` answers the Claude Code Stop hook: `block` with a reason that
 *   asks the agent to pin the decision, or `none`. It writes nothing, so it may
 *   take the text the session's wrapper sends.
 * - `detect` writes the Detected pin when the agent still did not pin. It takes
 *   no text: the agent holds the CLI token, and `detected` is a kind only the
 *   server creates, so the text is read from the stored messages of the turn and
 *   the key is `detected:<messageId>`. The turn-end detector (Sub-Issue J,
 *   #6456) will call the same `detect` on the same stored message, so the two
 *   will never pin one ask twice.
 *
 * ## A matching pin
 * Any of: a `hapi_pin` fence in the text (the fence reader writes it after the
 * message's event, so it may not be stored yet); an open pin the agent owns that
 * was created or revised since the turn started; or an open pin whose key the
 * text names (a loop tick that refers to a pin by key). Dashboards are `live`,
 * never `open`, so a dashboard update never hides an ask.
 *
 * The Pins gate is the route's (cliPins.ts), which is the only caller today.
 */
import { createHash } from "node:crypto";
import {
  classifyDecisionSignals,
  normalizeForMatch,
  PinContentSchema,
  PinKeySchema,
  scanPinFences,
  type DecisionSignal,
  type Pin,
  type PinContent,
} from "@hapi/protocol";
import { capPinText, cleanPinText } from "./pinText";
import { extractUserFacingAssistantTexts } from "./needsReviewContent";
import type { PinService, PinSessionRef } from "./pinService";

/** The Detected pin's key prefix. */
export const DETECTED_PIN_PREFIX = "detected:";
/** Open Detected pins one session may hold; an extra one withdraws the oldest. */
export const DETECTED_OPEN_MAX = 10;
/** Pins and messages this close before the turn's start still count as this turn. */
export const TURN_SKEW_MS = 10_000;
/** Stored messages a detection reads, newest first. */
export const DETECT_MESSAGE_WINDOW = 20;
/** A stored message longer than this is skipped unparsed. */
export const DETECT_MESSAGE_MAX_CHARS = 64 * 1024;
const REASON_MAX_CHARS = 600;
const TITLE_MAX_CHARS = 200;
const CONTEXT_EXCERPT_MAX_CHARS = 2000;

const SIGNAL_LABELS: Record<DecisionSignal, string> = {
  answer_key: "an answer key",
  needs_from_you: "a Needs from you list",
  needs_your: "a request for input",
  ask_question: "a question",
  consent_offer: "an offer awaiting consent",
  ask_statement: "a request to reply",
  trailing_question: "a question",
  option_list: "a list of options",
};

/** The nudge reason after the quote: what to do, and why. */
export const NUDGE_REASON_TAIL = [
  "Always pin each decision or step the operator must act on (pin_post or a hapi_pin block) before ending your turn, because the chat scrolls away and the Pins tab keeps it.",
  "Always point to the pin instead of re-asking in the chat, because the pin holds the question.",
  "Always keep approval tokens out of pins, because pin text reaches the operator's reply, where a token approves.",
  "Otherwise Hapimatic pins an excerpt of this message itself.",
];

export type TurnCheckInput = { text: string; turnStartedAt?: number };

export type NudgeResult =
  | { action: "block"; reason: string }
  | { action: "none"; why: string };

export type DetectResult =
  | { action: "detected"; pin: Pin }
  | { action: "none"; why: string };

export type PinTurnCheckOptions = {
  pins: Pick<
    PinService,
    "listTurnCandidates" | "upsert" | "withdraw" | "listKeysByPrefix"
  >;
  getRecentMessages: (
    sessionId: string,
    options: { limit: number; sinceMs: number; maxChars: number }
  ) => Array<{ id: string; createdAt: number; content: unknown }>;
};

/**
 * The ask as a title: a lone line's question sentence, else the first line.
 * Scrubbed BEFORE it is capped: the approval-token marker is longer than a
 * token, so scrubbing a capped title could push it past the 200-character limit
 * and the pin would fail validation.
 */
function titleFrom(excerpt: string): string {
  const lines = excerpt
    .split("\n")
    .map(line => line.replace(/^\s{0,3}#{1,6}\s+|\*\*/g, "").trim())
    .filter(Boolean);
  let title = lines[0] ?? "Unpinned ask";
  if (lines.length === 1) {
    const sentences = title.split(/(?<=[.?!])\s+/);
    title =
      sentences.filter(s => s.includes("?")).at(-1) ??
      sentences.at(-1) ??
      title;
  }
  return capPinText(cleanPinText(title), TITLE_MAX_CHARS);
}

const KEY_CHAR = /[a-z0-9_]/;

/**
 * Whether `text` (normalized, lower case) names `key` as a whole token, so a
 * short key such as `plan` is not found inside "planning" or "plan-b".
 */
export function namesPinKey(text: string, key: string): boolean {
  const needle = key.toLowerCase();
  for (
    let at = text.indexOf(needle);
    at !== -1;
    at = text.indexOf(needle, at + 1)
  ) {
    const before = at === 0 ? "" : text[at - 1]!;
    const after = text[at + needle.length] ?? "";
    const next = text[at + needle.length + 1] ?? "";
    const openBefore = before === "" || !/[a-z0-9_.:-]/.test(before);
    const openAfter =
      after === "" ||
      (!KEY_CHAR.test(after) &&
        !(
          (after === "-" || after === ":" || after === ".") &&
          KEY_CHAR.test(next)
        ));
    if (openBefore && openAfter) return true;
  }
  return false;
}

function detectedKey(messageId: string): string {
  const key = `${DETECTED_PIN_PREFIX}${messageId}`;
  if (PinKeySchema.safeParse(key).success) return key;
  const hash = createHash("sha256").update(messageId).digest("hex");
  return `${DETECTED_PIN_PREFIX}h-${hash.slice(0, 24)}`;
}

export class PinTurnCheck {
  constructor(private readonly options: PinTurnCheckOptions) {}

  /** True when a pin already covers the ask in `text`. */
  private matched(
    sessionId: string,
    text: string,
    turnStartedAt?: number
  ): boolean {
    if (scanPinFences(text, { maxBlocks: 1 }).blocks.length > 0) return true;
    const candidates = this.options.pins.listTurnCandidates(sessionId);
    if (turnStartedAt !== undefined) {
      const since = turnStartedAt - TURN_SKEW_MS;
      if (candidates.some(p => p.createdAt >= since || p.updatedAt >= since)) {
        return true;
      }
    }
    const normalized = normalizeForMatch(text);
    return candidates.some(p => namesPinKey(normalized, p.key));
  }

  /** The Stop hook's question: block the turn end once, or let it end. */
  checkNudge(session: PinSessionRef, input: TurnCheckInput): NudgeResult {
    const signals = classifyDecisionSignals(input.text);
    if (signals.verdict === "none")
      return { action: "none", why: "no_signals" };
    if (this.matched(session.id, input.text, input.turnStartedAt)) {
      return { action: "none", why: "matched" };
    }
    const first = signals.signals[0] ?? "ask_question";
    const rest = NUDGE_REASON_TAIL.join(" ");
    const head = (quote: string) =>
      `📌 Pins: your last message ends with ${SIGNAL_LABELS[first]} ("${quote}"), and no open pin covers it.`;
    // The quote gives way, so the whole instruction always fits.
    const room = REASON_MAX_CHARS - rest.length - 1 - head("").length;
    const quote = capPinText(titleFrom(signals.excerpt), Math.max(20, room));
    return {
      action: "block",
      reason: capPinText(`${head(quote)} ${rest}`, REASON_MAX_CHARS),
    };
  }

  /**
   * Pin the newest unpinned ask of the turn as a Detected pin. Writes run inline:
   * the caller is an HTTP route (and, once #6456 lands, a server loop), never a
   * socket listener.
   */
  detect(
    session: PinSessionRef,
    input: { turnStartedAt?: number } = {}
  ): DetectResult {
    const messages = this.options.getRecentMessages(session.id, {
      limit: DETECT_MESSAGE_WINDOW,
      sinceMs:
        input.turnStartedAt === undefined
          ? 0
          : input.turnStartedAt - TURN_SKEW_MS,
      maxChars: DETECT_MESSAGE_MAX_CHARS,
    });
    for (const message of messages) {
      if (message.content === null) continue;
      const text = extractUserFacingAssistantTexts(message.content)
        .map(t => t.text)
        .join("\n");
      if (!text.trim()) continue;
      const signals = classifyDecisionSignals(text);
      if (signals.verdict === "none") continue;
      if (this.matched(session.id, text, input.turnStartedAt)) {
        return { action: "none", why: "matched" };
      }
      return this.writeDetected(session, message.id, signals.excerpt);
    }
    return { action: "none", why: "no_unpinned_ask" };
  }

  private writeDetected(
    session: PinSessionRef,
    messageId: string,
    excerpt: string
  ): DetectResult {
    const key = detectedKey(messageId);
    const title = titleFrom(excerpt);
    const quoted = capPinText(cleanPinText(excerpt), CONTEXT_EXCERPT_MAX_CHARS)
      .split("\n")
      .map(line => `> ${line}`)
      .join("\n");
    const parsed = PinContentSchema.safeParse({
      key,
      kind: "detected",
      title: title || "Unpinned ask",
      context: `${quoted}\n\nHapimatic found this in the chat; the agent did not pin it.`,
      stakes: "reversible",
      risk: "low",
      blocking: false,
      plainText: `Found in the chat, not pinned by the agent: ${capPinText(cleanPinText(excerpt), 1000)}`,
    } satisfies Partial<PinContent> & Record<string, unknown>);
    if (!parsed.success) return { action: "none", why: "invalid_content" };
    const outcome = this.options.pins.upsert(session, parsed.data, {
      anchor: { messageId, blockId: null, offsetPx: 0, anchorHeightPx: null },
    });
    if ("closed" in outcome) return { action: "none", why: "already_closed" };
    if ("missing" in outcome) return { action: "none", why: "missing" };
    if ("capped" in outcome)
      return { action: "none", why: `capped_${outcome.capped}` };
    // The same content on a dismissed pin is a no-op that returns the closed pin.
    if (outcome.pin.status !== "open")
      return { action: "none", why: "already_closed" };
    this.capOpenDetected(session);
    return { action: "detected", pin: outcome.pin };
  }

  /** At most `DETECTED_OPEN_MAX` open Detected pins: withdraw the oldest. */
  private capOpenDetected(session: PinSessionRef): void {
    const open = this.options.pins.listKeysByPrefix(
      session.id,
      DETECTED_PIN_PREFIX,
      "open"
    );
    for (const key of open.slice(
      0,
      Math.max(0, open.length - DETECTED_OPEN_MAX)
    )) {
      this.options.pins.withdraw(session, key);
    }
  }
}
