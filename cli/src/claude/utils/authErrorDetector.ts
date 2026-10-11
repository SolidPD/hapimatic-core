// SPDX-License-Identifier: MIT
/**
 * Detects auth-class API failures (HTTP 401/403 `authentication_error`) in the
 * message stream so launchers can fail FAST instead of burning their burst-load
 * retry budget on an unhealable condition (issue #1635, R3/R4).
 *
 * Why this exists: a session bound to a non-host account spawns native `claude`
 * against an isolated `.credentials.json` snapshot. When that snapshot has been
 * server-side revoked (refresh-token family rotation — see #1546/#1635), every
 * API call 401s and NO amount of respawning can heal it (the launcher resolves
 * the account binding ONCE per invocation, outside the retry loop). Before this
 * detector, the tmux launcher's R14 burst-load classifier (`isBurstLoadExit` —
 * exit-code + elapsed-time only, deliberately no stderr parsing) could not
 * distinguish an auth-dead exit from rate-limit burst, so it retry-looped 401s.
 *
 * The auth error surfaces in TWO shapes, mirroring SurrogateErrorDetector:
 *   1. Transcript launchers (pty/tmux/local) — the scanner reads either a raw
 *      `{ type: "system", subtype: "api_error", error: { status: 401, message:
 *      "401 {...authentication_error...}" } }` record (verified against the
 *      live 2026-06-09/10 incident transcripts) or a synthetic `{ type:
 *      "assistant", isApiErrorMessage: true, apiErrorStatus: 401 }` entry.
 *   2. SDK launcher — `{ type: "system", subtype: "api_error", error: {
 *      statusCode: 401, ... } }` injected by parseStderrApiError().
 *
 * Latch semantics: `authErrorObserved()` reports whether an auth-class error
 * has been seen SINCE the last forward-progress signal. A successful result or
 * a normal assistant message clears the latch — native Claude Code retries
 * internally (and CAN recover, e.g. a host session refreshing mid-turn), and a
 * recovered session must not have a later unrelated exit misattributed to auth.
 * The latch deliberately survives across R14 retry attempts (no reset between
 * attempts): the account binding is frozen per launcher invocation, so an auth
 * failure in attempt N implies attempt N+1 fails identically.
 */

import type { RawJSONLines } from "../types";
import { logger } from "@/ui/logger";

/**
 * Substrings that identify an auth-class API error in message text. Matched
 * only INSIDE the two api-error shapes (never against arbitrary message text),
 * so an assistant merely *talking about* authentication can never latch.
 */
export const AUTH_ERROR_SUBSTRINGS = [
  "authentication_error",
  "Invalid authentication credentials",
];

/** HTTP statuses treated as auth-class (unhealable by respawn). */
export const AUTH_ERROR_STATUSES = [401, 403];

const MAX_ERROR_LENGTH = 2000;

export class AuthErrorDetector {
  /** Latched while an auth error has been seen with no forward progress since. */
  private observed = false;
  /** Once-only guard for reportError + the optional callback. */
  private reported = false;
  /** Last matched error text (for launcher messaging). */
  private lastErrorText = "";

  /**
   * @param onAuthError Optional once-per-launcher-invocation callback fired on
   *   the FIRST auth-class error. Launchers typically do NOT terminate here —
   *   native may still self-recover — they consult {@link authErrorObserved}
   *   at the exit/retry decision point instead.
   */
  constructor(
    private readonly onAuthError?: (
      sessionId: string,
      errorText: string
    ) => void
  ) {}

  /** True while an auth-class error is latched (no success signal since). */
  authErrorObserved(): boolean {
    return this.observed;
  }

  /** The most recent matched auth error text ("" if none). */
  errorText(): string {
    return this.lastErrorText;
  }

  /**
   * Process a parsed JSONL/SDK-converted message. Call for every message
   * emitted by the session scanner or SDK-to-log converter (same seam as
   * ToolErrorDetector / SurrogateErrorDetector).
   */
  processMessage(message: RawJSONLines, sessionId: string | null): void {
    const hit = matchAuthError(message);
    if (hit !== null) {
      this.observed = true;
      this.lastErrorText = hit.slice(0, MAX_ERROR_LENGTH);
      if (!this.reported) {
        this.reported = true;
        logger.reportError({
          message:
            "Auth-class API error observed in session stream (issue #1635) — launcher will fail fast instead of burst-retrying",
          category: "auth-error",
          severity: "warn",
          sessionId: sessionId ?? undefined,
          context: JSON.stringify({ errorText: this.lastErrorText }),
        });
        if (sessionId) {
          this.onAuthError?.(sessionId, this.lastErrorText);
        }
      }
      return;
    }

    // Forward progress clears the latch: native recovered (e.g. mid-turn
    // refresh succeeded), so a later exit must not be blamed on auth.
    if (isSuccessSignal(message)) {
      this.observed = false;
    }
  }

  /**
   * Clear ALL state (latch + once-only report guard). NOT called between R14
   * retry attempts (the latch must survive them — see module doc); reserved
   * for launchers with full session-restart loops where the account binding is
   * re-resolved.
   */
  reset(): void {
    this.observed = false;
    this.reported = false;
    this.lastErrorText = "";
  }
}

/**
 * Returns the matched error text if `message` is an auth-class API error in
 * either surfacing shape, else null. Reads passthrough fields defensively.
 */
function matchAuthError(message: RawJSONLines): string | null {
  const msg = message as Record<string, unknown>;

  // Shape A — transcript assistant synthetic error (pty/tmux/local via scanner)
  if (msg.type === "assistant" && msg.isApiErrorMessage === true) {
    const status = msg.apiErrorStatus;
    const text = extractAssistantText(msg.message);
    if (isAuthStatus(status) || containsAuthSubstring(text)) {
      return text || `API error (status ${String(status)})`;
    }
  }

  // Shape B — system/api_error: raw transcript record (error.status) or SDK
  // synthetic (error.statusCode).
  if (msg.type === "system" && msg.subtype === "api_error") {
    const error = msg.error as Record<string, unknown> | undefined;
    if (error) {
      const status = error.status ?? error.statusCode;
      const text = String(error.message ?? error.body ?? "");
      if (isAuthStatus(status) || containsAuthSubstring(text)) {
        return text || `API error (status ${String(status)})`;
      }
    }
  }

  return null;
}

/**
 * A turn-terminating forward-progress signal that clears the latch (mirrors
 * SurrogateErrorDetector.isSuccessSignal):
 *  - a result message with is_error falsy
 *  - a normal assistant message (NOT an API error) — real model output
 */
function isSuccessSignal(message: RawJSONLines): boolean {
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

function isAuthStatus(status: unknown): boolean {
  return typeof status === "number" && AUTH_ERROR_STATUSES.includes(status);
}

function containsAuthSubstring(text: string): boolean {
  if (!text) return false;
  return AUTH_ERROR_SUBSTRINGS.some(sub => text.includes(sub));
}

/** Concatenate the text of an assistant message's content blocks. */
function extractAssistantText(inner: unknown): string {
  if (!inner || typeof inner !== "object") return "";
  const content = (inner as Record<string, unknown>).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(block => {
      if (block && typeof block === "object") {
        const text = (block as Record<string, unknown>).text;
        if (typeof text === "string") return text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}
