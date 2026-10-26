// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import type { FeedbackEntryCategory } from "@hapi/protocol/types";

/**
 * One persisted feedback row (issue #2664, epic #2663 — In-app feedback system).
 * `description` and `metadataJson` are ALREADY scrubbed by the route before they
 * reach the store (R4) — the store never sees raw free-text.
 */
export type StoredFeedback = {
  id: string;
  createdAt: number;
  namespace: string | null;
  category: FeedbackEntryCategory;
  description: string;
  submitterEmail: string | null;
  /** Scrubbed, composed safe-metadata (`FeedbackMetadata`), JSON-serialized. */
  metadataJson: string;
  /**
   * Attachment metadata (issue #2665) — a JSON array of
   * `{ filename, mimeType, size }` refs, or `null` when the submission had no
   * attachments. Only the REFS are stored; the bytes ride the email (Path A),
   * so the row records WHAT was attached without bloating the DB.
   */
  attachmentsJson: string | null;
  emailed: boolean;
  emailError: string | null;
  /**
   * Forward state for the gateway's central sink (issue #2911). `pending` rows are
   * sent by the POST kick and the reconciler; `legacy` rows predate the sink and
   * wait for the operator backfill; `rejected` rows were refused (400/413) and are
   * never retried.
   */
  forwardState: FeedbackForwardState;
  /** The last forward failure, or null. Never contains the sink token. */
  forwardError: string | null;
  /** When the sink accepted the row (epoch ms), or null. */
  forwardedAt: number | null;
  /** Failed retryable forward attempts so far. */
  forwardAttempts: number;
};

/** Forward state of a local feedback row (the `forwarded` column, issue #2911). */
export type FeedbackForwardState =
  | "pending"
  | "forwarded"
  | "legacy"
  | "rejected";

/** The outcome of one forward attempt, recorded by {@link FeedbackStore.markForwarded}. */
export type FeedbackForwardOutcome =
  | { kind: "forwarded" }
  | { kind: "retryable"; error: string }
  | { kind: "rejected"; error: string }
  | { kind: "config-error"; error: string };

const FORWARD_PENDING = 0;
const FORWARD_DONE = 1;
const FORWARD_LEGACY = 2;
const FORWARD_REJECTED = 3;

const FORWARD_STATES: Record<number, FeedbackForwardState> = {
  [FORWARD_PENDING]: "pending",
  [FORWARD_DONE]: "forwarded",
  [FORWARD_LEGACY]: "legacy",
  [FORWARD_REJECTED]: "rejected",
};

/** Input to {@link FeedbackStore.createEntry} — the route supplies scrubbed content. */
export type CreateFeedbackEntry = {
  namespace?: string | null;
  category: FeedbackEntryCategory;
  description: string;
  submitterEmail?: string | null;
  metadataJson: string;
  /** JSON array of attachment refs (issue #2665); omit/null when none. */
  attachmentsJson?: string | null;
};

export type FeedbackFilters = {
  namespace?: string;
  category?: FeedbackEntryCategory;
  limit?: number;
  offset?: number;
};

type DbFeedbackRow = {
  id: string;
  created_at: number;
  namespace: string | null;
  category: string;
  description: string;
  submitter_email: string | null;
  metadata_json: string;
  attachments_json: string | null;
  emailed: number;
  email_error: string | null;
  forwarded?: number;
  forward_error?: string | null;
  forwarded_at?: number | null;
  forward_attempts?: number;
};

function toStoredFeedback(row: DbFeedbackRow): StoredFeedback {
  return {
    id: row.id,
    createdAt: row.created_at,
    namespace: row.namespace,
    category: row.category as FeedbackEntryCategory,
    description: row.description,
    submitterEmail: row.submitter_email,
    metadataJson: row.metadata_json,
    // A pre-#2665 row (or a SELECT before the column migration) has no
    // attachments_json; coalesce the absent column to null.
    attachmentsJson: row.attachments_json ?? null,
    emailed: row.emailed === 1,
    emailError: row.email_error,
    // A SELECT before the #2911 column migration has no forward columns; such a
    // row reads as legacy, like the column DEFAULT.
    forwardState: FORWARD_STATES[row.forwarded ?? FORWARD_LEGACY] ?? "legacy",
    forwardError: row.forward_error ?? null,
    forwardedAt: row.forwarded_at ?? null,
    forwardAttempts: row.forward_attempts ?? 0,
  };
}

/**
 * CRUD for the `feedback` table (issue #2664). Structurally mirrors
 * `ErrorLogStore`, but written fresh with an `updateEmailStatus` method that
 * `ErrorLogStore` lacks: the feedback row is persisted BEFORE the email is
 * attempted (R7 — persist-before-email), and the email outcome is recorded
 * afterward (R10). The row is the durable record — the admin viewer (#2666)
 * reads these rows and #2665 (attachments) extends the schema.
 */
export class FeedbackStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  createEntry(entry: CreateFeedbackEntry): StoredFeedback {
    const id = randomUUID();
    const now = Date.now();

    this.db
      .prepare(
        `
        INSERT INTO feedback (
          id, created_at, namespace, category, description,
          submitter_email, metadata_json, attachments_json, emailed, email_error,
          forwarded
        ) VALUES (
          @id, @created_at, @namespace, @category, @description,
          @submitter_email, @metadata_json, @attachments_json, 0, NULL,
          0
        )
        `
      )
      .run({
        id,
        created_at: now,
        namespace: entry.namespace ?? null,
        category: entry.category,
        description: entry.description,
        submitter_email: entry.submitterEmail ?? null,
        metadata_json: entry.metadataJson,
        attachments_json: entry.attachmentsJson ?? null,
      });

    return {
      id,
      createdAt: now,
      namespace: entry.namespace ?? null,
      category: entry.category,
      description: entry.description,
      submitterEmail: entry.submitterEmail ?? null,
      metadataJson: entry.metadataJson,
      attachmentsJson: entry.attachmentsJson ?? null,
      emailed: false,
      emailError: null,
      forwardState: "pending",
      forwardError: null,
      forwardedAt: null,
      forwardAttempts: 0,
    };
  }

  /**
   * Record the email outcome AFTER the persist-first submit (R7/R10). Called by
   * the route once the FeedbackSender returns — `emailed=true` on success,
   * `emailed=false` + `emailError` on a failed/skipped send.
   */
  updateEmailStatus(
    id: string,
    emailed: boolean,
    emailError: string | null
  ): void {
    this.db
      .prepare("UPDATE feedback SET emailed = ?, email_error = ? WHERE id = ?")
      .run(emailed ? 1 : 0, emailError, id);
  }

  /**
   * Pending rows, oldest first — the reconciler's queue (issue #2911). Legacy and
   * rejected rows never block it.
   */
  getUnforwarded(limit: number): StoredFeedback[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM feedback WHERE forwarded = ? ORDER BY created_at, id LIMIT ?"
      )
      .all(FORWARD_PENDING, limit) as DbFeedbackRow[];
    return rows.map(toStoredFeedback);
  }

  /**
   * Record one forward attempt (issue #2911). A success marks the row forwarded;
   * a failure only touches a row that is still pending, so a kick and the
   * reconciler racing on one row cannot mark a forwarded row as failed.
   */
  markForwarded(id: string, outcome: FeedbackForwardOutcome): void {
    switch (outcome.kind) {
      case "forwarded":
        this.db
          .prepare(
            "UPDATE feedback SET forwarded = ?, forwarded_at = ?, forward_error = NULL WHERE id = ?"
          )
          .run(FORWARD_DONE, Date.now(), id);
        return;
      case "retryable":
        this.db
          .prepare(
            "UPDATE feedback SET forward_attempts = forward_attempts + 1, forward_error = ? WHERE id = ? AND forwarded = ?"
          )
          .run(outcome.error, id, FORWARD_PENDING);
        return;
      case "rejected":
        this.db
          .prepare(
            "UPDATE feedback SET forwarded = ?, forward_error = ? WHERE id = ? AND forwarded = ?"
          )
          .run(FORWARD_REJECTED, outcome.error, id, FORWARD_PENDING);
        return;
      case "config-error":
        this.db
          .prepare(
            "UPDATE feedback SET forward_error = ? WHERE id = ? AND forwarded = ?"
          )
          .run(outcome.error, id, FORWARD_PENDING);
        return;
    }
  }

  /**
   * The operator backfill (issue #2911): mark every legacy row pending so the
   * reconciler forwards it. Idempotent; returns how many rows were requeued.
   */
  requeueLegacyRows(): number {
    return this.db
      .prepare("UPDATE feedback SET forwarded = ? WHERE forwarded = ?")
      .run(FORWARD_PENDING, FORWARD_LEGACY).changes;
  }

  getEntry(id: string): StoredFeedback | null {
    const row = this.db
      .prepare("SELECT * FROM feedback WHERE id = ?")
      .get(id) as DbFeedbackRow | undefined;

    return row ? toStoredFeedback(row) : null;
  }

  getEntries(filters: FeedbackFilters = {}): StoredFeedback[] {
    let query = "SELECT * FROM feedback WHERE 1=1";
    const params: (string | number)[] = [];

    if (filters.namespace) {
      query += " AND namespace = ?";
      params.push(filters.namespace);
    }
    if (filters.category) {
      query += " AND category = ?";
      params.push(filters.category);
    }

    query += " ORDER BY created_at DESC";

    if (filters.limit != null) {
      query += " LIMIT ?";
      params.push(filters.limit);
    }
    if (filters.offset != null) {
      query += " OFFSET ?";
      params.push(filters.offset);
    }

    const rows = this.db.prepare(query).all(...params) as DbFeedbackRow[];
    return rows.map(toStoredFeedback);
  }

  /**
   * Total number of feedback rows matching the (namespace/category) filters,
   * ignoring `limit`/`offset` — the pagination total for the #2666 admin viewer
   * (`GET /api/feedback` returns `{ items, total }`). Mirrors the `COUNT(*)`
   * shape of `errorLog.countBySeverity`, but scoped to the same predicate
   * `getEntries` applies so the count and the page stay consistent.
   */
  countEntries(filters: FeedbackFilters = {}): number {
    let query = "SELECT COUNT(*) as count FROM feedback WHERE 1=1";
    const params: (string | number)[] = [];

    if (filters.namespace) {
      query += " AND namespace = ?";
      params.push(filters.namespace);
    }
    if (filters.category) {
      query += " AND category = ?";
      params.push(filters.category);
    }

    const row = this.db.prepare(query).get(...params) as { count: number };
    return row.count;
  }
}
