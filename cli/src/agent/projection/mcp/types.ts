// SPDX-License-Identifier: AGPL-3.0-only
/**
 * HAL MCP config translation — canonical MCP model + hapi-server factory
 * (issue #3125, epic #3117 Sub-Issue J).
 *
 * The canonical MCP server set is the harness-agnostic input the four dialect
 * emitters translate into each CLI's VERIFIED carrier: Claude `--mcp-config`
 * `{ mcpServers }` document, Codex `config.toml` `[mcp_servers]`, and
 * Gemini/OpenCode ACP `newSession({ mcpServers })` arrays. Per the expert-review
 * ruling (KD1a), the gemini `settings.json` / `opencode.json` nominal config
 * files are DEAD under the current spawn paths — the emitters build the ACP
 * array, never those files.
 *
 * MCP is the one universal axis across the surveyed CLIs (KD5); only the carrier
 * differs, so these emitters stay mechanical — transport (stdio/http) + secret
 * placement (see `secretDelivery.ts`), no per-CLI semantic special-casing.
 */
import { getHappyCliCommand } from "@/utils/spawnHappyCLI";

/** MCP transport the canonical server speaks. */
export type McpTransport = "stdio" | "http";

/**
 * A single MCP server in the harness-agnostic canonical form. `command`/`args`
 * carry the stdio invocation; `url`/`headers` carry the http endpoint; `env`
 * carries process-env values. Secret-bearing values (`env`, http `headers`)
 * ride each carrier's NATIVE secret channel — never argv (see `secretDelivery`).
 */
export interface CanonicalMcpServer {
  name: string;
  transport: McpTransport;
  /** stdio: the executable. */
  command?: string;
  /** stdio: argv — never carries a secret (`secretDelivery.assertNoSecretInArgv`). */
  args?: string[];
  /** http: the endpoint URL. */
  url?: string;
  /** Process-env values delivered to the server (secret-bearing). */
  env?: Record<string, string>;
  /** http: auth headers (secret-bearing; ride the carrier's native channel — OR4). */
  headers?: Record<string, string>;
}

/**
 * The projection input: the full canonical set plus the per-session enable set
 * (R3). A server whose `name` is NOT in `enabledSet` is filtered OUT of every
 * projected dialect on the next spawn.
 */
export interface McpProjectionInput {
  servers: CanonicalMcpServer[];
  /** Names enabled this session (the per-session MCP profile). */
  enabledSet: Set<string>;
}

/** Canonical name of the Hapimatic bridge MCP server (change_title/image_fetch). */
export const HAPI_MCP_SERVER_NAME = "happy";

/**
 * The hapi bridge as a canonical server (R4). A FACTORY, not a constant: the
 * endpoint port is OS-assigned per session (`server.listen(0)` in
 * `startHappyServer.ts`) and the bridge CLI path resolves per-process
 * (`getHappyCliCommand`), so the caller passes the LIVE `happyServer.url` at
 * projection time.
 *
 * NB: the ACP spawn path (`runAgentSession.ts`) already injects this server for
 * gemini/opencode. Projection must COMPOSE with that and never double-register
 * it — dedup by `name` (`HAPI_MCP_SERVER_NAME`).
 */
export function hapiMcpServer(url: string): CanonicalMcpServer {
  const { command, args } = getHappyCliCommand(["mcp", "--url", url]);
  return {
    name: HAPI_MCP_SERVER_NAME,
    transport: "stdio",
    command,
    args,
    env: {},
  };
}

/** Apply the per-session enable filter (R3) — drop any server not enabled. */
export function filterEnabled(input: McpProjectionInput): CanonicalMcpServer[] {
  return input.servers.filter(server => input.enabledSet.has(server.name));
}
