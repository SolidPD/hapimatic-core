// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { z } from "zod";
import { defineCapability } from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";

import type { WebAppEnv } from "../middleware/auth";
import type { ErrorLogger } from "../../logging/errorLogger";
import type { ContextWatermarkService } from "../../watermark/contextWatermarkService";
import { saveContextWatermarkConfig } from "../../config/contextWatermarkConfig";
import { createRateLimiter } from "../middleware/rateLimit";
import { logAndJson } from "./routeErrorHelper";

/**
 * Context-watermark status + manual-override API (issue #2158, epic rp1-home#1319;
 * admin surface + enable toggle #2587).
 *
 * Makes the successor-handoff automation OBSERVABLE (R5) rather than spooky:
 *   - `GET  /api/watermark`                    → `{ enabled, watermarkPercent, roles,
 *                                                states }` — the status block source
 *                                                (#2587 R1) plus per-session state
 *                                                (armed / deferred reason / handoff
 *                                                state / suppressed).
 *   - `PUT  /api/watermark/config`             → enable/disable toggle (#2587 R2):
 *                                                persists to settings.json AND reloads
 *                                                the running service so `isEnabled()`
 *                                                reflects it immediately (no restart —
 *                                                the #2486 divergence class).
 *   - `POST /api/watermark/:sessionId/disarm`  → manual override to `idle` that sets
 *                                                a PERSISTED suppression flag with
 *                                                hysteresis (no re-arm until context
 *                                                falls below the watermark) — without
 *                                                it the 30s poll re-arms a still-over
 *                                                session within one interval.
 *   - `POST /api/watermark/:sessionId/rearm`   → clear the suppression flag.
 *
 * Mounted under `/api` AFTER the JWT auth middleware in `server.ts`, so R6's 401
 * gating comes from the global middleware. The rate limiter is instantiated INSIDE
 * the factory so each call (including tests) gets a fresh bucket map. `dataDir` is
 * threaded in for the enable-toggle's settings.json persistence; when absent the
 * toggle route degrades to 503 (the read/disarm routes are unaffected).
 */

const SessionIdParamSchema = z.object({ sessionId: z.string().min(1) });
// #2587: the config write body. Both fields are optional (an operator may change
// the enable flag, the watermark percent, or both in one call) but at least one
// must be present. `watermarkPercent` is a percent-of-context in (0, 100].
const ConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    watermarkPercent: z.number().positive().max(100).optional(),
  })
  .refine(d => d.enabled !== undefined || d.watermarkPercent !== undefined, {
    message: "At least one of `enabled` or `watermarkPercent` is required",
  });

export function createWatermarkRoutes(
  getService: () => ContextWatermarkService | null,
  options?: { errorLogger?: ErrorLogger | null; dataDir?: string }
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  const errorLogger = options?.errorLogger ?? null;
  const dataDir = options?.dataDir ?? null;
  const limiter = createRateLimiter({ name: "watermark" }); // env default 100/60s

  function requireService(c: {
    json: (data: unknown, status?: number) => Response;
  }): ContextWatermarkService | Response {
    const svc = getService();
    if (!svc) {
      return c.json({ error: "Context watermark service not available" }, 503);
    }
    return svc;
  }

  // GET /watermark — observability (R5) + status block (#2587 R1). Read-only, so
  // no rate limiter. `watermarkPercent`/`roles` come from the running service's
  // config so the admin surface can show the effective settings, not just states.
  app.get(
    "/watermark",
    cataloged(
      defineCapability({
        id: "session-introspection.watermark-get",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Return the context-watermark state for the caller's sessions.",
        whenToUse: "When the UI shows context-usage watermarks.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/watermark",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    c => {
      const svc = requireService(c);
      if (svc instanceof Response) return svc;
      try {
        const cfg = svc.getConfig();
        return c.json(
          {
            enabled: svc.isEnabled(),
            watermarkPercent: cfg.watermarkPercent,
            roles: cfg.roles,
            states: svc.getStates(),
          },
          200
        );
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "context-watermark",
          fallbackMessage: "Failed to read watermark state",
        });
      }
    }
  );

  // PUT /watermark/config — enable toggle (#2587 R2) + user-editable watermark
  // percent (#2587 follow-up). Persists the given field(s) to settings.json
  // (server-authoritative, survives restart) AND reloads the running service so a
  // fresh GET reflects the change with no restart-to-converge gap (the #2486
  // divergence this feature warns about). Returns the effective config.
  app.put(
    "/watermark/config",
    cataloged(
      defineCapability({
        id: "session-introspection.watermark-set-config",
        domain: "session-introspection",
        surface: "rest",
        description: "Update the context-watermark configuration.",
        whenToUse: "When the user changes watermark thresholds.",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/api/watermark/config",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    limiter,
    async c => {
      const svc = requireService(c);
      if (svc instanceof Response) return svc;
      if (!dataDir) {
        return c.json(
          { error: "Watermark config persistence is not configured" },
          503
        );
      }
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "Invalid JSON body" }, 400);
      }
      const parsed = ConfigSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { error: "Invalid config", details: parsed.error.flatten() },
          400
        );
      }
      try {
        // Persist only the fields present in the request.
        const updates: { enabled?: boolean; watermarkPercent?: number } = {};
        if (parsed.data.enabled !== undefined)
          updates.enabled = parsed.data.enabled;
        if (parsed.data.watermarkPercent !== undefined) {
          updates.watermarkPercent = parsed.data.watermarkPercent;
        }
        // saveContextWatermarkConfig returns the ENV-AWARE reload, so the
        // HAPI_CONTEXT_WATERMARK_ENABLED kill-switch keeps winning at runtime:
        // apply `saved.*` (NOT the raw request) to the running service.
        const saved = await saveContextWatermarkConfig(dataDir, updates);
        if (parsed.data.enabled !== undefined) svc.setEnabled(saved.enabled);
        if (parsed.data.watermarkPercent !== undefined) {
          svc.setWatermarkPercent(saved.watermarkPercent);
        }
        return c.json(
          {
            enabled: saved.enabled,
            watermarkPercent: saved.watermarkPercent,
            roles: saved.roles,
            // Only meaningful when `enabled` was in the request — true iff the env
            // kill-switch forced a different effective value than requested.
            forcedByEnv:
              parsed.data.enabled !== undefined &&
              saved.enabled !== parsed.data.enabled,
          },
          200
        );
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "context-watermark",
          fallbackMessage: "Failed to update watermark config",
        });
      }
    }
  );

  // POST /watermark/:sessionId/disarm — manual override + persisted suppression.
  app.post(
    "/watermark/:sessionId/disarm",
    cataloged(
      defineCapability({
        id: "session-introspection.watermark-disarm",
        domain: "session-introspection",
        surface: "rest",
        description: "Disarm the context watermark for one session.",
        whenToUse: "When the user silences the watermark for a session.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/watermark/:sessionId/disarm",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    limiter,
    c => {
      const svc = requireService(c);
      if (svc instanceof Response) return svc;
      const parsed = SessionIdParamSchema.safeParse({
        sessionId: c.req.param("sessionId"),
      });
      if (!parsed.success) {
        return c.json(
          { error: "Invalid sessionId", details: parsed.error.flatten() },
          400
        );
      }
      try {
        const state = svc.disarm(parsed.data.sessionId);
        return c.json({ state }, 200);
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "context-watermark",
          fallbackMessage: "Failed to disarm session",
        });
      }
    }
  );

  // POST /watermark/:sessionId/rearm — clear the suppression flag.
  app.post(
    "/watermark/:sessionId/rearm",
    cataloged(
      defineCapability({
        id: "session-introspection.watermark-rearm",
        domain: "session-introspection",
        surface: "rest",
        description: "Re-arm the context watermark for one session.",
        whenToUse: "When the user re-enables the watermark for a session.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/watermark/:sessionId/rearm",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    limiter,
    c => {
      const svc = requireService(c);
      if (svc instanceof Response) return svc;
      const parsed = SessionIdParamSchema.safeParse({
        sessionId: c.req.param("sessionId"),
      });
      if (!parsed.success) {
        return c.json(
          { error: "Invalid sessionId", details: parsed.error.flatten() },
          400
        );
      }
      try {
        const state = svc.rearm(parsed.data.sessionId);
        return c.json({ state }, 200);
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "context-watermark",
          fallbackMessage: "Failed to rearm session",
        });
      }
    }
  );

  return app;
}
