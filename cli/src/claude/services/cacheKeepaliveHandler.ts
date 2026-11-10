// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #6169 (epic #6163, Sub C2) — the CLI half of the prompt-cache keep-alive.
 *
 * `CacheKeepaliveTracker` follows the SDK remote launcher's live query and keeps
 * the facts only the CLI knows exactly: when the last request that touched the
 * main cache started, the TTL of the last cache write, and whether a turn is in
 * flight. The launcher reports `snapshot()` on the keepAlive tick, so the server
 * knows when a session is due; the server then calls the `cache-keepalive` RPC,
 * answered by `createCacheKeepaliveHandler`, which re-checks everything and sends
 * Claude Code's `side_question` control request (`Query.askSideQuestion`).
 *
 * A side question runs as a one-shot fork on the main conversation's cache
 * prefix with no tools, no transcript line and no hooks, so the main agent never
 * sees it — a session parked at an approval gate stays parked. Its read renews
 * the cache. A read of an EXPIRED cache would write the whole prefix instead, so
 * every guard below errs toward not sending.
 */
import {
  CACHE_KEEPALIVE_MAX_AGE_MS,
  CACHE_KEEPALIVE_QUESTION,
  CacheKeepaliveRequestSchema,
  cacheTtlOfUsage,
  type CacheKeepaliveRefusalCode,
  type CacheKeepaliveResponse,
  type PromptCacheState,
  type PromptCacheTtl,
} from "@hapi/protocol";
import { SdkRequestError, type SideQuestionAnswer } from "@/claude/sdk/types";
import { logger } from "@/ui/logger";

/** Fits inside the server's fixed 30 s RPC timeout; fixtures answered in ~1 s. */
export const CACHE_KEEPALIVE_SIDE_QUESTION_TIMEOUT_MS = 25_000;

/**
 * The error Claude Code answers for a control request it does not know
 * (`Unsupported control request subtype: <subtype>`, also behind a
 * `[DirectConnect]` prefix on the Remote Control bridge; read from the 2.1.312
 * binary). Matched on this fixed phrase, so an unrelated error never switches
 * the feature off.
 */
const UNSUPPORTED_PATTERN = /Unsupported control request subtype/;

/** The slice of a stream message the tracker reads. */
interface StreamMessageLike {
  type?: unknown;
  subtype?: unknown;
  /** A `result`'s whole-turn usage. */
  usage?: unknown;
  /** An `assistant` message's API message, whose `usage` is that call's. */
  message?: unknown;
  /** Set (a tool-use id) on a subagent's messages; null or absent on the main chain's. */
  parent_tool_use_id?: unknown;
}

/**
 * Whether a call's (or a turn's) usage shows it read or wrote the prompt cache.
 * A request that failed before the model ran (an API error) shows neither.
 */
export function usageTouchedCache(usage: unknown): boolean {
  if (!usage || typeof usage !== "object") return false;
  const u = usage as {
    cache_read_input_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
  };
  const positive = (v: unknown): boolean => typeof v === "number" && v > 0;
  return (
    positive(u.cache_read_input_tokens) ||
    positive(u.cache_creation_input_tokens) ||
    cacheTtlOfUsage(usage) !== null
  );
}

export class CacheKeepaliveTracker {
  /** The start of the last request whose usage CONFIRMED it touched the cache. */
  private touchedAt: number | null = null;
  /** The start of the latest request of the current turn (not yet confirmed). */
  private requestStartAt: number | null = null;
  private touchedThisTurn = false;
  private ttl: PromptCacheTtl | null = null;
  private idleSince: number | null = null;
  private turnPending = false;
  private turnsCompleted = 0;
  private inputEnded = false;
  private configAtLastTurn: string | null = null;
  private toolsEpoch = 0;
  private toolsEpochAtLastTurn = 0;
  private inFlight = false;
  private unsupported = false;
  /** A side question succeeded in this process, so the binary supports it. */
  private supportedThisProcess = false;

  constructor(
    /** The session's model + effort identity, read at each turn end. */
    private readonly configFingerprint: () => string,
    private readonly now: () => number = Date.now
  ) {}

  /**
   * A new Claude process started (first launch, or a relaunch after a mode
   * change). It has no cache parameters until its first turn completes, so the
   * per-process facts reset; the cache clock and TTL carry over. The
   * `unsupported` latch resets too: the relaunch may run a newer binary.
   */
  onQueryStarted(): void {
    // `turnPending` is left alone: the launcher pushes the first prompt before
    // the query object exists, and a turn cut off by a relaunch stays pending
    // (refusing) until the next result.
    this.turnsCompleted = 0;
    this.inputEnded = false;
    this.inFlight = false;
    this.unsupported = false;
    this.supportedThisProcess = false;
  }

  /** A user message was handed to Claude: a turn starts with a new request. */
  onPromptPushed(): void {
    this.startTurn(this.now());
  }

  private startTurn(t: number): void {
    this.turnPending = true;
    this.touchedThisTurn = false;
    this.idleSince = null;
    this.requestStartAt = t;
  }

  /** A request that started at `requestStartAt` read or wrote the cache. */
  private confirmTouch(): void {
    if (this.requestStartAt === null) return;
    this.touchedAt = Math.max(this.touchedAt ?? 0, this.requestStartAt);
    this.touchedThisTurn = true;
  }

  /** The launcher stopped feeding this query (mode change parked a message, or abort). */
  onInputEnded(): void {
    this.inputEnded = true;
  }

  /** An MCP server was toggled: the tool list, the first part of the prefix, changed. */
  onToolsChanged(): void {
    this.toolsEpoch += 1;
  }

  /** Every SDK stream message, at the launcher's onMessage head. */
  onSdkMessage(message: StreamMessageLike): void {
    // A subagent's requests never move the main cache clock. Most build their
    // own prefix; a fork's may renew the main one too, and ignoring that only
    // leaves the clock earlier, which errs toward not sending.
    if (
      typeof message.parent_tool_use_id === "string" &&
      message.parent_tool_use_id !== ""
    ) {
      return;
    }
    const t = this.now();
    if (message.type === "system" && message.subtype === "init") {
      // A turn starts — including one Claude Code starts itself (a background
      // task notification), which no push precedes.
      if (!this.turnPending || this.requestStartAt === null) this.startTurn(t);
      return;
    }
    if (message.type === "user" && this.turnPending) {
      // A tool result: Claude Code sends the next request right after it.
      this.requestStartAt = t;
      return;
    }
    if (message.type === "assistant") {
      const call = message.message as { usage?: unknown } | undefined;
      if (call && usageTouchedCache(call.usage)) this.confirmTouch();
      return;
    }
    if (message.type === "result") {
      // Fallback for a stream whose assistant messages carried no usage: the
      // turn's own usage. A turn that ended on an API error shows none, and
      // leaves the cache clock where it was.
      if (!this.touchedThisTurn && usageTouchedCache(message.usage)) {
        this.confirmTouch();
      }
      this.turnPending = false;
      this.requestStartAt = null;
      this.idleSince = t;
      this.turnsCompleted += 1;
      this.ttl = cacheTtlOfUsage(message.usage) ?? this.ttl;
      this.configAtLastTurn = this.configFingerprint();
      this.toolsEpochAtLastTurn = this.toolsEpoch;
    }
  }

  /** The keepAlive-tick field; `null` until a request has touched the cache. */
  snapshot(): PromptCacheState | null {
    if (this.touchedAt === null) return null;
    return {
      touchedAt: this.touchedAt,
      ttl: this.ttl,
      idleSince: this.turnPending ? null : this.idleSince,
    };
  }

  /** Why a keep-alive must not be sent now, or `null` when it may. */
  refusal(
    isThinking: boolean,
    deadlineAt: number
  ): CacheKeepaliveRefusalCode | null {
    const t = this.now();
    if (this.unsupported) return "unsupported";
    if (this.inputEnded) return "input_ended";
    if (isThinking || this.turnPending) return "turn_in_flight";
    if (this.inFlight) return "in_flight";
    if (this.turnsCompleted === 0) return "no_turn_yet";
    if (this.ttl !== "1h") return "cache_ttl_not_1h";
    if (this.configFingerprint() !== this.configAtLastTurn)
      return "model_changed";
    if (this.toolsEpoch !== this.toolsEpochAtLastTurn) return "tools_changed";
    if (
      this.touchedAt === null ||
      t > deadlineAt ||
      t - this.touchedAt > CACHE_KEEPALIVE_MAX_AGE_MS
    ) {
      return "window_missed";
    }
    return null;
  }

  beginSend(): void {
    this.inFlight = true;
  }

  /** A keep-alive succeeded: its request read (and renewed) the cache at `sentAt`. */
  endSend(sentAt: number | null): void {
    this.inFlight = false;
    if (sentAt !== null && sentAt > 0) {
      // Never backwards: a prompt pushed during the side question may have
      // started a later request already.
      this.touchedAt = Math.max(this.touchedAt ?? 0, sentAt);
      this.supportedThisProcess = true;
    }
  }

  /**
   * Latch `unsupported` for this process; returns whether it latched. A process
   * whose binary already answered a side question is never latched.
   */
  markUnsupported(): boolean {
    if (this.supportedThisProcess || this.unsupported) return false;
    this.unsupported = true;
    return true;
  }
}

export interface CacheKeepaliveHandlerOptions {
  /** Read FRESH each call: null before launch, after teardown, or in local mode. */
  getQuery: () => {
    askSideQuestion(
      question: string,
      opts: { timeoutMs: number }
    ): Promise<SideQuestionAnswer>;
  } | null;
  tracker: CacheKeepaliveTracker;
  /** The session's own thinking flag (`SessionBase.thinking`). */
  isThinking: () => boolean;
  now?: () => number;
  timeoutMs?: number;
  /** Called once when the binary proves it has no `side_question` (default: the server error log). */
  onUnsupported?: (error: string) => void;
}

function reportUnsupported(error: string): void {
  logger.reportError({
    message: `[cache-keepalive] this Claude Code binary has no side_question; keep-alives are off until Claude relaunches: ${error}`,
    category: "cache-keepalive",
    severity: "warn",
  });
}

/**
 * The `cache-keepalive` RPC handler. Never sends a user message, never calls
 * `set_model`, never touches effort: the side question runs on the parameters
 * of the session's last turn. The answer text is discarded and never logged.
 */
export function createCacheKeepaliveHandler(
  opts: CacheKeepaliveHandlerOptions
): (params?: unknown) => Promise<CacheKeepaliveResponse> {
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? CACHE_KEEPALIVE_SIDE_QUESTION_TIMEOUT_MS;
  const onUnsupported = opts.onUnsupported ?? reportUnsupported;
  return async (params?: unknown): Promise<CacheKeepaliveResponse> => {
    const query = opts.getQuery();
    if (!query) {
      return {
        ok: false,
        code: "no_active_query",
        error:
          "No live Claude query — keep-alive needs the SDK remote launcher.",
      };
    }
    const parsed = CacheKeepaliveRequestSchema.safeParse(params);
    if (!parsed.success) {
      return {
        ok: false,
        code: "invalid_request",
        error: "deadlineAt is required",
      };
    }
    const refusal = opts.tracker.refusal(
      opts.isThinking(),
      parsed.data.deadlineAt
    );
    if (refusal) return { ok: false, code: refusal };

    opts.tracker.beginSend();
    const startedAt = now();
    let sentAt: number | null = null;
    try {
      const answer = await query.askSideQuestion(CACHE_KEEPALIVE_QUESTION, {
        timeoutMs,
      });
      if (answer.response === null || answer.synthetic) {
        // Claude Code answers with a synthetic (or no) answer when the fork's
        // request failed: no cache read is proven, so the clock stays put.
        const error = answer.synthetic
          ? "side question returned a synthetic answer"
          : "side question returned no answer";
        logger.debug(`[cache-keepalive] ${error}`);
        return { ok: false, code: "side_question_failed", error };
      }
      sentAt = answer.sentAt;
      const latencyMs = now() - startedAt;
      logger.debug(
        `[cache-keepalive] side question answered in ${latencyMs} ms (${answer.response?.length ?? 0} chars, discarded)`
      );
      return { ok: true, latencyMs };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const cause =
        err instanceof SdkRequestError && err.code ? err.code : undefined;
      if (UNSUPPORTED_PATTERN.test(error) && opts.tracker.markUnsupported()) {
        onUnsupported(error);
      }
      logger.debug(
        `[cache-keepalive] side question failed: ${error}${cause ? ` (${cause})` : ""}`
      );
      return {
        ok: false,
        code: "side_question_failed",
        error,
        ...(cause ? { cause } : {}),
      };
    } finally {
      opts.tracker.endSend(sentAt);
    }
  };
}
