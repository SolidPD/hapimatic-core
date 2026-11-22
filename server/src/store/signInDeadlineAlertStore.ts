// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";

/**
 * The sign-in deadline alert's de-dupe store (issue #6161, R14).
 *
 * ONE row per account holds the deadline it was last alerted for and when. The
 * `SignInDeadlineAlertService` reads the row before it notifies and records it
 * after a notification persisted, so a restart, a repeated tick, a peer read, a
 * rotation that shortens the deadline or a change of the resolved source never
 * creates a second notification, while a new sign-in (a later deadline, or a
 * sign-in time after the alert) can create a new one. Bounded by construction:
 * one row per account. Created in `store/index.ts` `runMigrations()`, additive
 * and outside `REQUIRED_TABLES`, like `usage_alert_state`.
 */
export type SignInDeadlineAlertRow = {
  /** The deadline (epoch ms) the last notification was for. */
  deadlineAt: number;
  /** When it was sent (epoch ms). */
  alertedAt: number;
};

interface DbRow {
  deadline_at: number;
  alerted_at: number;
}

export class SignInDeadlineAlertStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /** The account's row, or null when it has never been alerted. */
  get(accountUuid: string): SignInDeadlineAlertRow | null {
    const row = this.db
      .prepare(
        "SELECT deadline_at, alerted_at FROM sign_in_deadline_alerts WHERE account_uuid = ?"
      )
      .get(accountUuid) as DbRow | null | undefined;
    return row
      ? { deadlineAt: row.deadline_at, alertedAt: row.alerted_at }
      : null;
  }

  /** Record (upsert) the deadline the account was just alerted for. */
  recordAlerted(
    accountUuid: string,
    deadlineAt: number,
    alertedAt: number
  ): void {
    this.db
      .prepare(
        `INSERT INTO sign_in_deadline_alerts (account_uuid, deadline_at, alerted_at)
         VALUES (@account_uuid, @deadline_at, @alerted_at)
         ON CONFLICT(account_uuid)
         DO UPDATE SET deadline_at = excluded.deadline_at,
                       alerted_at = excluded.alerted_at`
      )
      .run({
        account_uuid: accountUuid,
        deadline_at: deadlineAt,
        alerted_at: alertedAt,
      });
  }
}

/** The table, created by `runMigrations()` (also used by the store's test). */
export const SIGN_IN_DEADLINE_ALERTS_DDL =
  "CREATE TABLE IF NOT EXISTS sign_in_deadline_alerts (" +
  "account_uuid TEXT PRIMARY KEY, " +
  "deadline_at INTEGER NOT NULL, " +
  "alerted_at INTEGER NOT NULL)";
