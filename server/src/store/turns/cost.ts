// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";

import { PRICING_PROVIDER } from "@hapi/protocol/pricing";

import { getActiveRateCard, type RateCardPrices } from "./rateCards";

/**
 * Pure per-turn cost calculator (issue #1667, epic #1662, Sub E).
 *
 * `computeTurnCost` prices a turn's token counts against the rate card in effect
 * at the turn's `started_at` (R3/R4) and returns the cost columns A's
 * `FinalizeTurnInput` carries (flat: `costIn`/`costOut`/`costCacheRead`/
 * `costCacheWrite`/`costTotal`/`rateCardId`). Sub B inserts the call at finalize;
 * `backfill-costs` exercises it offline. NO DB writes happen here — it is a pure
 * compute that returns the costs object the caller forwards (R8: computed-from-
 * rate-card is authoritative for ALL launchers; SDK `total_cost_usd` is recorded
 * into `tokens_extra` for comparison only, never consumed here).
 */

/** The six cost columns produced per turn (mirrors A's `FinalizeTurnInput` cost fields). */
export interface TurnCosts {
  costIn: number | null;
  costOut: number | null;
  costCacheRead: number | null;
  costCacheWrite: number | null;
  costTotal: number | null;
  rateCardId: string | null;
}

/** Inputs `computeTurnCost` needs — the turn's model, start time, and token counts. */
export interface ComputeTurnCostInput {
  /** Defaults to the pricing provider (`anthropic`) when the turn's provider is NULL. */
  provider?: string | null;
  modelId: string | null | undefined;
  startedAtMs: number;
  tokIn: number | null | undefined;
  tokOut: number | null | undefined;
  tokCacheRead: number | null | undefined;
  tokCacheWrite: number | null | undefined;
}

const NULL_COSTS: Readonly<TurnCosts> = {
  costIn: null,
  costOut: null,
  costCacheRead: null,
  costCacheWrite: null,
  costTotal: null,
  rateCardId: null,
};

/**
 * Rate-limit the "no rate card" warning to one per (provider, model) so a backfill
 * over thousands of unknown-model turns does not flood the log (R5). Resettable so
 * a long-running process re-warns after a rate card is added (and for test isolation).
 */
const warnedModels = new Set<string>();

/** Clear the unknown-model warning dedup set (test seam + post-seed re-warn hook). */
export function resetTurnCostWarnings(): void {
  warnedModels.clear();
}

/**
 * Compute the per-turn costs. Returns all-NULL costs (token counts are still
 * recorded by the caller) and emits exactly one warning when no rate card
 * resolves for the turn's model (R5). Cache writes are priced at the 5m rate (R7).
 * The turn's billing binding (#4824 `auth_binding_kind`) never changes the
 * price — it only decides whether the figure is shown as a real charge or an
 * API-equivalent value.
 */
export function computeTurnCost(
  db: Database,
  input: ComputeTurnCostInput
): TurnCosts {
  const provider = input.provider ?? PRICING_PROVIDER;
  const card = getActiveRateCard(
    db,
    provider,
    input.modelId,
    input.startedAtMs
  );

  if (!card) {
    const dedupKey = `${provider}::${input.modelId ?? "(null)"}`;
    if (!warnedModels.has(dedupKey)) {
      warnedModels.add(dedupKey);
      console.warn(
        `[turns-cost] no rate card for model "${input.modelId ?? "(null)"}" ` +
          `(provider=${provider}); recording tokens with NULL cost`
      );
    }
    return { ...NULL_COSTS };
  }

  const prices = JSON.parse(card.prices) as RateCardPrices;
  const tokIn = input.tokIn ?? 0;
  const tokOut = input.tokOut ?? 0;
  const tokCacheRead = input.tokCacheRead ?? 0;
  const tokCacheWrite = input.tokCacheWrite ?? 0;

  const costIn = (tokIn / 1_000_000) * prices.inPerMTok;
  const costOut = (tokOut / 1_000_000) * prices.outPerMTok;
  // Issue #3353 (3353-2 / 3353-5): a class the provider's card does not price (an
  // absent rate — Google/OpenAI have no per-token cache-write fee) yields a NULL
  // per-class cost, distinct from a measured $0. The total sums only the priced
  // classes (a null class contributes 0), so it stays correct either way.
  const costCacheRead =
    prices.cacheReadPerMTok != null
      ? (tokCacheRead / 1_000_000) * prices.cacheReadPerMTok
      : null;
  // R7: cache writes priced at the 5m rate; the 1h rate stays in the card for re-pricing.
  const costCacheWrite =
    prices.cacheWrite5mPerMTok != null
      ? (tokCacheWrite / 1_000_000) * prices.cacheWrite5mPerMTok
      : null;
  const costTotal =
    costIn + costOut + (costCacheRead ?? 0) + (costCacheWrite ?? 0);

  return {
    costIn,
    costOut,
    costCacheRead,
    costCacheWrite,
    costTotal,
    rateCardId: card.id,
  };
}
