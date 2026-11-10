// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { z } from "zod";
import {
  defineCapability,
  MCP_SET_CAPABILITY,
  McpSetSchema,
} from "@hapi/protocol";
import type { McpCatalogResponse } from "@hapi/protocol/schemas";
import type { WebAppEnv } from "../middleware/auth";
import type { SyncEngine } from "../../sync/syncEngine";
import type { NodeRegistry } from "../../federation/nodeRegistry";
import { cataloged } from "../../capabilities/cataloged";
import { createRateLimiter } from "../middleware/rateLimit";
import { expandTilde, isTildePath } from "../../utils/expandTilde";
import { isSafeMachinePath } from "../../utils/pathSecurity";

type McpCatalogRouteResponse =
  | { success: true; catalog: McpCatalogResponse }
  | { success: false; error: string; code?: string };

const projectDefaultBodySchema = z.object({
  directory: z.string().min(1),
  nodeId: z.string().min(1).optional(),
  /** null clears the project's default. */
  set: McpSetSchema.nullable(),
});

function usableDirectory(dir: string): boolean {
  return dir.startsWith("/") || isTildePath(dir);
}

/** The peer's refusal text when it runs a binary older than this feature. */
const NODE_UNSUPPORTED =
  "This node's Hapimatic version cannot choose MCP servers yet. Update it first.";

/**
 * The New Session picker's data (issue #6171): `GET /api/mcp-catalog` and
 * `PUT /api/mcp-project-default`, for this node or, with `nodeId`, a peer. A project's
 * MCP config lives on one node, so a hub proxies rather than answering from its own
 * list. Lookup failures answer 200 `{success:false}` so the form shows "unavailable"
 * (the shape of `/api/git/branches`, #4481).
 */
export function createMcpCatalogRoutes(options: {
  getSyncEngine: () => SyncEngine | null;
  getNodeRegistry?: () => NodeRegistry | null;
}): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  const defaultLimiter = createRateLimiter({ name: "mcp-project-default" });

  app.get(
    "/mcp-catalog",
    cataloged(
      defineCapability({
        id: "mcp.catalog",
        domain: "mcp",
        surface: "rest",
        description:
          "List the MCP servers known for a project on a node, with each server's project state, RAM and context cost, and the project's default set.",
        whenToUse:
          "When the New Session form or the session configuration modal lists MCP servers.",
        invocation: { kind: "rest", method: "GET", path: "/api/mcp-catalog" },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const dir = c.req.query("directory")?.trim() ?? "";
      if (dir && !usableDirectory(dir)) {
        return c.json(
          {
            success: false,
            error: "Invalid directory path",
          } satisfies McpCatalogRouteResponse,
          400
        );
      }

      const nodeId = c.req.query("nodeId");
      if (nodeId) {
        const registry = options.getNodeRegistry?.();
        if (!registry) {
          return c.json({
            success: false,
            error: "Federation not available",
          } satisfies McpCatalogRouteResponse);
        }
        if (!registry.nodeSupports(nodeId, MCP_SET_CAPABILITY)) {
          return c.json({
            success: false,
            error: NODE_UNSUPPORTED,
            code: "mcp_set_node_unsupported",
          } satisfies McpCatalogRouteResponse);
        }
        const result = await registry.getMcpCatalogOnNode(nodeId, dir);
        return c.json(
          result.type === "error"
            ? ({
                success: false,
                error: result.message,
              } satisfies McpCatalogRouteResponse)
            : ({
                success: true,
                catalog: result.catalog,
              } satisfies McpCatalogRouteResponse)
        );
      }

      if (dir && !isSafeMachinePath(expandTilde(dir))) {
        return c.json(
          {
            success: false,
            error: "Access denied",
          } satisfies McpCatalogRouteResponse,
          403
        );
      }
      const engine = options.getSyncEngine();
      if (!engine) {
        return c.json(
          {
            success: false,
            error: "Not connected",
          } satisfies McpCatalogRouteResponse,
          503
        );
      }
      return c.json({
        success: true,
        catalog: engine.getMcpCatalog().getCatalog(dir || undefined),
      } satisfies McpCatalogRouteResponse);
    }
  );

  app.put(
    "/mcp-project-default",
    cataloged(
      defineCapability({
        id: "mcp.project-default",
        domain: "mcp",
        surface: "rest",
        description:
          "Store or clear a project's default MCP set on a node. The default pre-fills the New Session form and applies to spawns that name no set.",
        whenToUse: "When the user saves or clears a project's default MCP set.",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/api/mcp-project-default",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
        // probe: writes a project's default (#5212)
        probe: "skip",
      })
    ),
    defaultLimiter,
    async c => {
      const parsed = projectDefaultBodySchema.safeParse(
        await c.req.json().catch(() => null)
      );
      if (!parsed.success || !usableDirectory(parsed.data.directory)) {
        return c.json({ ok: false, error: "Invalid body" }, 400);
      }
      const { directory, nodeId, set } = parsed.data;

      if (nodeId) {
        const registry = options.getNodeRegistry?.();
        if (!registry) {
          return c.json({ ok: false, error: "Federation not available" }, 503);
        }
        if (!registry.nodeSupports(nodeId, MCP_SET_CAPABILITY)) {
          return c.json(
            {
              ok: false,
              error: NODE_UNSUPPORTED,
              code: "mcp_set_node_unsupported",
            },
            409
          );
        }
        const result = await registry.setMcpProjectDefaultOnNode(nodeId, {
          directory,
          set,
        });
        return result.type === "error"
          ? c.json({ ok: false, error: result.message }, 502)
          : c.json({ ok: true });
      }

      if (!isSafeMachinePath(expandTilde(directory))) {
        return c.json({ ok: false, error: "Access denied" }, 403);
      }
      const engine = options.getSyncEngine();
      if (!engine) return c.json({ ok: false, error: "Not connected" }, 503);
      engine.getMcpCatalog().setProjectDefault(directory, set);
      return c.json({ ok: true });
    }
  );

  return app;
}
