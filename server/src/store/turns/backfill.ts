// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";

import { computeTurnCost, type TurnCosts } from "./cost";

/**
 * Cost backfill core (issue #1667, epic #1662, Sub E).
 *
 * `backfillCosts` fills the cost columns for turns where `cost_total IS NULL` and
 * a rate card now resolves, pricing each turn against ITS OWN `started_at_ms`
 * (R6). It NEVER overwrites a non-NULL cost ("history is never silently
 * recomputed" — enforced by the `cost_total IS NULL` filter), and it leaves rows
 * whose model still has no card untouched (they stay NULL).
 *
 * This core is separated from the `backfill-costs` CLI script so it is unit-
 * testable directly against an in-memory DB (the script is a thin path-resolution
 * + DB-open wrapper that calls this function).
 */

export interface BackfillSummary {
  /** Rows considered (cost_total IS NULL AND model_id IS NOT NULL). */
  scanned: number;
  /** Rows updated with a resolved card's costs. */
  priced: number;
  /** Rows skipped because no rate card resolved (left NULL). */
  stillUnknown: number;
}

export interface BackfillOptions {
  /** When true, compute + count but do not write any UPDATE. */
  dryRun?: boolean;
}

interface CandidateRow {
  id: string;
  model_provider: string | null;
  model_id: string | null;
  started_at_ms: number;
  tok_in: number | null;
  tok_out: number | null;
  tok_cache_read: number | null;
  tok_cache_write: number | null;
}

export function backfillCosts(
  db: Database,
  options: BackfillOptions = {}
): BackfillSummary {
  const dryRun = options.dryRun ?? false;

  const rows = db
    .prepare(
      `SELECT id, model_provider, model_id, started_at_ms,
              tok_in, tok_out, tok_cache_read, tok_cache_write
         FROM turns
        WHERE cost_total IS NULL AND model_id IS NOT NULL`
    )
    .all() as CandidateRow[];

  const update = db.prepare(
    `UPDATE turns
        SET cost_in          = @cost_in,
            cost_out         = @cost_out,
            cost_cache_read  = @cost_cache_read,
            cost_cache_write = @cost_cache_write,
            cost_total       = @cost_total,
            rate_card_id     = @rate_card_id
      WHERE id = @id`
  );

  const toApply: Array<{ id: string; costs: TurnCosts }> = [];
  let stillUnknown = 0;

  for (const row of rows) {
    const costs = computeTurnCost(db, {
      provider: row.model_provider ?? undefined,
      modelId: row.model_id,
      startedAtMs: row.started_at_ms,
      tokIn: row.tok_in,
      tokOut: row.tok_out,
      tokCacheRead: row.tok_cache_read,
      tokCacheWrite: row.tok_cache_write,
    });

    // No card resolved → leave the row NULL (R6); a later rate card + re-run prices it.
    if (costs.rateCardId === null) {
      stillUnknown++;
      continue;
    }
    toApply.push({ id: row.id, costs });
  }

  if (!dryRun && toApply.length > 0) {
    const applyAll = db.transaction(
      (items: Array<{ id: string; costs: TurnCosts }>) => {
        for (const { id, costs } of items) {
          update.run({
            id,
            cost_in: costs.costIn,
            cost_out: costs.costOut,
            cost_cache_read: costs.costCacheRead,
            cost_cache_write: costs.costCacheWrite,
            cost_total: costs.costTotal,
            rate_card_id: costs.rateCardId,
          });
        }
      }
    );
    applyAll(toApply);
  }

  return {
    scanned: rows.length,
    priced: toApply.length,
    stillUnknown,
  };
}
