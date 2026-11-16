// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The Pins nudge (issue #6455, epic #6446): Claude Code asks the Stop hook
 * whether a turn may end. When the agent's last message asks the operator for
 * something and no pin covers it, the hook blocks the stop once with a reason
 * that asks the agent to pin it. When the agent still ends the turn without a
 * pin, the server pins an excerpt itself (a Detected pin).
 *
 * The classifier runs here first, so a turn that asks nothing costs no request.
 * The server decides the match (it holds the pins) and writes the Detected pin
 * from the stored message, never from text this process sends.
 *
 * Every failure lets the turn end: a broken nudge must never hold a session.
 * A nudge request the server never answered still has the server pin the ask.
 */
import {
  classifyDecisionSignals,
  DECISION_SIGNAL_MAX_CHARS,
  trimTrailingChars,
} from "@hapi/protocol";

import { logger } from "@/ui/logger";
import type { FetchLike } from "./startHappyServer";
import type { SessionHookData, StopHookDecision } from "./startHookServer";

/** Below the hook server's 4 s Stop budget, so a slow server lets the turn end. */
export const NUDGE_REQUEST_TIMEOUT_MS = 3500;
/** Time for the flagged message to reach the server's store before a detect. */
export const DETECT_DELAY_MS = 1500;
const DETECT_REQUEST_TIMEOUT_MS = 10_000;
/**
 * #6527 CR2-SF2: the one detect retry waits at least this long, so it outlasts
 * a server restart (the usual cause of a refused or 503 detect); a longer
 * `Retry-After` (the 429 rate limiter, a 503) wins, up to DETECT_RETRY_MAX_MS.
 */
export const DETECT_RETRY_DELAY_MS = 30_000;
export const DETECT_RETRY_MAX_MS = 120_000;

export type PinStopNudgeDeps = {
  selfSessionId: string;
  serverUrl: string;
  getCliApiToken: () => string | null | undefined;
  /** Tests inject a fetch; nothing is mocked. */
  fetchFn?: FetchLike;
  now?: () => number;
  delay?: (run: () => void, ms: number) => void;
};

export type PinStopNudge = {
  /** A turn opened (UserPromptSubmit): forget the last turn's nudge. */
  onTurnOpen(): void;
  /** The hook server's `onStopDecision`. Never throws. */
  onStop(data: SessionHookData): Promise<StopHookDecision | null>;
};

type TurnState = {
  turnStartedAt: number | undefined;
  nudged: boolean;
  detectSent: boolean;
};

/**
 * One turn-end request's outcome. `skip` means there is nothing to ask (no
 * token, or a 404 because the Pins gate closed); `failed` means the server
 * never decided (an error status, an unreadable body, a timeout or an
 * unreachable server).
 */
type TurnEndReply =
  | { kind: "answer"; body: unknown }
  | { kind: "skip" }
  | { kind: "failed"; detail: unknown; retryAfterMs?: number };

/** A `Retry-After` value (seconds, or an HTTP date) in ms; undefined if unreadable. */
function parseRetryAfterMs(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

export function createPinStopNudge(deps: PinStopNudgeDeps): PinStopNudge {
  const doFetch: FetchLike = deps.fetchFn ?? ((url, init) => fetch(url, init));
  const now = deps.now ?? Date.now;
  const delay =
    deps.delay ??
    ((run: () => void, ms: number) => {
      setTimeout(run, ms).unref?.();
    });
  const url = `${trimTrailingChars(deps.serverUrl, "/")}/cli/sessions/${encodeURIComponent(deps.selfSessionId)}/pins/turn-end`;
  let turn: TurnState = {
    turnStartedAt: undefined,
    nudged: false,
    detectSent: false,
  };

  async function post(body: object, timeoutMs: number): Promise<TurnEndReply> {
    const token = deps.getCliApiToken();
    if (!token) return { kind: "skip" };
    try {
      const resp = await doFetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Hapi-Session-Id": deps.selfSessionId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (resp.status === 404) return { kind: "skip" };
      if (!resp.ok) {
        return {
          kind: "failed",
          detail: resp.status,
          retryAfterMs: parseRetryAfterMs(resp.headers?.get("Retry-After")),
        };
      }
      return { kind: "answer", body: await resp.json() };
    } catch (error) {
      return { kind: "failed", detail: error };
    }
  }

  function withStart(body: object, turnStartedAt: number | undefined): object {
    return turnStartedAt === undefined ? body : { ...body, turnStartedAt };
  }

  async function nudge(
    text: string,
    state: TurnState
  ): Promise<StopHookDecision | null> {
    const reply = await post(
      withStart(
        { mode: "nudge", text: text.slice(-DECISION_SIGNAL_MAX_CHARS) },
        state.turnStartedAt
      ),
      NUDGE_REQUEST_TIMEOUT_MS
    );
    if (reply.kind === "failed") {
      // Nothing says a pin covers the ask, so let the turn end and have the
      // server pin it once the message is stored.
      logger.debug("[pinStopNudge] nudge request failed", reply.detail);
      detectLater(state);
      return null;
    }
    if (reply.kind === "skip") return null;
    const answer = reply.body as { action?: unknown; reason?: unknown } | null;
    if (
      answer?.action !== "block" ||
      typeof answer.reason !== "string" ||
      answer.reason.length === 0
    ) {
      return null;
    }
    state.nudged = true;
    return { decision: "block", reason: answer.reason };
  }

  /**
   * Ask the server to pin the ask itself once the message is stored. #6527
   * CR2-SF2: any failed detect (a timeout, a refused connection during a
   * restart, a 429, a 503) is sent once more after DETECT_RETRY_DELAY_MS or the
   * server's `Retry-After`, whichever is longer (capped). The retry is safe:
   * the server keys the Detected pin `detected:<messageId>`, so a detect that
   * did land the first time changes nothing. A `skip` (404: the gate closed,
   * or no token) is never retried. A failed nudge keeps the turn's one detect
   * (the sink's F2 note): it is what pins the ask when the nudge never got an
   * answer.
   */
  function detectLater(state: TurnState): void {
    state.detectSent = true;
    const body = withStart({ mode: "detect" }, state.turnStartedAt);
    const attempt = (retried: boolean): void => {
      // #6458 review D4: the server takes the newest matching message since
      // this turn's start, so once the next turn has opened a retry could pin
      // that turn's message, or one the operator already answered.
      if (retried && turn !== state) {
        logger.warn(
          "[pinStopNudge] detect not retried: a new turn started, so the earlier ask may be unpinned"
        );
        return;
      }
      void post(body, DETECT_REQUEST_TIMEOUT_MS).then(reply => {
        if (reply.kind === "failed" && retried) {
          logger.warn(
            "[pinStopNudge] detect failed twice; the ask is not pinned",
            reply.detail
          );
          return;
        }
        if (reply.kind === "failed") {
          const wait = Math.min(
            DETECT_RETRY_MAX_MS,
            Math.max(DETECT_RETRY_DELAY_MS, reply.retryAfterMs ?? 0)
          );
          logger.debug(
            `[pinStopNudge] detect failed; retrying once in ${wait} ms`,
            reply.detail
          );
          delay(() => attempt(true), wait);
          return;
        }
        logger.debug("[pinStopNudge] detect answered", reply);
      });
    };
    delay(() => attempt(false), DETECT_DELAY_MS);
  }

  return {
    onTurnOpen(): void {
      turn = { turnStartedAt: now(), nudged: false, detectSent: false };
    },

    async onStop(data: SessionHookData): Promise<StopHookDecision | null> {
      const state = turn;
      try {
        // Claude Code 2.1.312 sends the message. An older build gets no nudge
        // and, until #6456's turn-end detector lands, no Detected pin.
        const text = data.last_assistant_message;
        if (typeof text !== "string") return null;
        if (state.detectSent) return null;
        if (!state.nudged) {
          if (classifyDecisionSignals(text).verdict === "none") return null;
          if (data.stop_hook_active !== true) return await nudge(text, state);
        }
        // Nudged already, or another Stop hook is keeping the turn going: let
        // it end, and have the server pin the ask if the agent did not.
        detectLater(state);
        return null;
      } catch (error) {
        logger.debug("[pinStopNudge] Stop check failed", error);
        return null;
      }
    },
  };
}
