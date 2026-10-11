// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Append-only VM-provisioning audit log (issue #2471, epic #2467 Sub D — R3).
 *
 * A durable audit trail, SEPARATE from the job records (`jobStore.ts`), recording
 * who/what/when/flags for the security-relevant lifecycle events: every job
 * creation, every deprovision `--apply` confirmation, and every terminal state.
 * The panel can terminate VMs and spend money, so this trail is the forensic
 * record of who did what.
 *
 * ## Append-only by construction
 *
 * The class exposes ONLY {@link AuditLog.append} and {@link AuditLog.list} — there
 * is no update or delete method. The table is written with monotonic `INSERT`s and
 * read chronologically; an entry, once written, is never mutated by this API.
 *
 * ## A dedicated database, not a table in the job store
 *
 * The caller MUST inject a Database DISTINCT from the job store's (the server
 * wiring opens `provisioner-audit.sqlite`; tests inject `new Database(":memory:")`).
 * Keeping the trail in its own file means a bug (or a future feature) touching the
 * job store's schema cannot reach the audit rows, and the audit file's on-disk
 * lifetime is independent of the job records.
 *
 * ## Trust boundary (documented, not enforced here)
 *
 * Tamper-resistance is API-level only: this class never mutates a row, but a
 * same-user process can write the underlying SQLite file directly. Prod, dev, and
 * worktree instances share one Unix user, so the audit file is only as trustworthy
 * as that user's process set. A cryptographic hash chain would raise this bar and
 * is recorded as future work in `docs/internal/architecture/vm-admin-security.md`.
 */

import type { Database } from "bun:sqlite";

export const PROVISIONER_AUDIT_TABLE = "provisioner_audit";
export const PROVISIONER_AUDIT_SCHEMA_VERSION = 1;

/** The security-relevant lifecycle events the trail records. */
export type AuditAction = "create" | "apply-confirm" | "terminal";

export const AUDIT_ACTIONS: readonly AuditAction[] = [
  "create",
  "apply-confirm",
  "terminal",
] as const;

/**
 * Who performed the action. An operator action carries the JWT identity
 * (`{uid, ns}` — the payload has no email); the runner's terminal transition has
 * no request context (it can fire from a startup re-attach), so it is attributed
 * to `system`. The actor is NEVER a client-supplied field.
 */
export type AuditActor =
  | { kind: "operator"; userId: number; namespace: string }
  | { kind: "system" };

/** The system actor singleton — the runner's terminal-state transitions. */
export const SYSTEM_ACTOR: AuditActor = { kind: "system" };

/** Build an operator actor from the JWT context values. */
export function operatorActor(userId: number, namespace: string): AuditActor {
  return { kind: "operator", userId, namespace };
}

/** An entry as handed to {@link AuditLog.append} (id/ts assigned by the store). */
export interface AuditEntryInput {
  actor: AuditActor;
  action: AuditAction;
  jobId: string;
  /** The job kind (a `JobKind` literal — kept loose so the audit module has no server-type dep). */
  kind: string;
  /**
   * The sanitized job argv. Secret-free BY CONSTRUCTION: `buildJob`'s allowlist
   * (#2468 R5) admits only positionals + non-secret flags, and every secret is
   * read from the process ENVIRONMENT, never argv — so no secret can reach a row.
   */
  flags: string[];
  /** Job state at the time of the action (the terminal state for `terminal`). */
  state?: string | null;
  /** Override timestamp (default: the store's clock). */
  ts?: number;
}

/** A persisted audit entry (append-only). */
export interface AuditEntry {
  id: number;
  ts: number;
  actor: AuditActor;
  action: AuditAction;
  jobId: string;
  kind: string;
  flags: string[];
  state: string | null;
}

/** Filter for {@link AuditLog.list}. Omit for the full chronological trail. */
export interface AuditListFilter {
  jobId?: string;
  action?: AuditAction;
}

// Schema as discrete statements (CREATE TABLE, CREATE INDEX, PRAGMA), each run
// individually on construction — mirrors the house SQLite store idiom (one
// injectable `Database`, schema ensured in the constructor) without a single
// multi-statement string.
const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS ${PROVISIONER_AUDIT_TABLE} (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ts INTEGER NOT NULL,
     actor TEXT NOT NULL,          -- JSON: {kind:'operator',userId,namespace} | {kind:'system'}
     action TEXT NOT NULL CHECK (action IN ('create','apply-confirm','terminal')),
     job_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     flags TEXT NOT NULL,          -- JSON array of strings (sanitized argv)
     state TEXT                    -- nullable
   )`,
  `CREATE INDEX IF NOT EXISTS idx_${PROVISIONER_AUDIT_TABLE}_job
     ON ${PROVISIONER_AUDIT_TABLE}(job_id)`,
  `PRAGMA user_version = ${PROVISIONER_AUDIT_SCHEMA_VERSION}`,
];

/** Physical row shape (snake_case, JSON-as-text). */
interface AuditRow {
  id: number;
  ts: number;
  actor: string;
  action: string;
  job_id: string;
  kind: string;
  flags: string;
  state: string | null;
}

function rowToEntry(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    ts: row.ts,
    actor: JSON.parse(row.actor) as AuditActor,
    action: row.action as AuditAction,
    jobId: row.job_id,
    kind: row.kind,
    flags: JSON.parse(row.flags) as string[],
    state: row.state,
  };
}

/**
 * Append-only store over ONE injectable {@link Database}. Ensures its own schema
 * on construction (no separate migration step). Inject a dedicated database — see
 * the module doc.
 */
export class AuditLog {
  private readonly db: Database;
  private readonly now: () => number;

  constructor(db: Database, opts: { now?: () => number } = {}) {
    this.db = db;
    this.now = opts.now ?? (() => Date.now());
    for (const statement of SCHEMA_STATEMENTS) {
      this.db.run(statement);
    }
  }

  /** Record one lifecycle event. Returns the stored entry (with `id` + `ts`). */
  append(input: AuditEntryInput): AuditEntry {
    const ts = input.ts ?? this.now();
    const state = input.state ?? null;
    const info = this.db
      .prepare(
        `INSERT INTO ${PROVISIONER_AUDIT_TABLE}
           (ts, actor, action, job_id, kind, flags, state)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        ts,
        JSON.stringify(input.actor),
        input.action,
        input.jobId,
        input.kind,
        JSON.stringify(input.flags),
        state
      );
    return {
      id: Number(info.lastInsertRowid),
      ts,
      actor: input.actor,
      action: input.action,
      jobId: input.jobId,
      kind: input.kind,
      flags: input.flags,
      state,
    };
  }

  /** The chronological trail (ascending `id`), optionally filtered by job/action. */
  list(filter: AuditListFilter = {}): AuditEntry[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.jobId !== undefined) {
      clauses.push("job_id = ?");
      params.push(filter.jobId);
    }
    if (filter.action !== undefined) {
      clauses.push("action = ?");
      params.push(filter.action);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT * FROM ${PROVISIONER_AUDIT_TABLE} ${where} ORDER BY id ASC`
      )
      .all(...params) as AuditRow[];
    return rows.map(rowToEntry);
  }
}
