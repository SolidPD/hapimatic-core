// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Stall Watchdog API Routes
 *
 * GET  /watchdog/status  — Current watchdog state and recent stall events
 * POST /watchdog/check   — Trigger an immediate one-shot poll
 * GET  /watchdog/config  — Read current configuration
 * PUT  /watchdog/config  — Update configuration
 */

import { Hono } from "hono";
import { defineCapability } from "@hapi/protocol";
import type { WebAppEnv } from "../../web/middleware/auth";
import type { StallWatchdogService } from "./stallWatchdogService";
import { cataloged } from "../../capabilities/cataloged";
import { saveStallWatchdogConfig, loadStallWatchdogConfig } from "./config";
import { configuration } from "../../configuration";

export function createWatchdogRoutes(
  getWatchdogService: () => StallWatchdogService | null
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  function requireService(c: {
    json: (data: unknown, status?: number) => Response;
  }): StallWatchdogService | Response {
    const service = getWatchdogService();
    if (!service)
      return c.json({ error: "Stall watchdog service not available" }, 503);
    return service;
  }

  // GET /watchdog/status
  app.get(
    "/watchdog/status",
    cataloged(
      defineCapability({
        id: "harness-admin.watchdog-status",
        domain: "harness-admin",
        surface: "rest",
        description: "Return the watchdog extension's status.",
        whenToUse: "When the UI shows watchdog health.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/watchdog/status",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    c => {
      const service = requireService(c);
      if (service instanceof Response) return service;
      return c.json(service.getStatus());
    }
  );

  // POST /watchdog/check
  app.post(
    "/watchdog/check",
    cataloged(
      defineCapability({
        id: "harness-admin.watchdog-check",
        domain: "harness-admin",
        surface: "rest",
        description: "Run an on-demand watchdog check.",
        whenToUse: "When the user forces a watchdog check.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/watchdog/check",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const service = requireService(c);
      if (service instanceof Response) return service;

      const events = await service.checkNow();
      return c.json({ events });
    }
  );

  // GET /watchdog/config
  app.get(
    "/watchdog/config",
    cataloged(
      defineCapability({
        id: "harness-admin.watchdog-get-config",
        domain: "harness-admin",
        surface: "rest",
        description: "Return the watchdog configuration.",
        whenToUse: "When the UI loads watchdog settings.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/watchdog/config",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const config = await loadStallWatchdogConfig(configuration.dataDir);
      return c.json({ config });
    }
  );

  // PUT /watchdog/config
  app.put(
    "/watchdog/config",
    cataloged(
      defineCapability({
        id: "harness-admin.watchdog-set-config",
        domain: "harness-admin",
        surface: "rest",
        description: "Update the watchdog configuration.",
        whenToUse: "When the user changes watchdog settings.",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/api/watchdog/config",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const service = requireService(c);
      if (service instanceof Response) return service;

      const body = await c.req.json();
      if (!body || typeof body !== "object") {
        return c.json({ error: "Invalid request body" }, 400);
      }

      await saveStallWatchdogConfig(configuration.dataDir, body);
      await service.updateConfig(body);

      const config = await loadStallWatchdogConfig(configuration.dataDir);
      return c.json({ config });
    }
  );

  return app;
}
