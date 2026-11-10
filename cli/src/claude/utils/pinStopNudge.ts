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
  | { kind: "failed"; detail: unknown };

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
      if (!resp.ok) return { kind: "failed", detail: resp.status };
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

  /** Ask the server to pin the ask itself once the message is stored. */
  function detectLater(state: TurnState): void {
    state.detectSent = true;
    const turnStartedAt = state.turnStartedAt;
    delay(() => {
      void post(
        withStart({ mode: "detect" }, turnStartedAt),
        DETECT_REQUEST_TIMEOUT_MS
      ).then(reply => logger.debug("[pinStopNudge] detect answered", reply));
    }, DETECT_DELAY_MS);
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
