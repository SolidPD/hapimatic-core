// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Runaway-session ceiling guard — the PURE decision half (issue #5254, the
 * #1905 follow-up). `SyncEngine.checkSessionCeilings` gathers the facts
 * (cumulative totals, trailing-hour usage, last operator message) and acts on
 * the result; everything that decides lives here, with no I/O, so it is unit-
 * testable and the grandfathered `syncEngine.ts` god-file (#2077) shrinks.
 *
 * Two kinds of dimension:
 *   - cumulative (#1905): uncached tokens, turn count, cost over the session's
 *     life. A long, productive session crosses these slowly, so they only
 *     matter when nobody is at the keyboard.
 *   - rate (#5254 R1): turns and uncached tokens in the trailing 60 minutes —
 *     the shape a real runaway takes.
 *
 * Every breach is gated on operator inactivity (R2): with an operator message
 * in the trailing window the caller records the breach as suppressed instead
 * of stopping the session.
 */

import type {
  CeilingBreachDimension,
  CeilingBreachKind,
  CeilingGuardConfig,
  CeilingGuardConfigPatch,
} from "@hapi/protocol/schemas";

/** The fixed metering + inactivity window (D4): 60 minutes. */
export const CEILING_RATE_WINDOW_MS = 3_600_000;

/** The ceilings in force for one session after every overlay is applied. */
export interface EffectiveCeilings {
  uncachedTokenCeiling: number | null;
  iterationCeiling: number | null;
  costUsdCeiling: number | null;
  turnsPerHourCeiling: number | null;
  uncachedTokensPerHourCeiling: number | null;
  hardStop: boolean;
}

const OVERLAY_KEYS = [
  "uncachedTokenCeiling",
  "iterationCeiling",
  "costUsdCeiling",
  "turnsPerHourCeiling",
  "uncachedTokensPerHourCeiling",
  "hardStop",
] as const;

/**
 * Overlay the role profile and then the session's own override on the global
 * config, field by field. Precedence: session > role > global. `!== undefined`
 * so an explicit `null` ceiling disables that dimension (the #1905 R7 rule);
 * an omitted field falls through to the next layer.
 */
export function resolveEffectiveCeilings(
  global: CeilingGuardConfig,
  roleOverride?: CeilingGuardConfigPatch | null,
  sessionOverride?: CeilingGuardConfigPatch | null
): EffectiveCeilings {
  const effective: EffectiveCeilings = {
    uncachedTokenCeiling: global.uncachedTokenCeiling,
    iterationCeiling: global.iterationCeiling,
    costUsdCeiling: global.costUsdCeiling,
    turnsPerHourCeiling: global.turnsPerHourCeiling,
    uncachedTokensPerHourCeiling: global.uncachedTokensPerHourCeiling,
    hardStop: global.hardStop,
  };
  for (const layer of [roleOverride, sessionOverride]) {
    if (!layer) continue;
    for (const key of OVERLAY_KEYS) {
      const value = layer[key];
      if (value !== undefined) {
        (effective as unknown as Record<string, unknown>)[key] = value;
      }
    }
  }
  return effective;
}

/** One breached dimension. `value`/`ceiling` are the compared numbers. */
export interface CeilingBreach {
  kind: CeilingBreachKind;
  dimension: CeilingBreachDimension;
  value: number;
  ceiling: number;
}

export interface CeilingEvaluationInput {
  now: number;
  effective: EffectiveCeilings;
  /** Cumulative facts from `v_session_totals`. */
  totals: {
    uncached: number;
    turnCount: number;
    totalCost: number | null;
  };
  /** Trailing-window usage (`TurnStore.getRollingUsage`). */
  rolling: { turns: number; uncached: number };
  /** `sessions.last_operator_message_at`, or null when none ever arrived. */
  lastOperatorAt: number | null;
}

export interface CeilingEvaluation {
  /** Breached dimensions in a fixed order: tokens, iterations, cost,
   *  turnsPerHour, uncachedTokensPerHour (so "first dimension wins" log text
   *  stays stable). Empty when nothing is breached. */
  breaches: CeilingBreach[];
  /** An operator message arrived inside the trailing window (R2). */
  operatorActive: boolean;
}

/** Decide which dimensions are breached and whether an operator is present. */
export function evaluateCeilings(
  input: CeilingEvaluationInput
): CeilingEvaluation {
  const { now, effective, totals, rolling, lastOperatorAt } = input;
  const breaches: CeilingBreach[] = [];

  const check = (
    kind: CeilingBreachKind,
    dimension: CeilingBreachDimension,
    value: number | null,
    ceiling: number | null
  ): void => {
    // A null ceiling disables the dimension; a null value is never a breach
    // (#1905 OR-5: missing cost data must not produce a false positive).
    if (ceiling == null || value == null) return;
    if (value >= ceiling) breaches.push({ kind, dimension, value, ceiling });
  };

  // R1 (#1905): uncached = non-cache input + output only; cache reads/writes
  // are not spend-equivalent and are excluded.
  check(
    "cumulative",
    "tokens",
    totals.uncached,
    effective.uncachedTokenCeiling
  );
  check(
    "cumulative",
    "iterations",
    totals.turnCount,
    effective.iterationCeiling
  );
  check("cumulative", "cost", totals.totalCost, effective.costUsdCeiling);
  check("rate", "turnsPerHour", rolling.turns, effective.turnsPerHourCeiling);
  check(
    "rate",
    "uncachedTokensPerHour",
    rolling.uncached,
    effective.uncachedTokensPerHourCeiling
  );

  const operatorActive =
    lastOperatorAt != null && lastOperatorAt >= now - CEILING_RATE_WINDOW_MS;

  return { breaches, operatorActive };
}
