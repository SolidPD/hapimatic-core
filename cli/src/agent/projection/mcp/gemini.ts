// SPDX-License-Identifier: AGPL-3.0-only
/**
 * HAL MCP — Gemini ACP `newSession({ mcpServers })` array emitter (issue #3125,
 * KD1a).
 *
 * Gemini's `settings.json` is DEAD config under the current spawn path (it has
 * no config-home/settings plumbing at all). The VERIFIED carrier is the ACP
 * `session/new` `mcpServers` array — the exact `McpServerStdio[]` shape
 * `runAgentSession.ts` builds and `AcpSdkBackend.newSession` forwards. So the
 * gemini "emitter" produces that array (name/command/args/env), NOT a config
 * file. Secrets ride the per-server `env` fields in-protocol; the on-disk
 * handoff artifact that carries this array to the child is written mode 0600
 * (secretDelivery). OpenCode shares this exact carrier — see `opencode.ts`.
 *
 * The ACP `McpServerStdio` shape is stdio-only, so an `http`-transport canonical
 * server is not representable here and is dropped (OR2 carrier-drift — http over
 * ACP awaits the protocol's http `McpServer` variant). Callers project http
 * servers only onto carriers that support them (codex/claude).
 */
import type { McpEnvVar, McpServerStdio } from "@/agent/types";
import type { CanonicalMcpServer } from "./types";

/** Convert a canonical `env` map into the ACP `McpEnvVar[]` shape. */
function toAcpEnv(env: Record<string, string> | undefined): McpEnvVar[] {
  if (!env) return [];
  return Object.entries(env).map(([name, value]) => ({ name, value }));
}

/** Convert an ACP `McpEnvVar[]` back into a canonical `env` map. */
function fromAcpEnv(env: McpEnvVar[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { name, value } of env) out[name] = value;
  return out;
}

/**
 * Translate the canonical set into the ACP `mcpServers` array (R1). Only stdio
 * servers are representable in the ACP `McpServerStdio` shape; http servers are
 * skipped (see module note). This is the shared Gemini/OpenCode carrier.
 */
export function buildAcpMcpServers(
  servers: CanonicalMcpServer[]
): McpServerStdio[] {
  const out: McpServerStdio[] = [];
  for (const server of servers) {
    if (server.transport !== "stdio") continue;
    out.push({
      name: server.name,
      command: server.command ?? "",
      args: server.args ?? [],
      env: toAcpEnv(server.env),
    });
  }
  return out;
}

/**
 * Parse an ACP `mcpServers` array back into the canonical set — the inverse used
 * by the R5 round-trip battery (deep-equal of the ACP `McpServer[]`, KD3).
 */
export function parseAcpMcpServers(
  servers: McpServerStdio[]
): CanonicalMcpServer[] {
  return servers.map(server => {
    const env = fromAcpEnv(server.env);
    return {
      name: server.name,
      transport: "stdio" as const,
      command: server.command,
      args: server.args,
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
  });
}

/** Gemini-named alias for the shared ACP carrier builder (KD1a). */
export const buildGeminiMcpServers = buildAcpMcpServers;
