// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";

import type {
  DailySummary,
  ProjectGroupedSummary,
  StoredTimeLogEntry,
  TimeLogFilters,
  WeeklySummary,
} from "./types";
import {
  createEntry,
  deleteEntriesOlderThan,
  deleteEntry,
  estimateNamespaceTimeFromMessages,
  getDailySummary,
  getDistinctProjectDirectories,
  getEntries,
  getEntriesByDate,
  getEntry,
  getProjectGroupedSummary,
  getWeeklySummary,
  lookupSessionMetadata,
  restoreFromBackup1122,
  restoreFromBackup1508,
  restoreOrphans1508,
  updateEntry,
  upsertEntry,
} from "./timeLog";

export class TimeLogStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  createEntry(
    entry: Omit<StoredTimeLogEntry, "id" | "createdAt">,
    namespace: string
  ): StoredTimeLogEntry {
    return createEntry(this.db, entry, namespace);
  }

  upsertEntry(
    entry: Omit<StoredTimeLogEntry, "id" | "createdAt">,
    namespace: string
  ): StoredTimeLogEntry {
    return upsertEntry(this.db, entry, namespace);
  }

  getEntry(id: string, namespace: string): StoredTimeLogEntry | null {
    return getEntry(this.db, id, namespace);
  }

  getEntries(filters: TimeLogFilters, namespace: string): StoredTimeLogEntry[] {
    return getEntries(this.db, filters, namespace);
  }

  getEntriesByDate(date: string, namespace: string): StoredTimeLogEntry[] {
    return getEntriesByDate(this.db, date, namespace);
  }

  getDailySummary(date: string, namespace: string): DailySummary {
    return getDailySummary(this.db, date, namespace);
  }

  getWeeklySummary(
    startDate: string,
    namespace: string,
    timezone?: string
  ): WeeklySummary {
    return getWeeklySummary(this.db, startDate, namespace, timezone);
  }

  getProjectGroupedSummary(
    startDate: string,
    endDate: string,
    namespace: string
  ): ProjectGroupedSummary {
    return getProjectGroupedSummary(this.db, startDate, endDate, namespace);
  }

  deleteEntry(id: string, namespace: string): boolean {
    return deleteEntry(this.db, id, namespace);
  }

  deleteEntriesOlderThan(days: number, namespace: string): number {
    return deleteEntriesOlderThan(this.db, days, namespace);
  }

  getDistinctProjectDirectories(namespace: string): string[] {
    return getDistinctProjectDirectories(this.db, namespace);
  }

  updateEntry(
    id: string,
    updates: { projectDirectory?: string; sessionName?: string },
    namespace: string
  ): boolean {
    return updateEntry(this.db, id, updates, namespace);
  }

  lookupSessionMetadata(
    sessionId: string
  ): { path?: string; name?: string } | null {
    return lookupSessionMetadata(this.db, sessionId);
  }

  /** Issue #1122: manual rollback of cleanup migration. */
  restoreFromBackup1122(ids?: string[]): {
    restored: number;
    missing: string[];
  } {
    return restoreFromBackup1122(this.db, ids);
  }

  /** Issue #1508: manual rollback of the historical-scrub migration. */
  restoreFromBackup1508(ids?: string[]): {
    restored: number;
    missing: string[];
  } {
    return restoreFromBackup1508(this.db, ids);
  }

  /** Issue #1508 (v2): manual rollback of the orphan-cleanup migration —
   * re-INSERTs rows the scrub deleted, from the full-row backup. */
  restoreOrphans1508(ids?: string[]): {
    restored: number;
    missing: string[];
  } {
    return restoreOrphans1508(this.db, ids);
  }

  /** Issue #1122: independent message-based time estimate for validation. */
  estimateNamespaceTimeFromMessages(
    namespace: string,
    startDate: string,
    endDate: string
  ): {
    estimatedMs: number;
    sessionCount: number;
    comparedToLog: number;
    deltaPct: number;
  } {
    return estimateNamespaceTimeFromMessages(
      this.db,
      namespace,
      startDate,
      endDate
    );
  }
}
