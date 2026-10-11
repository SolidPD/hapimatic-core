// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";

/**
 * Usage-threshold alert de-dupe store (epic #1855, Sub-Issue H / #1863).
 *
 * Persists ONE row per (account_uuid, limit_key, threshold) recording the most
 * recent reset-window (`window_key` = the limit's raw `resets_at`, or
 * `NO_RESET_WINDOW` when null) for which a threshold-crossing alert was already
 * sent. The `UsageAlertService` consults `shouldAlert` before firing a push and
 * calls `recordAlerted` after — so a sustained over-threshold utilization alerts
 * at most once per reset window per threshold, and never re-fires after a server
 * restart within the same window. Bounded by construction: one row per
 * account×limit×threshold. Created in `store/index.ts` runMigrations; models
 * `account_rotation_leases` (a small keyed state table) + `UsageHistoryStore`'s
 * prepared-statement shape.
 *
 * Window comparison (#4836): the usage API reports `resets_at` with microsecond
 * jitter around the same boundary (`13:00:00.334256` on one sample,
 * `13:00:00.388803` on the next, `12:59:59.999260` on a third), so an exact
 * string compare treated every 2-minute sample as a new window and re-fired the
 * alert all day. `isSameResetWindow` therefore parses both keys and treats
 * instants less than `RESET_WINDOW_TOLERANCE_MS` apart as one window. Parsing at
 * compare time (not at write time) makes rows written before #4836 — raw
 * microsecond strings — compare correctly with no migration, so the upgrade
 * itself sends no extra alert. Unparseable keys keep exact-string semantics.
 *
 * Missing reset (#4836): a sample with no `resets_at` never re-arms a row that
 * already exists, so a value → null flip cannot re-fire. The other direction
 * can, once: a row first stored as `NO_RESET_WINDOW` re-arms when the first
 * real `resets_at` arrives.
 */

/** Window key used when a limit has no `resets_at` (ambiguous window). */
export const NO_RESET_WINDOW = "no-reset";

/**
 * Two parsed `resets_at` instants closer than this are the same reset window.
 * The shortest limit window is 5 h (five-hour windows end on 10-minute marks,
 * weekly ones on the hour), so 5 min can never merge two real windows, while it
 * absorbs the sub-second jitter observed live (~±0.5 s).
 */
export const RESET_WINDOW_TOLERANCE_MS = 5 * 60_000;

/**
 * True when two window keys name the same reset window: both parse as dates
 * within `RESET_WINDOW_TOLERANCE_MS` of each other, or (when either does not
 * parse — e.g. `NO_RESET_WINDOW`) they are the identical string.
 */
export function isSameResetWindow(
  storedKey: string,
  currentKey: string
): boolean {
  const a = Date.parse(storedKey);
  const b = Date.parse(currentKey);
  return Number.isFinite(a) && Number.isFinite(b)
    ? Math.abs(a - b) < RESET_WINDOW_TOLERANCE_MS
    : storedKey === currentKey;
}

interface DbUsageAlertRow {
  window_key: string;
}

export class UsageAlertStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * True when no alert has yet been sent for this
   * (accountUuid, limitKey, threshold) at the given reset window — i.e. either
   * no row exists, or the stored `window_key` names a different reset window
   * (`isSameResetWindow`). A current key of `NO_RESET_WINDOW` never re-arms an
   * existing row (#4836).
   */
  shouldAlert(
    accountUuid: string,
    limitKey: string,
    threshold: number,
    windowKey: string
  ): boolean {
    const row = this.db
      .prepare(
        `SELECT window_key FROM usage_alert_state
         WHERE account_uuid = ? AND limit_key = ? AND threshold = ?`
      )
      .get(accountUuid, limitKey, threshold) as DbUsageAlertRow | undefined;
    if (!row) return true;
    if (windowKey === NO_RESET_WINDOW) return false;
    return !isSameResetWindow(row.window_key, windowKey);
  }

  /**
   * Record that an alert was sent for this (accountUuid, limitKey, threshold) at
   * the given reset window. UPSERT keeps exactly one row per key triple, so the
   * table is bounded by account×limit×threshold and re-arms on a window change.
   */
  recordAlerted(
    accountUuid: string,
    limitKey: string,
    threshold: number,
    windowKey: string,
    alertedAt: number
  ): void {
    this.db
      .prepare(
        `INSERT INTO usage_alert_state
           (account_uuid, limit_key, threshold, window_key, alerted_at)
         VALUES (@account_uuid, @limit_key, @threshold, @window_key, @alerted_at)
         ON CONFLICT(account_uuid, limit_key, threshold)
         DO UPDATE SET window_key = excluded.window_key,
                       alerted_at = excluded.alerted_at`
      )
      .run({
        account_uuid: accountUuid,
        limit_key: limitKey,
        threshold,
        window_key: windowKey,
        alerted_at: alertedAt,
      });
  }
}
