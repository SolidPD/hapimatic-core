// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Transient "the session's node is offline or not responding" errors (issue #5375).
 *
 * The hub's remote-session availability guard answers a live session on a
 * briefly offline or unreachable federation node with `code: "node_offline"`
 * (503) or `code: "node_unreachable"` (502/504/500), carrying `nodeLabel` and
 * `retryAfterSeconds`. Those are transient: the web retries them quietly and
 * shows a reconnecting notice instead of the raw `HTTP <status> : <body>` text.
 *
 * `ApiError` is imported as a TYPE only — `api/client.ts` imports
 * `isNodeUnavailableCode` from here, so a runtime import back would create a
 * module cycle. The error check is therefore structural.
 */
import type { ApiError } from "@/api/client";

export const NODE_UNAVAILABLE_CODES = [
  "node_offline",
  "node_unreachable",
] as const;

export type NodeUnavailableCode = (typeof NODE_UNAVAILABLE_CODES)[number];

/**
 * Retry attempts for `node_offline` (≈ 105 s with the delays below and the
 * hub's 5 s hint). The hub answers these itself, so a retry never reaches the
 * node that is down.
 */
export const NODE_RETRY_MAX = 8;

/**
 * Retry attempts for `node_unreachable`. Each attempt reaches the peer, and a
 * timed-out read also lands here, so a slow request is not re-run eight times;
 * once the node is marked offline its errors become `node_offline` and the
 * longer, cheaper budget takes over.
 *
 * Worst case (#5410): 4 attempts, each held up to 25 s by the hub's federation
 * read timeout (`FEDERATION_READ_TIMEOUT_MS`), plus back-off delays of 5 s,
 * 10 s and 15 s from the hub's 5 s hint ≈ 130 s (up to ~136 s with jitter). A
 * peer that fails fast (connection refused) takes ≈ 30 s. The budget stays at 3
 * because the long tail moves to `node_offline` once the hub marks the node
 * offline.
 */
export const NODE_UNREACHABLE_RETRY_MAX = 3;

const NODE_RETRY_MIN_DELAY_MS = 3_000;
const NODE_RETRY_MAX_DELAY_MS = 15_000;
const NODE_RETRY_JITTER = 0.2;

export function isNodeUnavailableCode(
  code: unknown
): code is NodeUnavailableCode {
  return (
    typeof code === "string" &&
    (NODE_UNAVAILABLE_CODES as readonly string[]).includes(code)
  );
}

/** True for an ApiError whose body code says the session's node is unavailable. */
export function isNodeUnavailableError(err: unknown): err is ApiError {
  return (
    err instanceof Error &&
    typeof (err as { status?: unknown }).status === "number" &&
    isNodeUnavailableCode((err as { code?: unknown }).code)
  );
}

/** The node code of a transient node error, or null. */
export function nodeUnavailableCode(err: unknown): NodeUnavailableCode | null {
  return isNodeUnavailableError(err)
    ? ((err as { code: NodeUnavailableCode }).code ?? null)
    : null;
}

export type NodeUnavailableInfo = {
  nodeLabel: string | null;
  retryAfterSeconds: number | null;
};

/** Read the node label + retry hint the hub put in the error body. */
export function nodeUnavailableInfo(err: unknown): NodeUnavailableInfo {
  const empty: NodeUnavailableInfo = {
    nodeLabel: null,
    retryAfterSeconds: null,
  };
  if (!isNodeUnavailableError(err) || !err.body) return empty;
  try {
    const parsed = JSON.parse(err.body) as {
      nodeLabel?: unknown;
      retryAfterSeconds?: unknown;
    };
    return {
      nodeLabel:
        typeof parsed.nodeLabel === "string" && parsed.nodeLabel !== ""
          ? parsed.nodeLabel
          : null,
      retryAfterSeconds:
        typeof parsed.retryAfterSeconds === "number" &&
        Number.isFinite(parsed.retryAfterSeconds) &&
        parsed.retryAfterSeconds > 0
          ? parsed.retryAfterSeconds
          : null,
    };
  } catch {
    return empty;
  }
}

function labelOf(err: unknown, fallbackLabel?: string | null): string | null {
  return nodeUnavailableInfo(err).nodeLabel ?? fallbackLabel ?? null;
}

/**
 * Shown while the query is retrying. `node_unreachable` means the node did not
 * answer or answered with a transport-level error; neither says it is
 * restarting, so the message must not claim a restart (#5410).
 */
export function describeNodeUnavailable(
  err: unknown,
  fallbackLabel?: string | null
): string {
  const subject = labelOf(err, fallbackLabel) ?? "The session's node";
  return nodeUnavailableCode(err) === "node_unreachable"
    ? `${subject} isn't responding — reconnecting…`
    : `${subject} is restarting — reconnecting…`;
}

/**
 * Shown once the retry budget is spent. An offline node's sessions reload when
 * its status turns online again (useSessionNodeRecovery); a node that stays
 * marked online but is not answering has no such signal, so ask for a refresh.
 */
export function describeNodeUnavailableAfterRetries(
  err: unknown,
  fallbackLabel?: string | null
): string {
  const subject = labelOf(err, fallbackLabel) ?? "The session's node";
  return nodeUnavailableCode(err) === "node_unreachable"
    ? `${subject} isn't responding. Refresh to try again.`
    : `${subject} is offline. The session will reload when it is back.`;
}

/**
 * Global TanStack `retry`: `node_offline` retries up to NODE_RETRY_MAX times,
 * `node_unreachable` up to NODE_UNREACHABLE_RETRY_MAX; every other error keeps
 * the previous default (one retry).
 */
export function queryRetry(failureCount: number, err: unknown): boolean {
  const code = nodeUnavailableCode(err);
  if (code === "node_offline") return failureCount < NODE_RETRY_MAX;
  if (code === "node_unreachable") {
    return failureCount < NODE_UNREACHABLE_RETRY_MAX;
  }
  return failureCount < 1;
}

/**
 * Global TanStack `retryDelay`: node errors back off from the hub's
 * retryAfterSeconds hint (min 3 s), doubling, capped at 15 s, ±20 % jitter so
 * many clients do not re-hit the hub in lockstep; other errors keep TanStack's
 * default `min(1000 · 2^attempt, 30 s)`.
 */
export function queryRetryDelay(
  attempt: number,
  err: unknown,
  random: () => number = Math.random
): number {
  if (!isNodeUnavailableError(err)) {
    return Math.min(1000 * 2 ** attempt, 30_000);
  }
  const hintMs = (nodeUnavailableInfo(err).retryAfterSeconds ?? 0) * 1000;
  const baseMs = Math.max(hintMs, NODE_RETRY_MIN_DELAY_MS);
  const delay = Math.min(baseMs * 2 ** attempt, NODE_RETRY_MAX_DELAY_MS);
  const jitter = 1 + (random() * 2 - 1) * NODE_RETRY_JITTER;
  return Math.round(delay * jitter);
}

/** `ApiClient`'s message for a request its own timeout cut off. */
export const REQUEST_TIMED_OUT_MESSAGE = "Request timed out. Please try again.";

/** `ApiClient`'s message for a request whose caller aborted it. */
export const REQUEST_CANCELLED_MESSAGE = "Request was cancelled.";

/**
 * #5409: the request got no (complete) answer — `fetch()` rejected (offline,
 * DNS, connection refused or reset) or the body read dropped. `ApiClient`
 * wraps those TypeErrors; for session loads any other TypeError is a code bug
 * and is shown (classifySessionLoadFailure). Extends
 * TypeError so callers that test `instanceof TypeError` keep working.
 * Lives here (not api/client.ts) because client.ts imports from this module
 * and a runtime import back would create the cycle the header warns about.
 */
export class NetworkError extends TypeError {
  constructor(cause: unknown) {
    super(
      cause instanceof Error && cause.message
        ? cause.message
        : "Network request failed",
      { cause }
    );
    this.name = "NetworkError";
  }
}

/**
 * #5409: a transient session-load failure escalates from "Reconnecting…" to
 * its error message and a Retry button this long after the streak's first
 * settled error (with no data since)…
 */
export const RECONNECT_ESCALATE_AFTER_MS = 60_000;

/** …or once the streak reaches this many settled query errors. */
export const RECONNECT_ESCALATE_AFTER_FAILURES = 5;

/** HTTP statuses that mean "the hub or its gateway could not answer right now". */
const TRANSIENT_STATUSES = new Set([502, 503, 504]);

/**
 * Why a session failed to load (issue #5375):
 * - `not_found` — a definite 404: the session is gone (the only case that may
 *   show "Session not found" and clear the saved route).
 * - `transient` — the session's node or the hub is restarting or unreachable:
 *   a node code, a 502/503/504, or a request that got no answer at all
 *   (a `NetworkError`, a timeout, or a cancel).
 * - `failed` — any other error (403, 400, an expired login, or a plain
 *   TypeError, which is a code bug — #5409): show it.
 */
export type SessionLoadFailure = "not_found" | "transient" | "failed";

export function classifySessionLoadFailure(
  err: unknown
): SessionLoadFailure | null {
  if (!err) return null;
  if (isNodeUnavailableError(err)) return "transient";
  const status = (err as { status?: unknown }).status;
  if (err instanceof Error && typeof status === "number") {
    if (status === 404) return "not_found";
    return TRANSIENT_STATUSES.has(status) ? "transient" : "failed";
  }
  // No HTTP status: a tagged network failure, a timeout or a cancel is
  // transient; anything else (e.g. a plain TypeError, a code bug) is failed.
  if (err instanceof NetworkError) return "transient"; // fetch network failure (#5409)
  if (
    err instanceof Error &&
    (err.message === REQUEST_TIMED_OUT_MESSAGE ||
      err.message === REQUEST_CANCELLED_MESSAGE)
  ) {
    return "transient";
  }
  return "failed";
}
