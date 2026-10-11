// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import { safeJsonParse } from "./json";
import type { StoredPredictionAccuracy } from "./types";

export interface RecordPredictionAccuracyInput {
  repo: string;
  issue: string;
  predicted: string[];
  actual: string[];
}

interface PredictionAccuracyRow {
  id: string;
  repo: string;
  issue: string;
  predicted: string;
  actual: string;
  precision: number;
  recall: number;
  recorded_at: number;
}

function toStoredPredictionAccuracy(
  row: PredictionAccuracyRow
): StoredPredictionAccuracy {
  return {
    id: row.id,
    repo: row.repo,
    issue: row.issue,
    predicted: (safeJsonParse(row.predicted) as string[] | null) ?? [],
    actual: (safeJsonParse(row.actual) as string[] | null) ?? [],
    precision: row.precision,
    recall: row.recall,
    recordedAt: row.recorded_at,
  };
}

/**
 * Compute precision and recall for a predicted-vs-actual file footprint. Paths
 * are treated as SETS (deduped). Precision = |P ∩ A| / |P| (predicted paths that
 * were real), recall = |P ∩ A| / |A| (real paths that were predicted).
 *
 * Zero-denominator convention (Epic #1965 Sub G / #1972, Key Decision 1): when a
 * denominator is 0 the metric is 1.0 (vacuous truth). An empty predicted set
 * produces zero over-warning (precision measures over-warning risk here, so it is
 * vacuously precise); an empty actual set means nothing changed, so nothing was
 * missed (vacuously perfect recall). Chosen over scikit-learn's `zero_division=0`
 * because 0.0 would wrongly penalise the "predicted nothing, nothing changed"
 * case and poison the closer's accuracy report. The non-vacuous edges fall out
 * naturally (their denominators are non-zero): predicted-non-empty + actual-empty
 * ⇒ precision 0 (every prediction a false positive); predicted-empty +
 * actual-non-empty ⇒ recall 0 (missed everything).
 */
export function computePrecisionRecall(
  predicted: string[],
  actual: string[]
): { precision: number; recall: number; truePositives: number } {
  const p = new Set(predicted);
  const a = new Set(actual);
  let truePositives = 0;
  for (const path of p) {
    if (a.has(path)) truePositives++;
  }
  const precision = p.size === 0 ? 1 : truePositives / p.size;
  const recall = a.size === 0 ? 1 : truePositives / a.size;
  return { precision, recall, truePositives };
}

/**
 * SQLite-backed store for the prediction-accuracy dataset (Epic #1965 Sub G /
 * #1972). Records the predicted-vs-actual file footprint of each closed issue
 * plus computed precision/recall — the ground-truth dataset that powers the
 * rp1-home closer's accuracy report and the churn ignore-list auto-suggestion.
 *
 * Idempotent on (repo, issue): a re-submission REPLACES the prior record via
 * `INSERT ... ON CONFLICT(repo, issue) DO UPDATE` (mirrors LeaseStore /
 * parityRuns), preserving the original `id` and refreshing `recorded_at`. The
 * `prediction_accuracy` table + its index are created in `Store.runMigrations()`
 * (`store/index.ts`), NOT here (parity with FileClaimsStore / LeaseStore).
 */
export class PredictionAccuracyStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Compute precision/recall for the submitted sets and upsert the record, keyed
   * on (repo, issue). Idempotent replace — a second call for the same
   * (repo, issue) overwrites the prior row (preserving its `id`) with fresh
   * values and `recorded_at`. Incoming arrays are deduped so the stored sets
   * match what precision/recall were computed over. Returns the persisted record.
   */
  recordAccuracy(
    input: RecordPredictionAccuracyInput,
    now: number = Date.now()
  ): StoredPredictionAccuracy {
    const predicted = [...new Set(input.predicted)];
    const actual = [...new Set(input.actual)];
    const { precision, recall } = computePrecisionRecall(predicted, actual);
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO prediction_accuracy
           (id, repo, issue, predicted, actual, precision, recall, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo, issue) DO UPDATE SET
           predicted   = excluded.predicted,
           actual      = excluded.actual,
           precision   = excluded.precision,
           recall      = excluded.recall,
           recorded_at = excluded.recorded_at`
      )
      .run(
        id,
        input.repo,
        input.issue,
        JSON.stringify(predicted),
        JSON.stringify(actual),
        precision,
        recall,
        now
      );
    // SELECT-back returns the authoritative persisted row — the correct `id` on
    // both a fresh insert and a conflict-update (the codebase does not use
    // SQLite RETURNING). The row is guaranteed to exist (just upserted).
    return this.getAccuracyByIssue(input.repo, input.issue)!;
  }

  /** All accuracy records for a repo, newest first (index-backed on `repo`). */
  getAccuracyByRepo(repo: string): StoredPredictionAccuracy[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM prediction_accuracy
          WHERE repo = ?
          ORDER BY recorded_at DESC`
      )
      .all(repo) as PredictionAccuracyRow[];
    return rows.map(toStoredPredictionAccuracy);
  }

  /** The single accuracy record for a (repo, issue), or null if none exists. */
  getAccuracyByIssue(
    repo: string,
    issue: string
  ): StoredPredictionAccuracy | null {
    const row = this.db
      .prepare(
        `SELECT * FROM prediction_accuracy
          WHERE repo = ? AND issue = ?`
      )
      .get(repo, issue) as PredictionAccuracyRow | undefined;
    return row ? toStoredPredictionAccuracy(row) : null;
  }
}
