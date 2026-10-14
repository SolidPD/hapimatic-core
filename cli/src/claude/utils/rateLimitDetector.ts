// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Detects the Anthropic subscription SESSION-LIMIT rate-limit (HTTP 429) in the
 * session message stream so launchers can surface a "rate-limited — resets
 * {time}" state and clear the (now factually-wrong) thinking indicator
 * (issue #1647).
 *
 * Why this exists: when a turn aborts on a 429 session-limit error, the
 * transcript records a synthetic assistant entry — but under the tmux/pty
 * launchers NO `Stop` lifecycle hook fires (Claude Code only fires `Stop` on a
 * normally-completed response), so the #1611 hook-derived `thinking` latch
 * never clears and the web UI shows "thinking" indefinitely (the frozen-session
 * signature). Detecting the 429 here lets the launcher call
 * `session.setRateLimited(...)`, which both surfaces the chip AND clears
 * thinking at the TURN boundary (the launcher teardown `finally` only clears at
 * the PROCESS boundary, which a rate-limited-but-alive session never reaches).
 *
 * The 429 surfaces in TWO shapes, mirroring AuthErrorDetector (#1635):
 *   1. Transcript launchers (pty/tmux/local) — the scanner reads a synthetic
 *      `{ type: "assistant", isApiErrorMessage: true, apiErrorStatus: 429,
 *      error: "rate_limit", message.content[].text: "You've hit your session
 *      limit · resets 12:50pm (America/New_York)" }` entry (verified against the
 *      live 2026-06-10 incident transcripts).
 *   2. SDK launcher — `{ type: "system", subtype: "api_error", error: {
 *      status|statusCode: 429, message: "..." } }` injected by
 *      parseStderrApiError().
 *
 * Distinction from the transient infra 429: Anthropic ALSO emits
 * `"API Error: Server is temporarily limiting requests (not your usage limit) ·
 * Rate limited"` — a transient throttle Claude retries internally, carrying no
 * reset time. That is NOT a session limit: the chip MUST NOT fire for it (it
 * would show a misleading "resets {time}"). The session-limit gate below keys
 * off the "session limit" / "resets " text, not merely the 429 status.
 *
 * Latch semantics: the detector fires `onRateLimited` once on the RISING edge
 * (not-limited → limited) and stays latched while subsequent 429 records arrive
 * (a dead session re-emits the synthetic entry on each keepAlive). A
 * forward-progress signal (a normal assistant message or a success result)
 * clears the latch, so a session that resumes after the quota window resets and
 * later hits the limit again re-fires cleanly.
 *
 * Issue #3235: the FALLING edge (limited → not-limited) fires `onCleared` ONCE,
 * which launchers wire to `session.setRateLimited(null)`. This is the ONLY path
 * that clears the chip on genuine forward progress — `AgentSessionBase.
 * onThinkingChange` no longer nulls `rateLimited` (a bare turn-end, e.g. the
 * #1742 TurnEndDetector firing on the SAME refusal turn, used to clobber the
 * just-set chip so monitors always read null; the incident). Process teardown
 * clears it separately via each launcher's `finally`.
 */

import type { RawJSONLines } from "../types";
import { logger } from "@/ui/logger";
import {
  USAGE_WINDOW_SUBSTRINGS,
  classifyApiLimitSignal,
} from "@hapi/protocol/apiErrorClasses";
import { extractApiLimitSignal, extractAssistantText } from "./apiLimitSignal";

/** HTTP status treated as a (potential) rate limit. */
export const RATE_LIMIT_STATUS = 429;

/**
 * Substrings that identify a SESSION/USAGE limit (as opposed to the transient
 * "Server is temporarily limiting requests" infra throttle). Matched only
 * inside the two api-error shapes, never against arbitrary message text.
 *
 * #4936: the session-limit text test now lives in the shared classifier
 * (`classifyApiLimitSignal`, `@hapi/protocol/apiErrorClasses`) so a spend cap —
 * whose message also contains "usage limit" ("API usage limits") — is
 * classified BEFORE it, and never latches this chip. Re-exported for
 * back-compat.
 */
export const SESSION_LIMIT_SUBSTRINGS = USAGE_WINDOW_SUBSTRINGS;

const MAX_TEXT_LENGTH = 2000;

/** The parsed reset info handed to the launcher callback. */
export type RateLimitResetInfo = {
  /** Human-readable reset text, e.g. "12:50pm (America/New_York)". Always set. */
  resetText: string;
  /** Best-effort epoch ms of the reset; null when the free-text parse fails. */
  resetAt: number | null;
};

export class RateLimitDetector {
  /** Latched while a session-limit 429 has been seen with no forward progress since. */
  private limited = false;

  /**
   * @param onRateLimited Fired once on the rising edge of a session-limit 429.
   *   Launchers wire this to `session.setRateLimited({ ...info, since: Date.now() })`.
   */
  constructor(
    private readonly onRateLimited?: (
      sessionId: string,
      info: RateLimitResetInfo
    ) => void,
    /**
     * Issue #3235: fired ONCE on the FALLING edge (limited → not-limited) when a
     * forward-progress signal clears the latch. Launchers wire this to
     * `session.setRateLimited(null)` so the chip clears on genuine recovery — NOT
     * on a bare turn-end. Fired only on the transition, never on every
     * forward-progress record (else every assistant fragment triggers a keepAlive).
     */
    private readonly onCleared?: (sessionId: string) => void,
    /**
     * #4936: fired for each record the shared classifier calls an API spend
     * cap / user-set spend limit. Such a record never latches the session-limit
     * chip (it is not a usage window), so the tmux/pty launchers wire this to
     * `session.onThinkingChange(false)` to keep the turn-boundary "thinking"
     * clear the false "usage limit" match used to provide (`TurnEndDetector`
     * ignores synthetic records, and no Stop hook fires on API-error turns).
     */
    private readonly onSpendLimit?: (sessionId: string) => void
  ) {}

  /** True while a session-limit 429 is latched (no forward progress since). */
  rateLimitObserved(): boolean {
    return this.limited;
  }

  /**
   * Process a parsed JSONL/SDK-converted message. Call for every message emitted
   * by the session scanner or SDK-to-log converter (same seam as
   * ToolErrorDetector / AuthErrorDetector).
   */
  processMessage(message: RawJSONLines, sessionId: string | null): void {
    // #4936: a spend cap / user-set spend limit is not a usage window — no
    // latch, and not forward progress either. Clear "thinking" instead.
    const signal = extractApiLimitSignal(message);
    if (signal && classifyApiLimitSignal(signal).kind === "spend-limit") {
      if (sessionId) {
        this.onSpendLimit?.(sessionId);
      }
      return;
    }

    const text = matchSessionLimit429(message);
    if (text !== null) {
      if (!this.limited) {
        this.limited = true;
        const info = parseSessionLimitReset(text);
        logger.warn(
          `[rateLimitDetector]: session-limit 429 observed${
            sessionId ? ` for session ${sessionId}` : ""
          } — resets ${info.resetText} (issue #1647)`
        );
        if (sessionId) {
          this.onRateLimited?.(sessionId, info);
        }
      }
      return;
    }

    // Forward progress clears the latch so a post-reset re-limit re-fires.
    // Issue #3235: fire onCleared ONLY on the FALLING edge (limited → not) so the
    // launcher clears the rate-limited chip on genuine recovery, guarded so it
    // does not fire on every forward-progress record.
    if (isForwardProgress(message)) {
      if (this.limited) {
        this.limited = false;
        if (sessionId) {
          this.onCleared?.(sessionId);
        }
      }
    }
  }

  /**
   * Clear the latch. Reserved for launchers with full session-restart loops
   * (e.g. the SDK launcher's crash-restart path), mirroring the other detectors'
   * reset().
   */
  reset(): void {
    this.limited = false;
  }
}

/**
 * Returns the matched session-limit error text if `message` is a session-limit
 * 429 in either surfacing shape, else null. Reads passthrough fields
 * defensively (RawJSONLines is `.passthrough()`; these fields are untyped).
 *
 * #4936: the text test is the shared classifier's usage-window rule, so a
 * spend cap (whose message also says "usage limits") returns null here too.
 */
export function matchSessionLimit429(message: RawJSONLines): string | null {
  const msg = message as Record<string, unknown>;

  // Shape A — transcript assistant synthetic error (pty/tmux/local via scanner).
  if (msg.type === "assistant" && msg.isApiErrorMessage === true) {
    if (msg.apiErrorStatus === RATE_LIMIT_STATUS) {
      const text = extractAssistantText(msg.message);
      if (isUsageWindow429(text, msg.apiErrorCode)) {
        return text.slice(0, MAX_TEXT_LENGTH);
      }
    }
  }

  // Shape B — system/api_error: raw transcript record (error.status) or SDK
  // synthetic (error.statusCode).
  if (msg.type === "system" && msg.subtype === "api_error") {
    const error = msg.error as Record<string, unknown> | undefined;
    if (error) {
      const status = error.status ?? error.statusCode;
      if (status === RATE_LIMIT_STATUS) {
        const text = String(error.message ?? error.body ?? "");
        if (isUsageWindow429(text, extractApiLimitSignal(message)?.errorCode)) {
          return text.slice(0, MAX_TEXT_LENGTH);
        }
      }
    }
  }

  return null;
}

/** A 429 the shared classifier calls a subscription usage window (#4936). */
function isUsageWindow429(text: string, errorCode: unknown): boolean {
  return (
    classifyApiLimitSignal({
      status: RATE_LIMIT_STATUS,
      text,
      errorCode: typeof errorCode === "string" ? errorCode : undefined,
    }).kind === "usage-window"
  );
}

/**
 * A forward-progress signal that clears the latch (mirrors
 * AuthErrorDetector.isSuccessSignal):
 *  - a result message with is_error falsy
 *  - a normal assistant message (NOT an api error) — real model output
 */
function isForwardProgress(message: RawJSONLines): boolean {
  const msg = message as Record<string, unknown>;
  if (
    msg.type === "system" &&
    msg.subtype === "result" &&
    msg.is_error !== true
  ) {
    return true;
  }
  if (msg.type === "assistant" && msg.isApiErrorMessage !== true) {
    return true;
  }
  return false;
}

/**
 * Parse the free-text reset clause into a display string + best-effort epoch.
 * Pure + exported for unit testing. Degrades gracefully: `resetText` is always
 * populated (the substring after "resets ", or the trimmed whole text);
 * `resetAt` is null whenever the wall-clock parse is uncertain. Nothing in the
 * core feature depends on `resetAt` being non-null (issue #1647 — the optional
 * auto-resume stretch consumes it later).
 */
export function parseSessionLimitReset(text: string): RateLimitResetInfo {
  const resetsMatch = text.match(/resets\s+(.+)$/i);
  const resetText = resetsMatch
    ? resetsMatch[1].trim()
    : text.replace(/^you've hit your session limit\s*[·:-]?\s*/i, "").trim() ||
      text.trim();

  return { resetText, resetAt: parseResetEpoch(resetText) };
}

/**
 * Best-effort wall-clock → epoch ms for a reset string like
 * "12:50pm (America/New_York)" or "2pm". Returns null on any uncertainty.
 * Never throws.
 */
function parseResetEpoch(resetText: string): number | null {
  try {
    const m = resetText.match(/(\d{1,2})(?::(\d{2}))?\s*([ap]m)/i);
    if (!m) return null;
    let hour = parseInt(m[1], 10);
    const minute = m[2] ? parseInt(m[2], 10) : 0;
    const ampm = m[3].toLowerCase();
    if (hour === 12) hour = 0;
    if (ampm === "pm") hour += 12;
    if (hour > 23 || minute > 59) return null;

    const tzMatch = resetText.match(/\(([A-Za-z]+\/[A-Za-z_]+)\)/);
    const tz = tzMatch ? tzMatch[1] : undefined;

    return nextOccurrenceEpoch(hour, minute, tz);
  } catch {
    return null;
  }
}

/**
 * Compute the epoch ms of the next time the wall clock reads hour:minute in the
 * given IANA timezone (or local time when tz is undefined). If that instant is
 * already in the past relative to now, roll forward one day. Returns null on any
 * failure (e.g. an invalid tz name).
 */
function nextOccurrenceEpoch(
  hour: number,
  minute: number,
  tz: string | undefined
): number | null {
  const now = new Date();
  // Determine "today" in the target timezone.
  const partsNow = tzParts(now, tz);
  if (!partsNow) return null;

  let candidate = epochForTzWallClock(
    partsNow.year,
    partsNow.month,
    partsNow.day,
    hour,
    minute,
    tz
  );
  if (candidate === null) return null;
  if (candidate <= now.getTime()) {
    candidate += 24 * 60 * 60 * 1000; // roll to tomorrow
  }
  return candidate;
}

/** Extract year/month/day for an instant as rendered in a timezone. */
function tzParts(
  date: Date,
  tz: string | undefined
): { year: number; month: number; day: number } | null {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const parts = fmt.formatToParts(date);
    const get = (t: string) =>
      parseInt(parts.find(p => p.type === t)?.value ?? "", 10);
    const year = get("year");
    const month = get("month");
    const day = get("day");
    if ([year, month, day].some(Number.isNaN)) return null;
    return { year, month, day };
  } catch {
    return null;
  }
}

/**
 * Invert a wall-clock time in a timezone to an epoch ms. Uses the standard
 * "format a UTC guess in the tz, measure the offset, correct" technique.
 */
function epochForTzWallClock(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string | undefined
): number | null {
  try {
    const utcGuess = Date.UTC(year, month - 1, day, hour, minute);
    const seenParts = tzPartsFull(new Date(utcGuess), tz);
    if (!seenParts) return null;
    const seenAsUTC = Date.UTC(
      seenParts.year,
      seenParts.month - 1,
      seenParts.day,
      seenParts.hour,
      seenParts.minute
    );
    const offset = seenAsUTC - utcGuess;
    return utcGuess - offset;
  } catch {
    return null;
  }
}

function tzPartsFull(
  date: Date,
  tz: string | undefined
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
} | null {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    const parts = fmt.formatToParts(date);
    const get = (t: string) =>
      parseInt(parts.find(p => p.type === t)?.value ?? "", 10);
    const year = get("year");
    const month = get("month");
    const day = get("day");
    let hour = get("hour");
    const minute = get("minute");
    if (hour === 24) hour = 0; // some engines render midnight as 24
    if ([year, month, day, hour, minute].some(Number.isNaN)) return null;
    return { year, month, day, hour, minute };
  } catch {
    return null;
  }
}
