// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { z } from "zod";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { defineCapability } from "@hapi/protocol";
import type { WebAppEnv } from "../../middleware/auth";
import { cataloged } from "../../../capabilities/cataloged";
import type {
  MutateResult,
  SystemJobsErrorCode,
  SystemJobsService,
} from "../../../systemJobs/service";
import {
  SYSTEM_JOB_VERBS,
  dispatchLoopCronMutate,
} from "../../../systemJobs/service";
import { checkFederationToken, type FederationDeps } from "./shared";

/**
 * Node-to-node system-jobs receivers (issue #1536, epic #1534 ruling D1).
 *
 *   POST /api/federation/system-jobs/list    — list THIS node's jobs + live state
 *   POST /api/federation/system-jobs/mutate  — apply ONE mutate verb on THIS node
 *
 * These are PEER-INCOMING endpoints. The #1537 hub client route
 * (`/api/nodes/:nodeId/system-jobs/*`) proxies here via `proxyToNode` (POST-only,
 * mirroring the active-account / recent-paths receivers). Gated by the federation
 * token only (R7) — every handler calls `checkFederationToken` first. The mutate
 * body's `verb` is a fixed enum of the six R2 verbs; `command` is NOT an accepted
 * field (R9) and the strict body schema REJECTS it. Each receiver resolves the
 * job against THIS node's own `SystemJobsService` (in-process reconciler), so no
 * privileged action crosses the boundary beyond the named verb + args.
 *
 * System-jobs are node-global (not per-namespace), so — like the active-account
 * receivers — these do NOT call `checkCallerNamespace`.
 */

/**
 * Map service error codes → HTTP status (mcp-toggle convention). Exported so the
 * #1537 web-client route (`web/routes/systemJobs.ts`) reuses the SAME mapping
 * instead of duplicating it.
 */
export const STATUS_BY_CODE: Record<SystemJobsErrorCode, ContentfulStatusCode> =
  {
    invalid_request: 400,
    validation_failed: 400,
    job_not_found: 404,
    name_conflict: 409,
    reconcile_failed: 500,
    unsupported: 503,
    unknown: 500,
  };

/** Args object — strict so an injected `command` (or any extra key) is REJECTED (R9). */
const mutateArgsSchema = z
  .object({
    schedule: z.string().optional(),
    newName: z.string().optional(),
    description: z.string().optional(),
  })
  .strict();

const mutateBodySchema = z
  .object({
    verb: z.enum(SYSTEM_JOB_VERBS),
    name: z.string(),
    args: mutateArgsSchema.optional(),
  })
  .strict();

type MutateBody = z.infer<typeof mutateBodySchema>;

/**
 * Dispatch a validated mutate body to the matching service verb. Exported so the
 * #1537 web-client route (`web/routes/systemJobs.ts`) drives the LOCAL node's
 * in-process service through the SAME verb→method mapping the receiver uses for
 * peer-incoming mutations — no duplicated dispatch.
 */
export function dispatchMutate(
  service: SystemJobsService,
  body: MutateBody
): MutateResult {
  switch (body.verb) {
    case "enable":
      return service.enable(body.name);
    case "disable":
      return service.disable(body.name);
    case "delete":
      return service.remove(body.name);
    case "reschedule":
      if (body.args?.schedule === undefined) {
        return invalidArgs("reschedule requires args.schedule");
      }
      return service.reschedule(body.name, body.args.schedule);
    case "rename":
      if (body.args?.newName === undefined) {
        return invalidArgs("rename requires args.newName");
      }
      return service.rename(body.name, body.args.newName);
    case "edit-description":
      if (body.args?.description === undefined) {
        return invalidArgs("edit-description requires args.description");
      }
      return service.editDescription(body.name, body.args.description);
  }
}

function invalidArgs(error: string): MutateResult {
  return { ok: false, code: "invalid_request", error };
}

/**
 * Loop-cron mutation body (issue #2453, Task 6). A DEDICATED receiver — NOT a new
 * `SYSTEM_JOB_VERBS` member — because loop-cron ids are not systemd unit names and
 * `run` returns a verdict. Strict: rejects any extra key.
 */
const loopCronBodySchema = z
  .object({
    action: z.enum([
      "pause",
      "resume",
      "run",
      "delete",
      "reschedule",
      "edit-action",
    ]),
    id: z.string(),
    interval: z.string().optional(),
    // #3293 (D6(a) — full remote parity): allow the `edit-action` text through
    // the strict body so a hub can edit a loop's action on THIS node. The
    // empty-check lives in dispatchLoopCronMutate, so the schema stays as
    // permissive as `interval` (both are verb-conditional).
    actionText: z.string().optional(),
  })
  .strict();

export function createSystemJobsReceiverRoutes(
  deps: FederationDeps
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  // ─── POST /federation/system-jobs/list (READ) ──
  app.post(
    "/federation/system-jobs/list",
    cataloged(
      defineCapability({
        id: "harness-admin.federation-system-jobs-list",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Return this node's system jobs and their live reconciler state (POST because the node proxy only issues POST).",
        whenToUse:
          "When the hub reads a specific peer node's system-job list and status.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/system-jobs/list",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ ok: false, error: "Unauthorized" }, 401);
      }
      const service = deps.getSystemJobsService?.() ?? null;
      if (!service) {
        return c.json(
          {
            ok: false,
            error: "system-jobs service unavailable",
            code: "unsupported",
          },
          503
        );
      }
      const result = service.listJobs();
      return c.json(result, result.ok ? 200 : STATUS_BY_CODE[result.code]);
    }
  );

  // ─── POST /federation/system-jobs/mutate (MUTATE) ──
  app.post(
    "/federation/system-jobs/mutate",
    cataloged(
      defineCapability({
        id: "harness-admin.federation-system-jobs-mutate",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Apply one system-job verb (enable, disable, delete, reschedule, rename, edit-description) to a named job on this node; delete is irreversible.",
        whenToUse:
          "When the hub changes a system job on a specific peer node, including removing it.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/system-jobs/mutate",
        },
        auth: "federation-token",
        riskTier: "destructive",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ ok: false, error: "Unauthorized" }, 401);
      }
      const service = deps.getSystemJobsService?.() ?? null;
      if (!service) {
        return c.json(
          {
            ok: false,
            error: "system-jobs service unavailable",
            code: "unsupported",
          },
          503
        );
      }
      const body = await c.req.json().catch(() => null);
      const parsed = mutateBodySchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { ok: false, error: "Invalid body", code: "invalid_request" },
          400
        );
      }
      const result = dispatchMutate(service, parsed.data);
      return c.json(result, result.ok ? 200 : STATUS_BY_CODE[result.code]);
    }
  );

  // ─── POST /federation/system-jobs/loop-cron/mutate (#2453 Task 6) ──
  // Peer-incoming loop-cron mutation: a hub drives THIS node's loops (pause /
  // resume / run / delete / reschedule). There is deliberately NO summary
  // receiver — the header badge is own-instance-only by definition (R8), so a
  // cross-node summary has no consumer. Responds HTTP 200 even for a
  // service-level `ok:false`, so the structured code + status survive the
  // `proxyToNode` boundary (which only JSON-parses 2xx bodies); the hub route
  // re-derives the client status from the inner result.
  app.post(
    "/federation/system-jobs/loop-cron/mutate",
    cataloged(
      defineCapability({
        id: "harness-admin.federation-system-jobs-loop-cron-mutate",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Drive one loop-cron action (pause, resume, run, delete, reschedule, edit-action) on this node; delete is irreversible.",
        whenToUse:
          "When the hub controls a per-session loop-cron on a specific peer node, including removing it.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/system-jobs/loop-cron/mutate",
        },
        auth: "federation-token",
        riskTier: "destructive",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ ok: false, error: "Unauthorized" }, 401);
      }
      const service = deps.getSystemJobsService?.() ?? null;
      if (!service) {
        return c.json(
          {
            ok: false,
            error: "system-jobs service unavailable",
            code: "unsupported",
            status: 500,
          },
          503
        );
      }
      const parsed = loopCronBodySchema.safeParse(
        await c.req.json().catch(() => null)
      );
      if (!parsed.success) {
        return c.json(
          {
            ok: false,
            error: "Invalid body",
            code: "invalid_request",
            status: 400,
          },
          400
        );
      }
      const result = await dispatchLoopCronMutate(service, parsed.data);
      // 200 always — the inner `ok` + `status` carry the outcome across federation.
      return c.json(result, 200);
    }
  );

  return app;
}
