// SPDX-License-Identifier: AGPL-3.0-only
/**
 * HAL MCP — Codex `config.toml` `[mcp_servers]` emitter (issue #3125, KD1).
 *
 * Builds the `[mcp_servers]` section data from the canonical set and serializes
 * it with `smol-toml` (KD1 — no TOML package existed in the workspace and
 * `escapeTomlString` was already duplicated privately in two codex modules; a
 * real serializer supersedes hand-rolling a third escaper and correctly quotes
 * server names + values). The section is handed to the SINGLE composed
 * `config.toml` writer (`writeOpenRouterCodexHome`) — this module never writes a
 * second `config.toml` (V6). Secrets ride the composed file's own 0600 mode
 * inside the 0700 session home (secretDelivery); the `-c` argv path
 * (`codexMcpConfig.ts`) is left untouched for non-projected spawns.
 */
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import type { CanonicalMcpServer } from "./types";

/** A single `[mcp_servers.<name>]` entry (stdio or http). */
export type CodexMcpServerEntry =
  | { command: string; args: string[]; env?: Record<string, string> }
  | { url: string; env?: Record<string, string> };

/** The `mcp_servers` table value (server-name → entry). */
export type CodexMcpServersSection = Record<string, CodexMcpServerEntry>;

/** Translate the canonical set into the codex `[mcp_servers]` section (R1). */
export function buildCodexMcpServers(
  servers: CanonicalMcpServer[]
): CodexMcpServersSection {
  const section: CodexMcpServersSection = {};
  for (const server of servers) {
    const env =
      server.env && Object.keys(server.env).length > 0
        ? { env: server.env }
        : {};
    if (server.transport === "http") {
      section[server.name] = { url: server.url ?? "", ...env };
    } else {
      section[server.name] = {
        command: server.command ?? "",
        args: server.args ?? [],
        ...env,
      };
    }
  }
  return section;
}

/**
 * Serialize a codex `[mcp_servers]` section to a TOML fragment via `smol-toml`
 * (KD1). Empty section → empty string (no dangling table). The fragment is
 * appended to the composed `config.toml` by `writeOpenRouterCodexHome`.
 */
export function serializeCodexMcpServersToml(
  section: CodexMcpServersSection
): string {
  if (Object.keys(section).length === 0) return "";
  return stringifyToml({ mcp_servers: section });
}

/**
 * Parse a codex `config.toml` (or `[mcp_servers]` fragment) back into the
 * canonical set — the inverse used by the R5 round-trip battery (TOML parse-back
 * via `smol-toml`, KD3). Reads only the `mcp_servers` table; other tables
 * (provider config, shell policy) are ignored.
 */
export function parseCodexMcpServers(toml: string): CanonicalMcpServer[] {
  const parsed = parseToml(toml) as {
    mcp_servers?: Record<string, Record<string, unknown>>;
  };
  const table = parsed.mcp_servers ?? {};
  const servers: CanonicalMcpServer[] = [];
  for (const [name, entry] of Object.entries(table)) {
    const env = entry.env as Record<string, string> | undefined;
    if (typeof entry.url === "string") {
      servers.push({
        name,
        transport: "http",
        url: entry.url,
        ...(env ? { env } : {}),
      });
    } else {
      servers.push({
        name,
        transport: "stdio",
        command: typeof entry.command === "string" ? entry.command : "",
        args: Array.isArray(entry.args) ? (entry.args as string[]) : [],
        ...(env ? { env } : {}),
      });
    }
  }
  return servers;
}
