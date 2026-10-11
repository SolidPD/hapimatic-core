// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from "node:child_process";
import { readFileSync, existsSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { McpStatusUpdate, McpServerStatus } from "@hapi/protocol";
import { parseMcpList, classifyHostedServers } from "@hapi/protocol";
import { findCanonicalGitRoot } from "@hapi/protocol/gitRoot";

const MCP_REFRESH_TIMEOUT_MS = parseInt(
  process.env.HAPI_MCP_REFRESH_TIMEOUT || "60000",
  10
);

/** #2142: needs-auth cache TTL backstop (24h default) — see the CLI poller for
 *  the full rationale. Same env knob so both pollers share one value. */
const AUTH_CACHE_TTL_MS = parseInt(
  process.env.HAPI_MCP_AUTH_CACHE_TTL_MS || String(24 * 60 * 60 * 1000),
  10
);

let pollInProgress = false;

interface AuthCacheEntry {
  timestamp?: number;
}
type AuthCacheFile = Record<string, AuthCacheEntry>;

// The server process is never account-bound (no HAPI_ACCOUNT_UUID), so it always
// reads the HOME config/cache — correct by construction because the toggle +
// spawn scrub keep the home and isolated `disabledMcpServers` in sync.
const HOME_CONFIG_PATH = join(homedir(), ".claude.json");
const HOME_CACHE_PATH = join(homedir(), ".claude", "mcp-needs-auth-cache.json");

/** Active (non-TTL-expired) needs-auth server names from the home cache. */
function readAuthNeedsCache(now: number = Date.now()): Set<string> {
  try {
    const raw = readFileSync(HOME_CACHE_PATH, "utf-8");
    const cache = JSON.parse(raw);
    if (!cache || typeof cache !== "object") return new Set();
    const active = new Set<string>();
    for (const [name, entry] of Object.entries(cache as AuthCacheFile)) {
      const ts = typeof entry?.timestamp === "number" ? entry.timestamp : null;
      if (ts === null || now - ts <= AUTH_CACHE_TTL_MS) active.add(name);
    }
    return active;
  } catch {
    return new Set();
  }
}

/** Prune the home needs-auth cache: delete-on-connected + TTL. Atomic, fail-soft,
 *  frozen `{timestamp}` shape preserved (only DELETE keys). */
function pruneAuthNeedsCache(
  connectedNames: Set<string>,
  now: number = Date.now()
): void {
  try {
    let raw: string;
    try {
      raw = readFileSync(HOME_CACHE_PATH, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    let cache: AuthCacheFile;
    try {
      cache = JSON.parse(raw);
    } catch {
      return;
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
    const tmpPath = `${HOME_CACHE_PATH}.tmp.${process.pid}.${randomUUID()}`;
    writeFileSync(tmpPath, JSON.stringify(cache, null, 2));
    renameSync(tmpPath, HOME_CACHE_PATH);
  } catch {
    // Non-fatal — the cache is advisory.
  }
}

function applyAuthCacheOverrides(
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
 * Disabled servers for `projectDir`, keyed by CANONICAL GIT ROOT (#2142 — a
 * worktree cwd has no `projects[cwd]` key; Claude Code stores the list under the
 * main-repo root).
 */
function readDisabledServers(projectDir: string): string[] {
  try {
    const raw = readFileSync(HOME_CONFIG_PATH, "utf-8");
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
  } catch {
    return [];
  }
}

function findClaudePath(): string | null {
  // Check explicit env var
  if (process.env.HAPI_CLAUDE_PATH) {
    const envPath = process.env.HAPI_CLAUDE_PATH;
    if (envPath.startsWith("/") && existsSync(envPath)) {
      return envPath;
    }
  }

  // Bun-native PATH resolution
  const fromPath = Bun.which("claude");
  if (fromPath) return fromPath;

  // Well-known install locations (systemd daemons have minimal PATH)
  const home = homedir();
  const wellKnownPaths = [
    `${home}/.local/bin/claude`,
    `${home}/.npm-global/bin/claude`,
    "/usr/local/bin/claude",
  ];
  for (const p of wellKnownPaths) {
    if (existsSync(p)) return p;
  }

  return null;
}

/** Shared post-`claude mcp list` pipeline (mirrors the CLI poller's, REM-4c). */
function buildMcpStatus(
  stdout: string,
  cwd?: string
): { servers: McpServerStatus[]; disabledServers: string[] } {
  const { servers: parsed } = parseMcpList(stdout);
  let servers = classifyHostedServers(parsed);

  const authCache = readAuthNeedsCache();
  servers = applyAuthCacheOverrides(servers, authCache);

  const disabledServers = cwd ? readDisabledServers(cwd) : [];
  if (disabledServers.length > 0) {
    const disabledSet = new Set(disabledServers);
    servers = servers.filter(s => !disabledSet.has(s.name));
  }

  const connectedNames = new Set(
    servers
      .filter(s => s.status === "connected" || s.status === "hosted")
      .map(s => s.name)
  );
  pruneAuthNeedsCache(connectedNames);

  return { servers, disabledServers };
}

export async function pollMcpStatusOnDemand(
  cwd?: string
): Promise<McpStatusUpdate | null> {
  if (pollInProgress) return null;

  const claudePath = findClaudePath();
  if (!claudePath) return null;

  pollInProgress = true;

  try {
    return await new Promise<McpStatusUpdate | null>(resolve => {
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
        { timeout: MCP_REFRESH_TIMEOUT_MS, encoding: "utf-8", cwd },
        (error, stdout, stderr) => {
          if (error) {
            // Salvage partial output on timeout — same pipeline (REM-4c).
            if (error.killed && stdout) {
              const { servers, disabledServers } = buildMcpStatus(stdout, cwd);
              if (servers.length > 0) {
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
            void stderr;
            safeResolve(null);
            return;
          }

          const { servers, disabledServers } = buildMcpStatus(stdout, cwd);

          safeResolve({
            servers,
            checkedAt: new Date().toISOString(),
            projectDir: cwd,
            disabledServers:
              disabledServers.length > 0 ? disabledServers : undefined,
          });
        }
      );

      child.on("error", () => {
        safeResolve(null);
      });
    });
  } finally {
    pollInProgress = false;
  }
}
