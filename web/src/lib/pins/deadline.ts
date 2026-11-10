// SPDX-License-Identifier: AGPL-3.0-only
import type { DeadlineOf, PinViewModel } from "./ledger";

/**
 * #6451: the one seam every Pins deadline feature reads — the Deadline facet,
 * the Deadline sort, the window grouping and the timeline. F (#6452) fills it
 * from the instant the server stores beside each pin (`deadlineAt`), so every
 * device shows the same time and a re-raised pin's moved deadline shows too.
 */

/**
 * A pin's armed automatic-pick instant in epoch ms: an open pin that names a
 * pick and whose node has scheduled it. Undefined for a pick turned off, a
 * pin from a node built before #6452 (no `deadlineAt` at all), or a closed pin.
 * A module-level constant, so `PinsView`'s memo never rebuilds for it.
 */
export const pinDeadlineOf: DeadlineOf = pin => {
  if (pin.status !== "open" || !pin.ifUnanswered) return undefined;
  if (typeof pin.deadlineAt !== "string") return undefined;
  const at = Date.parse(pin.deadlineAt);
  return Number.isFinite(at) ? at : undefined;
};

/**
 * True when a pin will be decided automatically if left unanswered, which
 * needs an armed pick: the Deadline facet, the sort, the grouping, the
 * timeline and the row's timer all use this rule, so none of them disagree.
 */
export function hasAutomaticPick(model: PinViewModel): boolean {
  return model.ifUnanswered !== null && pinDeadlineOf(model.pin) !== undefined;
}

/**
 * The deadline source `PinsView` reads, through a hook so a later change can
 * substitute a closure fed by a query. Today it is the constant
 * {@link pinDeadlineOf}, so its identity never changes.
 */
export function usePinDeadlineOf(): DeadlineOf {
  return pinDeadlineOf;
}

/** The option an automatic pick names, with its label when the pin has one. */
type PickTarget = { option: string; label: string };

/**
 * What a pin's automatic pick is doing now:
 * - `armed`: it fires at `at` unless answered first;
 * - `off`: the operator turned it off (ruling D7: it stays off until the pin
 *   settles and is raised again);
 * - `unsupported`: the pin's node was built before #6452, so it has no
 *   deadline the Pins tab can show or change;
 * - `none`: no pick, a closed pin, or a pick the server suspended.
 */
export type AutomaticPickState =
  | ({ kind: "armed"; at: number } & PickTarget)
  | ({ kind: "off" } & PickTarget)
  | ({ kind: "unsupported" } & PickTarget)
  | { kind: "none" };

export function automaticPickState(model: PinViewModel): AutomaticPickState {
  const { pin, ifUnanswered } = model;
  if (pin.status !== "open" || !ifUnanswered) return { kind: "none" };
  const option = ifUnanswered.option;
  const target: PickTarget = {
    option,
    label: model.options.find(o => o.id === option)?.label ?? option,
  };
  const at = pinDeadlineOf(pin);
  if (at !== undefined) return { kind: "armed", at, ...target };
  if (pin.deadlineBy === "off") return { kind: "off", ...target };
  if (pin.deadlineAt === undefined) return { kind: "unsupported", ...target };
  return { kind: "none" };
}

/**
 * The time left before a pick, in whole minutes: "now", "12m", "2h 5m",
 * "3d 4h" (mockup v6 `left()`).
 */
export function formatCountdown(at: number, now: number): string {
  const minutes = Math.round((at - now) / 60_000);
  if (minutes <= 0) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`;
}
