// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { defineCapability } from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";
import { createAuthMiddleware, type WebAppEnv } from "../middleware/auth";
import type { NodeRegistry } from "../../federation/nodeRegistry";
import type { ErrorLogger } from "../../logging/errorLogger";
import { createRateLimiter } from "../middleware/rateLimit";
import type { UpdateService } from "../../selfUpdate/updateService";
import type { UpdateErrorCode } from "../../selfUpdate/updateOrchestrator";

/**
 * Harness self-update apply routes (issue #1774, Sub E of epic #1769).
 *
 *   POST /api/harness/:harnessId/update    body { version, node_id? }
 *   POST /api/harness/:harnessId/rollback  body { node_id? }
 *
 * 🔴 These are PRIVILEGED, host-mutating routes, so each one authenticates
 * ITSELF (#3261): the factory applies `createAuthMiddleware` on the two exact
 * paths (`app.use(path, auth)`, ahead of the `cataloged()` tag — never
 * `use("*")`, see adminVms.ts), so an unauthenticated request gets 401 wherever
 * the factory is mounted. The mount AFTER the global JWT gate in
 * `buildWebApp.ts` (`app.use("/api/*", createAuthMiddleware(...))`), beside
 * `createHarnessRoutes`, stays as defense-in-depth — keep it there. Before
 * #3261 a pre-gate mount would have shipped these routes UNAUTHENTICATED with
 * zero type errors (cf. the v1.0.644 `GET /api/jobs` precedent); the
 * isolated-mount tests in the test file now prove the routes reject an
 * unauthenticated request regardless of the mount.
 *
 * The privileged command NEVER reaches the client (R11): the request carries
 * only `{ action, harnessId, version }` and the command is resolved server-side
 * from the code-defined registry. The response returns a code + a GENERIC
 * message — never the command, its args, or raw stderr (which lands in the audit
 * row + server log instead).
 *
 * Per-node dispatch mirrors `systemJobs` `isRemoteNode` (R10): v1 handles the
 * local node only; a remote `node_id` returns 501 `not_supported_remote` — the
 * documented seam for a later `proxyToNode` "update all nodes" step.
 */

const updateBodySchema = z
  .object({ version: z.string().min(1), node_id: z.string().optional() })
  .strict();

const rollbackBodySchema = z
  .object({ node_id: z.string().optional() })
  .strict();

/** Orchestrator error code → HTTP status. */
const STATUS_BY_CODE: Record<UpdateErrorCode, ContentfulStatusCode> = {
  update_in_flight: 409,
  version_mismatch: 409,
  no_prior_version: 409,
  unknown_harness: 404,
  invalid_version: 400,
  binary_not_found: 500,
  exec_failed: 500,
};

/** Generic, command-free client messages (R11 — never echo the command/stderr). */
const MESSAGE_BY_CODE: Record<UpdateErrorCode, string> = {
  update_in_flight:
    "An update or rollback is already in progress for this harness.",
  version_mismatch:
    "The requested version does not match the latest detected version.",
  no_prior_version: "No prior version is available to roll back to.",
  unknown_harness: "Unknown harness.",
  invalid_version: "The requested version is invalid.",
  binary_not_found: "The harness binary could not be located on this node.",
  exec_failed:
    "The update command failed. See the server audit log for details.",
};

export function createHarnessUpdateRoutes(opts: {
  /** Signs the JWTs these routes verify themselves (#3261). Required, not
   *  optional: an omitted secret must be a compile error, never a route that
   *  silently skips its own auth check. */
  jwtSecret: Uint8Array;
  getUpdateService: () => UpdateService | null;
  getLocalNodeId?: () => string | null;
  /** Accepted upfront for the KD-4 federation seam — v1 returns 501 for a
   *  remote node, so the registry is not yet consulted. */
  getNodeRegistry?: () => NodeRegistry | null;
  errorLogger?: ErrorLogger | null;
}): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  const errorLogger = opts.errorLogger ?? null;
  // A host-mutating slow subprocess warrants a low limit.
  const limiter = createRateLimiter({ name: "harness-update", limit: 5 });
  const auth = createAuthMiddleware(opts.jwtSecret, errorLogger);

  // True when federation is configured AND the request targets a remote node.
  const isRemoteNode = (nodeId: string): boolean => {
    const local = opts.getLocalNodeId?.() ?? null;
    return local !== null && nodeId !== local;
  };

  // Per-route auth (#3261), on the two EXACT paths — mirrors update.ts and
  // health.ts. The position is load-bearing: Hono runs handlers in registration
  // order, so these must stay ABOVE the app.post calls to run first, ahead of
  // the cataloged() tag and the per-namespace limiter. The literals must match
  // the app.post paths byte for byte (the capability invoker admits an
  // exact-path ALL entry only on an equal path, capabilityCall.ts
  // dispatchedMatch). NEVER `use("*")`: mounted at /api it becomes an /api/*
  // middleware on every later-mounted route (adminVms.ts); `use("/harness/*")`
  // would likewise catch the later /api/harness/* routes (harnessChangelog).
  app.use("/harness/:harnessId/update", auth);
  app.use("/harness/:harnessId/rollback", auth);

  app.post(
    "/harness/:harnessId/update",
    cataloged(
      defineCapability({
        id: "harness-admin.update-apply",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Apply a harness self-update to a specific harness (privileged, host-mutating).",
        whenToUse: "When the operator applies a harness version.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/harness/:harnessId/update",
        },
        auth: "jwt",
        riskTier: "destructive",
        availability: { scope: "operator" },
        probe: "skip",
      })
    ),
    limiter,
    async c => {
      const harnessId = c.req.param("harnessId");
      const parsed = updateBodySchema.safeParse(
        await c.req.json().catch(() => null)
      );
      if (!parsed.success) {
        return c.json(
          { ok: false, error: "Invalid body", code: "invalid_request" },
          400
        );
      }
      const { version, node_id } = parsed.data;

      if (node_id && isRemoteNode(node_id)) {
        return c.json(
          {
            ok: false,
            code: "not_supported_remote",
            error: "Remote-node harness update is not supported in v1.",
          },
          501
        );
      }

      const svc = opts.getUpdateService();
      if (!svc) {
        return c.json(
          {
            ok: false,
            code: "service_unavailable",
            error: "harness update service unavailable",
          },
          503
        );
      }

      const actor = c.get("namespace") ?? null;
      try {
        const result = await svc.runUpdate(
          svc.nodeId,
          harnessId,
          version,
          actor
        );
        if (result.ok) {
          return c.json({ ok: true, new_version: result.newVersion });
        }
        // R11: never echo the command/args/stderr — log the detail, return generic.
        errorLogger?.warn(
          `[harness-update] update ${harnessId} ${result.code}: ${result.detail ?? ""}`,
          { category: "harness-update" }
        );
        return c.json(
          { ok: false, code: result.code, error: MESSAGE_BY_CODE[result.code] },
          STATUS_BY_CODE[result.code]
        );
      } catch (error) {
        return logAndJson500(c, error, errorLogger, "Harness update failed");
      }
    }
  );

  app.post(
    "/harness/:harnessId/rollback",
    cataloged(
      defineCapability({
        id: "harness-admin.update-rollback",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Roll a harness back to its prior version (privileged, host-mutating).",
        whenToUse: "When the operator reverts a bad harness update.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/harness/:harnessId/rollback",
        },
        auth: "jwt",
        riskTier: "destructive",
        availability: { scope: "operator" },
        probe: "skip",
      })
    ),
    limiter,
    async c => {
      const harnessId = c.req.param("harnessId");
      const parsed = rollbackBodySchema.safeParse(
        await c.req.json().catch(() => null)
      );
      if (!parsed.success) {
        return c.json(
          { ok: false, error: "Invalid body", code: "invalid_request" },
          400
        );
      }
      const { node_id } = parsed.data;

      if (node_id && isRemoteNode(node_id)) {
        return c.json(
          {
            ok: false,
            code: "not_supported_remote",
            error: "Remote-node harness rollback is not supported in v1.",
          },
          501
        );
      }

      const svc = opts.getUpdateService();
      if (!svc) {
        return c.json(
          {
            ok: false,
            code: "service_unavailable",
            error: "harness update service unavailable",
          },
          503
        );
      }

      const actor = c.get("namespace") ?? null;
      try {
        const result = await svc.runRollback(svc.nodeId, harnessId, actor);
        if (result.ok) {
          return c.json({ ok: true, new_version: result.newVersion });
        }
        errorLogger?.warn(
          `[harness-update] rollback ${harnessId} ${result.code}: ${result.detail ?? ""}`,
          { category: "harness-update" }
        );
        return c.json(
          { ok: false, code: result.code, error: MESSAGE_BY_CODE[result.code] },
          STATUS_BY_CODE[result.code]
        );
      } catch (error) {
        return logAndJson500(c, error, errorLogger, "Harness rollback failed");
      }
    }
  );

  return app;
}

/** A 500 fallback that logs the raw error server-side and returns a generic body
 *  (never the command — R11). Mirrors `logAndJson` but with a fixed generic
 *  message so an internal throw cannot leak the command into the client body. */
function logAndJson500(
  c: import("hono").Context<WebAppEnv>,
  error: unknown,
  errorLogger: ErrorLogger | null,
  message: string
) {
  errorLogger?.error(
    `[harness-update] ${message}: ${error instanceof Error ? error.message : String(error)}`,
    { category: "harness-update" }
  );
  return c.json({ ok: false, code: "internal_error", error: message }, 500);
}
