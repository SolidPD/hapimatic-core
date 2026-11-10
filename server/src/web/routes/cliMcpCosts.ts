// SPDX-License-Identifier: AGPL-3.0-only
import type { Hono } from "hono";
import { defineCapability } from "@hapi/protocol";
import { McpCostsUpdateSchema } from "@hapi/protocol/schemas";
import type { Store } from "../../store";
import { cataloged } from "../../capabilities/cataloged";
import type { CliEnv } from "./cli";

/**
 * Issue #6171: `POST /cli/mcp-costs` — per-server MCP memory from the daemon's
 * sampler and context cost from a session's per-turn reply, stored for the New
 * Session picker. Names and numbers only (the schema is bounded); never argv,
 * environ or a URL. Registered on the CLI-token app by `createCliRoutes`.
 */
export function registerCliMcpCostsRoute(
  app: Hono<CliEnv>,
  store: Store | undefined
): void {
  app.post(
    "/mcp-costs",
    cataloged(
      defineCapability({
        id: "mcp.cli-update-costs",
        domain: "mcp",
        surface: "rest",
        description:
          "Record measured per-server MCP RAM and context cost for this node over the CLI-token surface.",
        whenToUse:
          "When a daemon samples MCP process memory or a session measures MCP context cost.",
        invocation: { kind: "rest", method: "POST", path: "/cli/mcp-costs" },
        auth: "cli-token",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const parsed = McpCostsUpdateSchema.safeParse(
        await c.req.json().catch(() => null)
      );
      if (!parsed.success) {
        return c.json({ error: "Invalid MCP cost data" }, 400);
      }
      if (!store) return c.json({ ok: false, error: "No store" }, 503);
      store.mcpServerStats.recordRam(parsed.data.ram ?? []);
      store.mcpServerStats.recordContext(parsed.data.context ?? []);
      return c.json({ ok: true });
    }
  );
}
