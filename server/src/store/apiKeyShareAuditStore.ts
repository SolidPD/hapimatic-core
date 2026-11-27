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

/** What the requester asked for. `out-of-credit` (#6978) is a peer's report
 *  that a session there was refused for lack of credit on this home's key. */
export type ApiKeySharePurpose =
  | "list"
  | "resolve"
  | "secret"
  | "out-of-credit";

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
  private creditPurposeReady = false;

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
   * #6978: true when the table's CHECK accepts `purpose`. Only `out-of-credit`
   * can be missing: on a database whose one-time widen failed, the old table
   * stays and refuses it, so the out-of-credit receiver must refuse BEFORE it
   * stamps rather than stamp and then fail to record it. A true answer is
   * cached (the table is only ever widened); a false one is re-read each time.
   */
  acceptsPurpose(purpose: ApiKeySharePurpose): boolean {
    if (purpose !== "out-of-credit" || this.creditPurposeReady) return true;
    this.creditPurposeReady = creditPurposeCheck(this.db) === "wide";
    return this.creditPurposeReady;
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

/** The table's columns: ONE source for the DDL and the #6978 rebuild. */
const API_KEY_SHARE_AUDIT_COLUMNS =
  "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
  "timestamp INTEGER NOT NULL, " +
  "key_id TEXT NOT NULL, " +
  "key_label TEXT, " +
  "masked_key TEXT, " +
  "requesting_node_id TEXT NOT NULL, " +
  "peer_address TEXT, " +
  "session_id TEXT, " +
  "purpose TEXT NOT NULL CHECK(purpose IN ('list','resolve','secret','out-of-credit')), " +
  "outcome TEXT NOT NULL, " +
  "detail TEXT";

const API_KEY_SHARE_AUDIT_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_api_key_share_audit_timestamp " +
    "ON api_key_share_audit(timestamp)",
  "CREATE INDEX IF NOT EXISTS idx_api_key_share_audit_key " +
    "ON api_key_share_audit(key_id, timestamp)",
] as const;

/** The table's DDL, shared by `Store.runMigrations()` and the tests. */
export const API_KEY_SHARE_AUDIT_DDL = [
  `CREATE TABLE IF NOT EXISTS api_key_share_audit (${API_KEY_SHARE_AUDIT_COLUMNS})`,
  ...API_KEY_SHARE_AUDIT_INDEXES,
] as const;

type TableColumn = {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
};

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/**
 * Issue #6978: the audit table's `purpose` CHECK as SQLite stores it: `absent`
 * when there is no table, `wide` when it accepts `out-of-credit`, `narrow` when
 * it does not. The ONE reading for the boot-time widen and the receiver's
 * pre-stamp check ({@link ApiKeyShareAuditStore.acceptsPurpose}), so the two can
 * never disagree about whether a stamp can be recorded.
 */
function creditPurposeCheck(db: Database): "absent" | "narrow" | "wide" {
  const row = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'api_key_share_audit'"
    )
    .get() as { sql: string | null } | null | undefined;
  const sql = row?.sql;
  if (!sql) return "absent";
  return sql.includes("'out-of-credit'") ? "wide" : "narrow";
}

/**
 * Issue #6978: widen the `purpose` CHECK of an existing `api_key_share_audit`
 * table to accept `out-of-credit`. A CHECK cannot be altered in SQLite and the
 * DDL's `CREATE TABLE IF NOT EXISTS` does nothing on an existing table, so the
 * table is rebuilt once, in ONE immediate transaction:
 *
 * - every column the old table holds is kept, with its values: a column another
 *   migration added (for example #5807's planned `suppressed_count`) is added to
 *   the new table with its declared type, NOT NULL and default, and the copy's
 *   column list comes from the old table itself;
 * - every row keeps its id, and the AUTOINCREMENT high-water mark
 *   (`sqlite_sequence`) never goes down, so a pruned id is never handed out again;
 * - both indexes are recreated.
 *
 * Returns true when it rebuilt the table, false when there is no table or the
 * CHECK already accepts the purpose (so a second run changes nothing). A failure
 * throws and the transaction leaves the old table and its rows in place; the
 * caller logs it, and the receiver then refuses as `api_key_audit_unavailable`
 * before any stamp ({@link ApiKeyShareAuditStore.acceptsPurpose}; fail-closed).
 *
 * Rollback-safe: an older binary on the rebuilt table only runs its
 * `CREATE TABLE IF NOT EXISTS`, which does nothing, and the wider CHECK still
 * accepts its three purposes.
 */
export function widenApiKeySharePurposeCheck(db: Database): boolean {
  if (creditPurposeCheck(db) !== "narrow") return false;

  const rebuild = db.transaction(() => {
    db.run("DROP TABLE IF EXISTS api_key_share_audit_next");
    db.run(
      `CREATE TABLE api_key_share_audit_next (${API_KEY_SHARE_AUDIT_COLUMNS})`
    );

    const columnsOf = (table: string): TableColumn[] =>
      db.prepare(`PRAGMA table_info(${table})`).all() as TableColumn[];
    const oldColumns = columnsOf("api_key_share_audit");
    const newNames = new Set(
      columnsOf("api_key_share_audit_next").map(c => c.name)
    );
    for (const col of oldColumns) {
      if (newNames.has(col.name)) continue;
      db.run(
        `ALTER TABLE api_key_share_audit_next ADD COLUMN ${quoteIdent(col.name)}` +
          (col.type ? ` ${col.type}` : "") +
          (col.notnull ? " NOT NULL" : "") +
          (col.dflt_value !== null ? ` DEFAULT ${col.dflt_value}` : "")
      );
    }

    const list = oldColumns.map(c => quoteIdent(c.name)).join(", ");
    db.run(
      `INSERT INTO api_key_share_audit_next (${list}) SELECT ${list} FROM api_key_share_audit`
    );

    // The table's AUTOINCREMENT mark, read before the drop and after the rename.
    const readSeqRow = (): { seq: number } | undefined =>
      db
        .prepare(
          "SELECT seq FROM sqlite_sequence WHERE name = 'api_key_share_audit'"
        )
        .get() as { seq: number } | undefined;
    const oldSeq = readSeqRow()?.seq ?? 0;

    db.run("DROP TABLE api_key_share_audit");
    db.run(
      "ALTER TABLE api_key_share_audit_next RENAME TO api_key_share_audit"
    );

    const seqRow = readSeqRow();
    if (seqRow) {
      db.prepare(
        "UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'api_key_share_audit'"
      ).run(oldSeq);
    } else if (oldSeq > 0) {
      db.prepare(
        "INSERT INTO sqlite_sequence (name, seq) VALUES ('api_key_share_audit', ?)"
      ).run(oldSeq);
    }

    for (const ddl of API_KEY_SHARE_AUDIT_INDEXES) db.run(ddl);
  });
  rebuild.immediate();
  return true;
}
