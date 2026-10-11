// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";

import { resolveRepoIdentity } from "../utils/repoIdentity";
import type {
  DailySummary,
  ProjectGroupedSummary,
  StoredTimeLogEntry,
  TimeLogFilters,
  WeeklySummary,
} from "./types";

/**
 * Issue #1119: DST-correct date arithmetic helper.
 *
 * Compute YYYY-MM-DD for `dateStr + days` IN the given IANA timezone.
 * Anchors at local-noon UTC (always inside the day in any IANA zone),
 * advances by whole-day milliseconds, then reformats in the target zone.
 * Epoch-millisecond arithmetic alone is wrong across DST boundaries.
 *
 * Mirrors `addDaysInTimezone` in `sync/timelogReset.ts` — if you change one,
 * change both. (Issue #2080: moved out of `SyncEngine` into that delegate.)
 */
function addDaysInTimezone(
  dateStr: string,
  days: number,
  timezone: string
): string {
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) {
    throw new Error(`addDaysInTimezone: invalid YYYY-MM-DD: ${dateStr}`);
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const noonUtc = Date.UTC(year, month - 1, day, 12, 0, 0);
  const target = new Date(noonUtc + days * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(target);
}

/**
 * Get today's date as YYYY-MM-DD in the given IANA timezone.
 */
function getTodayInTimezone(timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/**
 * Resolve the configured timezone fallback for date arithmetic.
 * Wrapped so callers don't need to thread `timezone` through everywhere
 * — the sync engine and routes can pass an explicit timezone, but for
 * unscoped calls (tests, ad-hoc API) the runtime's resolved IANA zone
 * is the right default per #1119 R6 (NOT hardcoded America/New_York).
 */
function defaultTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

type DbTimeLogRow = {
  id: string;
  session_id: string;
  session_name: string;
  project_directory: string;
  date: string;
  duration_ms: number;
  created_at: number;
  namespace: string;
  // Issue #1120: provenance fields. NULL on rows written before this migration.
  event_type: string | null;
  timezone: string | null;
  reset_epoch: number | null;
};

function toStoredTimeLogEntry(row: DbTimeLogRow): StoredTimeLogEntry {
  return {
    id: row.id,
    sessionId: row.session_id,
    sessionName: row.session_name,
    projectDirectory: row.project_directory,
    date: row.date,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
    namespace: row.namespace,
    // Issue #1120: provenance — null on legacy rows pre-migration.
    eventType: (row.event_type as StoredTimeLogEntry["eventType"]) ?? null,
    timezone: row.timezone,
    resetEpoch: row.reset_epoch,
  };
}

export function createEntry(
  db: Database,
  entry: Omit<StoredTimeLogEntry, "id" | "createdAt">,
  namespace: string
): StoredTimeLogEntry {
  const now = Date.now();
  const id = randomUUID();
  // Issue #1120: optional provenance fields. COALESCE keeps the SQL DEFAULT
  // 'flush' behavior for event_type when the caller passes undefined/null.
  const eventType = entry.eventType ?? null;
  const timezone = entry.timezone ?? null;
  const resetEpoch = entry.resetEpoch ?? null;

  db.prepare(
    `
        INSERT INTO timelog_entries (
            id, session_id, session_name, project_directory,
            date, duration_ms, created_at, namespace,
            event_type, timezone, reset_epoch
        ) VALUES (
            @id, @session_id, @session_name, @project_directory,
            @date, @duration_ms, @created_at, @namespace,
            COALESCE(@event_type, 'flush'), @timezone, @reset_epoch
        )
    `
  ).run({
    id,
    session_id: entry.sessionId,
    session_name: entry.sessionName,
    project_directory: entry.projectDirectory,
    date: entry.date,
    duration_ms: entry.durationMs,
    created_at: now,
    namespace,
    event_type: eventType,
    timezone,
    reset_epoch: resetEpoch,
  });

  return {
    id,
    sessionId: entry.sessionId,
    sessionName: entry.sessionName,
    projectDirectory: entry.projectDirectory,
    date: entry.date,
    durationMs: entry.durationMs,
    createdAt: now,
    namespace,
    // Mirror what was actually persisted: explicit values override the SQL
    // default; otherwise event_type lands as 'flush' per the column default.
    eventType: eventType ?? "flush",
    timezone,
    resetEpoch,
  };
}

export function upsertEntry(
  db: Database,
  entry: Omit<StoredTimeLogEntry, "id" | "createdAt">,
  namespace: string
): StoredTimeLogEntry {
  // Check if entry exists for this session/date combo
  const existing = db
    .prepare(
      `
        SELECT * FROM timelog_entries
        WHERE session_id = ? AND date = ? AND namespace = ?
    `
    )
    .get(entry.sessionId, entry.date, namespace) as DbTimeLogRow | undefined;

  if (existing) {
    // Update existing entry — use MAX to prevent overwriting a larger
    // correct value with a smaller one after server restart (when
    // in-memory baselines are lost and the first post-restart delta
    // is smaller than the pre-restart total already in the DB).
    //
    // Issue #1120: COALESCE on the new provenance columns preserves the
    // existing values when the caller passes undefined/null — keeping the
    // signature backward-compatible for routes that don't supply them yet.
    const eventType = entry.eventType ?? null;
    const timezone = entry.timezone ?? null;
    const resetEpoch = entry.resetEpoch ?? null;

    db.prepare(
      `
            UPDATE timelog_entries
            SET duration_ms = MAX(duration_ms, @duration_ms),
                session_name = @session_name,
                project_directory = @project_directory,
                event_type   = COALESCE(@event_type, event_type),
                timezone     = COALESCE(@timezone, timezone),
                reset_epoch  = COALESCE(@reset_epoch, reset_epoch)
            WHERE id = @id AND namespace = @namespace
        `
    ).run({
      id: existing.id,
      duration_ms: entry.durationMs,
      session_name: entry.sessionName,
      project_directory: entry.projectDirectory,
      event_type: eventType,
      timezone,
      reset_epoch: resetEpoch,
      namespace,
    });

    // Issue #1120: re-read the row to return what was ACTUALLY persisted.
    // Pre-fix this returned `entry.durationMs` directly, which lied about
    // DB state when MAX kept the larger existing value. The re-read also
    // covers the COALESCE-keeps-existing case for the provenance columns.
    const after = db
      .prepare(`SELECT * FROM timelog_entries WHERE id = ? AND namespace = ?`)
      .get(existing.id, namespace) as DbTimeLogRow;

    return toStoredTimeLogEntry(after);
  }

  // Create new entry
  return createEntry(db, entry, namespace);
}

export function getEntry(
  db: Database,
  id: string,
  namespace: string
): StoredTimeLogEntry | null {
  const row = db
    .prepare(
      `
        SELECT * FROM timelog_entries
        WHERE id = ? AND namespace = ?
    `
    )
    .get(id, namespace) as DbTimeLogRow | undefined;

  return row ? toStoredTimeLogEntry(row) : null;
}

export function getEntries(
  db: Database,
  filters: TimeLogFilters,
  namespace: string
): StoredTimeLogEntry[] {
  let query = "SELECT * FROM timelog_entries WHERE namespace = ?";
  const params: (string | number)[] = [namespace];

  if (filters.startDate) {
    query += " AND date >= ?";
    params.push(filters.startDate);
  }

  if (filters.endDate) {
    query += " AND date <= ?";
    params.push(filters.endDate);
  }

  if (filters.sessionId) {
    query += " AND session_id = ?";
    params.push(filters.sessionId);
  }

  if (filters.projectDirectory) {
    query += " AND project_directory = ?";
    params.push(filters.projectDirectory);
  }

  query += " ORDER BY date DESC, created_at DESC";

  if (filters.limit) {
    query += " LIMIT ?";
    params.push(filters.limit);
  }

  const rows = db.prepare(query).all(...params) as DbTimeLogRow[];
  return rows.map(toStoredTimeLogEntry);
}

export function getEntriesByDate(
  db: Database,
  date: string,
  namespace: string
): StoredTimeLogEntry[] {
  const rows = db
    .prepare(
      `
        SELECT * FROM timelog_entries
        WHERE date = ? AND namespace = ?
        ORDER BY duration_ms DESC
    `
    )
    .all(date, namespace) as DbTimeLogRow[];

  return rows.map(toStoredTimeLogEntry);
}

export function getDailySummary(
  db: Database,
  date: string,
  namespace: string
): DailySummary {
  const entries = getEntriesByDate(db, date, namespace);

  const totalMs = entries.reduce((sum, e) => sum + e.durationMs, 0);

  return {
    date,
    totalMs,
    sessionCount: entries.length,
    entries: entries.map(e => ({
      sessionId: e.sessionId,
      sessionName: e.sessionName,
      durationMs: e.durationMs,
    })),
  };
}

export function getWeeklySummary(
  db: Database,
  startDate: string,
  namespace: string,
  timezone?: string
): WeeklySummary {
  // Issue #1119 R8: timezone-aware end-of-week computation.
  // The previous `new Date(startDate)` parsed YYYY-MM-DD as UTC midnight
  // and `toISOString().split("T")[0]` returned UTC dates — both wrong
  // around DST boundaries and for users east of UTC.
  const tz = timezone ?? defaultTimezone();
  const endDate = addDaysInTimezone(startDate, 6, tz);

  // Get all entries in range
  const entries = getEntries(db, { startDate, endDate }, namespace);

  // Aggregate by date
  const dailyMap = new Map<
    string,
    { totalMs: number; sessionIds: Set<string> }
  >();

  for (const entry of entries) {
    const existing = dailyMap.get(entry.date) || {
      totalMs: 0,
      sessionIds: new Set(),
    };
    existing.totalMs += entry.durationMs;
    existing.sessionIds.add(entry.sessionId);
    dailyMap.set(entry.date, existing);
  }

  // Build daily totals array (fill in missing days with zeros) — also
  // timezone-aware so a week that crosses DST gets exactly 7 dates.
  const dailyTotals: Array<{
    date: string;
    totalMs: number;
    sessionCount: number;
  }> = [];

  for (let i = 0; i < 7; i++) {
    const dateStr = addDaysInTimezone(startDate, i, tz);
    const dayData = dailyMap.get(dateStr);
    dailyTotals.push({
      date: dateStr,
      totalMs: dayData?.totalMs ?? 0,
      sessionCount: dayData?.sessionIds.size ?? 0,
    });
  }

  const totalMs = dailyTotals.reduce((sum, d) => sum + d.totalMs, 0);

  return {
    startDate,
    endDate,
    totalMs,
    dailyTotals,
  };
}

export function updateEntry(
  db: Database,
  id: string,
  updates: { projectDirectory?: string; sessionName?: string },
  namespace: string
): boolean {
  const setClauses: string[] = [];
  const params: Record<string, string> = { id, namespace };

  if (updates.projectDirectory !== undefined) {
    setClauses.push("project_directory = @project_directory");
    params.project_directory = updates.projectDirectory;
  }
  if (updates.sessionName !== undefined) {
    setClauses.push("session_name = @session_name");
    params.session_name = updates.sessionName;
  }

  if (setClauses.length === 0) return false;

  const result = db
    .prepare(
      `UPDATE timelog_entries SET ${setClauses.join(", ")} WHERE id = @id AND namespace = @namespace`
    )
    .run(params);

  return result.changes > 0;
}

export function lookupSessionMetadata(
  db: Database,
  sessionId: string
): { path?: string; name?: string } | null {
  const row = db
    .prepare("SELECT metadata FROM sessions WHERE id = ?")
    .get(sessionId) as { metadata: string } | undefined;

  if (!row?.metadata) return null;

  try {
    const meta = JSON.parse(row.metadata) as Record<string, unknown>;
    return {
      path: typeof meta.path === "string" ? meta.path : undefined,
      name:
        typeof meta.name === "string"
          ? meta.name
          : typeof (meta.summary as Record<string, unknown>)?.text === "string"
            ? ((meta.summary as Record<string, unknown>).text as string)
            : undefined,
    };
  } catch {
    return null;
  }
}

export function deleteEntry(
  db: Database,
  id: string,
  namespace: string
): boolean {
  const result = db
    .prepare(
      `
        DELETE FROM timelog_entries
        WHERE id = ? AND namespace = ?
    `
    )
    .run(id, namespace);

  return result.changes > 0;
}

export function deleteEntriesOlderThan(
  db: Database,
  days: number,
  namespace: string,
  timezone?: string
): number {
  // Issue #1119 R10: timezone-aware cutoff. The previous
  // `new Date().toISOString().split("T")[0]` returned the UTC date —
  // on a server in UTC, at 11pm ET (= 4am UTC next day) the cutoff was
  // computed one day ahead in ET terms, risking deletion of today's
  // entries. Now anchored to the configured timezone (default: server's
  // local IANA zone — see #1119 R6).
  const tz = timezone ?? defaultTimezone();
  const today = getTodayInTimezone(tz);
  const cutoffDateStr = addDaysInTimezone(today, -days, tz);

  const result = db
    .prepare(
      `
        DELETE FROM timelog_entries
        WHERE date < ? AND namespace = ?
    `
    )
    .run(cutoffDateStr, namespace);

  return result.changes;
}

/**
 * Extract the base project directory from a worktree path.
 * e.g., "/home/matt/projects/foo/.worktrees/hapi-123" → "/home/matt/projects/foo"
 * Returns null if the path is not a worktree path.
 */
function extractWorktreeBase(directory: string): string | null {
  const worktreeIdx = directory.indexOf("/.worktrees/");
  if (worktreeIdx === -1) return null;
  return directory.slice(0, worktreeIdx);
}

/**
 * Resolve a directory path to a stable project identity.
 * Uses repoIdentity (git remote) when available, falls back to directory basename.
 * For worktree paths, resolves the parent project directory instead.
 */
function resolveProjectIdentity(directory: string): string {
  if (directory === "Unknown" || !directory) return directory;

  // Try git-based resolution first (cached in memory)
  const repo = resolveRepoIdentity(directory);
  if (repo) return repo.name;

  // For worktree paths where the worktree no longer exists on disk,
  // try resolving the base project directory instead
  const worktreeBase = extractWorktreeBase(directory);
  if (worktreeBase) {
    const baseRepo = resolveRepoIdentity(worktreeBase);
    if (baseRepo) return baseRepo.name;
    // Fall back to base directory basename
    return basename(worktreeBase) || worktreeBase;
  }

  // Fall back to directory basename
  return basename(directory) || directory;
}

/**
 * Extract a short display name from a project identity string.
 * "MattStarfield/rp1-home" → "rp1-home"
 * "hapimatic-private-dev" → "hapimatic-private-dev"
 */
function getDisplayName(identity: string): string {
  if (identity === "Unknown" || identity === "Other") return identity;
  const slashIdx = identity.lastIndexOf("/");
  return slashIdx >= 0 ? identity.slice(slashIdx + 1) : identity;
}

export function getProjectGroupedSummary(
  db: Database,
  startDate: string,
  endDate: string,
  namespace: string
): ProjectGroupedSummary {
  const entries = getEntries(db, { startDate, endDate }, namespace);

  // Resolve each unique directory to a project identity (cached, fast)
  const identityCache = new Map<string, string>();
  function getIdentity(dir: string): string {
    let id = identityCache.get(dir);
    if (id === undefined) {
      id = resolveProjectIdentity(dir);
      identityCache.set(dir, id);
    }
    return id;
  }

  // Aggregate by project IDENTITY (not raw directory), then by session
  const projectMap = new Map<
    string, // projectIdentity
    {
      totalMs: number;
      // Keep the first directory seen for backward compat
      projectDirectory: string;
      sessions: Map<string, { name: string; totalMs: number }>;
    }
  >();

  for (const entry of entries) {
    const identity = getIdentity(entry.projectDirectory);

    let project = projectMap.get(identity);
    if (!project) {
      project = {
        totalMs: 0,
        projectDirectory: entry.projectDirectory,
        sessions: new Map(),
      };
      projectMap.set(identity, project);
    }
    project.totalMs += entry.durationMs;

    let session = project.sessions.get(entry.sessionId);
    if (!session) {
      session = { name: entry.sessionName, totalMs: 0 };
      project.sessions.set(entry.sessionId, session);
    }
    session.totalMs += entry.durationMs;
    // Use most recent session name
    session.name = entry.sessionName;
  }

  // Sort projects by total time descending
  const projects = Array.from(projectMap.entries())
    .sort((a, b) => b[1].totalMs - a[1].totalMs)
    .map(([projectIdentity, data]) => ({
      projectDirectory: data.projectDirectory,
      projectIdentity,
      displayName: getDisplayName(projectIdentity),
      totalMs: data.totalMs,
      sessions: Array.from(data.sessions.entries())
        .sort((a, b) => b[1].totalMs - a[1].totalMs)
        .map(([sessionId, s]) => ({
          sessionId,
          sessionName: s.name,
          totalMs: s.totalMs,
        })),
    }));

  const totalMs = projects.reduce((sum, p) => sum + p.totalMs, 0);

  return { startDate, endDate, totalMs, projects };
}

export function getDistinctProjectDirectories(
  db: Database,
  namespace: string
): string[] {
  const rows = db
    .prepare(
      `
        SELECT DISTINCT project_directory
        FROM timelog_entries
        WHERE namespace = ?
        ORDER BY project_directory
    `
    )
    .all(namespace) as Array<{ project_directory: string }>;

  return rows.map(r => r.project_directory);
}

/**
 * Issue #1122: restore the pre-cleanup `duration_ms` for rows captured in
 * `timelog_entries_backup_1122`. Manual rollback only — not part of
 * `runMigrations()`. Callable from a one-off Bun script if a deployed
 * cleanup needs to be undone.
 *
 * For each restored row, also clears the post-cleanup tagging:
 * `event_type` is reset to `'flush'` (the column DEFAULT) and
 * `reset_epoch` to `NULL`. Pre-cleanup rows could have been any
 * event_type, but `'flush'` is the dominant case for the rows the
 * cleanup targets (saturated daily flushes pre-#463). Best-effort.
 *
 * @param ids — if undefined, restore ALL backup rows. Otherwise restore
 *   only the listed ids.
 * @returns `restored` count of rows updated; `missing` ids that were
 *   requested but not found in the backup table.
 */
export function restoreFromBackup1122(
  db: Database,
  ids?: string[]
): { restored: number; missing: string[] } {
  // Verify backup table exists; if not, nothing to restore.
  const hasBackup = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'timelog_entries_backup_1122'"
    )
    .get() as { name: string } | undefined;
  if (!hasBackup) {
    return { restored: 0, missing: ids ?? [] };
  }

  type BackupRow = { id: string; original_duration_ms: number };
  let backupRows: BackupRow[];
  const missing: string[] = [];

  if (ids === undefined) {
    backupRows = db
      .prepare(
        "SELECT id, original_duration_ms FROM timelog_entries_backup_1122"
      )
      .all() as BackupRow[];
  } else {
    backupRows = [];
    const select = db.prepare(
      "SELECT id, original_duration_ms FROM timelog_entries_backup_1122 WHERE id = ?"
    );
    for (const id of ids) {
      const row = select.get(id) as BackupRow | undefined;
      if (row) backupRows.push(row);
      else missing.push(id);
    }
  }

  if (backupRows.length === 0) {
    return { restored: 0, missing };
  }

  let restored = 0;
  const txn = db.transaction(() => {
    const update = db.prepare(
      "UPDATE timelog_entries " +
        "SET duration_ms = ?, event_type = 'flush', reset_epoch = NULL " +
        "WHERE id = ?"
    );
    for (const row of backupRows) {
      const result = update.run(row.original_duration_ms, row.id);
      if (result.changes > 0) restored++;
    }
  });
  txn();

  return { restored, missing };
}

/**
 * Issue #1508: restore the pre-scrub `duration_ms` for rows captured in
 * `timelog_entries_backup_1508`. Manual rollback only — not part of
 * `runMigrations()`. Callable from a one-off Bun script if a deployed
 * scrub needs to be undone.
 *
 * For each restored row, also clears the post-scrub tagging:
 * `event_type` is reset to `'flush'` (the column DEFAULT) and
 * `reset_epoch` to `NULL`. Mirrors `restoreFromBackup1122` exactly,
 * targeting the #1508 backup table.
 *
 * @param ids — if undefined, restore ALL backup rows. Otherwise restore
 *   only the listed ids.
 * @returns `restored` count of rows updated; `missing` ids that were
 *   requested but not found in the backup table.
 */
export function restoreFromBackup1508(
  db: Database,
  ids?: string[]
): { restored: number; missing: string[] } {
  // Verify backup table exists; if not, nothing to restore.
  const hasBackup = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'timelog_entries_backup_1508'"
    )
    .get() as { name: string } | undefined;
  if (!hasBackup) {
    return { restored: 0, missing: ids ?? [] };
  }

  type BackupRow = { id: string; original_duration_ms: number };
  let backupRows: BackupRow[];
  const missing: string[] = [];

  if (ids === undefined) {
    backupRows = db
      .prepare(
        "SELECT id, original_duration_ms FROM timelog_entries_backup_1508"
      )
      .all() as BackupRow[];
  } else {
    backupRows = [];
    const select = db.prepare(
      "SELECT id, original_duration_ms FROM timelog_entries_backup_1508 WHERE id = ?"
    );
    for (const id of ids) {
      const row = select.get(id) as BackupRow | undefined;
      if (row) backupRows.push(row);
      else missing.push(id);
    }
  }

  if (backupRows.length === 0) {
    return { restored: 0, missing };
  }

  let restored = 0;
  const txn = db.transaction(() => {
    const update = db.prepare(
      "UPDATE timelog_entries " +
        "SET duration_ms = ?, event_type = 'flush', reset_epoch = NULL " +
        "WHERE id = ?"
    );
    for (const row of backupRows) {
      const result = update.run(row.original_duration_ms, row.id);
      if (result.changes > 0) restored++;
    }
  });
  txn();

  return { restored, missing };
}

/**
 * Issue #1508 (v2): restore rows DELETED by `Store.runIssue1508OrphanCleanup`
 * by re-INSERTing the full original row from `timelog_entries_orphan_backup_1508`.
 * Manual rollback only — not part of `runMigrations()`. Callable from a one-off
 * Bun script if a deployed orphan scrub needs to be undone.
 *
 * Unlike `restoreFromBackup1508` (which UPDATEs a duration on rows that still
 * exist), this RE-CREATES rows the scrub removed. Uses `INSERT OR IGNORE` so a
 * row that still exists (e.g. a partial prior restore) is skipped without
 * error; `restored` counts only rows actually re-created.
 *
 * @param ids — if undefined, restore ALL backup rows. Otherwise restore only
 *   the listed ids.
 * @returns `restored` count of rows re-inserted; `missing` ids that were
 *   requested but not found in the backup table.
 */
export function restoreOrphans1508(
  db: Database,
  ids?: string[]
): { restored: number; missing: string[] } {
  // Verify backup table exists; if not, nothing to restore.
  const hasBackup = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'timelog_entries_orphan_backup_1508'"
    )
    .get() as { name: string } | undefined;
  if (!hasBackup) {
    return { restored: 0, missing: ids ?? [] };
  }

  type BackupRow = {
    id: string;
    session_id: string;
    session_name: string;
    project_directory: string;
    date: string;
    duration_ms: number;
    created_at: number;
    namespace: string;
    event_type: string | null;
    timezone: string | null;
    reset_epoch: number | null;
  };
  const COLS =
    "id, session_id, session_name, project_directory, date, duration_ms, " +
    "created_at, namespace, event_type, timezone, reset_epoch";

  let backupRows: BackupRow[];
  const missing: string[] = [];

  if (ids === undefined) {
    backupRows = db
      .prepare(`SELECT ${COLS} FROM timelog_entries_orphan_backup_1508`)
      .all() as BackupRow[];
  } else {
    backupRows = [];
    const select = db.prepare(
      `SELECT ${COLS} FROM timelog_entries_orphan_backup_1508 WHERE id = ?`
    );
    for (const id of ids) {
      const row = select.get(id) as BackupRow | undefined;
      if (row) backupRows.push(row);
      else missing.push(id);
    }
  }

  if (backupRows.length === 0) {
    return { restored: 0, missing };
  }

  let restored = 0;
  const txn = db.transaction(() => {
    const insert = db.prepare(
      `INSERT OR IGNORE INTO timelog_entries (${COLS}) ` +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    for (const row of backupRows) {
      const result = insert.run(
        row.id,
        row.session_id,
        row.session_name,
        row.project_directory,
        row.date,
        row.duration_ms,
        row.created_at,
        row.namespace,
        row.event_type,
        row.timezone,
        row.reset_epoch
      );
      if (result.changes > 0) restored++;
    }
  });
  txn();

  return { restored, missing };
}

/**
 * Issue #1122: independent estimate of namespace time from the `messages`
 * table, used to validate the cleanup didn't go too far in either
 * direction. APPROXIMATE — message timestamps reflect the active
 * conversation window, not literal "thinking" time. The 5% target in
 * the issue's AC is aspirational and depends on Option 2/3 follow-up;
 * for Option 1 (cap fix) the realistic post-cleanup delta is "less
 * than pre-cleanup".
 *
 * For each (sessionId, date) within the date range, computes the
 * active span as `MAX(created_at) - MIN(created_at)` capped at 24h.
 * Sums those spans and compares against `SUM(duration_ms)` from
 * `timelog_entries` for the same scope.
 *
 * @returns
 *   `estimatedMs` — total active span across all (session, date) pairs
 *   `sessionCount` — distinct session_ids in scope
 *   `comparedToLog` — total duration_ms in `timelog_entries` for scope
 *   `deltaPct` — `((comparedToLog - estimatedMs) / estimatedMs) * 100`,
 *     0 if estimatedMs is 0
 */
export function estimateNamespaceTimeFromMessages(
  db: Database,
  namespace: string,
  startDate: string,
  endDate: string
): {
  estimatedMs: number;
  sessionCount: number;
  comparedToLog: number;
  deltaPct: number;
} {
  // Active span per (session_id, date_utc) capped at 24h, summed.
  // Joins messages -> sessions to filter by namespace.
  // SQLite's `date(unixepoch, 'unixepoch')` expects seconds, so divide by 1000.
  const cap = 24 * 60 * 60 * 1000;
  const estimateRow = db
    .prepare(
      "SELECT COALESCE(SUM(span_ms), 0) AS total_ms, " +
        "COUNT(DISTINCT session_id) AS session_count FROM (" +
        "SELECT m.session_id, " +
        "date(m.created_at / 1000, 'unixepoch') AS msg_date, " +
        "MIN(?, MAX(m.created_at) - MIN(m.created_at)) AS span_ms " +
        "FROM messages m " +
        "INNER JOIN sessions s ON s.id = m.session_id " +
        "WHERE s.namespace = ? " +
        "AND date(m.created_at / 1000, 'unixepoch') >= ? " +
        "AND date(m.created_at / 1000, 'unixepoch') <= ? " +
        "GROUP BY m.session_id, msg_date" +
        ")"
    )
    .get(cap, namespace, startDate, endDate) as {
    total_ms: number;
    session_count: number;
  };

  // Compare against timelog_entries total for the same scope.
  const logRow = db
    .prepare(
      "SELECT COALESCE(SUM(duration_ms), 0) AS total_ms FROM timelog_entries " +
        "WHERE namespace = ? AND date >= ? AND date <= ?"
    )
    .get(namespace, startDate, endDate) as { total_ms: number };

  const estimatedMs = estimateRow.total_ms;
  const comparedToLog = logRow.total_ms;
  const deltaPct =
    estimatedMs > 0 ? ((comparedToLog - estimatedMs) / estimatedMs) * 100 : 0;

  return {
    estimatedMs,
    sessionCount: estimateRow.session_count,
    comparedToLog,
    deltaPct,
  };
}
