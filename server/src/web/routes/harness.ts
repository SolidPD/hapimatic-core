// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { defineCapability } from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";
import type { WebAppEnv } from "../middleware/auth";
import { createRateLimiter } from "../middleware/rateLimit";
import { logAndJson } from "./routeErrorHelper";
import type { ErrorLogger } from "../../logging/errorLogger";
import type { HarnessPollService } from "../../harness/harnessPollService";
import {
  MIN_HARNESS_POLL_INTERVAL_MS,
  MAX_HARNESS_POLL_INTERVAL_MS,
} from "../../config/harnessPollConfig";

/**
 * Harness self-update detection routes (issue #1770, epic #1769).
 *
 *   GET  /api/harness/status — the local node's harness detection state. Each
 *        descriptor is REDACTED (no `detect` / `install_flavors` command
 *        templates) and no `changelog_text` rides on the wire (R6). Read-only.
 *   POST /api/harness/check — rate-limited "check now": re-runs detection on
 *        demand (reusing the poll's `detectNow` core) and returns the refreshed
 *        status. Works even when the daily poll is disabled (R7).
 *
 * Mounted under `/api` AFTER the global JWT middleware in `server.ts` (R6/R7):
 * an unauthenticated request is rejected by that middleware before reaching
 * here — the mount position IS the auth mechanism (cf. the jobs route's
 * v1.0.644 pre-gate-mount security fix). The redaction lives in the service's
 * `getStatus()` (server-side, next to the registry), so this route cannot
 * construct an unredacted payload.
 */
/** The 503 both handlers return when the poll service getter yields null (should
 *  not happen — the service is always constructed at boot). */
const serviceUnavailable = (c: Context<WebAppEnv>) =>
  c.json(
    {
      ok: false,
      error: "harness poll service unavailable",
      code: "service_unavailable",
    },
    503
  );

/**
 * #1775: `PUT /harness/poll-config` body. `.strict()` rejects unknown keys; the
 * bounded integer `pollIntervalMs` REJECTS NaN, floats, numeric strings ("6h"),
 * and out-of-range values with 400 BEFORE any clamp runs — a bare object-check +
 * `Math.max` would persist `Math.max(MIN, NaN)` = NaN as `null` and return a
 * silently-wrong 200. Both fields optional so a `{ pollIntervalMs }`-only body
 * (the v1 UI's shape) is valid.
 */
const harnessPollConfigPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    pollIntervalMs: z
      .number()
      .int()
      .min(MIN_HARNESS_POLL_INTERVAL_MS)
      .max(MAX_HARNESS_POLL_INTERVAL_MS)
      .optional(),
  })
  .strict();

export function createHarnessRoutes(
  getHarnessPollService: () => HarnessPollService | null,
  opts: { errorLogger?: ErrorLogger | null } = {}
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  const errorLogger = opts.errorLogger ?? null;
  const checkLimiter = createRateLimiter({ name: "harness-check" });

  app.get(
    "/harness/status",
    cataloged(
      defineCapability({
        id: "harness-admin.status",
        domain: "harness-admin",
        surface: "rest",
        description: "Return the harness poll service status.",
        whenToUse: "When the operator inspects harness health.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/harness/status",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "operator" },
      })
    ),
    c => {
      const svc = getHarnessPollService();
      if (!svc) return serviceUnavailable(c);
      try {
        return c.json(svc.getStatus());
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "harness",
          fallbackMessage: "Failed to read harness status",
        });
      }
    }
  );

  app.post(
    "/harness/check",
    cataloged(
      defineCapability({
        id: "harness-admin.check",
        domain: "harness-admin",
        surface: "rest",
        description: "Trigger an on-demand harness update check.",
        whenToUse: "When the operator forces a harness update check.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/harness/check",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    checkLimiter,
    async c => {
      const svc = getHarnessPollService();
      if (!svc) return serviceUnavailable(c);
      try {
        // #1775 R4: surface whether the manual check coalesced onto an in-flight
        // detection, so the panel can say "a check is already running" instead of
        // implying a fresh result with an unchanged last-checked timestamp.
        const { coalesced } = await svc.detectNow();
        return c.json({ ...svc.getStatus(), coalesced });
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "harness",
          fallbackMessage: "Failed to run harness check",
        });
      }
    }
  );

  // #1775: read the current poll cadence (R5). Returns the live in-memory config,
  // which tracks the on-disk truth because updateConfig re-reads on every change.
  app.get(
    "/harness/poll-config",
    cataloged(
      defineCapability({
        id: "harness-admin.get-poll-config",
        domain: "harness-admin",
        surface: "rest",
        description: "Return the harness update-poll configuration.",
        whenToUse: "When the operator views the harness poll settings.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/harness/poll-config",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "operator" },
      })
    ),
    c => {
      const svc = getHarnessPollService();
      if (!svc) return serviceUnavailable(c);
      try {
        return c.json({ config: svc.getConfig() });
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "harness",
          fallbackMessage: "Failed to read harness poll config",
        });
      }
    }
  );

  // #1775: update the poll cadence (R2/R3). Validate → persist → apply live
  // (save-then-read-back). The change takes effect on the next poll cycle with NO
  // server restart (the service re-arms the loop). Under the same JWT gate as the
  // other harness routes — the mount position IS the auth mechanism (R6).
  app.put(
    "/harness/poll-config",
    cataloged(
      defineCapability({
        id: "harness-admin.set-poll-config",
        domain: "harness-admin",
        surface: "rest",
        description: "Update the harness update-poll configuration.",
        whenToUse: "When the operator changes the harness poll cadence.",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/api/harness/poll-config",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      const svc = getHarnessPollService();
      if (!svc) return serviceUnavailable(c);

      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "Invalid JSON body" }, 400);
      }
      const parsed = harnessPollConfigPatchSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { error: "Invalid poll config", details: parsed.error.issues },
          400
        );
      }

      try {
        const config = await svc.setPollConfig(parsed.data);
        return c.json({ config });
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "harness",
          fallbackMessage: "Failed to update harness poll config",
        });
      }
    }
  );

  return app;
}
