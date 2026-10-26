// SPDX-License-Identifier: AGPL-3.0-only
/**
 * MCP config disk-store delegate (issue #2080 — extracted from syncEngine.ts).
 *
 * Reads/writes the per-project `disabledMcpServers` list in `~/.claude.json`
 * (`projects[projectDir].disabledMcpServers`) and computes a session's current
 * MCP state map for the batch coordinator. Complements `mcpBatchCoordinator.ts`
 * (which owns the RPC toggle pipeline) — this delegate owns only the durable
 * disk layer + the state-map computation.
 *
 * Carries the `isSafeMachinePath` path-security guard (#1098) on every write so
 * the server-side fallback path is not a softer target than the CLI path.
 *
 * Behaviour-preserving move: bodies are byte-identical to the pre-extraction
 * `SyncEngine` methods; only the enclosing `this` changed. `getMcpStatus` stays
 * a `SyncEngine` facade method and is injected here as an accessor callback.
 */

import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isSafeMachinePath } from "../utils/pathSecurity";
import type { McpStatusUpdate, McpToggleResponse } from "@hapi/protocol/types";
import type { SessionCache } from "./sessionCache";

export interface McpConfigStoreDeps {
  sessionCache: SessionCache;
  getMcpStatus: (projectDir?: string) => McpStatusUpdate | null;
  /** DI seam (#5676): defaults to `~/.claude.json`; tests pass a temp file. */
  claudeConfigPath?: string;
}

export class McpConfigStore {
  private readonly sessionCache: SessionCache;
  private readonly getMcpStatus: (
    projectDir?: string
  ) => McpStatusUpdate | null;
  private readonly claudeConfigPath: string;

  constructor(deps: McpConfigStoreDeps) {
    this.sessionCache = deps.sessionCache;
    this.getMcpStatus = deps.getMcpStatus;
    this.claudeConfigPath =
      deps.claudeConfigPath ?? join(homedir(), ".claude.json");
  }

  /**
   * Compute the current MCP state for the project a session lives in,
   * as a Map<serverName, isEnabled>. Servers in `mcpStatus.servers` are
   * enabled (true); servers in `disabledServers` are disabled (false).
   * Returns an empty Map if the session is unknown or its project has
   * no cached MCP status yet.
   */
  computeCurrentMcpStateForSession(sessionId: string): Map<string, boolean> {
    const session = this.sessionCache.getSession(sessionId);
    const projectDir = session?.metadata?.path;
    const status = this.getMcpStatus(projectDir);
    const out = new Map<string, boolean>();

    // The cached status only contains servers reported by the daemon's MCP
    // poller (typically just the connected ones, often nothing right after
    // a server restart). The authoritative disabled list lives in
    // ~/.claude.json under `projects[projectDir].disabledMcpServers`.
    //
    // Without this enrichment, the batch coordinator's `current` map is
    // missing all disabled servers — `computePending` then sees
    // `current === undefined` and silently skips the toggle. This is the
    // same on-the-fly enrichment the GET /api/mcp-status route applies for
    // the UI; doing it here keeps the coordinator's view consistent with
    // what the user sees in the modal.
    if (status) {
      for (const s of status.servers) out.set(s.name, true);
      for (const name of status.disabledServers ?? []) out.set(name, false);
    }

    // Always attempt the file fallback for disabled servers when projectDir
    // is known. This covers two cases:
    //   1. status === null  — common right after server restart (no daemon
    //      poll yet). Without the fallback every toggle would silently skip.
    //   2. status exists but disabledServers is empty/undefined — the daemon
    //      reports connected-only state; disabled servers come from disk.
    // Existing entries in `out` (real connected servers) are preserved.
    if (projectDir) {
      const fileDisabled = this.readDisabledServersFromConfig(projectDir);
      for (const name of fileDisabled) {
        if (!out.has(name)) out.set(name, false);
      }
    }
    return out;
  }

  /**
   * Read the per-project `disabledMcpServers` list from ~/.claude.json
   * using exact-match on `projects[projectDir]` only.
   *
   * Mirrors Claude Code's runtime scoping (and the route-side enrichment
   * at `GET /api/mcp-status`, fixed in #1177/#1178). A previous longest-
   * prefix fallback caused worktree sessions to inherit their parent
   * project's disabled list, making the batch coordinator's `current`
   * map disagree with what Claude actually treats as disabled at the
   * session cwd. See #1180.
   *
   * Returns `[]` on any failure (file missing, parse error, no project
   * entry, no disabled list). Failures are silent because this function
   * runs on every batch-coordinator computePending call — a transient
   * config corruption shouldn't crash the toggle pipeline.
   */
  readDisabledServersFromConfig(projectDir: string): string[] {
    try {
      const cfgPath = this.claudeConfigPath;
      const raw = readFileSync(cfgPath, "utf-8");
      const config = JSON.parse(raw);
      const projects = config?.projects;
      if (!projects || typeof projects !== "object") return [];

      const disabled = projects[projectDir]?.disabledMcpServers;
      if (!Array.isArray(disabled)) return [];
      return disabled.filter((s): s is string => typeof s === "string");
    } catch {
      return [];
    }
  }

  /**
   * Server-side fallback writer for `~/.claude.json` per-project
   * `disabledMcpServers` list. Used by the batch coordinator when the
   * primary RPC path (daemon → launcher → SDK) returns
   * `RPC handler not registered` — i.e. the session exists in the
   * registry but has no attached launcher process to receive the toggle.
   *
   * Mirrors the durable-write side of `applyDisabledServerToggle`
   * (cli/src/claude/utils/projectMcpConfig.ts) but keeps the SDK
   * in-memory state out of scope (no SDK to talk to in this branch).
   * Including the `isSafeMachinePath` guard from issue #1098 so the
   * server-side path isn't a softer target than the CLI path.
   *
   * Atomic via `tmp + rename`; idempotent (returns ok+method:config
   * even when no change was needed). Returns `McpToggleResponse`
   * shape so the caller can forward it directly.
   */
  writeDisabledServersToConfig(
    projectDir: string,
    serverName: string,
    enabled: boolean
  ): McpToggleResponse {
    if (!isSafeMachinePath(projectDir)) {
      return {
        ok: false,
        error: `Refusing to write Claude config for unsafe projectDir '${projectDir}'.`,
        code: "unsafe_path",
      };
    }
    const cfgPath = this.claudeConfigPath;
    let raw: string;
    try {
      raw = readFileSync(cfgPath, "utf-8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return {
          ok: false,
          error: `Claude config not found at ${cfgPath}`,
          code: "transport_failed",
        };
      }
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        code: "transport_failed",
      };
    }
    let config: { projects?: Record<string, unknown> };
    try {
      config = JSON.parse(raw);
    } catch {
      // #5676: a fixed reason, never the parser's text — Bun's JSON.parse
      // names an unquoted value verbatim, and this result reaches web clients
      // through the mcp-batch-progress event.
      return {
        ok: false,
        error: `Claude config at ${cfgPath} is not valid JSON.`,
        code: "config_corrupt",
      };
    }
    config.projects ??= {};
    const projects = config.projects;
    const project = (projects[projectDir] ??= {}) as Record<string, unknown>;
    const existing: string[] = Array.isArray(project.disabledMcpServers)
      ? (project.disabledMcpServers as unknown[]).filter(
          (s): s is string => typeof s === "string"
        )
      : [];
    const next = enabled
      ? existing.filter(s => s !== serverName)
      : existing.includes(serverName)
        ? existing
        : [...existing, serverName];
    const unchanged =
      next.length === existing.length &&
      next.every((v, i) => v === existing[i]);
    if (unchanged) {
      return { ok: true, method: "config" };
    }
    project.disabledMcpServers = next;
    const tmpPath = `${cfgPath}.tmp.${process.pid}.${randomUUID()}`;
    try {
      writeFileSync(tmpPath, JSON.stringify(config, null, 2));
      renameSync(tmpPath, cfgPath);
      return { ok: true, method: "config" };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        code: "transport_failed",
      };
    }
  }
}
