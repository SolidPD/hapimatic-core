// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";

import {
  getAll,
  get,
  upsert,
  type MidnightResetState,
} from "./midnightResetState";

export class MidnightResetStateStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  getAll(): MidnightResetState[] {
    return getAll(this.db);
  }

  get(namespace: string): MidnightResetState | null {
    return get(this.db, namespace);
  }

  upsert(
    namespace: string,
    timezone: string,
    lastResetDate: string,
    lastResetEpoch: number
  ): void {
    upsert(this.db, namespace, timezone, lastResetDate, lastResetEpoch);
  }
}

export type { MidnightResetState };
