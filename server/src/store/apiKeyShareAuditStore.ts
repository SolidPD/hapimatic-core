// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";

/**
 * Durable audit of every cross-node request for a shared API key (issue #5127,
 * R10). Kept on the key's HOME node: one row per `resolve` and `secret` request
 * and per refusal, so the operator can see which node asked for which key, for
 * which session, and what it was told.
 *
 * Not `errorLogger`: that is rate-limited per category and drops on flood
 * (`logging/errorLogger.ts`), and a release of a secret must never go unrecorded.
 * Writes are synchronous, like {@link AuditStore}. The `api_key_share_audit`
 * table is created in `Store.runMigrations()` (`store/index.ts`); this class is
 * pure queries.
 *
 * No key material ever reaches this table: `masked_key` holds the
 * `maskApiKey` form (four dots and the last four characters) and `detail` is a
 * refusal code or a short fixed note, never a request body or an error message.
 */

/** What the requester asked for. */
export type ApiKeySharePurpose = "list" | "resolve" | "secret";

/** One row to append. */
export interface ApiKeyShareAuditRow {
  timestamp: number;
  /** The vault id, or `*` for a `list` request (it covers every shared key). */
  keyId: string;
  keyLabel: string | null;
  maskedKey: string | null;
  /** The requester's CLAIMED node id (the mesh token is the authentication). */
  requestingNodeId: string;
  /** The TCP peer the request came from, for telling a tailnet peer from a
   *  same-host request. */
  peerAddress: string | null;
  sessionId: string | null;
  purpose: ApiKeySharePurpose;
  /** `ok`, or the refusal code. */
  outcome: string;
  detail: string | null;
}

export interface ApiKeyShareAuditRecord extends ApiKeyShareAuditRow {
  id: number;
}

/** One group of {@link ApiKeyShareAuditStore.summarize}. */
export interface ApiKeyShareAuditSummaryRow {
  requestingNodeId: string;
  keyId: string;
  keyLabel: string | null;
  maskedKey: string | null;
  purpose: ApiKeySharePurpose;
  outcome: string;
  count: number;
  lastAt: number;
}

/** How long rows are kept. */
export const API_KEY_SHARE_AUDIT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** A successful `list` from one node is recorded at most this often: the
 *  Create-page picker re-reads every node's shared keys on each open. */
export const API_KEY_SHARE_AUDIT_LIST_THROTTLE_MS = 10 * 60 * 1000;
/** Pruning runs from `append()` at most this often. */
export const API_KEY_SHARE_AUDIT_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
/** Identical flood-class refusals (same peer address, purpose and outcome,
 *  see {@link API_KEY_SHARE_AUDIT_COALESCED_OUTCOMES}) inside this
 *  window after a written one are counted, not written; the next written row
 *  for them carries the count. Bounds the table under a refusal flood. */
/** Refusals that come before a key is looked at — the ones a token holder
 *  can repeat without limit (perf review L3, code review F3). Only these are
 *  coalesced; every refusal about a specific key (not shared, changed, not
 *  found, …) is written, each with its key and session (R10). */
export const API_KEY_SHARE_AUDIT_COALESCED_OUTCOMES: ReadonlySet<string> =
  new Set([
    "tenant_vm",
    "home_mismatch",
    "api_key_transport_refused",
    "api_key_requester_unknown",
    "api_key_rate_limited",
    "api_key_audit_unavailable",
  ]);
export const API_KEY_SHARE_AUDIT_REFUSAL_COALESCE_MS = 60 * 1000;
/** Most refusal series tracked at once (the map is cleared past it). */
const MAX_REFUSAL_SERIES = 2000;

interface DbRow {
  id: number;
  timestamp: number;
  key_id: string;
  key_label: string | null;
  masked_key: string | null;
  requesting_node_id: string;
  peer_address: string | null;
  session_id: string | null;
  purpose: string;
  outcome: string;
  detail: string | null;
}

export class ApiKeyShareAuditStore {
  private readonly db: Database;
  private readonly now: () => number;
  private readonly lastListAt = new Map<string, number>();
  private readonly refusals = new Map<
    string,
    { at: number; suppressed: number }
  >();
  private readonly refusalCoalesceMs: number;
  private lastPruneAt = 0;

  constructor(
    db: Database,
    opts: { now?: () => number; refusalCoalesceMs?: number } = {}
  ) {
    this.db = db;
    this.now = opts.now ?? Date.now;
    this.refusalCoalesceMs =
      opts.refusalCoalesceMs ?? API_KEY_SHARE_AUDIT_REFUSAL_COALESCE_MS;
  }

  /**
   * Record one request. Synchronous: the row is committed before this returns,
   * so a key is never released without its record. A successful `list` from a
   * node already recorded within {@link API_KEY_SHARE_AUDIT_LIST_THROTTLE_MS}
   * is skipped. Every `resolve` and `secret` release is written; a burst of
   * identical refusals is coalesced (see
   * {@link API_KEY_SHARE_AUDIT_REFUSAL_COALESCE_MS}). Returns true when a row
   * was written.
   */
  append(input: ApiKeyShareAuditRow): boolean {
    let row = input;
    if (
      API_KEY_SHARE_AUDIT_COALESCED_OUTCOMES.has(row.outcome) &&
      this.refusalCoalesceMs > 0
    ) {
      // Keyed by the peer's address, not the requester it claims: a token
      // holder varying the claimed node id must not open a new series (and a
      // new row) per request (perf review L3).
      const series = `${row.peerAddress ?? ""}|${row.purpose}|${row.outcome}`;
      const prev = this.refusals.get(series);
      if (prev && row.timestamp - prev.at < this.refusalCoalesceMs) {
        prev.suppressed += 1;
        return false;
      }
      const carried = prev?.suppressed ?? 0;
      if (this.refusals.size >= MAX_REFUSAL_SERIES) this.refusals.clear();
      this.refusals.set(series, { at: row.timestamp, suppressed: 0 });
      if (carried > 0) {
        row = {
          ...row,
          detail: `${carried} identical refusal(s) in the minute before this one were not written`,
        };
      }
    }
    if (row.purpose === "list" && row.outcome === "ok") {
      const last = this.lastListAt.get(row.requestingNodeId);
      if (
        last !== undefined &&
        row.timestamp - last < API_KEY_SHARE_AUDIT_LIST_THROTTLE_MS
      ) {
        return false;
      }
      this.lastListAt.set(row.requestingNodeId, row.timestamp);
    }
    this.db
      .prepare(
        `INSERT INTO api_key_share_audit
           (timestamp, key_id, key_label, masked_key, requesting_node_id,
            peer_address, session_id, purpose, outcome, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.timestamp,
        row.keyId,
        row.keyLabel,
        row.maskedKey,
        row.requestingNodeId,
        row.peerAddress,
        row.sessionId,
        row.purpose,
        row.outcome,
        row.detail
      );
    const t = this.now();
    if (t - this.lastPruneAt >= API_KEY_SHARE_AUDIT_PRUNE_INTERVAL_MS) {
      this.lastPruneAt = t;
      this.pruneOlderThan(t - API_KEY_SHARE_AUDIT_RETENTION_MS);
    }
    return true;
  }

  /** Delete rows older than `cutoffMs`. Returns the number deleted. */
  pruneOlderThan(cutoffMs: number): number {
    return this.db
      .prepare(`DELETE FROM api_key_share_audit WHERE timestamp < ?`)
      .run(cutoffMs).changes;
  }

  /** The most recent `limit` rows, newest first. */
  list(limit = 100): ApiKeyShareAuditRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, timestamp, key_id, key_label, masked_key, requesting_node_id,
                peer_address, session_id, purpose, outcome, detail
           FROM api_key_share_audit
          ORDER BY id DESC
          LIMIT ?`
      )
      .all(limit) as DbRow[];
    return rows.map(r => ({
      id: r.id,
      timestamp: r.timestamp,
      keyId: r.key_id,
      keyLabel: r.key_label,
      maskedKey: r.masked_key,
      requestingNodeId: r.requesting_node_id,
      peerAddress: r.peer_address,
      sessionId: r.session_id,
      purpose: r.purpose as ApiKeySharePurpose,
      outcome: r.outcome,
      detail: r.detail,
    }));
  }

  /** Rows since `sinceMs`, grouped by requester, key, purpose and outcome. */
  summarize(sinceMs: number): ApiKeyShareAuditSummaryRow[] {
    const rows = this.db
      .prepare(
        `SELECT requesting_node_id, key_id, MAX(key_label) AS key_label,
                MAX(masked_key) AS masked_key, purpose, outcome,
                COUNT(*) AS count, MAX(timestamp) AS last_at
           FROM api_key_share_audit
          WHERE timestamp >= ?
          GROUP BY requesting_node_id, key_id, purpose, outcome
          ORDER BY last_at DESC`
      )
      .all(sinceMs) as Array<{
      requesting_node_id: string;
      key_id: string;
      key_label: string | null;
      masked_key: string | null;
      purpose: string;
      outcome: string;
      count: number;
      last_at: number;
    }>;
    return rows.map(r => ({
      requestingNodeId: r.requesting_node_id,
      keyId: r.key_id,
      keyLabel: r.key_label,
      maskedKey: r.masked_key,
      purpose: r.purpose as ApiKeySharePurpose,
      outcome: r.outcome,
      count: r.count,
      lastAt: r.last_at,
    }));
  }
}

/** The table's DDL, shared by `Store.runMigrations()` and the tests. */
export const API_KEY_SHARE_AUDIT_DDL = [
  "CREATE TABLE IF NOT EXISTS api_key_share_audit (" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
    "timestamp INTEGER NOT NULL, " +
    "key_id TEXT NOT NULL, " +
    "key_label TEXT, " +
    "masked_key TEXT, " +
    "requesting_node_id TEXT NOT NULL, " +
    "peer_address TEXT, " +
    "session_id TEXT, " +
    "purpose TEXT NOT NULL CHECK(purpose IN ('list','resolve','secret')), " +
    "outcome TEXT NOT NULL, " +
    "detail TEXT)",
  "CREATE INDEX IF NOT EXISTS idx_api_key_share_audit_timestamp " +
    "ON api_key_share_audit(timestamp)",
  "CREATE INDEX IF NOT EXISTS idx_api_key_share_audit_key " +
    "ON api_key_share_audit(key_id, timestamp)",
] as const;
