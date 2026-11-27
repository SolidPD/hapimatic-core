// SPDX-License-Identifier: AGPL-3.0-only
import { Hono, type Context } from "hono";
import { defineCapability } from "@hapi/protocol";

import { cataloged } from "../../capabilities/cataloged";
import {
  loadContextResetConfig,
  type ContextResetConfig,
} from "../../config/contextResetConfig";
import type { ContextResetService } from "../../contextReset/service";
import type { ErrorLogger } from "../../logging/errorLogger";
import type { WebAppEnv } from "../middleware/auth";
import { createRateLimiter } from "../middleware/rateLimit";
import {
  refuseAgentEscalation,
  type CallerSessionLookup,
} from "./agentEscalation";
import { logAndJson } from "./routeErrorHelper";

/**
 * Context-reset read and cancel routes (issue #6559, Task 11; R6, R8, R11, R15).
 *
 *   - `GET    /api/sessions/:id/context-reset` → the session's request (pending,
 *     or its last outcome) and whether it is pending. Never the delivery id
 *     (R8: a request's message id is server-minted and returned by no route).
 *   - `GET    /api/context-reset/config`       → the effective config, with
 *     `enabledSource` saying whether `HAPI_CONTEXT_RESET` is in force.
 *   - `DELETE /api/sessions/:id/context-reset` → the operator's cancel: an armed
 *     request ends `dropped:cancelled` and nothing is delivered; a firing one is
 *     refused `already_delivering` (ROUND RV10, Finding 1).
 *
 * There is no PUT and no arm route (ruling Q7a): the environment variable and
 * the settings file are the switch, and only the wrapper arms, over its own
 * socket. A session in another namespace, or none, answers 404 so its existence
 * does not leak.
 *
 * The DELETE takes `refuseAgentEscalation` as a header floor: a caller naming a
 * session that is not in a bypass permission mode is refused. Residual, stated
 * here and in docs/internal/architecture/context-reset.md: the floor lets through
 * a caller that omits the `X-Hapi-Session-Id` header (`agentEscalation.ts:205`),
 * so a process holding a token can still call it. The DELETE is never a promoted
 * capability (`PROMOTED_ENTRY_IDS`), so no agent is offered it as a typed tool.
 */

/**
 * The request without its delivery id. `getRequest` already omits it; the route
 * strips it again, because R8 says no route returns it, whatever a service does.
 */
function withoutDeliveryId(row: object | null): Record<string, unknown> | null {
  if (!row) return null;
  const copy: Record<string, unknown> = { ...row };
  delete copy.deliveryId;
  return copy;
}

export interface ContextResetRoutesOptions {
  /** settings.json lives here; the config route answers 503 without it. */
  dataDir?: string | null;
  errorLogger?: ErrorLogger | null;
  /** Test seam: load the config. */
  loadConfig?: (dataDir: string) => Promise<ContextResetConfig>;
}

export function createContextResetRoutes(
  getEngine: () => CallerSessionLookup | null,
  getService: () => ContextResetService | null,
  options: ContextResetRoutesOptions = {}
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  const errorLogger = options.errorLogger ?? null;
  const dataDir = options.dataDir ?? null;
  const loadConfig = options.loadConfig ?? loadContextResetConfig;
  // The cancel's own bucket, per namespace (env default 100/60s).
  const cancelLimiter = createRateLimiter({ name: "context-reset-cancel" });

  /** The session in the caller's namespace, or a 404 / 503 response. */
  function sessionInNamespace(c: Context<WebAppEnv>): string | Response {
    const engine = getEngine();
    if (!engine) return c.json({ error: "Not available" }, 503);
    const sessionId = c.req.param("id");
    const session = sessionId ? engine.getSession(sessionId) : undefined;
    if (!session || session.namespace !== c.get("namespace")) {
      return c.json({ error: "Session not found" }, 404);
    }
    return session.id;
  }

  function requireService(
    c: Context<WebAppEnv>
  ): ContextResetService | Response {
    const svc = getService();
    if (!svc)
      return c.json({ error: "Context reset service not available" }, 503);
    return svc;
  }

  app.get(
    "/sessions/:id/context-reset",
    cataloged(
      defineCapability({
        id: "session-introspection.context-reset-get",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Return a session's context-reset request: pending, or its last outcome.",
        whenToUse: "When checking a lane's pending context reset.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/sessions/:id/context-reset",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    c => {
      const sid = sessionInNamespace(c);
      if (sid instanceof Response) return sid;
      const svc = requireService(c);
      if (svc instanceof Response) return svc;
      try {
        return c.json(
          {
            request: withoutDeliveryId(svc.getRequest(sid)),
            pending: svc.isPending(sid),
          },
          200
        );
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "context-reset",
          fallbackMessage: "Failed to read the context-reset request",
        });
      }
    }
  );

  app.get(
    "/context-reset/config",
    cataloged(
      defineCapability({
        id: "session-introspection.context-reset-config-get",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Return the effective context-reset config and which source set the switch.",
        whenToUse: "When checking whether context reset is switched on.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/context-reset/config",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => {
      if (!dataDir) return c.json({ error: "Not available" }, 503);
      try {
        return c.json({ config: await loadConfig(dataDir) }, 200);
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "context-reset",
          fallbackMessage: "Failed to read the context-reset config",
        });
      }
    }
  );

  app.delete(
    "/sessions/:id/context-reset",
    cataloged(
      defineCapability({
        id: "session-lifecycle.context-reset-cancel",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Cancel a session's armed context reset; nothing is delivered. A reset already firing is refused (already_delivering).",
        whenToUse: "When the operator stops a pending context reset.",
        invocation: {
          kind: "rest",
          method: "DELETE",
          path: "/api/sessions/:id/context-reset",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    cancelLimiter,
    c => {
      const sid = sessionInNamespace(c);
      if (sid instanceof Response) return sid;
      const refused = refuseAgentEscalation(c, getEngine());
      if (refused) return refused;
      const svc = requireService(c);
      if (svc instanceof Response) return svc;
      try {
        // ROUND RV10, Finding 1: a refused cancel carries its reason beside the
        // boolean (`already_delivering` for a row that is already firing).
        const result = svc.cancel(sid);
        return c.json(
          {
            ok: true,
            cancelled: result.cancelled,
            ...(result.reason ? { reason: result.reason } : {}),
          },
          200
        );
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "context-reset",
          fallbackMessage: "Failed to cancel the context reset",
        });
      }
    }
  );

  return app;
}
