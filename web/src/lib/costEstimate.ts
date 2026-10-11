// SPDX-License-Identifier: AGPL-3.0-only
import type { SessionTokenStats } from "@/chat/types";
import {
  MODEL_PRICING,
  resolveModelPricing,
  type ModelPricing,
} from "@hapi/protocol/pricing";
// Type-only (erased at compile — no Zod at runtime, so the jsdom cost path stays clean).
import type { AuthBinding } from "@hapi/protocol";

/**
 * Live web cost estimate.
 *
 * The pricing TABLE now lives in `@hapi/protocol/pricing` — the single source of
 * truth shared by web + server (issue #1667, D5). This module keeps `estimateUsd`
 * because it operates on the web-only `SessionTokenStats` type; the server prices
 * per-turn from the seeded `rate_cards` snapshot instead. `MODEL_PRICING` and
 * `ModelPricing` are re-exported so existing importers (TokenUsageWidget, this
 * module's test) need no path change.
 *
 * The granular `@hapi/protocol/pricing` subpath is imported (not the barrel) so
 * the cost path stays free of Zod — keeping the jsdom test environment clean.
 */
export { MODEL_PRICING };
export type { ModelPricing };

/**
 * Compute an estimated USD cost from session token stats and a model name.
 * Returns null for unknown models (UI renders "—").
 *
 * Cache writes default to the 5-minute rate.
 */
export function estimateUsd(
  stats: SessionTokenStats,
  model: string | undefined
): number | null {
  const pricing = resolveModelPricing(model);
  if (!pricing) return null;
  const inputCost = (stats.totalInput / 1_000_000) * pricing.inputPerMTok;
  // Issue #3353 (3353-2): price only the classes this provider charges. A
  // non-anthropic model (gemini / codex) has no per-token cache-write fee, so its
  // rate is absent — that class contributes 0 to the estimate rather than NaN
  // from an `undefined` rate. Unknown model → `resolveModelPricing` is null →
  // the early return above keeps the "—" no-fabrication convention.
  const cacheReadCost =
    pricing.cacheReadPerMTok != null
      ? (stats.totalCacheRead / 1_000_000) * pricing.cacheReadPerMTok
      : 0;
  const cacheWriteCost =
    pricing.cacheWrite5mPerMTok != null
      ? (stats.totalCacheCreation / 1_000_000) * pricing.cacheWrite5mPerMTok
      : 0;
  const outputCost = (stats.totalOutput / 1_000_000) * pricing.outputPerMTok;
  return inputCost + cacheReadCost + cacheWriteCost + outputCost;
}

/**
 * How a session's API cost is PRESENTED, keyed on `metadata.authBinding.kind`
 * (issue #3353, rulings D4 / D5(a)). This is the SINGLE discriminator for the
 * real-vs-EQ display — both the per-turn footer (`AssistantMessage`) and the
 * cumulative row (`TokenUsageWidget`) route through it, so there is NEVER a
 * per-flavor (`flavor === "…"`) cost conditional anywhere (R3, grep-proof Task 8):
 *
 * - `"real"` — `api-key` / `gateway-key`: directly billed → mint `--app-accent`.
 * - `"equivalent"` — `subscription-account`: no marginal API charge, so the value
 *   is the EQUIVALENT at API rates → `--cost-equivalent` (EQ-blue) + an "EQ." marker.
 * - `"neutral"` — `inherited` or an absent binding (legacy / pre-#3351 session):
 *   unknown billing → `--app-hint` "—", no mint and no EQ claim.
 */
export type CostTreatment = "real" | "equivalent" | "neutral";

export function costTreatment(
  // Issue #4824: also a turn's RECORDED kind (a plain string on the wire), so
  // an unknown value falls to neutral like `inherited`.
  kind: AuthBinding["kind"] | (string & {}) | null | undefined
): CostTreatment {
  switch (kind) {
    case "api-key":
    case "gateway-key":
      return "real";
    case "subscription-account":
      return "equivalent";
    case "inherited":
    default:
      // `inherited` and an absent binding both render neutral (D5(a)).
      return "neutral";
  }
}

/**
 * Issue #4824 (R5): the treatment of ONE turn's cost, from the binding the
 * ledger recorded when that turn OPENED — so a mid-session switch never
 * re-colours an earlier turn.
 *
 * - A recorded kind → its own treatment.
 * - `null` (a row with no recorded binding — recorded before #4824 and not
 *   backfilled) → the session's treatment, except that it is never shown as a
 *   real charge (`real` → `neutral`): a cost nobody recorded as billed is not
 *   claimed as billed.
 * - `undefined` (the field is absent — an older federation peer that does not
 *   send it) → the session's treatment unchanged, i.e. today's rendering.
 */
export function turnCostTreatment(
  turnKind: string | null | undefined,
  sessionKind: AuthBinding["kind"] | undefined
): CostTreatment {
  if (turnKind === undefined) return costTreatment(sessionKind);
  if (turnKind !== null) return costTreatment(turnKind);
  const session = costTreatment(sessionKind);
  return session === "real" ? "neutral" : session;
}

/** Issue #4824: the session cost split the server returns (`v_session_totals`). */
export type SessionCostSplit = {
  realCost?: number | null;
  equivalentCost?: number | null;
  unattributedCost?: number | null;
};

/**
 * Issue #4824 (R4): the two accumulators the context widget shows.
 *
 * - `real` — real charges (`api-key` / `gateway-key` turns and agents).
 * - `equivalent` — the API-equivalent value of `subscription-account` turns.
 * - `excluded` — cost with no recorded binding that joins NEITHER figure. Rows
 *   with no recorded binding join the session's own bucket when that bucket is
 *   `equivalent`; when it is `real` (or `neutral`) they are excluded instead,
 *   because a cost nobody recorded as billed is never shown as a charge. The
 *   widget names the excluded amount in a tooltip, so its figures and the
 *   session total (which includes it) never disagree silently.
 *
 * Null when the totals carry no split (an older federation peer, a server whose
 * migration has not run, or nothing priced yet) — the caller then renders
 * today's single figure from the combined total.
 */
export type CostSplit = {
  real: number | null;
  equivalent: number | null;
  excluded: number | null;
};

export function splitCost(
  totals: SessionCostSplit | null | undefined,
  sessionKind: AuthBinding["kind"] | undefined
): CostSplit | null {
  if (!totals) return null;
  const real = totals.realCost ?? null;
  const equivalent = totals.equivalentCost ?? null;
  const unattributed = totals.unattributedCost ?? null;
  if (real === null && equivalent === null && unattributed === null) {
    return null;
  }
  if (unattributed !== null && costTreatment(sessionKind) === "equivalent") {
    return {
      real,
      equivalent: (equivalent ?? 0) + unattributed,
      excluded: null,
    };
  }
  return { real, equivalent, excluded: unattributed };
}
