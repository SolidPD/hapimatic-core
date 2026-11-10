// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";
import { McpSetSchema, stampedMcpSet, type McpSet } from "@hapi/protocol";

/** Raw `mcp_project_defaults` row. */
type McpProjectDefaultRow = { set_json: string };

/**
 * A project's default MCP set (issue #6171), keyed by its canonical git root on
 * this node. Node-local by design: a project's files and MCP config live on one
 * node, and a hub reaches it through `/federation/mcp-project-default`. No namespace
 * column, because `/federation/spawn` carries no caller namespace and the default
 * must apply there too.
 *
 * The table is created by the migration in `store/index.ts`.
 */
export class McpProjectDefaultsStore {
  private readonly db: Database;
  private readonly warned = new Set<string>();

  constructor(db: Database) {
    this.db = db;
  }

  /** The stored set, or null when none is stored or the row cannot be read. */
  get(projectRoot: string): McpSet | null {
    const row = this.db
      .prepare(
        "SELECT set_json FROM mcp_project_defaults WHERE project_root = ?"
      )
      .get(projectRoot) as McpProjectDefaultRow | null;
    if (!row) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.set_json);
    } catch {
      parsed = undefined;
    }
    const result = McpSetSchema.safeParse(parsed);
    if (result.success) return result.data;
    // A bad row must not stop a spawn: it reads as no default, logged once.
    if (!this.warned.has(projectRoot)) {
      this.warned.add(projectRoot);
      console.warn(
        `[mcp-project-defaults] ignoring an unreadable default for ${projectRoot}`
      );
    }
    return null;
  }

  /** Store a project's default. `enableForProject` is single-use, so it is dropped. */
  set(projectRoot: string, set: McpSet): void {
    const stored = stampedMcpSet(set);
    this.db
      .prepare(
        "INSERT INTO mcp_project_defaults (project_root, set_json, updated_at) " +
          "VALUES (?, ?, ?) " +
          "ON CONFLICT(project_root) DO UPDATE SET " +
          "set_json = excluded.set_json, updated_at = excluded.updated_at"
      )
      .run(projectRoot, JSON.stringify(stored), Date.now());
    this.warned.delete(projectRoot);
  }

  clear(projectRoot: string): void {
    this.db
      .prepare("DELETE FROM mcp_project_defaults WHERE project_root = ?")
      .run(projectRoot);
    this.warned.delete(projectRoot);
  }
}
