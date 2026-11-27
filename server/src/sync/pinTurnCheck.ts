// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The turn check (issue #6455, epic #6446; design D4, amended by #6738): does a
 * turn end on an ask that no pin covers?
 *
 * - `checkNudge` answers the Claude Code Stop hook: `block` with a reason that
 *   asks the agent to pin the decision, or `none`. It writes nothing, so it may
 *   take the text the session's wrapper sends. Both forms of the reason tell the
 *   agent that, when its message asks the operator nothing, it ends with "No
 *   decision is needed from you" and posts no pin; only the strong form says
 *   Hapimatic pins an excerpt itself.
 * - `detect` writes the Detected pin for a strong ask (`decision`) the agent
 *   neither pinned nor answered with a plain statement that nothing is asked
 *   ("nudge the agent, then pin it anyway" now holds only for that; Matt,
 *   2026-11-16, and the Pins PM's ruling Q1-1). A weak ask nudges once and is
 *   never pinned: the reply stands. It takes no text: the agent holds the CLI
 *   token, and `detected` is a kind only the server creates, so the text is read
 *   from the stored messages and the key is `detected:<messageId>`. It reads only
 *   the current turn, cut at the operator's own prompt, and classifies two kinds
 *   of message: the turn's final text row, and, when that is not strong, the
 *   message just before each stored Stop-hook record (the message a Stop hook
 *   judged), newest first. The turn-end detector (Sub-Issue J, #6456) will call
 *   the same `detect`, so the two will never pin one ask twice.
 * - A PM-managed peer (a session with the parent stamp, whose parent this node
 *   does not know to be gone or inactive) is never nudged or Detected-pinned:
 *   its PM pins what is the operator's (#6738, ruling Q2-1 as refined by RV-3).
 *
 * Every `none` answer names why: `no_signals`, `weak_signal`, `reply_stands`,
 * `nothing_asked`, `matched`, `no_unpinned_ask`, `managed_peer`, or a write
 * outcome (`already_closed`, `missing`, `capped_*`, `invalid_content`).
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
  answerKeyBlocks,
  classifyDecisionSignals,
  findPinIds,
  isCoverableAnswerCode,
  PIN_NUDGE_HEAD,
  PinKeySchema,
  scanPinFences,
  ServerPinContentSchema,
  standsAsToken,
  type DecisionSignal,
  type DecisionSignals,
  type Pin,
  type PinContent,
} from "@hapi/protocol";
import { unwrapRoleWrappedRecordEnvelope } from "@hapi/protocol/messages";
import type { ErrorLogger } from "../logging/errorLogger";
import {
  capPinText,
  cleanPinText,
  fitPinBody,
  isQuestionSentence,
  serverPinTitle,
  titleSentences,
} from "./pinText";
import {
  extractUserFacingAssistantTexts,
  isStopHookFeedbackRecord,
} from "./needsReviewContent";
import type { PinService, PinSessionRef } from "./pinService";
import { isOperatorUserMessage } from "./sentFrom";

/** The Detected pin's key prefix. */
export const DETECTED_PIN_PREFIX = "detected:";
/** Open Detected pins one session may hold; an extra one withdraws the oldest. */
export const DETECTED_OPEN_MAX = 10;
/** Pins and messages this close before the turn's start still count as this turn. */
export const TURN_SKEW_MS = 10_000;
/**
 * Stored messages a detection reads, newest first (#6738: was 20). A reply with
 * more than about 36 tool rows pushes the message a Stop hook judged out of it,
 * and that ask is then not pinned: a recorded limit for #6456.
 */
export const DETECT_MESSAGE_WINDOW = 40;
/** A stored message longer than this is skipped unparsed. */
export const DETECT_MESSAGE_MAX_CHARS = 64 * 1024;
/** A nudge reason's length, at most; the quote gives way, never the instructions. */
export const REASON_MAX_CHARS = 700;
const CONTEXT_EXCERPT_MAX_CHARS = 2000;
/** A Detected pin's title when its ask cannot be one (#6739, ruling RV-1). */
const DETECTED_FIXED_TITLE = "Unpinned ask";
/** The sentence after a Detected pin's quoted excerpt. */
const DETECTED_CONTEXT_NOTE =
  "Hapimatic found this in the chat; the agent did not pin it.";
/** A pin's text field, at most (`PIN_TEXT_MAX_CHARS` in shared/src/pins.ts). */
const PIN_BODY_MAX_CHARS = 16 * 1024;

export const SIGNAL_LABELS: Record<DecisionSignal, string> = {
  answer_key: "an answer key",
  needs_from_you: "a Needs from you list",
  needs_your: "a request for input",
  ask_question: "a question",
  consent_offer: "an offer awaiting consent",
  ask_statement: "a request to reply",
  trailing_question: "a question",
  option_list: "a list of options",
};

/**
 * The weak-ask nudge reason after the quote (verdict `ambiguous`): what to do,
 * and why. A weak ask is never pinned by Hapimatic (#6738), so it makes no
 * promise to pin. Its middle sentence tells an agent whose message asks the
 * operator nothing what to write instead of a pin (ruling RV-4).
 */
export const NUDGE_REASON_TAIL_WEAK = [
  "Always pin each decision or step the operator must act on (pin_post or a hapi_pin block) before ending your turn, and point to the pin instead of re-asking, because the chat scrolls away and the Pins tab keeps it.",
  'If your message asks the operator nothing, always end with the sentence "No decision is needed from you" and post no pin, because a pin must hold an ask.',
  "Always keep approval tokens out of pins, because pin text reaches the operator's reply, where a token approves.",
];
/**
 * The strong-ask nudge reason after the quote (verdict `decision`): the weak
 * form, then the pin Hapimatic writes when the agent neither pins the ask nor
 * says that nothing is asked.
 */
export const NUDGE_REASON_TAIL = [
  ...NUDGE_REASON_TAIL_WEAK,
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
    | "get"
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
  /**
   * True for a PM-managed peer (#6738, R12): its turns get no nudge and no
   * Detected pin. Build it with {@link managedPeerCheck}.
   */
  isManagedPeer: (sessionId: string) => boolean;
  /**
   * #6739: where a Detected pin's body cut or refused build is logged (debug,
   * not persisted), the prompt mirror's form. Optional: tests leave it out.
   */
  errorLogger?: ErrorLogger | null;
};

/** What this node knows of a parent session: whether it runs, and its lifecycle state. */
export type ParentSessionState = {
  active: boolean;
  lifecycleState?: string | null;
};

/**
 * `isManagedPeer` over two reads (#6738, R12; the expert review's ruling RV-3).
 * A session is a PM-managed peer when it carries the parent stamp
 * (`parentRelationship: "spawn"` with a `parentSessionId`, the stamp
 * `managesSession` in pinSubmission.ts reads) and this node does not know the
 * parent to be gone or inactive. `getParent` answers what this node knows of
 * the parent (its own session cache, then a hub's or peer's cache of remote
 * sessions), or null when it finds none; a parent found nowhere leaves the
 * session managed. A parent deleted here needs no test: its delete clears the
 * child's stamp. A `"branch"` session is not managed. A read that throws reads
 * as not managed, so the turn gets today's nudge.
 */
export function managedPeerCheck(deps: {
  getSession: (sessionId: string) =>
    | {
        parentSessionId?: string | null;
        parentRelationship?: string | null;
      }
    | null
    | undefined;
  getParent: (parentSessionId: string) => ParentSessionState | null | undefined;
}): (sessionId: string) => boolean {
  return sessionId => {
    try {
      const session = deps.getSession(sessionId);
      if (!session || session.parentRelationship !== "spawn") return false;
      const parentId = session.parentSessionId;
      if (typeof parentId !== "string" || parentId === "") return false;
      const parent = deps.getParent(parentId);
      if (!parent) return true;
      return parent.active === true && parent.lifecycleState !== "archived";
    } catch {
      return false;
    }
  };
}

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
 * The ask as a title (#6739, TITLE-D: an expanded pin shows its whole title, so
 * the server never cuts one). It is read from the classifier's uncut
 * `titleSource` (an answer key's or a needs list's first line, else the ask's
 * question, else its own sentence or line), never from the excerpt, whose
 * bounds would cut it. An ask whose excerpt is a lone line keeps that line's
 * last question sentence, else its last sentence, split by `titleSentences` (the
 * classifier's boundary with the title guards), so "e.g." and a URL's "?" do not
 * move the pick.
 * Scrubbed BEFORE it is measured or shortened: the approval-token marker is
 * longer than a token, and a scrub after the pick could leave part of a secret.
 * `serverPinTitle` then keeps a pick that fits 200 whole and makes longer prose
 * one complete sentence. Null when the pick does not fit
 * `PIN_SERVER_TITLE_MAX_CHARS`: the pin is then titled "Unpinned ask" with the
 * whole source quoted in its context.
 */
export function titleFrom(
  excerpt: string,
  titleSource?: string | null
): string | null {
  let line =
    titleLine((titleSource ?? "").replace(/\s+/g, " ")) || DETECTED_FIXED_TITLE;
  if (excerpt.split("\n").map(titleLine).filter(Boolean).length === 1) {
    const sentences = titleSentences(line);
    line =
      sentences.filter(isQuestionSentence).at(-1) ?? sentences.at(-1) ?? line;
  }
  return serverPinTitle(cleanPinText(line), "prose");
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

/**
 * #6456 (R4): the codes a Detected pin keeps for its message: every code of every
 * answer key, only when every ask of the message is an answer key whose fence
 * holds codes that can stand for options; else null, so no later pin's options
 * can settle an ask they do not hold.
 */
function detectedCodesOf(
  text: string,
  signals: DecisionSignals
): string[] | null {
  if (signals.verdict !== "decision" || signals.askTextsCut) return null;
  const blocks = answerKeyBlocks(text);
  if (blocks.length === 0) return null;
  const codes = new Set<string>();
  for (const ask of signals.askTexts) {
    const own = blocks.filter(block => block.askText === ask);
    if (own.length === 0) return null;
    for (const block of own) {
      if (!block.codes || block.codes.length === 0) return null;
      for (const code of block.codes) {
        if (!isCoverableAnswerCode(code)) return null;
        codes.add(code);
      }
    }
  }
  return codes.size > 0 ? [...codes] : null;
}

function detectedKey(messageId: string): string {
  const key = `${DETECTED_PIN_PREFIX}${messageId}`;
  if (PinKeySchema.safeParse(key).success) return key;
  const hash = createHash("sha256").update(messageId).digest("hex");
  return `${DETECTED_PIN_PREFIX}h-${hash.slice(0, 24)}`;
}

/** A stored row the turn check reads, newest first. */
type StoredRow = { id: string; createdAt: number; content: unknown };
/** A text row of the turn: its position in the newest-first rows, and its text. */
type TextRow = { at: number; id: string; text: string };

/**
 * Whether a stored row is the agent's (any `role: "agent"` row: a text, a tool
 * row, a Stop-hook record, a ready event). A row too large to parse has no
 * content and counts as the agent's, because a long tool output is by far the
 * likeliest such row.
 */
function isAgentRow(content: unknown): boolean {
  if (content === null) return true;
  return unwrapRoleWrappedRecordEnvelope(content)?.role === "agent";
}

/**
 * The current turn's rows, newest first (#6738, R5): every row newer than the
 * turn's operator prompt. Going newest first, an operator row with no agent row
 * newer than it is passed over, because a prompt the operator queued mid-turn is
 * sent the moment the turn ends and is stored before `detect` runs; the first
 * operator row with an agent row after it cuts the window. A lane report or a
 * PM relay (`meta.origin.sessionId`) is no operator prompt and does not cut.
 */
function currentTurn(rows: readonly StoredRow[]): StoredRow[] {
  const turn: StoredRow[] = [];
  let agentNewer = false;
  for (const row of rows) {
    if (row.content !== null && isOperatorUserMessage(row.content)) {
      if (agentNewer) break;
      continue;
    }
    if (isAgentRow(row.content)) agentNewer = true;
    turn.push(row);
  }
  return turn;
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
    // #6456 (R3): an answer key also counts as covered when every code of its
    // own fence is an option ID of an open agent pin of the session. Read from
    // the text, never from `excerpt` (the last block only, cut at 1,200).
    const keyed = signals.verdict === "decision" ? answerKeyBlocks(text) : [];
    let optionIds: Set<string> | null = null;
    const openOptionIds = (): Set<string> => {
      if (optionIds) return optionIds;
      optionIds = new Set();
      for (const candidate of candidates) {
        const pin = this.options.pins.get(session.id, candidate.key)?.pin;
        for (const option of pin?.options ?? []) optionIds.add(option.id);
      }
      return optionIds;
    };
    const coveredByCodes = (ask: string): boolean => {
      // Two keys with one ask text are covered only when both blocks are.
      const blocks = keyed.filter(block => block.askText === ask);
      if (blocks.length === 0) return false;
      return blocks.every(
        block =>
          block.codes !== null &&
          block.codes.length > 0 &&
          block.codes.every(
            code => isCoverableAnswerCode(code) && openOptionIds().has(code)
          )
      );
    };
    return asks.every(ask => namesOpenPin(ask) || coveredByCodes(ask));
  }

  /** The Stop hook's question: block the turn end once, or let it end. */
  checkNudge(session: PinSessionRef, input: TurnCheckInput): NudgeResult {
    if (this.options.isManagedPeer(session.id)) {
      return { action: "none", why: "managed_peer" };
    }
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
    // A weak ask is never pinned (#6738), so only the strong form says so.
    const rest = (
      signals.verdict === "decision"
        ? NUDGE_REASON_TAIL
        : NUDGE_REASON_TAIL_WEAK
    ).join(" ");
    const head = (quote: string) =>
      `${PIN_NUDGE_HEAD} ${label} ("${quote}"), and no open pin covers it.`;
    // The quote gives way, so the whole instruction always fits. Its double
    // quotes become single ones: the reason wraps it in ("…"), and an agent that
    // echoes a title holding its own double quotes would nest them.
    const room = REASON_MAX_CHARS - rest.length - 1 - head("").length;
    // A title past the server's limit (#6739) quotes its scrubbed source the
    // same way; either is re-cut to the reason's room, for the agent only.
    const title =
      titleFrom(signals.excerpt, signals.titleSource) ??
      cleanPinText(signals.titleSource ?? "")
        .replace(/\s+/g, " ")
        .trim();
    const quote = capPinText(title.replaceAll('"', "'"), Math.max(20, room));
    return {
      action: "block",
      reason: capPinText(`${head(quote)} ${rest}`, REASON_MAX_CHARS),
    };
  }

  /**
   * Pin the turn's unpinned strong ask as a Detected pin (#6738, R4): the final
   * text row F when it is strong; else the newest strong message a Stop hook
   * judged (the text row just before a stored Stop-hook record), unless a text
   * row after that record says plainly that nothing is asked, or F, weak, names
   * an open pin. A weak ask is never pinned. Writes run inline: the caller is an
   * HTTP route (and, once #6456 lands, a server loop), never a socket listener.
   */
  detect(
    session: PinSessionRef,
    input: { turnStartedAt?: number } = {}
  ): DetectResult {
    if (this.options.isManagedPeer(session.id)) {
      return { action: "none", why: "managed_peer" };
    }
    const turn = currentTurn(
      this.options.getRecentMessages(session.id, {
        limit: DETECT_MESSAGE_WINDOW,
        sinceMs:
          input.turnStartedAt === undefined
            ? 0
            : input.turnStartedAt - TURN_SKEW_MS,
        maxChars: DETECT_MESSAGE_MAX_CHARS,
      })
    );
    // Positions in the newest-first rows are seq order (messageStore); a
    // `createdAt` is never compared.
    const texts: TextRow[] = [];
    const records: number[] = [];
    turn.forEach((row, at) => {
      if (row.content === null) return;
      if (isStopHookFeedbackRecord(row.content)) {
        records.push(at);
        return;
      }
      const text = extractUserFacingAssistantTexts(row.content)
        .map(t => t.text)
        .join("\n");
      if (text.trim()) texts.push({ at, id: row.id, text });
    });
    const final = texts[0];
    if (!final) return { action: "none", why: "no_unpinned_ask" };
    const classified = new Map<TextRow, DecisionSignals>();
    const signalsOf = (row: TextRow): DecisionSignals => {
      let signals = classified.get(row);
      if (!signals) {
        signals = classifyDecisionSignals(row.text);
        classified.set(row, signals);
      }
      return signals;
    };
    const finalSignals = signalsOf(final);
    if (finalSignals.verdict === "decision") {
      return this.pinUnlessMatched(session, final, finalSignals, input);
    }
    // Each record's judged message is the first text row older than it; a
    // judged message's own record is the oldest that judged it (ruling RV-5).
    const judged = new Map<TextRow, number>();
    for (const record of records) {
      const row = texts.find(t => t.at > record);
      if (row) judged.set(row, Math.max(judged.get(row) ?? -1, record));
    }
    const ask = [...judged.entries()]
      .sort(([a], [b]) => a.at - b.at)
      .find(([row]) => signalsOf(row).verdict === "decision");
    if (!ask) {
      if (records.some(record => record > final.at)) {
        return { action: "none", why: "reply_stands" };
      }
      return {
        action: "none",
        why:
          finalSignals.verdict === "ambiguous"
            ? "weak_signal"
            : "no_unpinned_ask",
      };
    }
    const [askRow, askRecord] = ask;
    // The agent's plain "nothing is asked" after the nudge stands (ruling Q1-1).
    if (texts.some(t => t.at < askRecord && signalsOf(t).nothingAsked)) {
      return { action: "none", why: "nothing_asked" };
    }
    if (
      finalSignals.verdict === "ambiguous" &&
      this.matched(session, final.text, finalSignals, input.turnStartedAt)
    ) {
      return { action: "none", why: "matched" };
    }
    return this.pinUnlessMatched(session, askRow, signalsOf(askRow), input);
  }

  /** Write `row`'s strong ask as a Detected pin, unless a pin covers it. */
  private pinUnlessMatched(
    session: PinSessionRef,
    row: TextRow,
    signals: DecisionSignals,
    input: { turnStartedAt?: number }
  ): DetectResult {
    if (this.matched(session, row.text, signals, input.turnStartedAt)) {
      return { action: "none", why: "matched" };
    }
    return this.writeDetected(
      session,
      row.id,
      signals.excerpt,
      titleFrom(signals.excerpt, signals.titleSource),
      cleanPinText(signals.titleSource ?? ""),
      detectedCodesOf(row.text, signals)
    );
  }

  /**
   * Write a Detected pin. `title` is `titleFrom`'s (null when the ask is past the
   * server's title limit) and `titleSource` the scrubbed uncut source. The first
   * build is the titled one, with the excerpt capped as before. When the title is
   * null or that build is refused (the 32 KiB content limit), it is built once
   * more under "Unpinned ask" with the whole source quoted first (when the
   * excerpt does not hold it), then the excerpt, so nothing of the ask is cut
   * from a title (#6739, ruling RV-1). That body is bounded only by the pin's own
   * limits: when it cannot fit them it is cut at a word, marked "…", and logged.
   * A pin refused twice is logged and answers `invalid_content`.
   */
  private writeDetected(
    session: PinSessionRef,
    messageId: string,
    excerpt: string,
    title: string | null,
    titleSource: string,
    codes: string[] | null = null
  ): DetectResult {
    const key = detectedKey(messageId);
    const cleanExcerpt = cleanPinText(excerpt);
    const quote = (text: string): string =>
      text
        .split("\n")
        .map(line => `> ${line}`)
        .join("\n");
    const build = (pinTitle: string, quoted: string): PinContent | null => {
      const parsed = ServerPinContentSchema.safeParse({
        key,
        kind: "detected",
        title: pinTitle,
        context: `${quote(quoted)}\n\n${DETECTED_CONTEXT_NOTE}`,
        stakes: "reversible",
        risk: "low",
        blocking: false,
        plainText: `Found in the chat, not pinned by the agent: ${capPinText(cleanExcerpt, 1000)}`,
      } satisfies Partial<PinContent> & Record<string, unknown>);
      return parsed.success ? parsed.data : null;
    };
    let content = title
      ? build(title, capPinText(cleanExcerpt, CONTEXT_EXCERPT_MAX_CHARS))
      : null;
    if (!content) {
      const flat = (text: string): string => text.replace(/\s+/g, " ").trim();
      const source = flat(titleSource);
      const whole =
        source && !flat(cleanExcerpt).includes(source)
          ? `${titleSource.trim()}\n\n${cleanExcerpt}`
          : cleanExcerpt;
      const fitted = fitPinBody(whole, PIN_BODY_MAX_CHARS, body =>
        build(DETECTED_FIXED_TITLE, body)
      );
      if (fitted?.cut) {
        this.log("a Detected pin's quoted ask was cut to fit", session.id, {
          title: title === null ? "past the limit" : "refused",
          chars: whole.length,
        });
      }
      content = fitted?.pin ?? null;
    }
    if (!content) {
      this.log("a Detected pin was refused twice", session.id, {
        chars: titleSource.length,
      });
      return { action: "none", why: "invalid_content" };
    }
    const outcome = this.options.pins.upsert(session, content, {
      anchor: { messageId, blockId: null, offsetPx: 0, anchorHeightPx: null },
      // #6456 (R4): the answer-key codes a later agent pin's options may cover.
      detectedCodes: codes,
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

  /**
   * A debug line in the prompt mirror's form, never persisted (#6739). The
   * session and figures go into the line: ErrorLogger prints only the message.
   */
  private log(
    message: string,
    sessionId: string,
    context: Record<string, unknown>
  ): void {
    const line = `${message} (session ${sessionId}, ${JSON.stringify(context)})`;
    this.options.errorLogger?.debug(`pin turn check: ${line}`, {
      category: "pin-turn",
      sessionId,
      context,
      persist: false,
    });
  }

  /**
   * At most `DETECTED_OPEN_MAX` open Detected pins: withdraw the oldest. A pin
   * the operator reopened (#6456, R8) is neither closed by the cap nor counted
   * toward it, and the cap records no closure: it is a plain withdrawal, not a
   * settlement.
   */
  private capOpenDetected(session: PinSessionRef): void {
    const open = this.options.pins.listKeysByPrefix(
      session.id,
      DETECTED_PIN_PREFIX,
      "open",
      { notReopened: true }
    );
    for (const key of open.slice(
      0,
      Math.max(0, open.length - DETECTED_OPEN_MAX)
    )) {
      this.options.pins.withdraw(session, key);
    }
  }
}
