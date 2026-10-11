// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";

import { getDailySummary } from "../timeLog";
import {
  resolveNamespaceTimezone,
  localDayBoundsMs,
} from "../../parity/timeParityDerivation";
import { TimelogAdjustmentsStore } from "./timelogAdjustmentsStore";

/**
 * One-way legacy `manual` time-log migration (issue #1892, Sub H2, R5 / KD-2).
 *
 * H2 deletes the legacy `timelog_entries` write path; the turns-derived read path
 * (`timelogDerivation.ts`) becomes the sole displayed time source. Days a user had
 * MANUALLY overridden in the legacy UI would otherwise revert to the raw
 * turns-derived total once the legacy writers are gone. This migration reinstates
 * those overrides in the new manual ledger (`timelog_adjustments`) exactly once.
 *
 * ── Mapping (BD-3, KD-2 — corrected from the cycle-1 per-row mapping) ──
 * For each `(namespace, localDate)` that has ≥1 `event_type='manual'` row in
 * `timelog_entries`, emit ONE `set` checkpoint:
 *   - `to_ms` = `getDailySummary(date, namespace).totalMs` — the legacy DISPLAYED
 *     daily total (Σ every session's `duration_ms` for that day), i.e. what the
 *     user saw before cutover.
 *   - `ts_ms` = END of that local day in the namespace timezone
 *     (`localDayBoundsMs(date, tz).endMs`). The derivation walk applies the latest
 *     checkpoint in a bucket as an absolute reset (`order:2` wins tsMs ties), and
 *     placing it at end-of-day guarantees NO auto turn accrues after it → the
 *     bucket's derived `netMs` == the legacy total (no double-count).
 *   - `actor` = `'migration:1892'` (idempotency key + provenance).
 *
 * NOT per-row (would clobber sibling sessions on a multi-session day, since a
 * second `set` in the same bucket wins). NOT `delta` (would ADD on top of the auto
 * turns → double-count). Days WITHOUT a manual row are left untouched so they keep
 * the accurate turns-derived total.
 *
 * READ-ONLY over `timelog_entries` — the legacy table is never written (one-way).
 *
 * ── Idempotency (defense in depth) ──
 *   1. Primary (directive-specified): skip entirely if ANY row with
 *      `actor='migration:1892'` already exists in `timelog_adjustments`.
 *   2. A `_migration_markers` row (`legacy-manual-rows-1892-v1`) is also recorded
 *      for observability, mirroring the #1122/#1508 precedent.
 *
 * `hapi_session_id`/`node_id` are `NOT NULL` on `timelog_adjustments` but carry no
 * FK and are ignored by the derivation (it buckets by namespace+localDate), so a
 * labeled `migration:1892` sentinel is honest provenance, not a fabricated id.
 */

const MIGRATION_ACTOR = "migration:1892";
const MIGRATION_MARKER_KEY = "legacy-manual-rows-1892-v1";

export interface LegacyManualRowMigrationDeps {
  db: Database;
  /** Provenance for the created adjustment rows (ignored by the derivation). */
  nodeId: string;
  /** Fallback timezone when a namespace has no `midnight_reset_state` row. */
  defaultTimezone: string;
}

export interface LegacyManualRowMigrationResult {
  skipped: boolean;
  reason?: string;
  bucketsMigrated: number;
}

export function runLegacyManualRowMigration(
  deps: LegacyManualRowMigrationDeps
): LegacyManualRowMigrationResult {
  const { db, nodeId, defaultTimezone } = deps;

  // Idempotency guard 1 (directive-specified): any prior migration row → skip.
  const existing = db
    .prepare(`SELECT 1 AS ok FROM timelog_adjustments WHERE actor = ? LIMIT 1`)
    .get(MIGRATION_ACTOR) as { ok: number } | undefined;
  if (existing) {
    return {
      skipped: true,
      reason: "already-migrated (actor row exists)",
      bucketsMigrated: 0,
    };
  }

  // Enumerate (namespace, localDate) pairs carrying ≥1 manual row.
  // `timelog_entries.namespace` is `NOT NULL DEFAULT 'default'` and `date` is
  // already YYYY-MM-DD in the legacy pipeline's namespace timezone.
  const manualDays = db
    .prepare(
      `SELECT DISTINCT namespace, date
         FROM timelog_entries
        WHERE event_type = 'manual'
        ORDER BY namespace, date`
    )
    .all() as { namespace: string; date: string }[];

  if (manualDays.length === 0) {
    // No manual overrides to reinstate — record the marker so the next boot is a
    // fast no-op, and report success (not "skipped", which means already-run).
    recordMarker(db, 0);
    return { skipped: false, reason: "no manual rows", bucketsMigrated: 0 };
  }

  const adjustments = new TimelogAdjustmentsStore(db);
  const tzCache = new Map<string, string>();
  const tzFor = (ns: string): string => {
    let tz = tzCache.get(ns);
    if (tz === undefined) {
      tz = resolveNamespaceTimezone(db, ns, defaultTimezone);
      tzCache.set(ns, tz);
    }
    return tz;
  };

  let bucketsMigrated = 0;
  const txn = db.transaction(() => {
    for (const { namespace, date } of manualDays) {
      const totalMs = getDailySummary(db, date, namespace).totalMs;
      const { endMs } = localDayBoundsMs(date, tzFor(namespace));
      adjustments.set({
        hapiSessionId: MIGRATION_ACTOR,
        nodeId,
        namespace,
        tsMs: endMs,
        toMs: totalMs,
        // `fromMs` (derived total at the set instant) is optional audit context;
        // the derivation does not require it and this is a bulk historical set.
        fromMs: null,
        actor: MIGRATION_ACTOR,
        note: `Legacy manual-row migration (#1892) for ${namespace}/${date}`,
      });
      bucketsMigrated++;
    }
    recordMarker(db, bucketsMigrated);
  });
  txn();

  return { skipped: false, bucketsMigrated };
}

function recordMarker(db: Database, rowsAffected: number): void {
  db.prepare(
    "INSERT OR IGNORE INTO _migration_markers " +
      "(key, applied_at, rows_affected, strategy, metadata) " +
      "VALUES (?, ?, ?, ?, ?)"
  ).run(
    MIGRATION_MARKER_KEY,
    Date.now(),
    rowsAffected,
    "per-namespace-date-set-checkpoint",
    JSON.stringify({ actor: MIGRATION_ACTOR })
  );
}
