// SPDX-License-Identifier: MIT
/**
 * Detects Anthropic API errors in the Claude Code JSONL message stream and
 * reports them to the server's error log system via logger.reportError()
 * (issue #1232, epic #1231). Observation-only: no session control, no message
 * injection, no behavior change to running sessions.
 *
 * Two signals are captured:
 *   - Terminal retry exhaustion — an `assistant` message with
 *     `isApiErrorMessage: true` (the SDK gave up after its internal 10×
 *     exponential-backoff retries). Reported at severity "error",
 *     `context.phase: "exhausted"`. NEVER rate-limited.
 *   - In-progress retry / raw api_error record — a `system` message with
 *     `subtype: "api_error"`. Two first-class shapes converge here:
 *       Shape 2a (SDK synthetic, injected by parseStderrApiError in
 *         cli/src/claude/sdk/query.ts): carries retry metadata
 *         (retryAttempt/maxRetries/retryInSeconds/isThundering) and
 *         `error.type` / `error.statusCode`.
 *       Shape 2b (raw transcript record written to the on-disk JSONL by Claude
 *         Code, read on the local/pty/tmux scanner paths): `error.status` +
 *         `error.message`, NO retry metadata.
 *     Reported at severity "warn", `context.phase: "retrying"`, rate-limited to
 *     at most one per session per 60s.
 *
 * Spend-limit branch (#4936), checked FIRST: an assistant record the shared
 * classifier (`classifyApiLimitSignal`) calls a spend cap / user-set spend
 * limit is reported ONCE (deduped by record uuid) as `phase: "exhausted"`,
 * `errorType: "spend_limit_error"` — a terminal class the server never
 * auto-recovers — and is NOT also reported by Branch 1. It runs on every
 * launcher: on the SDK launcher the converter carries `apiErrorCode` but not
 * `isApiErrorMessage`, so Branch 1 never sees these records there.
 *
 * Single-session contract: each instance lives for the lifetime of one session
 * scanner. Launchers with a crash-restart loop (claudeRemoteLauncher) MUST call
 * reset() between attempts to clear rate-limit state so a recycled session does
 * not silently swallow its first retry report after restart.
 *
 * All field reads are defensive: RawJSONLines is `.passthrough()` and these
 * synthetic messages are not validated by Zod beyond the discriminated-union
 * `type` field, so a missing/renamed field degrades to undefined rather than
 * throwing.
 */

import type { RawJSONLines } from "../types";
import { logger } from "@/ui/logger";
import {
  canonicalizeErrorType,
  classifyApiLimitSignal,
  type ApiLimitClass,
  type ApiLimitSignal,
} from "@hapi/protocol/apiErrorClasses";
import { extractApiLimitSignal } from "./apiLimitSignal";

/** Max length for the report `message` and the `context.innerText` field. */
const MAX_MESSAGE_LENGTH = 500;
/** In-progress retry reports are rate-limited to one per session per window. */
const RETRY_REPORT_WINDOW_MS = 60_000;
/** Bound on the spend-limit uuid de-dup set (#4936). */
const SPEND_LIMIT_DEDUP_CAP = 64;

/**
 * Exact substrings identifying the Claude-Code-authored connection-drop /
 * stream-closed notice (#2487 Sub-Issue D, Task 1). Claude Code writes this text
 * ITSELF when a streaming connection drops mid-turn — an `assistant` message
 * carrying the text but NOT flagged `isApiErrorMessage`, so it matched neither
 * Branch 1 (`assistant && isApiErrorMessage === true`) nor Branch 2 (`system &&
 * api_error`) and produced no record at any layer. Mirrors the
 * `SURROGATE_400_SUBSTRINGS` precedent (`surrogateErrorDetector.ts`): a SHORT
 * exact-substring list, gated by the corroborating "API Error:" text-block
 * prefix, test-pinned so an Anthropic/Claude-Code reword fails loudly rather
 * than silently.
 */
export const CONNECTION_DROP_SUBSTRINGS = [
  "Connection closed mid-response",
  "The response above may be incomplete",
] as const;

/**
 * True if `text` is the client-authored connection-drop / stream-closed notice:
 * the first text block starts with "API Error:" AND contains a known
 * connection-drop substring. The two-part match keeps a normal assistant turn
 * that merely mentions "connection" from being misclassified.
 */
export function matchClientAuthoredApiError(text: string): boolean {
  if (!text.trimStart().startsWith("API Error:")) return false;
  return CONNECTION_DROP_SUBSTRINGS.some(sub => text.includes(sub));
}

export class ApiErrorDetector {
  /** Per-session timestamp of the last in-progress retry report (R3). */
  private readonly lastRetryReportAt = new Map<string, number>();
  /** Record uuids already reported as a spend limit (#4936; bounded, FIFO). */
  private readonly reportedSpendLimitUuids = new Set<string>();
  /** Injectable clock — defaults to Date.now(); tests inject a fixed clock. */
  private readonly getNow: () => number;

  constructor(opts?: { getNow?: () => number }) {
    this.getNow = opts?.getNow ?? (() => Date.now());
  }

  /**
   * Clear internal rate-limit state. Call between session attempts in launchers
   * with crash-restart loops so a recycled session does not swallow its first
   * retry report after restart (R4).
   */
  reset(): void {
    this.lastRetryReportAt.clear();
    this.reportedSpendLimitUuids.clear();
  }

  /**
   * Process a parsed JSONL message. Call for every message emitted by the
   * session scanner or SDK-to-log converter (same seam as ToolErrorDetector).
   *
   * Spend-limit branch (#4936), checked FIRST: an assistant record the shared
   *   classifier calls a spend cap / user-set spend limit → "error" with the
   *   terminal `spend_limit_error` class, once per record uuid; it then returns,
   *   so Branch 1 never also reports it.
   * Branch 1: terminal exhaustion (assistant + isApiErrorMessage) → "error".
   * Branch 2: in-progress retry / raw api_error (system + api_error) → "warn".
   * Branch 4 (#2487 D): client-authored connection-drop / stream-closed notice
   *   (assistant + NOT isApiErrorMessage + "API Error:" text signature) →
   *   "error" with the minted `connection_error` class. Mutually exclusive with
   *   Branch 1 by the `isApiErrorMessage !== true` guard, so it can never
   *   double-report a message Branch 1 already caught.
   * Branch 3: anything else → silently ignored.
   */
  processMessage(message: RawJSONLines, sessionId: string | null): void {
    if (!sessionId) return;
    const msg = message as Record<string, unknown>;

    // Spend-limit branch (#4936) — before Branch 1 so a spend-cap record is
    // reported once, as the terminal class, and never also as rate_limit_error.
    // Assistant records only: the turn's result frame is never matched.
    if (msg.type === "assistant") {
      const signal = extractApiLimitSignal(message);
      if (signal) {
        const cls = classifyApiLimitSignal(signal);
        if (cls.kind === "spend-limit") {
          this.reportSpendLimit(msg, sessionId, signal, cls);
          return;
        }
      }
    }

    if (msg.type === "assistant" && msg.isApiErrorMessage === true) {
      this.reportExhausted(msg, sessionId);
      return;
    }
    if (msg.type === "system" && msg.subtype === "api_error") {
      this.reportRetrying(msg, sessionId);
      return;
    }
    // Branch 4 (#2487 D): the Claude-Code-authored connection-drop notice is an
    // `assistant` message WITHOUT `isApiErrorMessage` (so it is disjoint from
    // Branch 1). Text-signature gated, like the SurrogateErrorDetector 400
    // branch. The sibling detectors treat this same shape as a success signal
    // (resetting their latches) — that is out of scope for D and left untouched.
    if (msg.type === "assistant" && msg.isApiErrorMessage !== true) {
      const inner = msg.message as Record<string, unknown> | undefined;
      const text = firstTextBlock(inner);
      if (text !== undefined && matchClientAuthoredApiError(text)) {
        this.reportExhausted(msg, sessionId, "connection_error");
      }
    }
    // Branch 3: any other message shape — no logging, no throwing.
  }

  /**
   * Branch 1 / Branch 4: terminal retry exhaustion. Never rate-limited.
   * `forcedErrorType` (Branch 4) overrides the normalized error type when the
   * class was determined by a text signature rather than an SDK `error` field.
   */
  private reportExhausted(
    msg: Record<string, unknown>,
    sessionId: string,
    forcedErrorType?: string
  ): void {
    const rawErrorType = typeof msg.error === "string" ? msg.error : undefined;
    const apiErrorStatus =
      typeof msg.apiErrorStatus === "number" ? msg.apiErrorStatus : undefined;
    const requestId =
      typeof msg.requestId === "string" ? msg.requestId : undefined;

    const inner = msg.message as Record<string, unknown> | undefined;
    const model =
      inner && typeof inner.model === "string" ? inner.model : undefined;
    const innerText = firstTextBlock(inner);

    // LC-2 normalization → D3 canonicalization: prefer the inner Anthropic error
    // type parsed from an embedded `API Error: {…}` JSON body; else the raw
    // top-level `error` string — canonicalized to the ONE class vocabulary
    // (#2487 D). Branch 4 passes `forcedErrorType` (a text-signature class).
    // #1234 gates recovery on this value; `rawErrorType` below preserves the
    // pre-canonical string for #2485's accounting when the two differ.
    const errorType =
      forcedErrorType ?? normalizeErrorType(rawErrorType, innerText);
    const rawDiffers =
      typeof rawErrorType === "string" && rawErrorType !== errorType;

    logger.reportError({
      message: `API error (exhausted): ${errorType ?? "unknown"} ${
        apiErrorStatus ?? ""
      } — ${innerText ?? ""}`.slice(0, MAX_MESSAGE_LENGTH),
      category: "api-error",
      severity: "error",
      sessionId,
      context: JSON.stringify({
        phase: "exhausted",
        // #2485 (R6): attributable provenance — which detector branch generated
        // this trigger. Additive only; kept MINIMAL because the server route
        // caps `context` at 2000 chars and silently drops an over-cap report.
        detector: "apiErrorDetector",
        detectorBranch: "reportExhausted",
        errorType,
        rawErrorType: rawDiffers ? rawErrorType : undefined,
        apiErrorStatus,
        requestId,
        model,
        innerText: innerText?.slice(0, MAX_MESSAGE_LENGTH),
      }),
    });
  }

  /**
   * Spend-limit branch (#4936): a terminal API spend cap / user-set spend
   * limit. Reported once per record uuid; never rate-limited (terminal, like
   * Branch 1). The context stays well under the route's 2,000-char cap.
   */
  private reportSpendLimit(
    msg: Record<string, unknown>,
    sessionId: string,
    signal: ApiLimitSignal,
    cls: Extract<ApiLimitClass, { kind: "spend-limit" }>
  ): void {
    const uuid = typeof msg.uuid === "string" ? msg.uuid : undefined;
    if (uuid !== undefined) {
      if (this.reportedSpendLimitUuids.has(uuid)) return;
      if (this.reportedSpendLimitUuids.size >= SPEND_LIMIT_DEDUP_CAP) {
        const oldest = this.reportedSpendLimitUuids.values().next().value;
        if (oldest !== undefined) this.reportedSpendLimitUuids.delete(oldest);
      }
      this.reportedSpendLimitUuids.add(uuid);
    }

    const requestId =
      typeof msg.requestId === "string" ? msg.requestId : undefined;
    const text = signal.text ?? "";

    logger.reportError({
      message: `API spend limit reached (${cls.variant}) — ${text}`.slice(
        0,
        MAX_MESSAGE_LENGTH
      ),
      category: "api-error",
      severity: "error",
      sessionId,
      context: JSON.stringify({
        phase: "exhausted",
        detector: "apiErrorDetector",
        detectorBranch: "reportSpendLimit",
        errorType: "spend_limit_error",
        limitVariant: cls.variant,
        resumesAt: cls.resumesAt ?? undefined,
        apiErrorStatus: signal.status,
        errorCode: signal.errorCode,
        requestId,
        innerText: text.slice(0, MAX_MESSAGE_LENGTH),
      }),
    });
  }

  /** Branch 2: in-progress retry / raw api_error record. Rate-limited (R3). */
  private reportRetrying(
    msg: Record<string, unknown>,
    sessionId: string
  ): void {
    // Rate limit: at most one report per session per window. Terminal
    // exhaustion (Branch 1) is never rate-limited.
    const last = this.lastRetryReportAt.get(sessionId);
    if (last !== undefined && this.getNow() - last < RETRY_REPORT_WINDOW_MS) {
      return;
    }
    this.lastRetryReportAt.set(sessionId, this.getNow());

    const error = msg.error as Record<string, unknown> | undefined;
    const errorType =
      error && typeof error.type === "string" ? error.type : undefined;
    // Shape 2b (transcript) uses `status`; Shape 2a (SDK synthetic) uses
    // `statusCode`.
    const statusCode =
      error && typeof error.status === "number"
        ? error.status
        : error && typeof error.statusCode === "number"
          ? error.statusCode
          : undefined;

    // Retry metadata is present only in Shape 2a; omit when absent so the
    // report never reads "attempt undefined/undefined in undefineds".
    const retryAttempt =
      typeof msg.retryAttempt === "number" ? msg.retryAttempt : undefined;
    const maxRetries =
      typeof msg.maxRetries === "number" ? msg.maxRetries : undefined;
    const retryInSeconds =
      typeof msg.retryInSeconds === "number" ? msg.retryInSeconds : undefined;
    const isThundering =
      typeof msg.isThundering === "boolean" ? msg.isThundering : undefined;
    const thunderingDurationSeconds =
      typeof msg.thunderingDurationSeconds === "number"
        ? msg.thunderingDurationSeconds
        : undefined;

    // A positive maxRetries marks a genuine retry countdown (Shape 2a "retry"
    // case); the 0/0 synthetics (thundering/api_error) carry no useful counts.
    const attempt =
      typeof retryAttempt === "number" &&
      typeof maxRetries === "number" &&
      maxRetries > 0
        ? ` attempt ${retryAttempt}/${maxRetries}`
        : "";
    const delay =
      typeof retryInSeconds === "number" && retryInSeconds > 0
        ? ` in ${retryInSeconds}s`
        : "";
    const label = errorType ?? statusCode ?? "unknown";

    logger.reportError({
      message: `API retry: ${label}${attempt}${delay}${
        isThundering ? " (thundering)" : ""
      }`.slice(0, MAX_MESSAGE_LENGTH),
      category: "api-error",
      severity: "warn",
      sessionId,
      context: JSON.stringify({
        phase: "retrying",
        // #2485 (R6): attributable provenance — which detector branch generated
        // this trigger. Additive only; kept MINIMAL because the server route
        // caps `context` at 2000 chars and silently drops an over-cap report.
        detector: "apiErrorDetector",
        detectorBranch: "reportRetrying",
        retryAttempt,
        maxRetries,
        retryInSeconds,
        isThundering,
        thunderingDurationSeconds: isThundering
          ? thunderingDurationSeconds
          : undefined,
        errorType,
        statusCode,
      }),
    });
  }
}

/**
 * LC-2 errorType normalization → D3 canonicalization (#2487 Sub-Issue D).
 * Returns the inner Anthropic error type parsed from an embedded
 * `API Error: {…}` JSON body (e.g. "overloaded_error") when the payload text
 * carries one, else the raw top-level value — then canonicalizes the result to
 * the ONE class vocabulary (`@hapi/protocol/apiErrorClasses`) on EVERY path,
 * including the raw fallback (the common real-data case: `rate_limit` →
 * `rate_limit_error`, `server_error` → `api_error`). An already-canonical or
 * unrecognized value passes through unchanged. Never throws.
 */
export function normalizeErrorType(
  rawValue: string | undefined,
  payloadText: string | undefined
): string | undefined {
  if (typeof payloadText === "string") {
    const braceIdx = payloadText.indexOf("{");
    if (braceIdx !== -1) {
      try {
        const parsed = JSON.parse(payloadText.slice(braceIdx)) as unknown;
        if (parsed && typeof parsed === "object") {
          const obj = parsed as Record<string, unknown>;
          const nested = obj.error as Record<string, unknown> | undefined;
          if (nested && typeof nested.type === "string" && nested.type) {
            return canonicalizeErrorType(nested.type);
          }
          // A bare `{"type":"overloaded_error"}` (no "error" wrapper). Skip the
          // wrapper's own `type: "error"`, which is not the error kind.
          if (
            typeof obj.type === "string" &&
            obj.type &&
            obj.type !== "error"
          ) {
            return canonicalizeErrorType(obj.type);
          }
        }
      } catch {
        // Payload is prose, not JSON (the common real-data case) — fall back.
      }
    }
  }
  return canonicalizeErrorType(rawValue);
}

/** First text block of an assistant message's content array, if any. */
function firstTextBlock(
  inner: Record<string, unknown> | undefined
): string | undefined {
  if (!inner) return undefined;
  const content = inner.content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as Record<string, unknown>).type === "text" &&
      typeof (block as Record<string, unknown>).text === "string"
    ) {
      return (block as Record<string, unknown>).text as string;
    }
  }
  return undefined;
}
