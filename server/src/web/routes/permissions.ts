// SPDX-License-Identifier: AGPL-3.0-only
import {
  isPermissionModeAllowedForFlavor,
  defineCapability,
} from "@hapi/protocol";
import { PermissionModeSchema } from "@hapi/protocol/schemas";
import { Hono } from "hono";
import { z } from "zod";
import type { SyncEngine } from "../../sync/syncEngine";
import type { WebAppEnv } from "../middleware/auth";
import { requireSessionFromParam, requireSyncEngine } from "./guards";
import { cataloged } from "../../capabilities/cataloged";
import type { NodeRegistry } from "../../federation/nodeRegistry";
import type { ErrorLogger } from "../../logging/errorLogger";
import { proxyTransportFailure } from "./routeErrorHelper";

const decisionSchema = z.enum([
  "approved",
  "approved_for_session",
  "denied",
  "abort",
]);

const approveBodySchema = z.object({
  mode: PermissionModeSchema.optional(),
  allowTools: z.array(z.string()).optional(),
  decision: decisionSchema.optional(),
  answers: z.record(z.string(), z.array(z.string())).optional(),
});

const denyBodySchema = z.object({
  decision: decisionSchema.optional(),
});

export function createPermissionsRoutes(
  getSyncEngine: () => SyncEngine | null,
  options?: {
    getNodeRegistry?: () => NodeRegistry | null;
    federationApiToken?: string | null;
    /** Logs federation proxy transport failures (#5404). */
    errorLogger?: ErrorLogger | null;
  }
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  app.post(
    "/sessions/:id/permissions/:requestId/approve",
    cataloged(
      defineCapability({
        id: "model-permission.approve-permission",
        domain: "model-permission",
        surface: "rest",
        description:
          "Approve a session's pending tool-permission request, optionally setting the permission mode, allowed tools, or prompt answers.",
        whenToUse:
          "When the user approves a tool-permission prompt raised by a session.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/sessions/:id/permissions/:requestId/approve",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) {
        return engine;
      }

      const requestId = c.req.param("requestId");

      const json = await c.req.json().catch(() => null);
      const parsed = approveBodySchema.safeParse(json ?? {});
      if (!parsed.success) {
        return c.json({ error: "Invalid body" }, 400);
      }

      const sessionResult = requireSessionFromParam(c, engine, {
        requireActive: true,
      });
      if (!(sessionResult instanceof Response)) {
        const { sessionId, session } = sessionResult;

        const requests = session.agentState?.requests ?? null;
        if (!requests || !requests[requestId]) {
          return c.json({ error: "Request not found" }, 404);
        }

        const mode = parsed.data.mode;
        if (mode !== undefined) {
          const flavor = session.metadata?.flavor ?? "claude";
          if (!isPermissionModeAllowedForFlavor(mode, flavor)) {
            return c.json(
              { error: "Invalid permission mode for session flavor" },
              400
            );
          }
        }
        const allowTools = parsed.data.allowTools;
        const decision = parsed.data.decision;
        const answers = parsed.data.answers;
        await engine.approvePermission(
          sessionId,
          requestId,
          mode,
          allowTools,
          decision,
          answers
        );
        return c.json({ ok: true });
      }

      // Federation fallback: proxy approve to the remote node
      const registry = options?.getNodeRegistry?.();
      if (registry) {
        const sessionId = c.req.param("id");
        const node = registry.findNodeForSession(sessionId);
        if (node) {
          const headers: Record<string, string> = {
            "Content-Type": "application/json",
            // #5411: the peer re-asserts the caller's namespace (#1097).
            "X-Hapi-Caller-Namespace": c.get("namespace"),
          };
          if (options?.federationApiToken) {
            headers["Authorization"] = `Bearer ${options.federationApiToken}`;
          }
          // #5375/#5404: a transport failure is logged and answers 502; any
          // other error is rethrown so app.onError logs it as a 500.
          let resp: Response;
          try {
            resp = await fetch(
              `${node.url}/api/federation/sessions/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(requestId)}/approve`,
              { method: "POST", headers, body: JSON.stringify(parsed.data) }
            );
          } catch (error) {
            return proxyTransportFailure(c, error, {
              errorLogger: options?.errorLogger,
              nodeId: node.nodeId,
            });
          }
          if (resp.ok) {
            return c.json({ ok: true });
          }
          const body = await resp.json().catch(() => ({}));
          return c.json(
            body as Record<string, unknown>,
            resp.status as 400 | 404 | 409 | 500 | 503
          );
        }
      }

      return sessionResult;
    }
  );

  app.post(
    "/sessions/:id/permissions/:requestId/deny",
    cataloged(
      defineCapability({
        id: "model-permission.deny-permission",
        domain: "model-permission",
        surface: "rest",
        description:
          "Deny or abort a session's pending tool-permission request.",
        whenToUse:
          "When the user denies a tool-permission prompt raised by a session.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/sessions/:id/permissions/:requestId/deny",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) {
        return engine;
      }

      const requestId = c.req.param("requestId");

      const json = await c.req.json().catch(() => null);
      const parsed = denyBodySchema.safeParse(json ?? {});
      if (!parsed.success) {
        return c.json({ error: "Invalid body" }, 400);
      }

      const sessionResult = requireSessionFromParam(c, engine, {
        requireActive: true,
      });
      if (!(sessionResult instanceof Response)) {
        const { sessionId, session } = sessionResult;

        const requests = session.agentState?.requests ?? null;
        if (!requests || !requests[requestId]) {
          return c.json({ error: "Request not found" }, 404);
        }

        await engine.denyPermission(sessionId, requestId, parsed.data.decision);
        return c.json({ ok: true });
      }

      // Federation fallback: proxy deny to the remote node
      const registry = options?.getNodeRegistry?.();
      if (registry) {
        const sessionId = c.req.param("id");
        const node = registry.findNodeForSession(sessionId);
        if (node) {
          const headers: Record<string, string> = {
            "Content-Type": "application/json",
            // #5411: the peer re-asserts the caller's namespace (#1097).
            "X-Hapi-Caller-Namespace": c.get("namespace"),
          };
          if (options?.federationApiToken) {
            headers["Authorization"] = `Bearer ${options.federationApiToken}`;
          }
          // #5375/#5404: a transport failure is logged and answers 502; any
          // other error is rethrown so app.onError logs it as a 500.
          let resp: Response;
          try {
            resp = await fetch(
              `${node.url}/api/federation/sessions/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(requestId)}/deny`,
              { method: "POST", headers, body: JSON.stringify(parsed.data) }
            );
          } catch (error) {
            return proxyTransportFailure(c, error, {
              errorLogger: options?.errorLogger,
              nodeId: node.nodeId,
            });
          }
          if (resp.ok) {
            return c.json({ ok: true });
          }
          const body = await resp.json().catch(() => ({}));
          return c.json(
            body as Record<string, unknown>,
            resp.status as 400 | 404 | 409 | 500 | 503
          );
        }
      }

      return sessionResult;
    }
  );

  return app;
}
