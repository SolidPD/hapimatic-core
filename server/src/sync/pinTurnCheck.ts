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
 * was created or revised since the turn started; or (#6527, rulings Q2-A and
 * Q3-A) asks that each name an open pin in their own text, by key or pin ID: a
 * loop tick that points at a pin instead of re-asking. A named pin is an open pin
 * of this session (reserved Detected and prompt pins included) or, by pin ID, an
 * open pin of another session in the same namespace on this node; no other node
 * is asked, because the nudge has a 3.5 s budget. Every strong ask must name one,
 * so a message that points at a pin and asks something new is still nudged; a
 * weak ask is read as its whole ask tail. Dashboards are `live`, never `open`, so
 * a dashboard update never hides an ask.
 *
 * The Pins gate is the route's (cliPins.ts), which is the only caller today.
 */
import { createHash } from "node:crypto";
import {
  classifyDecisionSignals,
  findPinIds,
  PinContentSchema,
  PinKeySchema,
  scanPinFences,
  standsAsToken,
  type DecisionSignal,
  type DecisionSignals,
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
    | "listTurnCandidates"
    | "listOpenPinRefs"
    | "upsert"
    | "withdraw"
    | "listKeysByPrefix"
  >;
  getRecentMessages: (
    sessionId: string,
    options: { limit: number; sinceMs: number; maxChars: number }
  ) => Array<{ id: string; createdAt: number; content: unknown }>;
  /**
   * True only for a pin on this node whose status is `open` and whose session is
   * in `namespace` (ruling Q3-A). Build it with {@link openPinInNamespace}.
   */
  resolveOpenPinNamespace: (pinId: string, namespace: string) => boolean;
};

/**
 * `resolveOpenPinNamespace` over a by-ID pin read and a namespace-scoped session
 * read, the way `findLocalPinById` (pinById.ts) checks a pin's namespace.
 */
export function openPinInNamespace(deps: {
  getByPinId: (pinId: string) => { pin: Pin } | null;
  getSessionByNamespace: (sessionId: string, namespace: string) => unknown;
}): (pinId: string, namespace: string) => boolean {
  return (pinId, namespace) => {
    const hit = deps.getByPinId(pinId);
    if (!hit || hit.pin.status !== "open") return false;
    return Boolean(deps.getSessionByNamespace(hit.pin.sessionId, namespace));
  };
}

/** A leading list marker: `- `, `* `, `+ `, `1. `, `1) `, `A. `. */
const LIST_MARKER = /^(?:[-*+]|\d{1,2}[.)]|[A-Z]\d?[.)])[ \t]+/;
/** A sentence ends at `.`, `?` or `!`, even before a closing quote, bracket or `*`. */
const SENTENCE_SPLIT = /(?<=[.?!]["'\u201d\u2019)*]{0,3})\s+/;

/** One line of an excerpt without its heading marks, bold marks or list marker. */
function titleLine(line: string): string {
  return line
    .replace(/^\s{0,3}#{1,6}\s+|\*\*/g, "")
    .trim()
    .replace(LIST_MARKER, "")
    .trim();
}

/**
 * Whether a title is the classifier's question: any ask but an answer key or a
 * needs list, when the classifier found one. The nudge then calls the ask "a
 * question" (#6527), so its label and its quote agree.
 */
function titledByQuestion(
  signal?: DecisionSignal,
  question?: string | null
): boolean {
  const block = signal === "answer_key" || signal === "needs_from_you";
  return (
    !block && !!question && titleLine(question.replace(/\s+/g, " ")) !== ""
  );
}

/**
 * The ask as a title. An answer key or a needs list keeps its first line. Any
 * other ask takes the classifier's `question` (the last question of the ask's
 * own text, read past quotes, code spans and URLs) when there is one; else a
 * lone line's question sentence, else the first line.
 * Scrubbed BEFORE it is capped: the approval-token marker is longer than a
 * token, so scrubbing a capped title could push it past the 200-character limit
 * and the pin would fail validation.
 */
function titleFrom(
  excerpt: string,
  signal?: DecisionSignal,
  question?: string | null
): string {
  let title = titledByQuestion(signal, question)
    ? titleLine(question!.replace(/\s+/g, " "))
    : "";
  if (!title) {
    const lines = excerpt.split("\n").map(titleLine).filter(Boolean);
    title = lines[0] ?? "Unpinned ask";
    if (lines.length === 1) {
      const sentences = title.split(SENTENCE_SPLIT);
      title =
        sentences.filter(s => s.includes("?")).at(-1) ??
        sentences.at(-1) ??
        title;
    }
  }
  return capPinText(cleanPinText(title), TITLE_MAX_CHARS);
}

/**
 * Whether `text` (normalized, lower case) names `key` as a whole token, so a
 * short key such as `plan` is not found inside "planning" or "plan-b". The rule
 * is `standsAsToken`, which `findPinIds` shares.
 */
export function namesPinKey(text: string, key: string): boolean {
  const needle = key.toLowerCase();
  for (
    let at = text.indexOf(needle);
    at !== -1;
    at = text.indexOf(needle, at + 1)
  ) {
    if (standsAsToken(text, at, needle.length)) return true;
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

  /** True when a pin already covers the asks `signals` found in `text`. */
  private matched(
    session: PinSessionRef,
    text: string,
    signals: DecisionSignals,
    turnStartedAt?: number
  ): boolean {
    if (scanPinFences(text, { maxBlocks: 1 }).blocks.length > 0) return true;
    // Posted or revised this turn: the agent's own pins only, so a Detected pin
    // written earlier in the turn or a mirrored prompt never hides the last ask.
    const candidates = this.options.pins.listTurnCandidates(session.id);
    if (turnStartedAt !== undefined) {
      const since = turnStartedAt - TURN_SKEW_MS;
      if (candidates.some(p => p.createdAt >= since || p.updatedAt >= since)) {
        return true;
      }
    }
    // An ask cut from askTexts was never checked, so the message is not covered.
    if (signals.verdict === "decision" && signals.askTextsCut) return false;
    const asks =
      signals.verdict === "decision" ? signals.askTexts : [signals.matchText];
    if (asks.length === 0) return false;
    const refs = this.options.pins.listOpenPinRefs(session.id);
    const namesOpenPin = (ask: string): boolean =>
      refs.some(
        ref =>
          namesPinKey(ask, ref.key) ||
          (ref.pinId !== null && namesPinKey(ask, ref.pinId))
      ) ||
      findPinIds(ask).some(id =>
        this.options.resolveOpenPinNamespace(id, session.namespace)
      );
    return asks.every(namesOpenPin);
  }

  /** The Stop hook's question: block the turn end once, or let it end. */
  checkNudge(session: PinSessionRef, input: TurnCheckInput): NudgeResult {
    const signals = classifyDecisionSignals(input.text);
    if (signals.verdict === "none")
      return { action: "none", why: "no_signals" };
    if (this.matched(session, input.text, signals, input.turnStartedAt)) {
      return { action: "none", why: "matched" };
    }
    const first = signals.signals[0] ?? "ask_question";
    const label = titledByQuestion(first, signals.question)
      ? SIGNAL_LABELS.ask_question
      : SIGNAL_LABELS[first];
    const rest = NUDGE_REASON_TAIL.join(" ");
    const head = (quote: string) =>
      `📌 Pins: your last message ends with ${label} ("${quote}"), and no open pin covers it.`;
    // The quote gives way, so the whole instruction always fits. Its double
    // quotes become single ones: the reason wraps it in ("…"), and an agent that
    // echoes a title holding its own double quotes would nest them.
    const room = REASON_MAX_CHARS - rest.length - 1 - head("").length;
    const title = titleFrom(signals.excerpt, first, signals.question);
    const quote = capPinText(title.replaceAll('"', "'"), Math.max(20, room));
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
      if (this.matched(session, text, signals, input.turnStartedAt)) {
        return { action: "none", why: "matched" };
      }
      return this.writeDetected(
        session,
        message.id,
        signals.excerpt,
        titleFrom(signals.excerpt, signals.signals[0], signals.question)
      );
    }
    return { action: "none", why: "no_unpinned_ask" };
  }

  private writeDetected(
    session: PinSessionRef,
    messageId: string,
    excerpt: string,
    title: string
  ): DetectResult {
    const key = detectedKey(messageId);
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
