// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  HAPI_MCP_SERVER_NAME,
  resolveMcpDenyPolicy,
  type McpSetLaunchPayload,
} from "@hapi/protocol";
import { isolatedConfigPath } from "@/accounts/accountConfigDir";
import { logger } from "@/ui/logger";
import { findCanonicalGitRoot } from "./canonicalGitRoot";
import { applyDisabledServerToggle } from "./projectMcpConfig";

/**
 * Issue #6171: what a session's MCP set becomes in its `--settings` file.
 * `deny` feeds `deniedMcpServers`, `connectorsOff` feeds
 * `disableClaudeAiConnectors`, and `enableNow` is the `enableForProject` names to
 * turn on for the whole project before Claude starts. `enabledNames` (the set's
 * servers that are on: not off for the project, or enabled by `enableNow`) goes
 * to the Claude child as `HAPI_MCP_SET_ENABLED`, so the rp1-home default-disable
 * hook (rp1-home#2999) leaves them alone on its enforce roots.
 */
export interface SessionMcpPolicy {
  deny: string[];
  connectorsOff: boolean;
  enableNow: string[];
  enabledNames: string[];
}

export const MCP_SET_ENABLED_ENV = "HAPI_MCP_SET_ENABLED";

function objectKeys(value: unknown): string[] {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value)
    : [];
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The Claude configs this session may read: home, and an account's own. */
export function sessionClaudeConfigPaths(
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const paths = [join(homedir(), ".claude.json")];
  const accountUuid = env.HAPI_ACCOUNT_UUID;
  if (accountUuid) {
    try {
      paths.push(isolatedConfigPath(accountUuid));
    } catch {
      // A malformed uuid names no readable config.
    }
  }
  return paths;
}

/**
 * Every MCP server name Claude Code can load statically for this directory: the
 * user and project `mcpServers` in each config and `.mcp.json` at the directory
 * and at the canonical root. Added to the server's list, because a name the
 * server never saw (a project server, a server added since the last poll) would
 * otherwise stay on.
 */
export function readStaticMcpNames(
  workingDirectory: string,
  canonicalRoot: string,
  configPaths: string[]
): string[] {
  const names = new Set<string>();
  for (const path of configPaths) {
    const config = readJson(path);
    for (const name of objectKeys(config?.mcpServers)) names.add(name);
    const projects = config?.projects as Record<string, unknown> | undefined;
    const project = projects?.[canonicalRoot] as
      | Record<string, unknown>
      | undefined;
    for (const name of objectKeys(project?.mcpServers)) names.add(name);
  }
  for (const dir of new Set([workingDirectory, canonicalRoot])) {
    for (const name of objectKeys(
      readJson(join(dir, ".mcp.json"))?.mcpServers
    )) {
      names.add(name);
    }
  }
  return [...names];
}

/**
 * The policy for a launch payload, or null when the session has no set (no keys
 * are written and the session starts as it did before #6171).
 */
export function resolveSessionMcpPolicy(input: {
  payload: McpSetLaunchPayload | undefined;
  workingDirectory: string;
  canonicalRoot: string;
  configPaths: string[];
}): SessionMcpPolicy | null {
  const { payload } = input;
  if (!payload) return null;
  if (payload.set.mode === "all") {
    return { deny: [], connectorsOff: false, enableNow: [], enabledNames: [] };
  }
  const known = [
    ...payload.known,
    ...readStaticMcpNames(
      input.workingDirectory,
      input.canonicalRoot,
      input.configPaths
    ),
  ];
  const { deny, connectorsOff } = resolveMcpDenyPolicy(payload.set, known);
  const servers = payload.set.servers.filter(
    name => name !== HAPI_MCP_SERVER_NAME
  );
  const enableNow = (payload.set.enableForProject ?? []).filter(name =>
    servers.includes(name)
  );
  // Only the servers that are really on: a set (a stored default, or an
  // inherited one) can name a server that is off for the project without
  // enabling it, and it stays off. Exporting it would let the rp1-home hook turn
  // it on for the whole project on an enforce root (rp1-home#2999), which only
  // `enableForProject` may do (DM-1). Read from the home config only (the first
  // path): it is the file that hook rewrites and the one the server's catalog
  // calls "off for the project". An isolated account's copy can be stale, and a
  // server off only there must still be exported, or the hook turns it off.
  const offForProject = readProjectDisabledMcpNames(
    input.canonicalRoot,
    input.configPaths.slice(0, 1)
  );
  const enabledNames = servers.filter(
    name => !offForProject.has(name) || enableNow.includes(name)
  );
  return { deny, connectorsOff, enableNow, enabledNames };
}

/** Names off for the project (`disabledMcpServers`) in the given configs. */
export function readProjectDisabledMcpNames(
  canonicalRoot: string,
  configPaths: string[]
): Set<string> {
  const names = new Set<string>();
  for (const path of configPaths) {
    const projects = readJson(path)?.projects as
      | Record<string, unknown>
      | undefined;
    const project = projects?.[canonicalRoot] as
      | Record<string, unknown>
      | undefined;
    const disabled = project?.disabledMcpServers;
    if (!Array.isArray(disabled)) continue;
    for (const name of disabled) {
      if (typeof name === "string") names.add(name);
    }
  }
  return names;
}

/**
 * Turn the `enableForProject` names on for the project in each config the session
 * may read, next to the `hapi` scrub and as forgiving: a failure is logged and
 * the spawn proceeds (the server then stays off, as it was). A missing account
 * config is normal and quiet.
 */
export async function applyMcpEnableForProject(
  canonicalRoot: string,
  names: string[],
  configPaths: string[]
): Promise<void> {
  for (const configPath of configPaths) {
    for (const name of names) {
      try {
        const wrote = await applyDisabledServerToggle(
          canonicalRoot,
          name,
          /* enabled */ true,
          configPath
        );
        if (wrote) {
          logger.info(
            `[mcpSet] Turned '${name}' on for ${canonicalRoot} in ${configPath}`
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/not found/i.test(message)) {
          logger.debug(`[mcpSet] No config at ${configPath}: ${message}`);
        } else {
          logger.warn(
            `[mcpSet] Could not turn '${name}' on for ${canonicalRoot}: ${message}`
          );
        }
      }
    }
  }
}

/**
 * The metadata probe's inline `--settings` JSON: only the two MCP keys, so the
 * probe starts the same servers the session does and gains no hooks. Undefined
 * when the policy writes neither key.
 */
export function buildMcpProbeSettings(
  policy: SessionMcpPolicy | null
): string | undefined {
  if (!policy) return undefined;
  const settings: {
    deniedMcpServers?: Array<{ serverName: string }>;
    disableClaudeAiConnectors?: boolean;
  } = {};
  if (policy.deny.length > 0) {
    settings.deniedMcpServers = policy.deny.map(serverName => ({ serverName }));
  }
  if (policy.connectorsOff) settings.disableClaudeAiConnectors = true;
  return Object.keys(settings).length > 0
    ? JSON.stringify(settings)
    : undefined;
}

/**
 * Resolve the policy for this session, apply `enableForProject`, and set (or
 * clear, so a value inherited from a tmux server's env never leaks into a
 * session without a set) `HAPI_MCP_SET_ENABLED` for the Claude child. Never
 * throws. `deps` is a test seam; production passes nothing.
 */
export async function prepareSessionMcpPolicy(
  payload: McpSetLaunchPayload | undefined,
  workingDirectory: string,
  deps: { env?: NodeJS.ProcessEnv; configPaths?: string[] } = {}
): Promise<SessionMcpPolicy | null> {
  const env = deps.env ?? process.env;
  delete env[MCP_SET_ENABLED_ENV];
  if (!payload) return null;
  try {
    const canonicalRoot =
      findCanonicalGitRoot(workingDirectory) ?? workingDirectory;
    const configPaths = deps.configPaths ?? sessionClaudeConfigPaths(env);
    const policy = resolveSessionMcpPolicy({
      payload,
      workingDirectory,
      canonicalRoot,
      configPaths,
    });
    if (!policy) return null;
    if (policy.enableNow.length > 0) {
      await applyMcpEnableForProject(
        canonicalRoot,
        policy.enableNow,
        configPaths
      );
    }
    if (policy.enabledNames.length > 0) {
      env[MCP_SET_ENABLED_ENV] = JSON.stringify(policy.enabledNames);
    }
    logger.debug(
      `[mcpSet] ${payload.set.mode} set: deny ${policy.deny.length}, connectors ${policy.connectorsOff ? "off" : "on"}`
    );
    return policy;
  } catch (err) {
    // Fail toward today's behavior: every server starts.
    logger.warn(
      `[mcpSet] Could not apply the MCP set: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}
