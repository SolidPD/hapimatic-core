// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";

import type { ErrorLogFilters, StoredErrorLog } from "./types";
import type { TurnErrorMirror } from "./turns/turnErrorMirror";
import {
  countBySeverity,
  createEntry,
  type CreateErrorLogEntry,
  deleteEntriesOlderThan,
  deleteEntry,
  getEntries,
  getEntry,
} from "./errorLog";

export class ErrorLogStore {
  private readonly db: Database;

  /**
   * Issue #1673 (Sub K): optional fail-open dual-writer that mirrors each
   * `error_logs` insert into `turn_events` (kind=error/api_error). Late-bound —
   * the `TurnWriteService` it needs is constructed after the Store, so this is
   * null until `setTurnErrorMirror` runs from `index.ts`. Existing tests and the
   * Sub A/B world are therefore unaffected.
   */
  private turnErrorMirror: TurnErrorMirror | null = null;

  constructor(db: Database) {
    this.db = db;
  }

  /** Wire the per-turn error mirror (issue #1673). Pass `null` to disable. */
  setTurnErrorMirror(mirror: TurnErrorMirror | null): void {
    this.turnErrorMirror = mirror;
  }

  createEntry(entry: CreateErrorLogEntry): StoredErrorLog {
    const stored = createEntry(this.db, entry);
    // Issue #1673: best-effort dual-write into turn_events. The mirror is
    // non-throwing by contract; the extra guard ensures an error-log write can
    // NEVER fail because of the telemetry mirror (R3 fail-open).
    try {
      this.turnErrorMirror?.mirrorError(stored);
    } catch {
      // swallowed — dual-write is best-effort telemetry
    }
    return stored;
  }

  getEntry(id: string): StoredErrorLog | null {
    return getEntry(this.db, id);
  }

  getEntries(filters: ErrorLogFilters): StoredErrorLog[] {
    return getEntries(this.db, filters);
  }

  deleteEntry(id: string): boolean {
    return deleteEntry(this.db, id);
  }

  deleteEntriesOlderThan(days: number): number {
    return deleteEntriesOlderThan(this.db, days);
  }

  countBySeverity(): Record<string, number> {
    return countBySeverity(this.db);
  }
}
