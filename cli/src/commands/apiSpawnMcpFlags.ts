// SPDX-License-Identifier: AGPL-3.0-only
import { McpSetSchema, type McpSet } from "@hapi/protocol";

/** Every value of a repeatable flag, in order. */
function parseRepeatedFlag(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === flag) values.push(args[++i]!);
  }
  return values;
}

/**
 * Issue #6171: the spawn's MCP set from `--mcp <name>` (repeatable),
 * `--mcp-none`, `--mcp-all` and `--mcp-enable-for-project`. No flag means no
 * set: the project's default applies, else every server (today's behavior).
 * `hapi` stays on whatever the set says. The server is the authoritative check
 * (an agent other than Claude, safe mode, a server off for the project).
 */
export function parseMcpSetFlags(
  args: string[]
): { mcpSet?: McpSet } | { error: string } {
  const names = parseRepeatedFlag(args, "--mcp");
  const none = args.includes("--mcp-none");
  const all = args.includes("--mcp-all");
  const enable = args.includes("--mcp-enable-for-project");
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
    servers: names,
    ...(enable ? { enableForProject: names } : {}),
  });
  if (!parsed.success) {
    return {
      error: `Invalid --mcp value: ${parsed.error.issues[0]?.message ?? "bad server name"}.`,
    };
  }
  return { mcpSet: parsed.data };
}
