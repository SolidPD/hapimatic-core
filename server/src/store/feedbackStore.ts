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
          submitter_email, metadata_json, attachments_json, emailed, email_error
        ) VALUES (
          @id, @created_at, @namespace, @category, @description,
          @submitter_email, @metadata_json, @attachments_json, 0, NULL
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
