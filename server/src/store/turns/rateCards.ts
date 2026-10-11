// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";

import {
  MODEL_PRICING_BY_PROVIDER,
  resolveModelPricingKey,
  PRICING_VERIFIED_AT_MS,
  PRICING_VERIFIED_AT_MS_BY_PROVIDER,
  type ModelPricing,
} from "@hapi/protocol/pricing";

import { newUuidV7 } from "./ids";
import type { RateCardRow } from "./types";

/**
 * Versioned pricing rate cards (issue #1667, epic #1662, Sub E).
 *
 * Sub A creates the `rate_cards` table EMPTY; this module seeds it from the
 * shared `MODEL_PRICING` table (R1/R2) and resolves the active card for a turn
 * (R3/R4). `rate_cards` is reference data seeded identically per node — no
 * `node_id`, no remote dependency (R10).
 */

/**
 * The JSON shape persisted in `rate_cards.prices` (E pins this, R9). Carries all
 * FIVE price classes — including the 1h cache-write rate — even though the live
 * calculator currently prices cache writes at the 5m rate (R7). Persisting the
 * 1h rate retires the "1h is dead data" gap and enables future re-pricing.
 */
export interface RateCardPrices {
  /** USD per million input tokens. */
  inPerMTok: number;
  /** USD per million output tokens. */
  outPerMTok: number;
  /**
   * USD per million cache-read input tokens. OPTIONAL (issue #3353, 3353-2): a
   * provider without a cached-input tier omits it (the persisted JSON drops the
   * key, and `computeTurnCost` prices that class as null rather than 0).
   */
  cacheReadPerMTok?: number;
  /** USD per million cache-write input tokens at 5-minute TTL. OPTIONAL (3353-2 —
   *  Google/OpenAI have no per-token cache-write fee, so the field is omitted). */
  cacheWrite5mPerMTok?: number;
  /** USD per million cache-write input tokens at 1-hour TTL. OPTIONAL (3353-2). */
  cacheWrite1hPerMTok?: number;
}

/**
 * Map a shared `ModelPricing` to the persisted `RateCardPrices` shape. Optional
 * cache fields are copied ONLY when present (issue #3353, 3353-2) — an absent
 * field is left off the persisted JSON, never written as a fabricated 0, so a
 * provider with no cache-write fee is faithfully represented.
 */
export function toRateCardPrices(p: ModelPricing): RateCardPrices {
  const out: RateCardPrices = {
    inPerMTok: p.inputPerMTok,
    outPerMTok: p.outputPerMTok,
  };
  if (p.cacheReadPerMTok != null) out.cacheReadPerMTok = p.cacheReadPerMTok;
  if (p.cacheWrite5mPerMTok != null)
    out.cacheWrite5mPerMTok = p.cacheWrite5mPerMTok;
  if (p.cacheWrite1hPerMTok != null)
    out.cacheWrite1hPerMTok = p.cacheWrite1hPerMTok;
  return out;
}

/** Map a raw `rate_cards` row (snake_case columns) to the camelCase `RateCardRow`. */
function rowToRateCard(r: Record<string, unknown>): RateCardRow {
  return {
    id: r.id as string,
    provider: r.provider as string,
    modelId: r.model_id as string,
    effectiveFrom: r.effective_from as number,
    prices: r.prices as string,
  };
}

/**
 * Idempotently seed `rate_cards` from the provider-aware `MODEL_PRICING_BY_PROVIDER`
 * table — one card per (provider, model) at that provider's snapshot
 * `effective_from` (R2; issue #3353, 3353-1). Each row is stamped with its TRUE
 * provider (`anthropic` / `google` / `openai`), so a non-claude turn carrying that
 * provider (issue #3352 writes `turns.model_provider`) resolves its own card
 * rather than mispricing under anthropic. Runs at every boot (wired into
 * `runMigrations()`); re-seeding never duplicates an existing card because each
 * INSERT is guarded by an existence check on the natural composite key
 * `(provider, model_id, effective_from)`.
 *
 * Fail-open (try/catch + console.error) like A's migration blocks — a seed error
 * logs but never aborts daemon boot.
 */
export function seedRateCards(db: Database): void {
  try {
    const existsStmt = db.prepare(
      `SELECT 1 FROM rate_cards
        WHERE provider = @provider AND model_id = @model_id AND effective_from = @effective_from
        LIMIT 1`
    );
    const insertStmt = db.prepare(
      `INSERT INTO rate_cards (id, provider, model_id, effective_from, prices)
       VALUES (@id, @provider, @model_id, @effective_from, @prices)`
    );

    for (const [provider, models] of Object.entries(
      MODEL_PRICING_BY_PROVIDER
    )) {
      const effectiveFrom =
        PRICING_VERIFIED_AT_MS_BY_PROVIDER[provider] ?? PRICING_VERIFIED_AT_MS;
      for (const [modelId, pricing] of Object.entries(models)) {
        const already = existsStmt.get({
          provider,
          model_id: modelId,
          effective_from: effectiveFrom,
        });
        if (already) continue;

        insertStmt.run({
          id: newUuidV7(),
          provider,
          model_id: modelId,
          effective_from: effectiveFrom,
          prices: JSON.stringify(toRateCardPrices(pricing)),
        });
      }
    }
  } catch (error) {
    console.error(`[Store] seedRateCards failed:`, error);
  }
}

/**
 * Resolve the rate card in effect for a turn (R3/R4): prefix-match the turn's
 * `modelId` to a seeded base key, then pick the card whose `effective_from` is
 * the latest at or before `atMs` (the turn's `started_at`). Uses
 * `idx_rate_cards_lookup`. Returns `null` for an unknown model (caller records
 * NULL costs — R5).
 */
export function getActiveRateCard(
  db: Database,
  provider: string,
  modelId: string | null | undefined,
  atMs: number
): RateCardRow | null {
  // Resolve the base key WITHIN this provider's sub-table (issue #3353): a gemini
  // turn (provider="google") must prefix-match google's models, never anthropic's.
  const key = resolveModelPricingKey(modelId ?? undefined, provider);
  if (!key) return null;

  const row = db
    .prepare(
      `SELECT id, provider, model_id, effective_from, prices
         FROM rate_cards
        WHERE provider = @provider AND model_id = @model_id AND effective_from <= @at
        ORDER BY effective_from DESC
        LIMIT 1`
    )
    .get({ provider, model_id: key, at: atMs }) as
    | Record<string, unknown>
    | undefined;

  return row ? rowToRateCard(row) : null;
}
