// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import type {
  ErrorLogFilters,
  ErrorLogSeverity,
  ErrorLogSource,
  StoredErrorLog,
} from "./types";

type DbErrorLogRow = {
  id: string;
  timestamp: number;
  severity: string;
  category: string;
  source: string;
  message: string;
  stack: string | null;
  session_id: string | null;
  namespace: string | null;
  context: string | null;
  user_agent: string | null;
  request_path: string | null;
  request_method: string | null;
  status_code: number | null;
  original_timestamp: number | null;
};

function toStoredErrorLog(row: DbErrorLogRow): StoredErrorLog {
  return {
    id: row.id,
    timestamp: row.timestamp,
    severity: row.severity as ErrorLogSeverity,
    category: row.category,
    source: row.source as ErrorLogSource,
    message: row.message,
    stack: row.stack,
    sessionId: row.session_id,
    namespace: row.namespace,
    context: row.context,
    userAgent: row.user_agent,
    requestPath: row.request_path,
    requestMethod: row.request_method,
    statusCode: row.status_code,
    originalTimestamp: row.original_timestamp,
  };
}

export type CreateErrorLogEntry = {
  severity: ErrorLogSeverity;
  category: string;
  source: ErrorLogSource;
  message: string;
  stack?: string | null;
  sessionId?: string | null;
  namespace?: string | null;
  context?: string | null;
  userAgent?: string | null;
  requestPath?: string | null;
  requestMethod?: string | null;
  statusCode?: number | null;
  /** Issue #1244: client-side enqueuedAt for replayed reports. NULL on live POSTs. */
  originalTimestamp?: number | null;
};

export function createEntry(
  db: Database,
  entry: CreateErrorLogEntry
): StoredErrorLog {
  const id = randomUUID();
  const now = Date.now();

  db.prepare(
    `
    INSERT INTO error_logs (
      id, timestamp, severity, category, source, message,
      stack, session_id, namespace, context,
      user_agent, request_path, request_method, status_code,
      original_timestamp
    ) VALUES (
      @id, @timestamp, @severity, @category, @source, @message,
      @stack, @session_id, @namespace, @context,
      @user_agent, @request_path, @request_method, @status_code,
      @original_timestamp
    )
    `
  ).run({
    id,
    timestamp: now,
    severity: entry.severity,
    category: entry.category,
    source: entry.source,
    message: entry.message,
    stack: entry.stack ?? null,
    session_id: entry.sessionId ?? null,
    namespace: entry.namespace ?? null,
    context: entry.context ?? null,
    user_agent: entry.userAgent ?? null,
    request_path: entry.requestPath ?? null,
    request_method: entry.requestMethod ?? null,
    status_code: entry.statusCode ?? null,
    original_timestamp: entry.originalTimestamp ?? null,
  });

  return {
    id,
    timestamp: now,
    severity: entry.severity,
    category: entry.category,
    source: entry.source,
    message: entry.message,
    stack: entry.stack ?? null,
    sessionId: entry.sessionId ?? null,
    namespace: entry.namespace ?? null,
    context: entry.context ?? null,
    userAgent: entry.userAgent ?? null,
    requestPath: entry.requestPath ?? null,
    requestMethod: entry.requestMethod ?? null,
    statusCode: entry.statusCode ?? null,
    originalTimestamp: entry.originalTimestamp ?? null,
  };
}

export function getEntry(db: Database, id: string): StoredErrorLog | null {
  const row = db.prepare("SELECT * FROM error_logs WHERE id = ?").get(id) as
    | DbErrorLogRow
    | undefined;

  return row ? toStoredErrorLog(row) : null;
}

export function getEntries(
  db: Database,
  filters: ErrorLogFilters
): StoredErrorLog[] {
  let query = "SELECT * FROM error_logs WHERE 1=1";
  const params: (string | number)[] = [];

  if (filters.severity) {
    query += " AND severity = ?";
    params.push(filters.severity);
  }

  if (filters.category) {
    query += " AND category = ?";
    params.push(filters.category);
  }

  if (filters.source) {
    query += " AND source = ?";
    params.push(filters.source);
  }

  if (filters.sessionId) {
    query += " AND session_id = ?";
    params.push(filters.sessionId);
  }

  if (filters.startTime != null) {
    query += " AND timestamp >= ?";
    params.push(filters.startTime);
  }

  if (filters.endTime != null) {
    query += " AND timestamp <= ?";
    params.push(filters.endTime);
  }

  query += " ORDER BY timestamp DESC";

  if (filters.limit != null) {
    query += " LIMIT ?";
    params.push(filters.limit);
  }

  if (filters.offset != null) {
    query += " OFFSET ?";
    params.push(filters.offset);
  }

  const rows = db.prepare(query).all(...params) as DbErrorLogRow[];
  return rows.map(toStoredErrorLog);
}

export function deleteEntry(db: Database, id: string): boolean {
  const result = db.prepare("DELETE FROM error_logs WHERE id = ?").run(id);

  return result.changes > 0;
}

export function deleteEntriesOlderThan(db: Database, days: number): number {
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;

  const result = db
    .prepare("DELETE FROM error_logs WHERE timestamp < ?")
    .run(cutoffMs);

  return result.changes;
}

export function countBySeverity(db: Database): Record<string, number> {
  const rows = db
    .prepare(
      "SELECT severity, COUNT(*) as count FROM error_logs GROUP BY severity"
    )
    .all() as Array<{ severity: string; count: number }>;

  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.severity] = row.count;
  }
  return counts;
}
