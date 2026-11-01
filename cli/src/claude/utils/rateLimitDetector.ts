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
 *      live 2026-06-10 incident transcripts). Claude Code writes
 *      `message.usage.service_tier: null` on it, which the transcript schema
 *      accepts since #6065 (before that the scanner dropped every such record).
 *      Current versions (2.1.282 onward, the oldest sampled) also write
 *      `quotaLimits.resetsAt` (epoch seconds), the value the text is formatted
 *      from; the rising edge prefers it and falls back to parsing the text
 *      (#6065).
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
import {
  extractApiLimitSignal,
  extractAssistantText,
  extractStructuredResetAt,
  isSyntheticAssistantRecord,
} from "./apiLimitSignal";

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
  /**
   * Best-effort epoch ms of the reset: Claude Code's structured value when the
   * record carries one, else the free-text parse; null when neither yields one.
   */
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
     * chip (it is not a usage window), so the transcript launchers (pty, tmux
     * and local, through `createSessionRateLimitDetector`) wire this to
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
        // #6065: the structured reset Claude Code recorded on the record is
        // exact; the text parse is the fallback (older versions, Shape B).
        const parsed = parseSessionLimitReset(text);
        const structured = extractStructuredResetAt(message);
        const info: RateLimitResetInfo = {
          resetText: parsed.resetText,
          resetAt: structured ?? parsed.resetAt,
        };
        logger.warn(
          `[rateLimitDetector]: session-limit 429 observed${
            sessionId ? ` for session ${sessionId}` : ""
          } — resets ${info.resetText} (source: ${
            structured !== null ? "structured" : "text"
          }) (issue #1647)`
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
 * A record Claude Code wrote itself (`model: "<synthetic>"`, e.g. "No response
 * requested.") is not model output, so it never clears the latch (#6065).
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
  if (isSyntheticAssistantRecord(message)) {
    return false;
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
 * `resetAt` is null whenever the wall-clock parse is uncertain. A null value
 * only leaves the server's #3612 reset nudge without a session value: it then
 * uses the account's usage snapshot, or leaves the lock to the ladder.
 *
 * @param now Epoch ms the reset is resolved against. Defaults to the current
 *   time; tests pin it.
 */
export function parseSessionLimitReset(
  text: string,
  now: number = Date.now()
): RateLimitResetInfo {
  const resetsMatch = text.match(/resets\s+(.+)$/i);
  const resetText = resetsMatch
    ? resetsMatch[1].trim()
    : text.replace(/^you've hit your session limit\s*[·:-]?\s*/i, "").trim() ||
      text.trim();

  return { resetText, resetAt: parseResetEpoch(resetText, now) };
}

/** Month abbreviation → month number (1–12). */
const MONTH_NUMBERS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const WEEKDAYS: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

/** `2pm`, `12:50pm`, `11:10 PM`. */
const CLOCK = /(\d{1,2})(?::(\d{2}))?\s*([ap]m)\b/i;

/** Month names, enumerated (not `[a-z]*`) so "marching" never reads as March. */
const MONTH_NAMES =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

/**
 * `Nov 4`, `Oct 17,`, `Jan 2, 2027`, `November 4th` — Claude Code renders a
 * reset more than 24 h away as month + day, adding the year only when it
 * differs from the current one (#6065).
 */
const MONTH_DAY = new RegExp(
  `\\b(${MONTH_NAMES})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`,
  "i"
);

/**
 * Any month name. A month name with no MONTH_DAY match (e.g. `4 Nov, 2pm`) is a
 * date form this parser does not know, so the reset is uncertain: null, never
 * the next clock time.
 */
const MONTH_NAME = new RegExp(`\\b(?:${MONTH_NAMES})\\b`, "i");

/**
 * `Mon 2pm`, `Monday, 2pm`. No sampled Claude Code version (2.1.282 to
 * 2.1.312) renders this form; it is
 * accepted so a weekday reset never reads as today or tomorrow (#6065 D9).
 * Enumerated so "monthly" never reads as Monday.
 */
const WEEKDAY =
  /\b(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)\.?(?=[\s,]|$)/i;

/** The first parenthesized token, e.g. `(UTC)` or `(America/New_York)`. */
const ZONE = /\(([^()]+)\)/;

/**
 * Best-effort wall-clock → epoch ms for a reset string. Accepted forms:
 *   - clock only, `2pm` / `12:50pm (America/New_York)`: the next time that
 *     wall clock occurs (today, else tomorrow);
 *   - month + day, `Oct 17, 3am (UTC)` / `Jan 2, 2027, 2pm (…)`: that calendar
 *     day, with no roll-forward (the year defaults to the current year in the
 *     zone, as Claude Code omits it only when it is unchanged);
 *   - weekday, `Mon 2pm`: the next occurrence of that weekday.
 * The first parenthesized token is the zone and must be one `Intl` accepts
 * (`UTC`, any IANA name); with none, the process's local zone is used. Returns
 * null on any uncertainty: no clock, an unknown zone, an impossible date.
 * Never throws.
 */
function parseResetEpoch(resetText: string, now: number): number | null {
  try {
    const zone = resetText.match(ZONE);
    let tz: string | undefined;
    if (zone) {
      tz = zone[1].trim();
      if (!isValidTimeZone(tz)) return null;
    }
    // Date and clock tokens come only from the text before the zone, so
    // trailing text such as "· progress saved" is never read as a date or clock.
    const body = zone ? resetText.slice(0, zone.index) : resetText;

    const clock = body.match(CLOCK);
    if (!clock) return null;
    let hour = parseInt(clock[1], 10);
    const minute = clock[2] ? parseInt(clock[2], 10) : 0;
    if (hour < 1 || hour > 12 || minute > 59) return null;
    if (hour === 12) hour = 0;
    if (clock[3].toLowerCase() === "pm") hour += 12;

    const today = tzParts(new Date(now), tz);
    if (!today) return null;

    const monthDay = body.match(MONTH_DAY);
    if (monthDay) {
      const month = MONTH_NUMBERS[monthDay[1].slice(0, 3).toLowerCase()];
      const day = parseInt(monthDay[2], 10);
      const year = monthDay[3] ? parseInt(monthDay[3], 10) : today.year;
      if (!isCalendarDate(year, month, day)) return null;
      return epochForTzWallClock(year, month, day, hour, minute, tz);
    }
    if (MONTH_NAME.test(body)) return null;

    const weekday = body.match(WEEKDAY);
    if (weekday) {
      const target = WEEKDAYS[weekday[1].slice(0, 3).toLowerCase()];
      const ahead = (target - today.weekday + 7) % 7;
      return nextOccurrenceEpoch(today, ahead, 7, hour, minute, tz, now);
    }

    return nextOccurrenceEpoch(today, 0, 1, hour, minute, tz, now);
  } catch {
    return null;
  }
}

/** True when `Intl` accepts `tz` as a time zone (`UTC`, `America/New_York`). */
function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** True when year-month-day names a real calendar date (no Feb 30). */
function isCalendarDate(year: number, month: number, day: number): boolean {
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

/**
 * The epoch ms of hour:minute on the calendar day `aheadDays` after `today`
 * (in `tz`, or local time when tz is undefined). If that instant is not after
 * `now`, step `stepDays` further (1 for a clock-only reset, 7 for a weekday).
 * The roll is built from the calendar date, never by adding a fixed 24 h, so a
 * DST change in between does not shift the wall clock. Returns null on any
 * failure (e.g. an invalid tz name).
 */
function nextOccurrenceEpoch(
  today: { year: number; month: number; day: number },
  aheadDays: number,
  stepDays: number,
  hour: number,
  minute: number,
  tz: string | undefined,
  now: number
): number | null {
  const onDay = (days: number): number | null => {
    const date = new Date(
      Date.UTC(today.year, today.month - 1, today.day + days)
    );
    return epochForTzWallClock(
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      date.getUTCDate(),
      hour,
      minute,
      tz
    );
  };
  const candidate = onDay(aheadDays);
  if (candidate === null) return null;
  return candidate > now ? candidate : onDay(aheadDays + stepDays);
}

/** Extract year/month/day/weekday for an instant as rendered in a timezone. */
function tzParts(
  date: Date,
  tz: string | undefined
): { year: number; month: number; day: number; weekday: number } | null {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
    });
    const parts = fmt.formatToParts(date);
    const get = (t: string) =>
      parseInt(parts.find(p => p.type === t)?.value ?? "", 10);
    const year = get("year");
    const month = get("month");
    const day = get("day");
    const weekday =
      WEEKDAYS[
        (parts.find(p => p.type === "weekday")?.value ?? "")
          .slice(0, 3)
          .toLowerCase()
      ];
    if ([year, month, day].some(Number.isNaN) || weekday === undefined) {
      return null;
    }
    return { year, month, day, weekday };
  } catch {
    return null;
  }
}

/**
 * Invert a wall-clock time in a timezone to an epoch ms. Formats a UTC guess
 * in the tz to measure the offset, corrects, then measures the offset AGAIN at
 * the corrected instant: when a DST change falls between the guess and the
 * answer, the two offsets differ by an hour and one pass lands an hour off
 * (#6065).
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
    const wanted = Date.UTC(year, month - 1, day, hour, minute);
    const offsetAt = (instant: number): number | null => {
      const seen = tzPartsFull(new Date(instant), tz);
      if (!seen) return null;
      const seenAsUTC = Date.UTC(
        seen.year,
        seen.month - 1,
        seen.day,
        seen.hour,
        seen.minute
      );
      return seenAsUTC - instant;
    };
    const firstOffset = offsetAt(wanted);
    if (firstOffset === null) return null;
    const secondOffset = offsetAt(wanted - firstOffset);
    if (secondOffset === null) return null;
    return wanted - secondOffset;
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
