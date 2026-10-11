// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";

/**
 * SQLite-backed persistence for cross-machine account rotation leases (#1644).
 *
 * The Anthropic refresh-token *family* is keyed by `(account, client_id)`; the
 * `client_id` is the single hardcoded public Claude Code id (identical on every
 * machine), so `account_uuid` IS the family key. When the same account is live on
 * more than one federation node, only the lease holder may rotate the family —
 * this store is the **hub's authoritative lease ledger** (peers acquire via the
 * hub's federation receivers).
 *
 * Mirrors the {@link PeerStore} / {@link MidnightResetStateStore} shape: `Database`
 * in the constructor, synchronous prepared queries. The `account_rotation_leases`
 * table is created in `Store.runMigrations()` (`store/index.ts`), NOT here — this
 * class is pure queries (parity with `MidnightResetStateStore`).
 */

// Mirrors `UUID_REGEX` in `services/accountService.ts` and the cli-side
// `accountStore`: a strict UUID-shape gate so a malformed id can never reach
// SQLite as a lease key. Route handlers already Zod-validate `z.string().uuid()`
// upstream; this is defense-in-depth.
const UUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface LeaseAcquireResult {
  /** True iff `holderNodeId` owns the lease after the call (fresh acquire OR renew). */
  granted: boolean;
  /** The node id owning the lease after the call (may be another node when `!granted`). */
  holder: string | null;
  /** The current holder's expiry (epoch ms), or 0 when no holder. */
  expiresAt: number;
}

export interface LeaseHolder {
  holderNodeId: string;
  expiresAt: number;
}

interface LeaseRow {
  account_uuid: string;
  holder_node_id: string;
  acquired_at: number;
  heartbeat_at: number;
  expires_at: number;
}

export class LeaseStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Atomically acquire (or renew) the rotation lease for `accountUuid`.
   *
   * A lease is acquirable iff: no row exists, OR the existing lease has expired
   * (`expires_at <= now`), OR `holderNodeId` already holds it (renew). The
   * conditional `INSERT ... ON CONFLICT DO UPDATE ... WHERE` is a single statement
   * (SQLite converts a false `WHERE` into a no-op, leaving the incumbent holder's
   * row untouched); a read-back then reports the TRUE holder so a losing caller
   * learns who won. The hub serializes all acquires (one DB, synchronous driver),
   * so two racing peers cannot both win.
   */
  tryAcquire(
    accountUuid: string,
    holderNodeId: string,
    ttlMs: number,
    now: number
  ): LeaseAcquireResult {
    if (!UUID_REGEX.test(accountUuid)) {
      throw new Error(`[LeaseStore] invalid accountUuid: ${accountUuid}`);
    }
    const expiresAt = now + ttlMs;
    this.db
      .prepare(
        `INSERT INTO account_rotation_leases
           (account_uuid, holder_node_id, acquired_at, heartbeat_at, expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(account_uuid) DO UPDATE SET
           holder_node_id = excluded.holder_node_id,
           acquired_at = CASE
             WHEN account_rotation_leases.holder_node_id = excluded.holder_node_id
               THEN account_rotation_leases.acquired_at
             ELSE excluded.acquired_at
           END,
           heartbeat_at = excluded.heartbeat_at,
           expires_at = excluded.expires_at
         WHERE account_rotation_leases.expires_at <= ?
            OR account_rotation_leases.holder_node_id = excluded.holder_node_id`
      )
      .run(accountUuid, holderNodeId, now, now, expiresAt, now);

    const row = this.readRow(accountUuid);
    if (!row) {
      // Unreachable in practice (we just inserted-or-conflicted) — fail closed.
      return { granted: false, holder: null, expiresAt: 0 };
    }
    return {
      granted: row.holder_node_id === holderNodeId,
      holder: row.holder_node_id,
      expiresAt: row.expires_at,
    };
  }

  /**
   * Extend the holder's lease (heartbeat). Returns false when the lease was lost
   * (taken over after a TTL expiry, or never held) so the caller can re-acquire.
   */
  heartbeat(
    accountUuid: string,
    holderNodeId: string,
    ttlMs: number,
    now: number
  ): boolean {
    if (!UUID_REGEX.test(accountUuid)) return false;
    const res = this.db
      .prepare(
        `UPDATE account_rotation_leases
            SET heartbeat_at = ?, expires_at = ?
          WHERE account_uuid = ?
            AND holder_node_id = ?
            AND expires_at > ?`
      )
      .run(now, now + ttlMs, accountUuid, holderNodeId, now);
    return res.changes > 0;
  }

  /**
   * Release the lease iff `holderNodeId` holds it (speeds handoff; the TTL covers
   * a crashed holder that never releases).
   */
  release(accountUuid: string, holderNodeId: string): void {
    if (!UUID_REGEX.test(accountUuid)) return;
    this.db
      .prepare(
        `DELETE FROM account_rotation_leases
          WHERE account_uuid = ? AND holder_node_id = ?`
      )
      .run(accountUuid, holderNodeId);
  }

  /** The current (non-expired) holder, or null when the family is free/expired. */
  getHolder(accountUuid: string, now: number): LeaseHolder | null {
    if (!UUID_REGEX.test(accountUuid)) return null;
    const row = this.db
      .prepare(
        `SELECT holder_node_id, expires_at
           FROM account_rotation_leases
          WHERE account_uuid = ? AND expires_at > ?`
      )
      .get(accountUuid, now) as
      | Pick<LeaseRow, "holder_node_id" | "expires_at">
      | undefined;
    if (!row) return null;
    return { holderNodeId: row.holder_node_id, expiresAt: row.expires_at };
  }

  private readRow(accountUuid: string): LeaseRow | undefined {
    return this.db
      .prepare(`SELECT * FROM account_rotation_leases WHERE account_uuid = ?`)
      .get(accountUuid) as LeaseRow | undefined;
  }
}
