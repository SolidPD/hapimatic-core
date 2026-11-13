// SPDX-License-Identifier: AGPL-3.0-only
import { McpSetSchema, type McpSet } from "@hapi/protocol";
import { scanSpawnFlags } from "./apiSpawnFlags";

/**
 * Issue #6171: the spawn's MCP set from `--mcp <name>` (repeatable),
 * `--mcp-none`, `--mcp-all` and `--mcp-enable-for-project`. No flag means no
 * set: the project's default applies, else every server (today's behavior).
 * `hapi` stays on whatever the set says. The server is the authoritative check
 * (an agent other than Claude, safe mode, a server off for the project).
 *
 * Issue #6400: the names and flags come from {@link scanSpawnFlags}, so a flag
 * counts only as its own token and every `--mcp` has a value (a trailing
 * `--mcp` is refused, and `--mcp --mcp-all` is never a server name).
 */
export function mcpSetFromScan(
  names: readonly string[],
  booleans: ReadonlySet<string>
): { mcpSet?: McpSet } | { error: string } {
  const none = booleans.has("--mcp-none");
  const all = booleans.has("--mcp-all");
  const enable = booleans.has("--mcp-enable-for-project");
  if (all && (none || names.length > 0)) {
    return { error: "--mcp-all cannot be combined with --mcp or --mcp-none." };
  }
  if (none && names.length > 0) {
    return { error: "--mcp-none cannot be combined with --mcp." };
  }
  if (enable && names.length === 0) {
    return {
      error: "--mcp-enable-for-project needs at least one --mcp <name>.",
    };
  }
  if (all) return { mcpSet: { mode: "all" } };
  if (!none && names.length === 0) return {};
  const parsed = McpSetSchema.safeParse({
    mode: "only",
    servers: [...names],
    ...(enable ? { enableForProject: [...names] } : {}),
  });
  if (!parsed.success) {
    return {
      error: `Invalid --mcp value: ${parsed.error.issues[0]?.message ?? "bad server name"}.`,
    };
  }
  return { mcpSet: parsed.data };
}

/**
 * The MCP set from bare spawn flags (no verb), scanned strictly
 * ({@link scanSpawnFlags}). `resolveSpawnArgs` calls {@link mcpSetFromScan}
 * on its own scan instead.
 */
export function parseMcpSetFlags(
  args: string[]
): { mcpSet?: McpSet } | { error: string } {
  const scan = scanSpawnFlags(args);
  if ("error" in scan) return scan;
  return mcpSetFromScan(scan.repeated.get("--mcp") ?? [], scan.booleans);
}
