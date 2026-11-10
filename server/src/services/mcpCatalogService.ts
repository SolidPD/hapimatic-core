// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findCanonicalGitRoot } from "@hapi/protocol/gitRoot";
import {
  CLAUDE_AI_CONNECTOR_PREFIX,
  HAPI_MCP_SERVER_NAME,
  normalizeMcpServerName,
  sanitizeKnownMcpNames,
  type McpServerStatus,
  type McpSet,
  type McpStatusUpdate,
} from "@hapi/protocol";
import type {
  McpCatalogEntry,
  McpCatalogResponse,
} from "@hapi/protocol/schemas";
import type { McpProjectDefaultsStore } from "../store/mcpProjectDefaultsStore";
import type { McpServerStatsStore } from "../store/mcpServerStatsStore";
import { expandTilde } from "../utils/expandTilde";

export interface McpCatalogDeps {
  getMcpStatus: (projectDir?: string) => McpStatusUpdate | null;
  defaults: McpProjectDefaultsStore;
  stats: McpServerStatsStore;
  /** DI seam: defaults to `~/.claude.json`; tests pass a temp file. */
  claudeConfigPath?: string;
}

/** What Claude Code's config says about a project, read per request. */
interface ProjectConfigNames {
  disabled: Set<string>;
  configured: Set<string>;
}

function objectKeys(value: unknown): string[] {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value)
    : [];
}

function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The picker's list for a project on this node (issue #6171), and the names a
 * session's deny list is built from.
 *
 * A pure read: it never runs `claude mcp list` (p50 2.1 s, max 15.6 s measured on
 * ms1), and it starts nothing, because the route is a readonly GET that the
 * capabilities probe calls generically. It merges the last global poll, any
 * per-directory poll, the names in Claude Code's config and `.mcp.json`, and the
 * durable stats table. A cold cache answers `stale: true`; the form then asks for
 * a poll through `POST /api/mcp-status/refresh`, because the daemon's first poll
 * comes about an hour after it starts.
 */
export class McpCatalogService {
  private readonly claudeConfigPath: string;

  constructor(private readonly deps: McpCatalogDeps) {
    this.claudeConfigPath =
      deps.claudeConfigPath ?? join(homedir(), ".claude.json");
  }

  /** The project key Claude Code uses: the canonical git root, else the directory. */
  projectRoot(directory: string): string {
    const expanded = expandTilde(directory);
    return findCanonicalGitRoot(expanded) ?? expanded;
  }

  /** With no directory, only the user-level names apply. */
  private readProjectConfig(directory?: string): ProjectConfigNames {
    const config = readJsonFile(this.claudeConfigPath);
    if (!directory) {
      return {
        disabled: new Set(),
        configured: new Set(objectKeys(config?.mcpServers)),
      };
    }
    const expanded = expandTilde(directory);
    const root = this.projectRoot(directory);
    const projects = config?.projects as Record<string, unknown> | undefined;
    const project = projects?.[root] as Record<string, unknown> | undefined;
    const disabled = Array.isArray(project?.disabledMcpServers)
      ? project.disabledMcpServers.filter(
          (name): name is string => typeof name === "string"
        )
      : [];
    const configured = new Set<string>([
      ...objectKeys(config?.mcpServers),
      ...objectKeys(project?.mcpServers),
    ]);
    // Claude Code walks up from the cwd for `.mcp.json`, so read both ends.
    for (const dir of new Set([expanded, root])) {
      for (const name of objectKeys(
        readJsonFile(join(dir, ".mcp.json"))?.mcpServers
      )) {
        configured.add(name);
      }
    }
    return { disabled: new Set(disabled), configured };
  }

  /** Global poll rows, overlaid by a per-directory poll when one exists. */
  private statusRows(directory?: string): {
    rows: Map<string, McpServerStatus>;
    checkedAt: string | null;
  } {
    const global = this.deps.getMcpStatus();
    const overlay = directory ? this.deps.getMcpStatus(directory) : null;
    const rows = new Map<string, McpServerStatus>();
    for (const status of [global, overlay]) {
      for (const server of status?.servers ?? []) {
        rows.set(server.name, server);
      }
    }
    const checkedAt =
      [global?.checkedAt, overlay?.checkedAt]
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1) ?? null;
    return { rows, checkedAt };
  }

  /** Names off for this project. */
  projectDisabledNames(directory: string): Set<string> {
    return this.readProjectConfig(directory).disabled;
  }

  /**
   * Every server name known for a project: what a deny list is built from. It takes
   * the widest view, because denying a name nothing uses is harmless and a name left
   * out stays on. Names a deny list cannot carry (blank, edge whitespace, too long,
   * a control character) are dropped here, and the list is capped, so one bad name
   * in a config file never makes the wrapper reject the launch payload.
   */
  knownNames(directory: string): string[] {
    const { rows } = this.statusRows(directory);
    const { disabled, configured } = this.readProjectConfig(directory);
    const names = new Set<string>([...rows.keys(), ...configured, ...disabled]);
    for (const stats of this.deps.stats.list().values()) names.add(stats.name);
    names.delete(HAPI_MCP_SERVER_NAME);
    return sanitizeKnownMcpNames(names);
  }

  getCatalog(directory?: string): McpCatalogResponse {
    const { rows, checkedAt } = this.statusRows(directory);
    const stale = checkedAt === null;

    const project = this.readProjectConfig(directory);
    const stats = this.deps.stats.list();
    const names = new Set<string>([...rows.keys(), ...project.configured]);
    // With a live poll a stats name may be an uninstalled server, so it counts only
    // while the cache is cold. A name only in the disabled list is left out too: the
    // list seeds names that may not exist here.
    if (stale) {
      for (const row of stats.values()) names.add(row.name);
    }
    names.delete(HAPI_MCP_SERVER_NAME);

    const servers = [...names].map((name): McpCatalogEntry => {
      const row = stats.get(normalizeMcpServerName(name));
      return {
        name,
        status: rows.get(name)?.status ?? "unknown",
        projectDisabled: project.disabled.has(name),
        hosted: name.startsWith(CLAUDE_AI_CONNECTOR_PREFIX),
        ...(row?.ram ? { ram: row.ram } : {}),
        ...(row?.context ? { context: row.context } : {}),
      };
    });
    servers.sort(
      (a, b) =>
        Number(a.projectDisabled) - Number(b.projectDisabled) ||
        a.name.localeCompare(b.name)
    );

    return {
      servers,
      projectRoot: directory ? this.projectRoot(directory) : null,
      projectDefault: directory ? this.getProjectDefault(directory) : null,
      checkedAt,
      stale,
    };
  }

  getProjectDefault(directory: string): McpSet | null {
    return this.deps.defaults.get(this.projectRoot(directory));
  }

  /** Store a project's default, or clear it with null. */
  setProjectDefault(directory: string, set: McpSet | null): void {
    const root = this.projectRoot(directory);
    if (set) this.deps.defaults.set(root, set);
    else this.deps.defaults.clear(root);
  }
}
