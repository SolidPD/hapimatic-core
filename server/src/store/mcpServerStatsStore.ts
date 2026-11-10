// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";
import { normalizeMcpServerName } from "@hapi/protocol";
import {
  McpServerContextCostSchema,
  McpServerRamCostSchema,
  type McpServerContextCost,
  type McpServerRamCost,
} from "@hapi/protocol/schemas";

/** A name unseen for this long stops counting as known (an uninstalled server). */
const KNOWN_NAME_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type McpServerStatsRow = {
  key: string;
  name: string;
  last_seen_at: number;
  ram_json: string | null;
  context_json: string | null;
};

export interface McpServerStats {
  /** The raw server name when one has been seen, else the normalized key. */
  name: string;
  lastSeenAt: number;
  ram?: McpServerRamCost;
  context?: McpServerContextCost;
}

function readJson<T>(
  raw: string | null,
  parse: (value: unknown) => { success: boolean; data?: T }
): T | undefined {
  if (!raw) return undefined;
  try {
    const result = parse(JSON.parse(raw));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What this node knows about each MCP server (issue #6171): the names from status
 * polls and the last measured RAM and context cost. It survives a server restart,
 * when the in-memory status cache is empty for up to an hour.
 *
 * Keyed by the normalized name because Claude Code reports a tool's server in
 * normalized form (`plugin_context7_context7`) and an instruction's in raw form
 * (`plugin:context7:context7`). The table is created by the migration in
 * `store/index.ts`.
 */
export class McpServerStatsStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * One row per server. A raw name replaces a normalized one, never the reverse:
   * when the key equals the given name it may simply be the normalized form.
   */
  private upsert(
    name: string,
    now: number,
    column?: "ram_json" | "context_json",
    value?: string
  ): void {
    const key = normalizeMcpServerName(name);
    const set = column ? `, ${column} = excluded.${column}` : "";
    const insertColumns = column ? `, ${column}` : "";
    const insertValues = column ? ", ?" : "";
    const params: Array<string | number> = [key, name, now];
    if (column && value !== undefined) params.push(value);
    this.db
      .prepare(
        `INSERT INTO mcp_server_stats (key, name, last_seen_at${insertColumns}) ` +
          `VALUES (?, ?, ?${insertValues}) ` +
          "ON CONFLICT(key) DO UPDATE SET " +
          "name = CASE WHEN excluded.name <> mcp_server_stats.key " +
          "THEN excluded.name ELSE mcp_server_stats.name END, " +
          `last_seen_at = excluded.last_seen_at${set}`
      )
      .run(...params);
  }

  /** Record names a status poll saw, and forget names unseen for 30 days. */
  touchNames(names: Iterable<string>, now: number = Date.now()): void {
    for (const name of names) this.upsert(name, now);
    this.db
      .prepare("DELETE FROM mcp_server_stats WHERE last_seen_at < ?")
      .run(now - KNOWN_NAME_TTL_MS);
  }

  recordRam(
    rows: ReadonlyArray<McpServerRamCost & { name: string }>,
    now: number = Date.now()
  ): void {
    for (const { name, ...ram } of rows) {
      this.upsert(name, now, "ram_json", JSON.stringify(ram));
    }
  }

  recordContext(
    rows: ReadonlyArray<McpServerContextCost & { name: string }>,
    now: number = Date.now()
  ): void {
    for (const { name, ...context } of rows) {
      this.upsert(name, now, "context_json", JSON.stringify(context));
    }
  }

  /** Every row still within the known-name window, by normalized key. */
  list(now: number = Date.now()): Map<string, McpServerStats> {
    const rows = this.db
      .prepare(
        "SELECT key, name, last_seen_at, ram_json, context_json " +
          "FROM mcp_server_stats WHERE last_seen_at >= ?"
      )
      .all(now - KNOWN_NAME_TTL_MS) as McpServerStatsRow[];
    const out = new Map<string, McpServerStats>();
    for (const row of rows) {
      const ram = readJson<McpServerRamCost>(row.ram_json, value =>
        McpServerRamCostSchema.safeParse(value)
      );
      const context = readJson<McpServerContextCost>(row.context_json, value =>
        McpServerContextCostSchema.safeParse(value)
      );
      out.set(row.key, {
        name: row.name,
        lastSeenAt: row.last_seen_at,
        ...(ram ? { ram } : {}),
        ...(context ? { context } : {}),
      });
    }
    return out;
  }
}
