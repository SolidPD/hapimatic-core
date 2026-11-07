// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";
import { getActiveRateCard } from "../turns/rateCards";

/**
 * Read-only rate-card access for throughput pricing (issue #6164, A1). Lives in
 * the store layer so the live rollup (through `ThroughputRollupStore`) and the
 * read-only report CLI (over its own `readonly` connection) share it.
 */

/** A rate card as the pricer reads it. */
export interface RateCard {
  id: string;
  effectiveFrom: number;
  /** The persisted `RateCardPrices` JSON. */
  prices: string;
}

/** Where the pricer reads rate cards from. */
export interface RateCardSource {
  /** The card in effect for `model` at `atMs`, or null. */
  active(provider: string, model: string, atMs: number): RateCard | null;
  /** The earliest card for a resolved model key, or null. */
  earliest(provider: string, modelKey: string): RateCard | null;
}

export function rateCardSourceFor(db: Database): RateCardSource {
  return {
    active: (provider, model, atMs) => {
      const card = getActiveRateCard(db, provider, model, atMs);
      return card
        ? {
            id: card.id,
            effectiveFrom: card.effectiveFrom,
            prices: card.prices,
          }
        : null;
    },
    earliest: (provider, modelKey) => {
      const row = db
        .prepare(
          `SELECT id, effective_from, prices FROM rate_cards
            WHERE provider = ? AND model_id = ?
            ORDER BY effective_from ASC LIMIT 1`
        )
        .get(provider, modelKey) as
        | { id: string; effective_from: number; prices: string }
        | undefined;
      return row
        ? { id: row.id, effectiveFrom: row.effective_from, prices: row.prices }
        : null;
    },
  };
}

/**
 * A fingerprint of the stored rate cards (count, latest effective time and a
 * digest of the ids). When it changes, every rollup bucket is re-priced.
 */
export function rateCardsGeneration(db: Database): string {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(MAX(effective_from), 0) AS latest,
              COALESCE(group_concat(id, ','), '') AS ids
         FROM (SELECT id, effective_from FROM rate_cards ORDER BY id)`
    )
    .get() as { n: number; latest: number; ids: string };
  let h = 0;
  for (let i = 0; i < row.ids.length; i += 1) {
    h = (Math.imul(h, 31) + row.ids.charCodeAt(i)) | 0;
  }
  return `${row.n}:${row.latest}:${(h >>> 0).toString(16)}`;
}
