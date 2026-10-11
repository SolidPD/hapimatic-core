// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { LOCAL_NODE_ID, defineCapability } from "@hapi/protocol";
import type { CatalogEntry } from "@hapi/protocol";
import type { WebAppEnv } from "../middleware/auth";
import { cataloged } from "../../capabilities/cataloged";
import type { NodeRegistry } from "../../federation/nodeRegistry";
import type {
  ListJobsResult,
  MutateResult,
  SystemJobMutateBody,
  SystemJobsService,
  SystemJobView,
  LoopCronMutateBody,
} from "../../systemJobs/service";
import { dispatchLoopCronMutate } from "../../systemJobs/service";
import { STATUS_BY_CODE, dispatchMutate } from "./federation/systemJobs";
import { createRateLimiter } from "../middleware/rateLimit";

/**
 * Hub web-client system-jobs routes (issue #1537, Sub-Issue C of epic #1534).
 *
 *   GET    /api/nodes/:nodeId/system-jobs              — one node's jobs + live state
 *   POST   /api/nodes/:nodeId/system-jobs/:name/enable
 *   POST   /api/nodes/:nodeId/system-jobs/:name/disable
 *   DELETE /api/nodes/:nodeId/system-jobs/:name
 *   POST   /api/nodes/:nodeId/system-jobs/:name/reschedule    — body { schedule }
 *   POST   /api/nodes/:nodeId/system-jobs/:name/rename        — body { newName }
 *   POST   /api/nodes/:nodeId/system-jobs/:name/description   — body { description }
 *   GET    /api/system-jobs/all                        — cross-node aggregate
 *
 * These are the JWT-gated, web-client-facing routes (epic ruling D1). They mirror
 * `routes/nodes.ts`'s active-account dispatch: when `:nodeId` is the LOCAL node,
 * the in-process #1536 `SystemJobsService` is called directly; when it is a
 * REMOTE node, the request is proxied via `NodeRegistry.{list,mutate}SystemJobOnNode`
 * → `proxyToNode` → the node's peer-incoming `/api/federation/system-jobs/*`
 * receiver (#1536). NO bespoke cross-node transport (R4).
 *
 * Mounted under `/api` AFTER the JWT auth middleware in `server.ts` (R5). The verb
 * set + the error-code→status map come from the SAME single sources the receiver
 * uses (`SYSTEM_JOB_VERBS`, `STATUS_BY_CODE`, `dispatchMutate`) so the local and
 * remote paths cannot drift apart.
 */

const rescheduleSchema = z.object({ schedule: z.string() }).strict();
const renameSchema = z.object({ newName: z.string() }).strict();
const descriptionSchema = z.object({ description: z.string() }).strict();

/** A name longer than this can never be a real unit name; reject at the edge. */
const MAX_JOB_NAME_LEN = 128;

export function createSystemJobsRoutes(opts: {
  getSystemJobsService: () => SystemJobsService | null;
  getLocalNodeId?: () => string | null;
  getNodeRegistry?: () => NodeRegistry | null;
}): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  // Issue #1539 (Sub-Issue E hardening): rate-limit the user-facing MUTATION
  // routes (enable/disable/delete/reschedule/rename/description) for parity
  // with the mcp-toggle convention (sessions.ts) — defense-in-depth against an
  // authenticated client spamming systemctl daemon-reload churn. The READ
  // routes (GET .../system-jobs and GET /system-jobs/all) are intentionally
  // NOT limited. The federation receiver (federation/systemJobs.ts) is
  // deliberately NOT double-limited: it is reached only via the hub's proxy of
  // an already-limited client request and is federation-token-gated.
  const mutateLimiter = createRateLimiter({ name: "system-jobs-mutate" });

  // True when federation is configured AND the request targets a remote node.
  // Non-federated instances (localNodeId === null) treat every request as local.
  const isRemoteNode = (nodeId: string): boolean => {
    const localNodeId = opts.getLocalNodeId?.() ?? null;
    return localNodeId !== null && nodeId !== localNodeId;
  };

  /** True when the request should be served by THIS node (local or the sentinel).
   *  Epic #3285 round 15: EVERY `/nodes/:nodeId/system-jobs*` dispatcher below
   *  branches on this (not bare `isRemoteNode`), so the `LOCAL_NODE_ID` sentinel
   *  the web client uses for own-instance calls is never proxied as a peer. */
  const isLocalRequest = (nodeId: string): boolean =>
    nodeId === LOCAL_NODE_ID || !isRemoteNode(nodeId);

  /** Local-or-proxy dispatch for ONE mutate verb; returns the route Response. */
  const handleMutate = async (
    c: Context<WebAppEnv>,
    nodeId: string,
    body: SystemJobMutateBody
  ) => {
    if (!isLocalRequest(nodeId)) {
      const registry = opts.getNodeRegistry?.() ?? null;
      if (!registry) {
        return c.json(
          {
            ok: false,
            error: "Federation not enabled",
            code: "federation_not_enabled",
          },
          503
        );
      }
      const result = await registry.mutateSystemJobOnNode(nodeId, body);
      if ("type" in result) {
        return c.json(
          {
            ok: false,
            error: result.message,
            code: "federation_proxy_error",
          },
          502
        );
      }
      return c.json(result, result.ok ? 200 : STATUS_BY_CODE[result.code]);
    }
    const service = opts.getSystemJobsService();
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
    const result = dispatchMutate(service, body);
    return c.json(result, result.ok ? 200 : STATUS_BY_CODE[result.code]);
  };

  /** Guard `:name`; returns an error Response when invalid, else null. */
  const badName = (c: Context<WebAppEnv>, name: string) => {
    if (!name || name.length > MAX_JOB_NAME_LEN) {
      return c.json(
        { ok: false, error: "Invalid job name", code: "invalid_request" },
        400
      );
    }
    return null;
  };

  // ── loop-cron (issue #2453) ──────────────────────────────────────────────
  // Loop-cron routes are keyed on the arm-time `<id>` (NOT the systemd `:name`)
  // and dispatch to the dedicated controller (out-of-process loop-cron.sh), NOT
  // the systemd applyMutation path. The controller does the authoritative
  // shape + allowlist validation; `badLoopId` is a cheap edge reject (V11).
  const LOOP_ID_RE = /^lc-\d{14}-\d+-\d+$/;
  const badLoopId = (c: Context<WebAppEnv>, id: string) => {
    if (id === "all" || id === "." || id === ".." || !LOOP_ID_RE.test(id)) {
      return c.json(
        { ok: false, error: "Invalid loop id", code: "invalid_request" },
        400
      );
    }
    return null;
  };
  const loopRescheduleSchema = z
    .object({
      interval: z
        .string()
        .regex(/^([1-9]|[1-5][0-9])m$|^([1-9]|1[0-9]|2[0-3])h$/),
    })
    .strict();

  // #3293: the action/prompt edit body. Non-empty-after-trim (whitespace-only is
  // rejected the way reschedule rejects a malformed interval); persisted verbatim
  // by the controller, so the value is NOT trim-mutated here.
  const loopActionSchema = z
    .object({
      actionText: z.string().refine(s => s.trim().length > 0, {
        message: "actionText must not be empty",
      }),
    })
    .strict();

  /** Local-or-proxy dispatch for a loop-cron mutation; returns the route Response. */
  const handleLoopMutate = async (
    c: Context<WebAppEnv>,
    nodeId: string,
    body: LoopCronMutateBody
  ) => {
    // Epic #3285 round 15: branch on `isLocalRequest`, NOT bare `isRemoteNode`,
    // so the `LOCAL_NODE_ID` sentinel ("local") is served here exactly like the
    // GET session-loop-summary route below already does. On a FEDERATED hub
    // `isRemoteNode("local")` was true (it is not the hub's own nodeId), so the
    // Loop-Crons modal — which addresses every verb to the sentinel — was
    // proxied to a peer named "local" and got 502 "Node is offline"
    // (federation_proxy_error), while System Jobs (real hub nodeId) worked and a
    // non-federated dev instance (every request local) never reproduced it.
    if (!isLocalRequest(nodeId)) {
      const registry = opts.getNodeRegistry?.() ?? null;
      if (!registry) {
        return c.json(
          {
            ok: false,
            error: "Federation not enabled",
            code: "federation_not_enabled",
          },
          503
        );
      }
      const result = await registry.loopCronMutateOnNode(nodeId, body);
      if ("type" in result) {
        return c.json(
          { ok: false, error: result.message, code: "federation_proxy_error" },
          502
        );
      }
      if (result.ok) return c.json(result, 200);
      const { status, ...err } = result;
      return c.json(err, status);
    }
    const service = opts.getSystemJobsService();
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
    const result = await dispatchLoopCronMutate(service, body);
    if (result.ok) return c.json(result, 200);
    const { status, ...err } = result;
    return c.json(err, status);
  };

  // ─── GET /nodes/:nodeId/system-jobs (READ) ──
  app.get(
    "/nodes/:nodeId/system-jobs",
    cataloged(
      defineCapability({
        id: "machine-daemon.api-system-jobs-list",
        domain: "machine-daemon",
        surface: "rest",
        description:
          "List a node's managed system jobs (systemd units and loop-cron entries) with their enable state, schedule, and last-run status.",
        whenToUse:
          "When the user wants to see the scheduled system jobs on a specific node.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/nodes/:nodeId/system-jobs",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const nodeId = c.req.param("nodeId");
      if (!isLocalRequest(nodeId)) {
        const registry = opts.getNodeRegistry?.() ?? null;
        if (!registry) {
          return c.json(
            {
              ok: false,
              error: "Federation not enabled",
              code: "federation_not_enabled",
            },
            503
          );
        }
        const result = await registry.listSystemJobsOnNode(nodeId);
        if ("type" in result) {
          return c.json(
            {
              ok: false,
              error: result.message,
              code: "federation_proxy_error",
            },
            502
          );
        }
        return c.json(result, result.ok ? 200 : STATUS_BY_CODE[result.code]);
      }
      const service = opts.getSystemJobsService();
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

  // ─── POST /nodes/:nodeId/system-jobs/:name/enable ──
  app.post(
    "/nodes/:nodeId/system-jobs/:name/enable",
    cataloged(
      defineCapability({
        id: "machine-daemon.api-system-jobs-enable",
        domain: "machine-daemon",
        surface: "rest",
        description:
          "Enable a named system job on a node so its systemd timer resumes firing on schedule.",
        whenToUse: "When the user wants to turn a disabled system job back on.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/nodes/:nodeId/system-jobs/:name/enable",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    mutateLimiter,
    async c => {
      const nodeId = c.req.param("nodeId");
      const name = c.req.param("name");
      return (
        badName(c, name) ?? handleMutate(c, nodeId, { verb: "enable", name })
      );
    }
  );

  // ─── POST /nodes/:nodeId/system-jobs/:name/disable ──
  app.post(
    "/nodes/:nodeId/system-jobs/:name/disable",
    cataloged(
      defineCapability({
        id: "machine-daemon.api-system-jobs-disable",
        domain: "machine-daemon",
        surface: "rest",
        description:
          "Disable a named system job on a node so its systemd timer stops firing, without deleting the job.",
        whenToUse:
          "When the user wants to pause a system job without removing it.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/nodes/:nodeId/system-jobs/:name/disable",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    mutateLimiter,
    async c => {
      const nodeId = c.req.param("nodeId");
      const name = c.req.param("name");
      return (
        badName(c, name) ?? handleMutate(c, nodeId, { verb: "disable", name })
      );
    }
  );

  // ─── DELETE /nodes/:nodeId/system-jobs/:name ──
  app.delete(
    "/nodes/:nodeId/system-jobs/:name",
    cataloged(
      defineCapability({
        id: "machine-daemon.api-system-jobs-delete",
        domain: "machine-daemon",
        surface: "rest",
        description:
          "Permanently delete a named system job from a node, removing its systemd unit and timer.",
        whenToUse: "When the user wants to remove a system job entirely.",
        invocation: {
          kind: "rest",
          method: "DELETE",
          path: "/api/nodes/:nodeId/system-jobs/:name",
        },
        auth: "jwt",
        riskTier: "destructive",
        availability: { scope: "user" },
      })
    ),
    mutateLimiter,
    async c => {
      const nodeId = c.req.param("nodeId");
      const name = c.req.param("name");
      return (
        badName(c, name) ?? handleMutate(c, nodeId, { verb: "delete", name })
      );
    }
  );

  // ─── POST /nodes/:nodeId/system-jobs/:name/reschedule (body { schedule }) ──
  app.post(
    "/nodes/:nodeId/system-jobs/:name/reschedule",
    cataloged(
      defineCapability({
        id: "machine-daemon.api-system-jobs-reschedule",
        domain: "machine-daemon",
        surface: "rest",
        description:
          "Change the systemd OnCalendar schedule of a named system job on a node.",
        whenToUse:
          "When the user wants a system job to run at a different time or cadence.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/nodes/:nodeId/system-jobs/:name/reschedule",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
        example: '{"schedule":"*-*-* 09:00:00"}',
      })
    ),
    mutateLimiter,
    async c => {
      const nodeId = c.req.param("nodeId");
      const name = c.req.param("name");
      const nameErr = badName(c, name);
      if (nameErr) return nameErr;
      const parsed = rescheduleSchema.safeParse(
        await c.req.json().catch(() => null)
      );
      if (!parsed.success) {
        return c.json(
          { ok: false, error: "Invalid body", code: "invalid_request" },
          400
        );
      }
      return handleMutate(c, nodeId, {
        verb: "reschedule",
        name,
        args: { schedule: parsed.data.schedule },
      });
    }
  );

  // ─── POST /nodes/:nodeId/system-jobs/:name/rename (body { newName }) ──
  app.post(
    "/nodes/:nodeId/system-jobs/:name/rename",
    cataloged(
      defineCapability({
        id: "machine-daemon.api-system-jobs-rename",
        domain: "machine-daemon",
        surface: "rest",
        description:
          "Rename a named system job on a node, moving its systemd unit to the new name.",
        whenToUse:
          "When the user wants to give a system job a clearer or different name.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/nodes/:nodeId/system-jobs/:name/rename",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
        example: '{"newName":"nightly-digest"}',
      })
    ),
    mutateLimiter,
    async c => {
      const nodeId = c.req.param("nodeId");
      const name = c.req.param("name");
      const nameErr = badName(c, name);
      if (nameErr) return nameErr;
      const parsed = renameSchema.safeParse(
        await c.req.json().catch(() => null)
      );
      if (!parsed.success) {
        return c.json(
          { ok: false, error: "Invalid body", code: "invalid_request" },
          400
        );
      }
      return handleMutate(c, nodeId, {
        verb: "rename",
        name,
        args: { newName: parsed.data.newName },
      });
    }
  );

  // ─── POST /nodes/:nodeId/system-jobs/:name/description (body { description }) ──
  app.post(
    "/nodes/:nodeId/system-jobs/:name/description",
    cataloged(
      defineCapability({
        id: "machine-daemon.api-system-jobs-set-description",
        domain: "machine-daemon",
        surface: "rest",
        description:
          "Set the human-readable description of a named system job on a node.",
        whenToUse: "When the user wants to document what a system job does.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/nodes/:nodeId/system-jobs/:name/description",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
        example: '{"description":"Nightly summary of commits and open PRs"}',
      })
    ),
    mutateLimiter,
    async c => {
      const nodeId = c.req.param("nodeId");
      const name = c.req.param("name");
      const nameErr = badName(c, name);
      if (nameErr) return nameErr;
      const parsed = descriptionSchema.safeParse(
        await c.req.json().catch(() => null)
      );
      if (!parsed.success) {
        return c.json(
          { ok: false, error: "Invalid body", code: "invalid_request" },
          400
        );
      }
      return handleMutate(c, nodeId, {
        verb: "edit-description",
        name,
        args: { description: parsed.data.description },
      });
    }
  );

  // ─── POST /nodes/:nodeId/system-jobs/loop-cron/:id/pause|resume|run (#2453) ──
  // #3831 (F.10 / R11 family B): this loop registers 3 routes from a template-literal
  // path, which #3743's literal-only AST generator cannot read. A literal 3-entry table
  // beside the loop supplies the generator its literal `defineCapability({...})` calls,
  // and the loop passes `cataloged(LOOP_CRON_ACTION_ENTRIES[action])` at the `app.post`
  // site so #3742's ESLint rule and the runtime capability tag both see it.
  const LOOP_CRON_ACTION_ENTRIES: Record<
    "pause" | "resume" | "run",
    CatalogEntry
  > = {
    pause: defineCapability({
      id: "machine-daemon.api-loop-cron-pause",
      domain: "machine-daemon",
      surface: "rest",
      description:
        "Pause a running loop-cron on a node by its arm-time id, halting its recurring self-prompt.",
      whenToUse:
        "When the user wants to temporarily stop a loop-cron without deleting it.",
      invocation: {
        kind: "rest",
        method: "POST",
        path: "/api/nodes/:nodeId/system-jobs/loop-cron/:id/pause",
      },
      auth: "jwt",
      riskTier: "mutating",
      availability: { scope: "user" },
    }),
    resume: defineCapability({
      id: "machine-daemon.api-loop-cron-resume",
      domain: "machine-daemon",
      surface: "rest",
      description:
        "Resume a paused loop-cron on a node by its arm-time id, restarting its recurring self-prompt.",
      whenToUse: "When the user wants to restart a paused loop-cron.",
      invocation: {
        kind: "rest",
        method: "POST",
        path: "/api/nodes/:nodeId/system-jobs/loop-cron/:id/resume",
      },
      auth: "jwt",
      riskTier: "mutating",
      availability: { scope: "user" },
    }),
    run: defineCapability({
      id: "machine-daemon.api-loop-cron-run",
      domain: "machine-daemon",
      surface: "rest",
      description:
        "Trigger one immediate iteration of a loop-cron on a node by its arm-time id, outside its normal interval.",
      whenToUse: "When the user wants to run a loop-cron once right now.",
      invocation: {
        kind: "rest",
        method: "POST",
        path: "/api/nodes/:nodeId/system-jobs/loop-cron/:id/run",
      },
      auth: "jwt",
      riskTier: "mutating",
      availability: { scope: "user" },
    }),
  };
  for (const action of ["pause", "resume", "run"] as const) {
    app.post(
      `/nodes/:nodeId/system-jobs/loop-cron/:id/${action}`,
      cataloged(LOOP_CRON_ACTION_ENTRIES[action]),
      mutateLimiter,
      async c => {
        const nodeId = c.req.param("nodeId");
        const id = c.req.param("id");
        return badLoopId(c, id) ?? handleLoopMutate(c, nodeId, { action, id });
      }
    );
  }

  // ─── POST /nodes/:nodeId/system-jobs/loop-cron/:id/reschedule (body { interval }) ──
  app.post(
    "/nodes/:nodeId/system-jobs/loop-cron/:id/reschedule",
    cataloged(
      defineCapability({
        id: "machine-daemon.api-loop-cron-reschedule",
        domain: "machine-daemon",
        surface: "rest",
        description:
          "Change the recurring interval of a loop-cron on a node, addressed by its arm-time id.",
        whenToUse:
          "When the user wants a loop-cron to repeat at a different interval.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/nodes/:nodeId/system-jobs/loop-cron/:id/reschedule",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
        example: '{"interval":"30m"}',
      })
    ),
    mutateLimiter,
    async c => {
      const nodeId = c.req.param("nodeId");
      const id = c.req.param("id");
      const idErr = badLoopId(c, id);
      if (idErr) return idErr;
      const parsed = loopRescheduleSchema.safeParse(
        await c.req.json().catch(() => null)
      );
      if (!parsed.success) {
        return c.json(
          {
            ok: false,
            error: "Invalid interval (use Nm 1-59 or Nh 1-23)",
            code: "invalid_request",
          },
          400
        );
      }
      return handleLoopMutate(c, nodeId, {
        action: "reschedule",
        id,
        interval: parsed.data.interval,
      });
    }
  );

  // ─── POST /nodes/:nodeId/system-jobs/loop-cron/:id/action (body { actionText }, #3293) ──
  app.post(
    "/nodes/:nodeId/system-jobs/loop-cron/:id/action",
    cataloged(
      defineCapability({
        id: "machine-daemon.api-loop-cron-set-action",
        domain: "machine-daemon",
        surface: "rest",
        description:
          "Change the prompt text a loop-cron sends on each iteration, addressed by its arm-time id.",
        whenToUse:
          "When the user wants to edit what a loop-cron does on each run.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/nodes/:nodeId/system-jobs/loop-cron/:id/action",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
        example: '{"actionText":"Review open PRs and summarize"}',
      })
    ),
    mutateLimiter,
    async c => {
      const nodeId = c.req.param("nodeId");
      const id = c.req.param("id");
      const idErr = badLoopId(c, id);
      if (idErr) return idErr;
      const parsed = loopActionSchema.safeParse(
        await c.req.json().catch(() => null)
      );
      if (!parsed.success) {
        return c.json(
          {
            ok: false,
            error: "Invalid action text (must not be empty)",
            code: "invalid_request",
          },
          400
        );
      }
      return handleLoopMutate(c, nodeId, {
        action: "edit-action",
        id,
        actionText: parsed.data.actionText,
      });
    }
  );

  // ─── DELETE /nodes/:nodeId/system-jobs/loop-cron/:id (= purge, D1) ──
  app.delete(
    "/nodes/:nodeId/system-jobs/loop-cron/:id",
    cataloged(
      defineCapability({
        id: "machine-daemon.api-loop-cron-delete",
        domain: "machine-daemon",
        surface: "rest",
        description:
          "Permanently delete (purge) a loop-cron on a node by its arm-time id, stopping and removing it.",
        whenToUse: "When the user wants to remove a loop-cron entirely.",
        invocation: {
          kind: "rest",
          method: "DELETE",
          path: "/api/nodes/:nodeId/system-jobs/loop-cron/:id",
        },
        auth: "jwt",
        riskTier: "destructive",
        availability: { scope: "user" },
      })
    ),
    mutateLimiter,
    async c => {
      const nodeId = c.req.param("nodeId");
      const id = c.req.param("id");
      return (
        badLoopId(c, id) ??
        handleLoopMutate(c, nodeId, { action: "delete", id })
      );
    }
  );

  // ─── GET /nodes/:nodeId/system-jobs/session-loop-summary (badge, R8) ──
  // The header badge reads its OWN node (own-instance-only by definition, R8).
  // A remote nodeId returns [] — there is no cross-node summary receiver by
  // design (Task 6 drops it); the panel's loop cards ride the aggregate instead.
  app.get(
    "/nodes/:nodeId/system-jobs/session-loop-summary",
    cataloged(
      defineCapability({
        id: "machine-daemon.api-session-loop-summary",
        domain: "machine-daemon",
        surface: "rest",
        description:
          "Return a node's per-session loop-cron summary, reporting which of its sessions currently have active loops.",
        whenToUse:
          "When rendering the session-loop badge for the current node.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/nodes/:nodeId/system-jobs/session-loop-summary",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
        telemetry: "off",
      })
    ),
    async c => {
      const nodeId = c.req.param("nodeId");
      if (!isLocalRequest(nodeId)) {
        return c.json({ ok: true, summaries: [] });
      }
      const service = opts.getSystemJobsService();
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
      return c.json({ ok: true, summaries: service.sessionLoopSummary() });
    }
  );

  // ─── GET /system-jobs/session-loop-summary/all (aggregate) ──
  // Own-instance-only (R8): only the local node has a summary. Kept as an
  // aggregate for parity with /system-jobs/all and to spare the client from
  // needing to know its own node id.
  app.get(
    "/system-jobs/session-loop-summary/all",
    cataloged(
      defineCapability({
        id: "machine-daemon.api-session-loop-summary-all",
        domain: "machine-daemon",
        surface: "rest",
        description:
          "Aggregate the local node's per-session loop-cron summary, reporting which sessions currently have active loops.",
        whenToUse:
          "When showing session-loop activity without needing to know the local node id.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/system-jobs/session-loop-summary/all",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
        telemetry: "off",
      })
    ),
    async c => {
      const localNodeId = opts.getLocalNodeId?.() ?? null;
      const localLabel = localNodeId ?? LOCAL_NODE_ID;
      const service = opts.getSystemJobsService();
      const nodes: Array<{
        nodeId: string;
        nodeLabel: string;
        status: string;
        summaries: ReturnType<SystemJobsService["sessionLoopSummary"]>;
      }> = [];
      if (service) {
        nodes.push({
          nodeId: localLabel,
          nodeLabel: localLabel,
          status: "online",
          summaries: service.sessionLoopSummary(),
        });
      }
      return c.json({ ok: true, nodes });
    }
  );

  // ─── GET /system-jobs/all (AGGREGATE — on-demand fan-out) ──
  // Local node is added explicitly: the hub is itself a node but is NOT present
  // in `getNodeSummaries()`. Remote nodes fan out concurrently with per-node
  // error isolation (R1/R2) — one offline/unsupported node never fails the whole
  // aggregate. No caching (R7 does not fire).
  app.get(
    "/system-jobs/all",
    cataloged(
      defineCapability({
        id: "machine-daemon.api-system-jobs-all",
        domain: "machine-daemon",
        surface: "rest",
        description:
          "Aggregate managed system jobs across the local node and every reachable peer, with per-node error isolation.",
        whenToUse:
          "When the user wants a fleet-wide view of scheduled system jobs.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/system-jobs/all",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => {
      type NodeJobs = {
        nodeId: string;
        nodeLabel: string;
        status: string;
        jobs?: SystemJobView[];
        error?: string;
        code?: string;
      };
      const nodes: NodeJobs[] = [];
      const localNodeId = opts.getLocalNodeId?.() ?? null;
      const localLabel = localNodeId ?? LOCAL_NODE_ID;

      const service = opts.getSystemJobsService();
      if (service) {
        const result = service.listJobs();
        if (result.ok) {
          nodes.push({
            nodeId: localLabel,
            nodeLabel: localLabel,
            status: "online",
            jobs: result.jobs,
          });
        } else {
          nodes.push({
            nodeId: localLabel,
            nodeLabel: localLabel,
            status: "online",
            error: result.error,
            code: result.code,
          });
        }
      }

      const registry = opts.getNodeRegistry?.() ?? null;
      if (registry) {
        const summaries = registry.getNodeSummaries();
        const results = await Promise.allSettled(
          summaries.map(s => registry.listSystemJobsOnNode(s.nodeId))
        );
        summaries.forEach((s, i) => {
          const settled = results[i];
          if (settled.status !== "fulfilled") {
            nodes.push({
              nodeId: s.nodeId,
              nodeLabel: s.nodeLabel,
              status: s.status,
              error: String(settled.reason),
              code: "federation_proxy_error",
            });
            return;
          }
          const r: ListJobsResult | { type: "error"; message: string } =
            settled.value;
          if ("type" in r) {
            nodes.push({
              nodeId: s.nodeId,
              nodeLabel: s.nodeLabel,
              status: s.status,
              error: r.message,
              code: "federation_proxy_error",
            });
          } else if (r.ok) {
            nodes.push({
              nodeId: s.nodeId,
              nodeLabel: s.nodeLabel,
              status: s.status,
              jobs: r.jobs,
            });
          } else {
            nodes.push({
              nodeId: s.nodeId,
              nodeLabel: s.nodeLabel,
              status: s.status,
              error: r.error,
              code: r.code,
            });
          }
        });
      }

      return c.json({ ok: true, nodes });
    }
  );

  return app;
}
