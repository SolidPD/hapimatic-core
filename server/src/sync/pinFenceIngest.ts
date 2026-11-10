// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The `hapi_pin` fence reader (issue #6448, epic #6446): the fallback for an
 * agent with no MCP. A closed `hapi_pin` block in a stored assistant message goes
 * through the same `parsePinUpsert` and `PinService.upsert` as `pin_post`, so it
 * makes the same pin, anchored to that message.
 *
 * ## Where it runs, and the exception rule
 * `SyncEngine.handleRealtimeEvent` calls `onMessage` AFTER it has emitted the
 * message's own event, for every CLI-persisted message (the socket listener and
 * the busy-retry drainer). That is a socket listener's call, which has already
 * spent its one allowed blocking write on the message (`server/CLAUDE.md`
 * "Database"), so `onMessage` does no database work at all: it scans the text
 * and queues what it found. Every write — the pin, an `error_logs` row, the chat
 * notice — happens on the deferred drain, one queued item per `schedule` tick,
 * inside a try/catch. The server installs no `uncaughtException` handler, so a
 * throw from a timer callback would exit it; nothing here throws.
 *
 * ## What is read
 * One stored text unit at a time (`extractUserFacingAssistantTexts`): a Claude
 * text block, or a whole Codex message. Both are complete, so only closed fences
 * are read and an unclosed `hapi_pin` fence at the end is malformed. An ACP
 * agent's record is one chunk of a longer reply and is not read at all: a fence
 * split across chunks belongs with #6455/#6456, which assemble a turn's text
 * anyway and call `ingestText`.
 *
 * ## Failures
 * A block that is malformed, refused or fails to write makes no pin and never
 * throws. It is logged (category `pin-fence`, with the session, message and
 * reason, never the block's content) and posts one notice in the chat naming
 * the reason, as an agent event, never a user message, so it never re-prompts
 * the agent. A lost write lock is logged with `persist: false`, because an
 * `error_logs` insert would wait on the same lock, and is retried once after a
 * second with no notice, which would be another write on that lock. If the
 * retry loses the lock too, the block is dropped: the drop is logged in its own
 * category (`pin-fence-drop`), so the rate limit the `pin-fence` lines share
 * cannot hide it, and its notice follows after the same delay (a PM ruling on
 * #6448, superseding directive Task 7 steps 6-7). A fence has no tool result,
 * so without that notice the operator would never see the question and the
 * agent would wait for an answer that never comes.
 */
import {
  answerOnRecord,
  parsePinUpsert,
  PIN_FENCE_LANGUAGE,
  PIN_REQUEST_MAX_BYTES,
  scanPinFences,
} from "@hapi/protocol";
import type { ErrorLogger } from "../logging/errorLogger";
import { isSqliteBusy } from "../socket/handlers/cli/messageWriteRetryQueue";
import { extractUserFacingAssistantTexts } from "./needsReviewContent";
import type { PinService } from "./pinService";

/** Blocks read from one message; more are dropped and reported. */
export const PIN_FENCE_MAX_BLOCKS_PER_MESSAGE = 10;
/** Queued items across the node; an item past it is dropped and logged. */
export const PIN_FENCE_QUEUE_MAX = 32;
/**
 * A text unit longer than this is not scanned. Ten maximum-size pins fit well
 * inside it; the scan is linear, but a megabyte that is all fence lines still
 * costs tens of milliseconds on the event loop.
 */
export const PIN_FENCE_MAX_TEXT_CHARS = 1024 * 1024;
/** The one delayed retry after a lost write lock. */
export const PIN_FENCE_BUSY_RETRY_MS = 1000;

const LOG_CATEGORY = "pin-fence";
/**
 * A block dropped because its retry lost the write lock too. Its own category,
 * because ErrorLogger rate-limits per category and every `pin-fence` debug line
 * counts against that limit.
 */
const DROP_LOG_CATEGORY = "pin-fence-drop";
const NOTICE_PREFIX = "📌 A hapi_pin block in this message was not saved: ";
const BUSY_DROP_DETAIL =
  "the server's database stayed busy, so it was dropped. Ask the agent to post it again.";

export type PinFenceFailure =
  | "invalid_json"
  | "no_key"
  | "rejected"
  | "unclosed"
  | "too_large"
  | "too_many_blocks"
  | "pin_closed"
  | "cap_reached"
  | "write_failed"
  | "queue_full"
  | "busy";

type Origin = { sessionId: string; namespace: string; messageId: string };

type QueuedItem =
  | (Origin & {
      kind: "block";
      body: string;
      retried: boolean;
      /** Scan order across the node, so a late retry can tell it was overtaken. */
      seq: number;
    })
  | (Origin & { kind: "failure"; reason: PinFenceFailure; detail: string });

export type PinFenceIngestOptions = {
  pins: Pick<PinService, "upsert">;
  /** Persist a chat notice; `MessageService.persistPinFenceNotice` in production. */
  notify: (sessionId: string, text: string) => void;
  /** The Pins gate, read once at construction. A server writer that bypasses the routes must check it itself. */
  pinsEnabled: boolean;
  errorLogger?: ErrorLogger | null;
  /** Runs one drain step later; `setImmediate` by default, injectable for tests. */
  schedule?: (run: () => void) => void;
  /** Runs the busy retry later; `setTimeout` by default, injectable for tests. */
  delay?: (run: () => void, ms: number) => void;
};

/** A stored message as `handleRealtimeEvent` sees it. */
export type PinFenceMessage = { id: string; content: unknown };

/**
 * The flavor whose `codex`-envelope records are whole messages. Every other
 * flavor that uses the envelope is an ACP agent (`runAgentSession` sets the
 * flavor to the agent type), which stores each `agent_message_chunk` as its own
 * record, so one record can open or close a fence another record holds.
 */
const WHOLE_MESSAGE_FLAVOR = "codex";

export class PinFenceIngest {
  private readonly queue: QueuedItem[] = [];
  private draining = false;
  private seqCounter = 0;
  /**
   * Busy retries scheduled and not yet finished. While any is pending, each
   * written block records its `seq` by session and key, so a retry that a newer
   * block for the same key overtook is dropped rather than rolling the pin back.
   */
  private pendingRetries = 0;
  private readonly lastWrittenSeq = new Map<string, number>();
  private readonly schedule: (run: () => void) => void;
  private readonly delay: (run: () => void, ms: number) => void;

  constructor(private readonly options: PinFenceIngestOptions) {
    this.schedule = options.schedule ?? (run => setImmediate(run));
    this.delay =
      options.delay ??
      ((run, ms) => {
        setTimeout(run, ms).unref?.();
      });
  }

  /**
   * Scan a stored message for `hapi_pin` blocks and queue them. Called from the
   * socket listener's path, so it does no database work and never throws.
   */
  onMessage(
    sessionId: string,
    namespace: string | undefined,
    message: PinFenceMessage,
    flavor?: string | null
  ): void {
    try {
      if (!this.options.pinsEnabled) return;
      // The substring check runs on the extracted text, not the raw content: a
      // session that discusses Pins mentions the word in tool output and notes.
      const texts = extractUserFacingAssistantTexts(message.content).filter(t =>
        t.text.includes(PIN_FENCE_LANGUAGE)
      );
      if (texts.length === 0) return;
      if (!namespace) {
        this.consoleLog("no namespace for the session; fence not read", {
          sessionId,
          messageId: message.id,
        });
        return;
      }
      // A Claude text block is always whole, and so is a Codex message. An ACP
      // chunk is not read: an example fence the agent nested on purpose can open
      // in one chunk and close in another, so a chunk alone can show a block that
      // is not a pin. #6455/#6456 read the assembled turn through `ingestText`.
      const readable = texts.filter(
        t => t.complete || flavor === WHOLE_MESSAGE_FLAVOR
      );
      if (readable.length < texts.length) {
        this.consoleLog("chunked message; fence waits for the assembled turn", {
          sessionId,
          messageId: message.id,
          flavor: flavor ?? null,
        });
      }
      const origin = { sessionId, namespace, messageId: message.id };
      let budget = PIN_FENCE_MAX_BLOCKS_PER_MESSAGE;
      for (const { text } of readable) {
        const scanned = this.scan(origin, text, budget);
        // The cap is per message: once it is reported, the rest is not read.
        if (scanned.truncated) break;
        budget = scanned.left;
      }
    } catch (error) {
      this.consoleLog("fence scan failed", {
        sessionId,
        messageId: message?.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Scan an assembled, complete text (#6455/#6456 join a turn's ACP chunks from
   * stored rows, where a fence split across chunks becomes readable). Same rules
   * and the same queue as `onMessage`; an unclosed fence here is malformed.
   */
  ingestText(
    sessionId: string,
    namespace: string,
    messageId: string,
    text: string
  ): void {
    try {
      if (!this.options.pinsEnabled || !text.includes(PIN_FENCE_LANGUAGE)) {
        return;
      }
      this.scan(
        { sessionId, namespace, messageId },
        text,
        PIN_FENCE_MAX_BLOCKS_PER_MESSAGE
      );
    } catch (error) {
      this.consoleLog("fence scan failed", {
        sessionId,
        messageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Queue the blocks in one text, at most `budget` of them; returns the budget
   * left and whether the text held more. The scanner stops at the cap, so a text
   * full of blocks is not read to its end.
   */
  private scan(
    origin: Origin,
    text: string,
    budget: number
  ): { left: number; truncated: boolean } {
    if (text.length > PIN_FENCE_MAX_TEXT_CHARS) {
      // No notice: a long message that only mentions the word is not a failed pin.
      this.consoleLog("text over the scan limit; fence not read", {
        sessionId: origin.sessionId,
        messageId: origin.messageId,
        chars: text.length,
      });
      return { left: budget, truncated: false };
    }
    const { blocks, unclosed, truncated } = scanPinFences(text, {
      maxBlocks: budget,
    });
    for (const block of blocks) {
      this.enqueue({
        ...origin,
        kind: "block",
        body: block.body,
        retried: false,
        seq: ++this.seqCounter,
      });
    }
    if (truncated) {
      this.enqueue({
        ...origin,
        kind: "failure",
        reason: "too_many_blocks",
        detail: `only the first ${PIN_FENCE_MAX_BLOCKS_PER_MESSAGE} hapi_pin blocks in one message are read`,
      });
      return { left: 0, truncated: true };
    }
    if (unclosed) {
      // Every text read here is whole, so an open fence at its end is malformed.
      this.enqueue({
        ...origin,
        kind: "failure",
        reason: "unclosed",
        detail: "the block has no closing fence",
      });
    }
    return { left: budget - blocks.length, truncated: false };
  }

  /** Queue an item; false when the queue was full and the item was dropped. */
  private enqueue(item: QueuedItem): boolean {
    if (this.queue.length >= PIN_FENCE_QUEUE_MAX) {
      // No row and no notice: both are writes, and this is the listener's path.
      // A warning still, because the dropped pin leaves no other trace.
      this.warnWithoutRow("hapi_pin item dropped: queue full", {
        sessionId: item.sessionId,
        messageId: item.messageId,
        reason: "queue_full",
      });
      return false;
    }
    this.queue.push(item);
    this.kick();
    return true;
  }

  private kick(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      this.schedule(() => this.drainOne());
    } catch {
      // A drain that was never scheduled must not leave the queue stuck.
      this.draining = false;
    }
  }

  /** One queued item per tick, so a stalled write never holds the event loop for a batch. */
  private drainOne(): void {
    try {
      const item = this.queue.shift();
      if (item?.kind === "block") this.write(item);
      else if (item?.kind === "failure") {
        this.fail(item, item.reason, item.detail);
      }
    } catch (error) {
      this.consoleLog("fence drain step failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      try {
        if (this.queue.length > 0) this.schedule(() => this.drainOne());
        else this.draining = false;
      } catch {
        this.draining = false;
      }
    }
  }

  private write(item: Extract<QueuedItem, { kind: "block" }>): void {
    try {
      this.writeBlock(item);
    } finally {
      if (item.retried) this.retryFinished();
    }
  }

  private writeBlock(item: Extract<QueuedItem, { kind: "block" }>): void {
    if (Buffer.byteLength(item.body, "utf8") > PIN_REQUEST_MAX_BYTES) {
      this.fail(
        item,
        "too_large",
        `the block is over the ${PIN_REQUEST_MAX_BYTES}-byte limit`
      );
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(item.body);
    } catch {
      this.fail(item, "invalid_json", "the block is not valid JSON");
      return;
    }
    const key =
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>).key
        : undefined;
    if (typeof key !== "string") {
      this.fail(item, "no_key", "the block has no string key");
      return;
    }
    const parsed = parsePinUpsert(key, body);
    if (!parsed.ok) {
      this.fail(item, "rejected", parsed.error);
      return;
    }
    const writtenKey = `${item.sessionId}\u0000${key}`;
    if (item.retried && (this.lastWrittenSeq.get(writtenKey) ?? 0) > item.seq) {
      // A newer block for this key was written while this one waited out the
      // lock; writing it now would roll the pin back to older content.
      this.consoleLog("busy retry overtaken by a newer block; dropped", {
        sessionId: item.sessionId,
        messageId: item.messageId,
      });
      return;
    }

    let outcome: ReturnType<PinService["upsert"]>;
    try {
      outcome = this.options.pins.upsert(
        { id: item.sessionId, namespace: item.namespace },
        parsed.content,
        {
          reopen: parsed.reopen,
          anchor: {
            messageId: item.messageId,
            blockId: null,
            offsetPx: 0,
            anchorHeightPx: null,
          },
        }
      );
    } catch (error) {
      if (isSqliteBusy(error)) {
        this.busy(item);
        return;
      }
      this.fail(
        item,
        "write_failed",
        error instanceof Error ? error.message : String(error)
      );
      return;
    }
    if (this.pendingRetries > 0) {
      this.lastWrittenSeq.set(
        writtenKey,
        Math.max(this.lastWrittenSeq.get(writtenKey) ?? 0, item.seq)
      );
    }

    if ("closed" in outcome) {
      const answer = answerOnRecord(outcome.closed);
      const quoted = answer
        ? ` The answer on record: ${[answer.option, answer.label ?? answer.text].filter(Boolean).join(". ")}.`
        : "";
      this.fail(
        item,
        "pin_closed",
        `pin "${key}" is already ${outcome.closed.status}.${quoted} Add "reopen": true to ask again.`
      );
    } else if ("capped" in outcome) {
      this.fail(
        item,
        "cap_reached",
        outcome.capped === "open"
          ? "this session has too many open pins; withdraw or resolve some first"
          : "this session has too many pins, and none can be evicted"
      );
    }
    // A write or a no-op is silent. `missing` cannot happen: a fence never sets mustExist.
  }

  /**
   * A lost write lock, logged without a row (R11). The first is retried once
   * after a delay, with no notice. A second drops the block: the drop is logged
   * in its own category and its notice is queued after the same delay, so it
   * does not meet the same contention at once (the header's "Failures").
   */
  private busy(item: Extract<QueuedItem, { kind: "block" }>): void {
    if (item.retried) {
      this.warnDropped(item, "busy after its retry");
      this.later(() => {
        this.enqueue({
          sessionId: item.sessionId,
          namespace: item.namespace,
          messageId: item.messageId,
          kind: "failure",
          reason: "busy",
          detail: BUSY_DROP_DETAIL,
        });
      });
      return;
    }
    this.options.errorLogger?.warn("hapi_pin block not saved: busy", {
      category: LOG_CATEGORY,
      sessionId: item.sessionId,
      context: { messageId: item.messageId, reason: "busy", retry: true },
      persist: false,
    });
    this.pendingRetries += 1;
    const scheduled = this.later(
      () => {
        if (!this.enqueue({ ...item, retried: true })) {
          this.warnDropped(item, "queue full at its retry");
          this.retryFinished();
        }
      },
      () => this.retryFinished()
    );
    if (!scheduled) this.retryFinished();
  }

  /**
   * Run `run` after the busy delay. A timer callback must never throw
   * (server/CLAUDE.md "Database"), so a throw from `run` goes to `onError`, and
   * a failure to schedule returns false.
   */
  private later(run: () => void, onError: () => void = () => {}): boolean {
    try {
      this.delay(() => {
        try {
          run();
        } catch {
          try {
            onError();
          } catch {
            // Nothing more to do: the timer callback must not throw.
          }
        }
      }, PIN_FENCE_BUSY_RETRY_MS);
      return true;
    } catch {
      return false;
    }
  }

  /** A block dropped after a lost write lock: its own category, no row (R11). */
  private warnDropped(origin: Origin, why: string): void {
    try {
      this.options.errorLogger?.warn(`hapi_pin block dropped: ${why}`, {
        category: DROP_LOG_CATEGORY,
        sessionId: origin.sessionId,
        context: { messageId: origin.messageId, reason: "busy" },
        persist: false,
      });
    } catch {
      // Logging must never throw out of the drain or a timer.
    }
  }

  /** One scheduled retry is done (written, dropped or failed again). */
  private retryFinished(): void {
    this.pendingRetries = Math.max(0, this.pendingRetries - 1);
    if (this.pendingRetries === 0) this.lastWrittenSeq.clear();
  }

  /**
   * Log a failure (on the deferred drain, so a row is allowed) and post its
   * notice. A busy drop was already logged where it happened, without a row, so
   * only its notice is posted here, and a failed notice for it stays in the drop
   * category.
   */
  private fail(origin: Origin, reason: PinFenceFailure, detail: string): void {
    if (reason !== "busy") {
      this.options.errorLogger?.warn(`hapi_pin block not saved: ${reason}`, {
        category: LOG_CATEGORY,
        sessionId: origin.sessionId,
        context: { messageId: origin.messageId, reason, detail },
      });
    }
    try {
      this.options.notify(origin.sessionId, `${NOTICE_PREFIX}${detail}`);
    } catch (error) {
      const busy = isSqliteBusy(error);
      this.options.errorLogger?.warn("hapi_pin notice not posted", {
        category: reason === "busy" ? DROP_LOG_CATEGORY : LOG_CATEGORY,
        sessionId: origin.sessionId,
        context: {
          messageId: origin.messageId,
          reason: busy ? "busy" : "notice_failed",
          error: error instanceof Error ? error.message : String(error),
        },
        persist: !busy,
      });
    }
  }

  /** A warning with no `error_logs` row, for a drop the listener's path cannot write. */
  private warnWithoutRow(
    message: string,
    context: Record<string, unknown>
  ): void {
    try {
      this.options.errorLogger?.warn(message, {
        category: LOG_CATEGORY,
        context,
        persist: false,
      });
    } catch {
      // Logging must never throw out of the listener.
    }
  }

  /** A line with no `error_logs` row, for the listener's path and the drain's own faults. */
  private consoleLog(message: string, context: Record<string, unknown>): void {
    try {
      this.options.errorLogger?.debug(`hapi_pin: ${message}`, {
        category: LOG_CATEGORY,
        context,
        persist: false,
      });
    } catch {
      // Logging must never throw out of the listener.
    }
  }
}
