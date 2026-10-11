// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { expandTilde } from "../utils/expandTilde";

export class RecentPathStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  getRecentPaths(
    machineId: string,
    namespace: string,
    limit: number = 10
  ): string[] {
    const rows = this.db
      .prepare(
        "SELECT path FROM recent_paths WHERE machine_id = ? AND namespace = ? ORDER BY used_at DESC LIMIT ?"
      )
      .all(machineId, namespace, limit) as Array<{ path: string }>;
    return rows.map(row => row.path);
  }

  removeRecentPath(
    machineId: string,
    namespace: string,
    path: string
  ): boolean {
    const result = this.db
      .prepare(
        "DELETE FROM recent_paths WHERE machine_id = ? AND namespace = ? AND path = ?"
      )
      .run(machineId, namespace, path);
    return result.changes > 0;
  }

  addRecentPath(machineId: string, namespace: string, path: string): void {
    // #3558 (R2): store the absolute form. A `~/x` row seeds the Create page's
    // Directory field with a tilde path. This store runs on the node that owns
    // the row, so this process's home is the right one to expand against.
    // (removeRecentPath stays exact-match: the UI removes by the displayed
    // string, so legacy tilde rows must remain removable as-is.)
    const home = homedir();
    const normalized = expandTilde(path, home);
    const now = Date.now();
    this.db
      .prepare(
        "INSERT OR REPLACE INTO recent_paths (machine_id, namespace, path, used_at) VALUES (?, ?, ?, ?)"
      )
      .run(machineId, namespace, normalized, now);

    // Drop the `~`-form twin of a path under home. The PK includes `path`, so
    // without this a legacy `~/x` row and the new `/home/u/x` row coexist and
    // the older tilde form keeps surfacing until the prune ages it out.
    const twin =
      normalized === home
        ? "~"
        : normalized.startsWith(`${home}/`)
          ? `~${normalized.slice(home.length)}`
          : null;
    if (twin) {
      this.db
        .prepare(
          "DELETE FROM recent_paths WHERE machine_id = ? AND namespace = ? AND path = ?"
        )
        .run(machineId, namespace, twin);
    }

    // Prune entries beyond 10 for this machine+namespace
    this.db
      .prepare(
        `DELETE FROM recent_paths WHERE machine_id = ? AND namespace = ? AND path NOT IN (
          SELECT path FROM recent_paths WHERE machine_id = ? AND namespace = ? ORDER BY used_at DESC LIMIT 10
        )`
      )
      .run(machineId, namespace, machineId, namespace);
  }
}
