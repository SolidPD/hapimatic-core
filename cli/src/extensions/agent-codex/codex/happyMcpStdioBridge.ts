// SPDX-License-Identifier: MIT
/**
 * HAPI MCP STDIO Bridge
 *
 * Minimal STDIO MCP server exposing a single tool `change_title`.
 * On invocation it forwards the tool call to an existing HAPI HTTP MCP server
 * using the StreamableHTTPClientTransport.
 *
 * Configure the target HTTP MCP URL via env var `HAPI_HTTP_MCP_URL` or
 * via CLI flag `--url <http://127.0.0.1:PORT>`.
 *
 * Note: This process must not print to stdout as it would break MCP STDIO.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { capabilityCatalogIndex, isTier0Eligible } from "@hapi/protocol";

function parseArgs(argv: string[]): { url: string | null } {
  let url: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url" && i + 1 < argv.length) {
      url = argv[i + 1];
      i++;
    }
  }
  return { url };
}

/**
 * The MCP tools the Codex/Gemini/opencode STDIO bridge exposes — the surface
 * those non-Claude harnesses see (issue #3748, Sub H, R5).
 *
 * Post-H the bridge is a TRANSPARENT PROXY (it forwards `tools/list` +
 * `tools/call` to the HTTP MCP server), so its ACTUAL runtime exposure is
 * whatever `startHappyServer` registers — all five hapi tools, with their real
 * schemas, not just `change_title`. This DECLARED list (the reported surface in
 * `commands/capabilities.ts`) is GENERATED from the SAME source Tier-0 renders
 * from — the catalog's Tier-0-eligible `mcp` entries — so Tier-0's tool list ⊆
 * this exposure BY CONSTRUCTION (V6). Before H the bridge hardcoded one tool, so
 * Tier-0 would have named `register_service_key` (and later tools) on three of
 * four harnesses where they did not exist.
 */
export const HAPI_STDIO_BRIDGE_TOOL_NAMES: readonly string[] =
  capabilityCatalogIndex
    .filter(isTier0Eligible)
    .filter(e => e.invocation.kind === "mcp")
    .map(e => (e.invocation as { tool: string }).tool);

export async function runHappyMcpStdioBridge(argv: string[]): Promise<void> {
  try {
    // Resolve target HTTP MCP URL
    const { url: urlFromArgs } = parseArgs(argv);
    const baseUrl = urlFromArgs || process.env.HAPI_HTTP_MCP_URL || "";

    if (!baseUrl) {
      // Write to stderr; never stdout.
      process.stderr.write(
        "[hapi-mcp] Missing target URL. Set HAPI_HTTP_MCP_URL or pass --url <http://127.0.0.1:PORT>\n"
      );
      process.exit(2);
    }

    let httpClient: Client | null = null;

    async function ensureHttpClient(): Promise<Client> {
      if (httpClient) return httpClient;
      // The proxy connects at the FIRST tools/list (harness startup), earlier
      // than the pre-H bridge's connect-on-first-call. The HTTP MCP server is
      // started before the harness spawns the bridge, but retry briefly to
      // absorb any startup race (issue #3748, R5).
      let lastErr: unknown;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const client = new Client(
            { name: "hapi-stdio-bridge", version: "1.0.0" },
            { capabilities: {} }
          );
          const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
          await client.connect(transport);
          httpClient = client;
          return client;
        } catch (err) {
          lastErr = err;
          await new Promise(resolve =>
            setTimeout(resolve, 100 * (attempt + 1))
          );
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    }

    // Create the STDIO MCP server as a TRANSPARENT PROXY (issue #3748, R5): it
    // forwards tools/list and tools/call to the HTTP MCP server, so every tool
    // startHappyServer registers reaches Codex/Gemini/opencode with its real
    // schema — not just change_title. Low-level `Server` (not `McpServer`)
    // because McpServer derives tools/list from statically-registered tools,
    // which is exactly the hardcoded floor this replaces.
    const server = new Server(
      { name: "HAPI MCP Bridge", version: "1.0.0" },
      { capabilities: { tools: {} } }
    );

    // tools/list → forward the HTTP server's tool list verbatim (names + schemas).
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const client = await ensureHttpClient();
      return await client.listTools();
    });

    // tools/call → forward the call by name to the HTTP server.
    server.setRequestHandler(CallToolRequestSchema, async request => {
      try {
        const client = await ensureHttpClient();
        const response = await client.callTool({
          name: request.params.name,
          arguments: request.params.arguments ?? {},
        });
        return response as CallToolResult;
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to call ${request.params.name}: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    });

    // Start STDIO transport
    const stdio = new StdioServerTransport();
    await server.connect(stdio);
  } catch (err) {
    try {
      process.stderr.write(
        `[hapi-mcp] Fatal: ${err instanceof Error ? err.message : String(err)}\n`
      );
    } finally {
      process.exit(1);
    }
  }
}
