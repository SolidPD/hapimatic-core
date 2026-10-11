// SPDX-License-Identifier: AGPL-3.0-only
/**
 * #3177: pure decision logic for the in-thread activity placeholder — the
 * "someone is working" row at the thread tail whenever the user is waiting.
 *
 * Kept free of React and of the clock (callers pass `nowMs`) so every case in the
 * 2026-09-17 operator ruling is unit-testable. `useThinkingPlaceholder` owns the
 * state that needs memory across renders (the send-time localId, the hide-hold).
 *
 * Triggers (either one shows the placeholder):
 * - (a) send-time: this client's last send is the thread's last user message and
 *   nothing has come back for it yet. Survives the optimistic bubble being
 *   replaced by its server echo (the echo keeps the `localId`, drops `status`).
 * - (b) running + quiet tail: the turn is running (`session.thinking` or a
 *   RECENT running tool — the #3505 recency bound) and the tail of the running
 *   turn is not itself showing activity.
 */
import type { ChatBlock, UserTextBlock } from "@/chat/types";
import {
  THINKING_PLACEHOLDER_ID,
  thinkingPlaceholderText,
} from "@/chat/reasoningPlaceholder";

/** R3: keep the placeholder this long after the signal drops, so a keepAlive
 * flap in `session.thinking` does not flicker it. */
export const PLACEHOLDER_HOLD_MS = 400;

/** R7: a send with no signal and no content after this long reads "waiting". */
export const PLACEHOLDER_STALL_MS = 20_000;

export const WAITING_LABEL = "waiting for the session to start…";
export const WORKING_LABEL = "working…";

export type TurnTail = {
  /**
   * `live`  — the tail block is itself an activity signal (running tool card,
   *           pending permission prompt, streaming-tail reasoning sweep).
   * `quiet` — nothing at the tail shows activity (includes "no content yet").
   * `over`  — a `turn-result` (SDK) or a same-turn `turn-duration` (claude
   *           pty/tmux, #4102) closed the turn after the last user message.
   */
  state: "quiet" | "live" | "over";
  lastUser: UserTextBlock | null;
  /** Any non-event block after the last user message. */
  hasPostUserContent: boolean;
};

function hasPendingPermission(block: ChatBlock): boolean {
  if (block.kind !== "tool-call") return false;
  if (block.tool.permission?.status === "pending") return true;
  return block.children.some(hasPendingPermission);
}

/**
 * A block that closes the running turn. The Claude SDK launcher ends a turn
 * with `turn-result`; the claude pty/tmux launchers write `turn-duration`
 * (#4095) after the turn's stop hooks — only for a completed turn (never on
 * abort), and deferred past later prompts while background work runs. Its
 * clock is measured from the turn's start, so a record whose start precedes
 * the last user message belongs to an EARLIER turn (deferred, or the message
 * was queued behind a running turn) and must not end this one (#4102).
 */
function isTurnEnd(block: ChatBlock, lastUser: UserTextBlock | null): boolean {
  if (block.kind !== "agent-event") return false;
  if (block.event.type === "turn-result") return true;
  if (block.event.type !== "turn-duration") return false;
  // AgentEvent's open catch-all member keeps `duration_ms` unknown after the
  // type check; a malformed record is not a turn end (today's behavior).
  const durationMs = block.event.duration_ms;
  if (typeof durationMs !== "number") return false;
  if (lastUser === null) return true;
  return block.createdAt - durationMs >= lastUser.createdAt;
}

/**
 * Events that answer the user's message. Only the Claude SDK launcher emits a
 * `turn-result`; a completed claude pty/tmux turn ends on its `turn-duration`
 * (#4102). On the pty/tmux, Codex and ACP paths a crash, a stop or a failed
 * prompt arrives ONLY as one of these notices ("Process exited unexpectedly",
 * "Aborted by user", …), so without them the pending send would never end.
 */
const REPLY_EVENT_TYPES: ReadonlySet<string> = new Set([
  "message",
  "api-error",
  "limit-reached",
  "gate-denied",
  // #4936: the spend-limit stop notice answers the send (the turn failed).
  "spend-limit-reached",
]);

function isReplyEvent(block: ChatBlock): boolean {
  return (
    block.kind === "agent-event" && REPLY_EVENT_TYPES.has(block.event.type)
  );
}

/**
 * Classifies the tail of the running turn in `blocks` (the RAW reduced blocks —
 * never the placeholder-augmented array).
 *
 * `outputOnlyHidden` (Q-A, option 1): when tools AND reasoning are both hidden,
 * `AssistantMessage` folds a running non-permission tool card and reasoning
 * behind the reveal row, so they show no activity — count them as QUIET. A
 * pending permission prompt always renders (the safety floor), so it stays LIVE.
 */
export function classifyTurnTail(
  blocks: readonly ChatBlock[],
  outputOnlyHidden: boolean
): TurnTail {
  let userIdx = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].kind === "user-text") {
      userIdx = i;
      break;
    }
  }
  const lastUser = userIdx >= 0 ? (blocks[userIdx] as UserTextBlock) : null;

  let tail: ChatBlock | null = null;
  let hasPostUserContent = false;
  for (let i = blocks.length - 1; i > userIdx; i--) {
    const block = blocks[i];
    if (isTurnEnd(block, lastUser)) {
      // A turn end (turn-result / turn-duration) with nothing after it: the
      // turn is over.
      if (tail === null)
        return { state: "over", lastUser, hasPostUserContent: true };
      break;
    }
    // A reply notice counts as (quiet) content; other events show no activity.
    if (block.kind === "agent-event" && !isReplyEvent(block)) continue;
    hasPostUserContent = true;
    if (tail === null) tail = block;
  }

  if (tail === null) return { state: "quiet", lastUser, hasPostUserContent };

  let live = false;
  if (tail.kind === "tool-call") {
    const running =
      tail.tool.state === "running" || tail.tool.state === "pending";
    live = running && (!outputOnlyHidden || hasPendingPermission(tail));
  } else if (tail.kind === "agent-reasoning") {
    live = !outputOnlyHidden;
  }
  return { state: live ? "live" : "quiet", lastUser, hasPostUserContent };
}

/** "thinking…" for Claude; the flavor name for other agents (R1 wording). */
export function thinkingLabel(flavor: string | null | undefined): string {
  if (!flavor || flavor === "claude") return "thinking…";
  return `${flavor.charAt(0).toUpperCase()}${flavor.slice(1)} is thinking…`;
}

export type PlaceholderDecision = {
  /** Show the placeholder now (before any hide-hold is applied). */
  show: boolean;
  /**
   * When not shown: true if the ONLY reason is the running signal dropping —
   * the caller may hold it for PLACEHOLDER_HOLD_MS. Content arriving, the turn
   * ending, or a failed/blocked send all remove it immediately.
   */
  holdable: boolean;
  label: string;
  /** Next clock time at which the decision can change on its own, if any. */
  nextChangeAt: number | null;
};

export function decidePlaceholder(input: {
  tail: TurnTail;
  thinking: boolean;
  /** `session.active` — false while the session is offline (sends are queued). */
  active: boolean;
  hasRecentRunningTools: boolean;
  /** localId of this client's latest send (remembered across its echo). */
  pendingSendLocalId: string | null;
  flavor: string | null | undefined;
  nowMs: number;
}): PlaceholderDecision {
  const { tail, nowMs } = input;
  const idle = { show: false, holdable: false, label: "", nextChangeAt: null };
  if (tail.state === "over") return idle;

  const user = tail.lastUser;
  const failed = user?.status === "failed" || user?.status === "blocked";
  // A failed or gate-blocked latest message suppresses the row outright, even
  // while an earlier turn is still running: it must not sit under the error.
  if (failed) return idle;
  const sendPending =
    user !== null &&
    !tail.hasPostUserContent &&
    (user.status === "sending" ||
      user.status === "sent" ||
      (user.localId !== null && user.localId === input.pendingSendLocalId));
  const running = input.thinking || input.hasRecentRunningTools;
  const quietRunning = running && tail.state === "quiet";

  if (!sendPending && !quietRunning) {
    return { ...idle, holdable: tail.state === "quiet" };
  }

  let label = tail.hasPostUserContent
    ? WORKING_LABEL
    : thinkingLabel(input.flavor);
  let nextChangeAt: number | null = null;
  // R7: a send that nothing has picked up reads "waiting…" — at once when the
  // session is offline (the send is only queued), else after the stall window.
  if (sendPending && !running) {
    const stallAt = user.createdAt + PLACEHOLDER_STALL_MS;
    if (!input.active || nowMs >= stallAt) label = WAITING_LABEL;
    else nextChangeAt = stallAt;
  }
  return { show: true, holdable: false, label, nextChangeAt };
}

/**
 * Appends the placeholder as a synthetic reasoning block. Immutable (never
 * mutates the memoized input). `createdAt` derives from the blocks so it is
 * stable across renders while the blocks are unchanged — a clock value would
 * churn reconcile's identity check (`reconcile.ts` compares `createdAt`).
 */
export function appendThinkingPlaceholder(
  blocks: readonly ChatBlock[],
  label: string
): ChatBlock[] {
  const last = blocks[blocks.length - 1];
  return [
    ...blocks,
    {
      kind: "agent-reasoning",
      id: THINKING_PLACEHOLDER_ID,
      localId: null,
      createdAt: last ? last.createdAt : 0,
      text: thinkingPlaceholderText(label),
    },
  ];
}
