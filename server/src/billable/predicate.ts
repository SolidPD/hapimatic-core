// SPDX-License-Identifier: AGPL-3.0-only
import type { AgentState } from "@hapi/protocol/types";

/**
 * Billable-time predicate (issue #6586): what "billable" means for one session at
 * one moment, the causes an interval row records, and the requests' own record of
 * the waits in a stretch.
 *
 * Pure: no I/O, and nothing imported from `sync/` or `store/`, because the store,
 * the write service, the tracker and the entry point all import this module.
 *
 * Ruled definition (FD-1, F4, Matt Starfield 2026-11-10): a turn's time counts
 * from prompt submit to the model's stop, including tools the model runs and waits
 * on; nothing after the stop; time waiting on a person mid-turn does not count; a
 * turn that dies without a stop counts up to its last recorded activity, never an
 * estimate. Ruling Q-1: a wait on any pending request is unbilled whoever answers
 * it.
 *
 * End causes, mapped to the issue's five causes:
 * - `stop`, `rate_limit` and `waiting_on_person` map one to one.
 * - `session_end` written for the CLI's own session-end event is "session end".
 * - `expired`, `session_deleted`, `hub_shutdown`, `hub_restart`, `superseded` and
 *   a hub-originated `session_end` are all "cut at last recorded activity".
 * - `rollover` splits one continuous run at 24 h and ends no work.
 * - `opening_balance` and `carried_forward` (start cause `balance`) are balance
 *   rows with no interval history.
 *
 * Start cause `reconnected`: the first open of a stretch that this hub process
 * first saw already thinking, or that revived after an `expired` close.
 */
export const BILLABLE_END_CAUSES = [
  "stop",
  "rate_limit",
  "waiting_on_person",
  "session_end",
  "session_deleted",
  "expired",
  "hub_shutdown",
  "hub_restart",
  "rollover",
  "superseded",
  "opening_balance",
  "carried_forward",
] as const;
export type BillableEndCause = (typeof BILLABLE_END_CAUSES)[number];

export const BILLABLE_START_CAUSES = [
  "thinking_started",
  "resumed_after_person",
  "reconnected",
  "rollover",
  "balance",
] as const;
export type BillableStartCause = (typeof BILLABLE_START_CAUSES)[number];

/** The session fields the wait rule reads, plus the tracker's leftover set. */
export interface AwaitingPersonInput {
  blockedOnTuiPrompt?: { message: string; since: number } | null;
  agentState?: AgentState | null;
  /**
   * Ids (keys of `agentState.requests`) the tracker has marked as leftovers. The
   * caller always supplies it: only the tracker knows which requests were pending
   * when a process attached or while the CLI reported no turn.
   */
  staleRequestIds: ReadonlySet<string>;
}

export interface BillableInput extends AwaitingPersonInput {
  thinking: boolean;
}

/**
 * True when the session waits on a person: a TUI-blocking prompt is shown, or at
 * least one pending request is live (its id is not in `staleRequestIds`).
 *
 * Never reads `createdAt`: the field is nullish and is the CLI's clock, and testing
 * it against the hub's clock bills a live wait whenever the hub first sees
 * `thinking=true` more than 2 s after the request was made (the archive guard after
 * a respawn, or a hub stall).
 */
export function isAwaitingPerson(input: AwaitingPersonInput): boolean {
  if (input.blockedOnTuiPrompt != null) return true;
  const requests = input.agentState?.requests;
  if (!requests) return false;
  for (const id of Object.keys(requests)) {
    if (!input.staleRequestIds.has(id)) return true;
  }
  return false;
}

/** Billable = thinking and not awaiting a person. */
export function isBillable(input: BillableInput): boolean {
  return input.thinking && !isAwaitingPerson(input);
}

/**
 * Why an open interval stopped being billable. `thinking` is tested first, so a
 * turn that stops while a request is still pending ends as `stop` or
 * `rate_limit`, never as `waiting_on_person`.
 */
export function endCauseFor(input: {
  thinking: boolean;
  rateLimited?: unknown;
}): BillableEndCause {
  if (!input.thinking) {
    return input.rateLimited != null ? "rate_limit" : "stop";
  }
  return "waiting_on_person";
}

export interface RequestWaitRef {
  /** Length of the union of the request waits inside `[fromMs, toMs]`. */
  ms: number;
  /** True when an entry lacked a time it needed. */
  incomplete: boolean;
}

/**
 * The wait time the session's own request records give for `[fromMs, toMs]` (the
 * `shadow` comparison): the length of the union of `[createdAt, toMs]` over the
 * pending `requests` and `[createdAt, completedAt]` over `completedRequests`, each
 * clipped to the stretch, skipping every id in `excludeIds`. Overlapping entries
 * are counted once. An entry that lacks a time it needs adds nothing and sets
 * `incomplete`, unless it is a completed entry whose `completedAt` is before
 * `fromMs`. It is independent of the tracker and decides nothing about billing.
 *
 * One pass over each map: `completedRequests` is never pruned and is inherited by
 * every relaunched process.
 */
export function requestWaitRef(
  agentState: AgentState | null | undefined,
  fromMs: number,
  toMs: number,
  excludeIds?: ReadonlySet<string>
): RequestWaitRef {
  const spans: Array<[number, number]> = [];
  let incomplete = false;
  const add = (start: number, end: number): void => {
    const s = Math.max(start, fromMs);
    const e = Math.min(end, toMs);
    if (e > s) spans.push([s, e]);
  };

  const pending = agentState?.requests;
  if (pending) {
    for (const [id, request] of Object.entries(pending)) {
      if (excludeIds?.has(id)) continue;
      const createdAt = request?.createdAt;
      if (typeof createdAt !== "number") {
        incomplete = true;
        continue;
      }
      add(createdAt, toMs);
    }
  }

  const completed = agentState?.completedRequests;
  if (completed) {
    for (const [id, request] of Object.entries(completed)) {
      if (excludeIds?.has(id)) continue;
      const createdAt = request?.createdAt;
      const completedAt = request?.completedAt;
      if (typeof completedAt === "number" && completedAt < fromMs) continue;
      if (typeof createdAt !== "number" || typeof completedAt !== "number") {
        incomplete = true;
        continue;
      }
      add(createdAt, completedAt);
    }
  }

  if (spans.length === 0) return { ms: 0, incomplete };
  spans.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [curStart, curEnd] = spans[0];
  for (let i = 1; i < spans.length; i++) {
    const [s, e] = spans[i];
    if (s <= curEnd) {
      if (e > curEnd) curEnd = e;
    } else {
      total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    }
  }
  total += curEnd - curStart;
  return { ms: total, incomplete };
}
