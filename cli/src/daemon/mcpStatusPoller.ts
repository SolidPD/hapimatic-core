// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { logger } from "@/ui/logger";
import { getDefaultClaudeCodePath } from "@/claude/sdk/utils";
import { findCanonicalGitRoot } from "@/claude/utils/canonicalGitRoot";
import {
  accountConfigDirFor,
  isolatedConfigPath,
} from "@/accounts/accountConfigDir";
import {
  parseMcpList,
  classifyHostedServers,
  type McpStatusUpdate,
  type McpServerStatus,
} from "@hapi/protocol";

const MCP_POLL_TIMEOUT_MS = parseInt(
  process.env.HAPI_MCP_POLL_TIMEOUT || "180000",
  10
);

/**
 * #2142: needs-auth cache TTL backstop (24h default). An entry older than this
 * no longer overrides a live status AND is pruned on the next write — a server
 * that re-authed but never reconnected (or is just permanently broken) can't
 * stay pinned to needs_auth forever. Tunable via env for tests / operators. The
 * cache record's `{timestamp}` shape is FROZEN (Sub-A rp1-home#1290 contract):
 * this module reads and DELETES entries, never reshapes a surviving one.
 */
const AUTH_CACHE_TTL_MS = parseInt(
  process.env.HAPI_MCP_AUTH_CACHE_TTL_MS || String(24 * 60 * 60 * 1000),
  10
);

// Re-exported for the two poller test suites + any future consumer — the pure
// parser now lives in `@hapi/protocol` (was a hardcoded-glyph copy here, the
// #2142 drift engine).
export { classifyHostedServers };

interface AuthCacheEntry {
  timestamp?: number;
}
type AuthCacheFile = Record<string, AuthCacheEntry>;

/**
 * Resolve the `.claude.json` + needs-auth-cache paths for a poll. When the poll
 * runs INSIDE an account-bound session (`HAPI_ACCOUNT_UUID` set — e.g. the
 * in-session capability read), the ISOLATED per-account files are used (issue
 * #2364: Claude Code reads its config from `CLAUDE_CONFIG_DIR`, not `~/.claude`).
 * The daemon poller runs UNBOUND, so it resolves the home files — correct by
 * construction because the toggle + spawn scrub keep the home and isolated
 * `disabledMcpServers` in sync (both write both).
 */
function resolveMcpConfigPaths(): { configPath: string; cachePath: string } {
  const accountUuid = process.env.HAPI_ACCOUNT_UUID;
  if (accountUuid) {
    try {
      return {
        configPath: isolatedConfigPath(accountUuid),
        cachePath: join(
          accountConfigDirFor(accountUuid),
          "mcp-needs-auth-cache.json"
        ),
      };
    } catch {
      // Malformed UUID etc. — fall back to home (Fallback Preservation Rule).
    }
  }
  return {
    configPath: join(homedir(), ".claude.json"),
    cachePath: join(homedir(), ".claude", "mcp-needs-auth-cache.json"),
  };
}

/**
 * Read per-project disabled MCP server names from Claude Code's config.
 *
 * #2142: keys by the CANONICAL GIT ROOT of `projectDir`, not the raw path. A
 * worktree cwd has no `projects[cwd]` entry of its own — Claude Code (and the
 * #1347/#2364 spawn scrub) store `disabledMcpServers` under the main-repo root
 * (`findCanonicalGitRoot`). Reading the raw cwd returned an empty list for every
 * worktree session, so the disabled-by-default filter silently never applied.
 */
export function readDisabledServers(
  projectDir: string,
  configPath?: string
): string[] {
  try {
    const cfgPath = configPath ?? join(homedir(), ".claude.json");
    const raw = readFileSync(cfgPath, "utf-8");
    const config = JSON.parse(raw);
    const key = findCanonicalGitRoot(projectDir) ?? projectDir;
    const projectConfig = config?.projects?.[key];
    const disabled = projectConfig?.disabledMcpServers;
    if (Array.isArray(disabled)) {
      return disabled.filter(
        (s: unknown): s is string => typeof s === "string"
      );
    }
    return [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.debug(
        `[MCP STATUS] Failed to read disabled servers: ${err instanceof Error ? err.message : err}`
      );
      logger.reportCaught(err, {
        category: "mcp-status-disabled-read",
        severity: "warn",
      });
    }
    return [];
  }
}

/**
 * Read the MCP auth-needs cache and return the ACTIVE (non-TTL-expired) server
 * names. File format: `{ "serverName": { "timestamp": number } }` (FROZEN shape).
 * An entry older than {@link AUTH_CACHE_TTL_MS} is excluded (the #2142 backstop);
 * an entry with no/invalid timestamp is treated as active (fail-open — the frozen
 * shape always carries a timestamp, so this only guards corruption).
 */
export function readAuthNeedsCache(
  configPath?: string,
  now: number = Date.now()
): Set<string> {
  try {
    const cfgPath =
      configPath ?? join(homedir(), ".claude", "mcp-needs-auth-cache.json");
    const raw = readFileSync(cfgPath, "utf-8");
    const cache = JSON.parse(raw);
    if (!cache || typeof cache !== "object") return new Set();
    const active = new Set<string>();
    for (const [name, entry] of Object.entries(cache as AuthCacheFile)) {
      const ts = typeof entry?.timestamp === "number" ? entry.timestamp : null;
      if (ts === null || now - ts <= AUTH_CACHE_TTL_MS) active.add(name);
    }
    return active;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.debug(
        `[MCP STATUS] Failed to read auth-needs cache: ${err instanceof Error ? err.message : err}`
      );
      logger.reportCaught(err, {
        category: "mcp-status-auth-cache-read",
        severity: "warn",
      });
    }
    return new Set();
  }
}

/**
 * #2142 cache lifecycle: prune the needs-auth cache. Removes any entry whose
 * server is now CONNECTED (delete-on-connected — the missing invalidation that
 * pinned a re-authed server to needs_auth forever) AND any TTL-expired entry
 * (backstop). Atomic (write-temp + rename); tolerate-missing; fully fail-soft —
 * never breaks a poll. Only DELETES keys, preserving each surviving entry's
 * frozen `{timestamp}` shape. The cache's external writer (native Claude Code)
 * may race this write; the cache is advisory (bounded harm: one extra auth
 * prompt), so last-writer-wins is acceptable.
 */
export function pruneAuthNeedsCache(
  cachePath: string,
  connectedNames: Set<string>,
  now: number = Date.now()
): void {
  try {
    let raw: string;
    try {
      raw = readFileSync(cachePath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    let cache: AuthCacheFile;
    try {
      cache = JSON.parse(raw);
    } catch {
      return; // corrupt — leave the external writer's file alone
    }
    if (!cache || typeof cache !== "object") return;
    let changed = false;
    for (const [name, entry] of Object.entries(cache)) {
      const ts = typeof entry?.timestamp === "number" ? entry.timestamp : null;
      const expired = ts !== null && now - ts > AUTH_CACHE_TTL_MS;
      if (connectedNames.has(name) || expired) {
        delete cache[name];
        changed = true;
      }
    }
    if (!changed) return;
    const tmpPath = `${cachePath}.tmp.${process.pid}.${randomUUID()}`;
    writeFileSync(tmpPath, JSON.stringify(cache, null, 2));
    renameSync(tmpPath, cachePath);
  } catch (err) {
    logger.debug(
      `[MCP STATUS] auth-cache prune failed (non-fatal): ${err instanceof Error ? err.message : err}`
    );
  }
}

/**
 * Cross-reference servers against the auth-needs cache. Reclassifies "failed"
 * servers to "needs_auth" if they appear in the cache. Never downgrades a
 * connected/hosted server (failed→needs_auth only).
 */
export function applyAuthCacheOverrides(
  servers: McpServerStatus[],
  authCache: Set<string>
): McpServerStatus[] {
  if (authCache.size === 0) return servers;
  return servers.map(s =>
    s.status === "failed" && authCache.has(s.name)
      ? { ...s, status: "needs_auth" as const }
      : s
  );
}

/**
 * Shared post-`claude mcp list` pipeline: parse (tolerant, never-drop) → hosted
 * reclassify → auth-cache override → disabled filter → cache prune. Used by BOTH
 * the normal completion path AND the partial-salvage (timeout) path so drift
 * hardening and disabled filtering apply identically (expert-review REM-4c).
 */
function buildMcpStatus(
  stdout: string,
  cwd?: string
): {
  servers: McpServerStatus[];
  disabledServers: string[];
  unparsedLineCount: number;
} {
  const { servers: parsed, unparsedLines } = parseMcpList(stdout);
  let servers = classifyHostedServers(parsed);

  const { configPath, cachePath } = resolveMcpConfigPaths();
  const authCache = readAuthNeedsCache(cachePath);
  servers = applyAuthCacheOverrides(servers, authCache);

  const disabledServers = cwd ? readDisabledServers(cwd, configPath) : [];
  if (disabledServers.length > 0) {
    const disabledSet = new Set(disabledServers);
    servers = servers.filter(s => !disabledSet.has(s.name));
  }

  // Housekeeping: drop cache entries for now-connected servers + TTL-expired.
  const connectedNames = new Set(
    servers
      .filter(s => s.status === "connected" || s.status === "hosted")
      .map(s => s.name)
  );
  pruneAuthNeedsCache(cachePath, connectedNames);

  return { servers, disabledServers, unparsedLineCount: unparsedLines.length };
}

export async function pollMcpStatus(
  cwd?: string
): Promise<McpStatusUpdate | null> {
  let claudePath: string;
  try {
    claudePath = getDefaultClaudeCodePath();
  } catch (err) {
    logger.debug(
      `[MCP STATUS] Claude Code CLI path resolution failed: ${err instanceof Error ? err.message : err}`
    );
    logger.reportCaught(err, {
      category: "mcp-status-claude-path",
      severity: "warn",
    });
    return null;
  }

  if (cwd && !existsSync(cwd)) {
    logger.debug(
      `[MCP STATUS] Skipping poll for non-existent directory: ${cwd}`
    );
    return null;
  }

  const start = Date.now();

  return new Promise(resolve => {
    let resolved = false;
    const safeResolve = (value: McpStatusUpdate | null) => {
      if (!resolved) {
        resolved = true;
        resolve(value);
      }
    };
    const child = execFile(
      claudePath,
      ["mcp", "list"],
      { timeout: MCP_POLL_TIMEOUT_MS, encoding: "utf-8", cwd },
      (error, stdout, stderr) => {
        const elapsed = Date.now() - start;

        if (error) {
          // Try to salvage partial output on timeout — routed through the SAME
          // pipeline as the success path (REM-4c).
          if (error.killed && stdout) {
            const { servers, disabledServers, unparsedLineCount } =
              buildMcpStatus(stdout, cwd);
            if (servers.length > 0) {
              logger.debug(
                `[MCP STATUS] Poll timed out after ${elapsed}ms but got ${servers.length} servers (partial); ${unparsedLineCount} unparsed line(s)`
              );
              safeResolve({
                servers,
                checkedAt: new Date().toISOString(),
                projectDir: cwd,
                disabledServers:
                  disabledServers.length > 0 ? disabledServers : undefined,
              });
              return;
            }
          }
          logger.debug(
            `[MCP STATUS] Poll failed after ${elapsed}ms: ${error.message}${stderr ? ` (stderr: ${stderr.slice(0, 200)})` : ""}`
          );
          safeResolve(null);
          return;
        }

        const { servers, disabledServers, unparsedLineCount } = buildMcpStatus(
          stdout,
          cwd
        );

        if (unparsedLineCount > 0) {
          // Drift signal: a well-formed line the parser could not classify now
          // becomes a status:"unknown" server (never dropped); a structureless
          // line is counted here. Visible in daemon logs, never user-facing.
          logger.debug(
            `[MCP STATUS] ${unparsedLineCount} unparsed mcp-list line(s) — possible \`claude mcp list\` format drift`
          );
        }

        if (servers.length === 0) {
          logger.debug(
            `[MCP STATUS] No servers parsed from output (${elapsed}ms)`
          );
          safeResolve({
            servers: [],
            checkedAt: new Date().toISOString(),
            projectDir: cwd,
            disabledServers:
              disabledServers.length > 0 ? disabledServers : undefined,
          });
          return;
        }

        logger.debug(
          `[MCP STATUS] Polled ${servers.length} servers in ${elapsed}ms: ${servers.filter(s => s.status !== "connected").length} unhealthy`
        );

        safeResolve({
          servers,
          checkedAt: new Date().toISOString(),
          projectDir: cwd,
          disabledServers:
            disabledServers.length > 0 ? disabledServers : undefined,
        });
      }
    );

    child.on("error", err => {
      logger.debug(`[MCP STATUS] Process error: ${err.message}`);
      safeResolve(null);
    });
  });
}
