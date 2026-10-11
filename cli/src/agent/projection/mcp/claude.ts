// SPDX-License-Identifier: AGPL-3.0-only
/**
 * HAL MCP — Claude `--mcp-config` document emitter (issue #3125).
 *
 * Emits the standalone `{ mcpServers }` JSON document Claude reads via
 * `--mcp-config` (the shape `cli/src/claude/utils/mcpConfig.ts` writes). This is
 * the round-trip REFERENCE dialect (R5): #3122 R6 guarantees Claude spawns are
 * byte-identical and SKIP projection, so this emitter is NOT wired into a Claude
 * spawn — it exists for the canonical → dialect → parse-back equivalence battery
 * and as the documented reference shape. `env` values inline into the JSON
 * document, delivered via the 0600 `--mcp-config` temp file (secretDelivery).
 */
import type { CanonicalMcpServer } from "./types";

/** A single entry in the Claude `--mcp-config` `mcpServers` map. */
export type ClaudeMcpEntry =
  | {
      type: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | { type: "http"; url: string; headers?: Record<string, string> };

/** The Claude `--mcp-config` document. */
export interface ClaudeMcpDocument {
  mcpServers: Record<string, ClaudeMcpEntry>;
}

/** Translate the canonical set into the Claude `--mcp-config` document (R1). */
export function buildClaudeMcpDocument(
  servers: CanonicalMcpServer[]
): ClaudeMcpDocument {
  const mcpServers: Record<string, ClaudeMcpEntry> = {};
  for (const server of servers) {
    if (server.transport === "http") {
      mcpServers[server.name] = {
        type: "http",
        url: server.url ?? "",
        ...(server.headers && Object.keys(server.headers).length > 0
          ? { headers: server.headers }
          : {}),
      };
    } else {
      mcpServers[server.name] = {
        type: "stdio",
        command: server.command ?? "",
        ...(server.args && server.args.length > 0 ? { args: server.args } : {}),
        ...(server.env && Object.keys(server.env).length > 0
          ? { env: server.env }
          : {}),
      };
    }
  }
  return { mcpServers };
}

/**
 * Parse a Claude `--mcp-config` document back into the canonical set — the
 * inverse of {@link buildClaudeMcpDocument} used by the R5 round-trip battery
 * (STRUCTURAL parse-back, KD3).
 */
export function parseClaudeMcpDocument(
  doc: ClaudeMcpDocument
): CanonicalMcpServer[] {
  const servers: CanonicalMcpServer[] = [];
  for (const [name, entry] of Object.entries(doc.mcpServers)) {
    if (entry.type === "http") {
      servers.push({
        name,
        transport: "http",
        url: entry.url,
        ...(entry.headers ? { headers: entry.headers } : {}),
      });
    } else {
      servers.push({
        name,
        transport: "stdio",
        command: entry.command,
        ...(entry.args ? { args: entry.args } : {}),
        ...(entry.env ? { env: entry.env } : {}),
      });
    }
  }
  return servers;
}
