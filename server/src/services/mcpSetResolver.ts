// SPDX-License-Identifier: AGPL-3.0-only
import {
  normalizeMcpSet,
  type McpSet,
  type SpawnWarning,
} from "@hapi/protocol";
import type { McpCatalogService } from "./mcpCatalogService";

export type SpawnMcpResolution =
  | { ok: true; mcpSet?: McpSet; warnings: SpawnWarning[] }
  | {
      ok: false;
      status: 400 | 409;
      code:
        | "mcp_set_agent_unsupported"
        | "mcp_set_safe_mode_unsupported"
        | "mcp_server_project_disabled";
      message: string;
      /** The servers a `mcp_server_project_disabled` refusal is about. */
      servers?: string[];
    };

/**
 * The MCP set a spawn starts with (issue #6171), resolved once on the node that owns
 * the project and called from the spawn route and the peer receiver. Not from
 * `spawnSession`: respawns pass through there, and a resumed session must keep its
 * own set rather than pick up a default stored since.
 *
 * With no set and no default this returns none, so the spawn is byte-identical to one
 * from before this feature. A default never applies to a non-Claude agent, to safe
 * mode (which drops the settings file), or to clone-on-spawn (the directory does not
 * exist yet, so it has no project).
 */
export function resolveSpawnMcpSet(input: {
  requested: McpSet | undefined;
  directory: string;
  flavor: string;
  safeMode: boolean;
  cloneRepo?: string;
  catalog: McpCatalogService | null;
}): SpawnMcpResolution {
  const { requested, directory, flavor, safeMode, cloneRepo, catalog } = input;

  if (requested === undefined) {
    if (flavor !== "claude" || safeMode || cloneRepo || !catalog) {
      return { ok: true, warnings: [] };
    }
    // A default that cannot be read (a store or config fault) is skipped, so
    // the spawn starts as it did before #6171 rather than failing (review SS-5).
    let stored: McpSet | null;
    try {
      stored = catalog.getProjectDefault(directory);
    } catch {
      return { ok: true, warnings: [] };
    }
    if (!stored) return { ok: true, warnings: [] };
    const warnings: SpawnWarning[] = [];
    if (stored.mode === "only") {
      // Only feeds the warning, so a failure here keeps the default
      // (delta review DS-4).
      let disabled: Set<string>;
      try {
        disabled = catalog.projectDisabledNames(directory);
      } catch {
        disabled = new Set();
      }
      const off = stored.servers.filter(name => disabled.has(name));
      if (off.length > 0) {
        warnings.push({
          code: "mcp_default_server_disabled",
          message: `The project's default MCP set names ${off.join(", ")}, which ${
            off.length === 1 ? "is" : "are"
          } off for this project, so ${
            off.length === 1 ? "it stays" : "they stay"
          } off.`,
        });
      }
    }
    return { ok: true, mcpSet: stored, warnings };
  }

  if (flavor !== "claude") {
    return {
      ok: false,
      status: 400,
      code: "mcp_set_agent_unsupported",
      message: `An MCP set applies to Claude sessions only, not "${flavor}".`,
    };
  }
  if (safeMode) {
    return {
      ok: false,
      status: 400,
      code: "mcp_set_safe_mode_unsupported",
      message:
        "An MCP set cannot apply in safe mode, which turns off MCP customizations.",
    };
  }

  const mcpSet = normalizeMcpSet(requested);
  if (mcpSet.mode === "only" && catalog && !cloneRepo) {
    const disabled = catalog.projectDisabledNames(directory);
    const enable = new Set(mcpSet.enableForProject ?? []);
    const refused = mcpSet.servers.filter(
      name => disabled.has(name) && !enable.has(name)
    );
    if (refused.length > 0) {
      return {
        ok: false,
        status: 409,
        code: "mcp_server_project_disabled",
        message: `${refused.join(", ")} ${
          refused.length === 1 ? "is" : "are"
        } off for this project. Claude Code has no per-session way to turn a server on, so list ${
          refused.length === 1 ? "it" : "them"
        } in enableForProject to turn ${
          refused.length === 1 ? "it" : "them"
        } on for the whole project.`,
        servers: refused,
      };
    }
  }
  return { ok: true, mcpSet, warnings: [] };
}
