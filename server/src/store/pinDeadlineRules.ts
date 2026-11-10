// SPDX-License-Identifier: AGPL-3.0-only
import {
  isAutoPickEligible,
  pinDeadlineAfterMs,
  type PinContent,
  type PinDeadlineBy,
} from "@hapi/protocol";

/**
 * The rules for a pin's automatic-pick deadline (issue #6452, epic #6446), as
 * pure functions so every transition is one table test. `PinStore` only decides
 * which transition happened and writes the result.
 *
 * Two invariants hold the safety line (rulings D6 and D7):
 * - an agent write only ever moves a running deadline later, never earlier;
 * - an operator's move or turn-off wins over agent writes until the question is
 *   settled and asked again.
 */

export type DeadlineState = {
  /** Epoch ms of the automatic pick; null when none is running. */
  at: number | null;
  by: PinDeadlineBy | null;
  /** The pin revision this state was last reconciled against. */
  revision: number | null;
  /** Changes whenever the deadline is armed or moved; names the automatic message. */
  id: string | null;
  /** When the operator last changed the pick (a pending report until a Submit says so). */
  changedAt: number | null;
};

export const NO_DEADLINE: DeadlineState = {
  at: null,
  by: null,
  revision: null,
  id: null,
  changedAt: null,
};

/**
 * - `create`: a new key.
 * - `update`: an open (or live) pin re-posted with changed content.
 * - `reraise-withdrawn`: a withdrawn pin re-posted, which re-opens it.
 * - `reopen-settled`: an answered, auto-answered or dismissed pin re-posted with
 *   `reopen`, which asks the question again.
 */
export type DeadlineTransition =
  | "create"
  | "update"
  | "reraise-withdrawn"
  | "reopen-settled";

function armed(
  next: PinContent,
  revision: number,
  now: number,
  newId: () => string,
  changedAt: number | null
): DeadlineState {
  const after = next.ifUnanswered?.after;
  if (!after || !isAutoPickEligible(next)) {
    return { ...NO_DEADLINE, revision, changedAt };
  }
  return {
    at: now + pinDeadlineAfterMs(after),
    by: "agent",
    revision,
    id: newId(),
    changedAt,
  };
}

/**
 * Whether the pick the operator would see changed: the duration, the named
 * option, or that option's label or consequence. Context, title, evidence and
 * plain-text edits are not, so an agent that regenerates its text on every loop
 * tick never pushes the deadline (the reason `after` is a duration).
 */
export function pickChanged(
  prev: PinContent | null,
  next: PinContent
): boolean {
  const before = prev?.ifUnanswered;
  const after = next.ifUnanswered;
  if (!before || !after) return true;
  if (before.after !== after.after || before.option !== after.option) {
    return true;
  }
  const optionOf = (content: PinContent) =>
    content.options?.find(option => option.id === after.option);
  const a = optionOf(prev);
  const b = optionOf(next);
  return a?.label !== b?.label || a?.consequence !== b?.consequence;
}

export function reconcileDeadline(input: {
  prev: DeadlineState;
  prevContent: PinContent | null;
  next: PinContent;
  transition: DeadlineTransition;
  revision: number;
  now: number;
  newId: () => string;
}): DeadlineState {
  const { prev, prevContent, next, transition, revision, now, newId } = input;
  switch (transition) {
    case "create":
      return armed(next, revision, now, newId, null);
    case "reopen-settled":
      // A settled question asked again is a new question: the operator's old
      // setting and any unreported change go with the old one.
      return armed(next, revision, now, newId, null);
    case "reraise-withdrawn":
      // "Off" is the operator's strongest intent, so it survives a withdraw and
      // re-post; a moved time does not.
      if (prev.by === "off") return { ...prev, at: null, revision };
      return armed(next, revision, now, newId, null);
    case "update":
      break;
  }
  if (prev.by === "off") return { ...prev, revision };
  // An operator's time wins while it stands (D7). Once spent with no pick to
  // fire (the agent removed it and the tick stopped it), re-adding the pick
  // arms it from now below, which is never earlier than the spent time.
  if (prev.by === "operator" && prev.at !== null) {
    return { ...prev, revision };
  }
  // Removed (or no longer eligible, which the schema refuses): suspended, not
  // cleared, so removing and re-adding the pick can never move it earlier. The
  // scheduler and the web both require an eligible `ifUnanswered` to act.
  if (!next.ifUnanswered || !isAutoPickEligible(next)) {
    return { ...prev, revision };
  }
  if (prev.at === null) {
    return armed(next, revision, now, newId, prev.changedAt);
  }
  if (!pickChanged(prevContent, next)) return { ...prev, revision };
  const pushed = Math.max(
    prev.at,
    now + pinDeadlineAfterMs(next.ifUnanswered.after)
  );
  return pushed === prev.at
    ? { ...prev, revision }
    : { ...prev, at: pushed, id: newId(), revision };
}

/**
 * The operator moved the pick to `at` (or turned a stopped one back on), or
 * turned it off. Always a pending report (ruling D5).
 */
export function operatorDeadline(
  prev: DeadlineState,
  request: { at: number } | { off: true },
  revision: number,
  now: number,
  newId: () => string
): DeadlineState {
  if ("off" in request) {
    return { ...prev, at: null, by: "off", revision, changedAt: now };
  }
  return {
    at: request.at,
    by: "operator",
    revision,
    id: newId(),
    changedAt: now,
  };
}

/**
 * An operator's question or note turns a running pick off (ruling D3): they are
 * engaged, so the default should not land while the agent answers them.
 */
export function deadlineOffForQuestion(
  prev: DeadlineState,
  now: number
): DeadlineState {
  return { ...prev, at: null, by: "off", changedAt: now };
}

/**
 * A pin whose revision moved without these rules running (a build without
 * #6452 edited it). Re-arm as if the pick changed, never earlier than it was;
 * an operator's setting stands.
 */
export function reconcileForeignEdit(
  prev: DeadlineState,
  content: PinContent,
  revision: number,
  now: number,
  newId: () => string
): DeadlineState {
  return reconcileDeadline({
    prev,
    prevContent: null,
    next: content,
    transition: "update",
    revision,
    now,
    newId,
  });
}

/** A report is pending when the operator changed the pick after the last report. */
export function isDeadlineReportPending(
  changedAt: number | null,
  reportedAt: number | null
): boolean {
  return changedAt !== null && (reportedAt === null || reportedAt < changedAt);
}
