// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Schedule API Routes
 *
 * CRUD operations for scheduled tasks and execution history.
 *
 * GET    /schedules              — List all scheduled tasks
 * POST   /schedules              — Create a new scheduled task
 * GET    /schedules/:id          — Get a specific scheduled task
 * PUT    /schedules/:id          — Update a scheduled task
 * DELETE /schedules/:id          — Delete a scheduled task
 * POST   /schedules/:id/toggle   — Enable/disable a task
 * POST   /schedules/:id/run      — Execute a task immediately
 * GET    /schedules/:id/history  — Get execution history for a task
 * POST   /schedules/executions/:execId/complete — A scheduled session declares
 *                                  its execution done (#2701)
 */

import { Hono } from "hono";
import { z } from "zod";
import { defineCapability } from "@hapi/protocol";
import type { SchedulerService } from "../scheduler/schedulerService";
import type { WebAppEnv } from "../../../web/middleware/auth";
import type { ErrorLogger } from "../../../logging/errorLogger";
import { cataloged } from "../../../capabilities/cataloged";
import { resolveRepoIdentity } from "../../../utils/repoIdentity";
import { logAndJson } from "../../../web/routes/routeErrorHelper";
import { refuseAgentEscalation } from "../../../web/routes/agentEscalation";
import type { SyncEngine } from "../../../sync/syncEngine";

const scheduleKindSchema = z.enum(["at", "every", "cron"]);
const overlapPolicySchema = z.enum(["skip", "queue", "allow"]);
const notifyOnSchema = z.enum(["completion", "error", "both", "none"]);
const childDispositionSchema = z.enum(["cascade", "orphan"]);

const createScheduleSchema = z.object({
  name: z.string().min(1).max(255),
  emoji: z.string().max(10).optional(),
  prompt: z.string().min(1).max(50_000),
  projectDirectory: z.string().min(1).max(1000),
  scheduleType: scheduleKindSchema,
  cronExpression: z.string().max(100).optional(),
  scheduledAt: z.number().int().positive().optional(),
  intervalMs: z.number().int().min(60_000).optional(), // min 1 minute
  timezone: z.string().max(100).optional(),
  deleteAfterRun: z.boolean().optional(),
  maxRuntimeMs: z.number().int().positive().optional(),
  notifyOn: notifyOnSchema.optional(),
  overlapPolicy: overlapPolicySchema.optional(),
  // 5-Layer Temporal Model
  operatingSchedule: z.string().max(10_000).optional(),
  exclusionSchedule: z.string().max(10_000).optional(),
  lifetimeStart: z.number().int().positive().optional(),
  lifetimeEnd: z.number().int().positive().optional(),
  eventCountLimit: z.number().int().min(1).optional(),
  jitterMaxMs: z.number().int().min(0).optional(),
  heartbeatMode: z.boolean().optional(),
  standingOrders: z.string().max(50_000).optional(),
  preWorkInstructions: z.string().max(50_000).optional(),
  closingInstructions: z.string().max(50_000).optional(),
  ackMaxChars: z.number().int().min(0).optional(),
  rotationConfig: z.string().max(1_000).optional(),
  backoffConfig: z.string().max(1_000).optional(),
  runOnceAtCreation: z.boolean().optional(),
  dstAdjustment: z.enum(["none", "skip", "double"]).optional(),
  sessionType: z.enum(["simple", "worktree"]).optional(),
  worktreeBranchName: z.string().max(255).optional(),
});

const updateScheduleSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  emoji: z.string().max(10).nullable().optional(),
  prompt: z.string().min(1).max(50_000).optional(),
  projectDirectory: z.string().min(1).max(1000).optional(),
  scheduleType: scheduleKindSchema.optional(),
  cronExpression: z.string().max(100).optional(),
  scheduledAt: z.number().int().positive().optional(),
  intervalMs: z.number().int().min(60_000).optional(),
  timezone: z.string().max(100).optional(),
  enabled: z.boolean().optional(),
  deleteAfterRun: z.boolean().optional(),
  maxRuntimeMs: z.number().int().positive().nullable().optional(),
  notifyOn: notifyOnSchema.optional(),
  overlapPolicy: overlapPolicySchema.optional(),
  // 5-Layer Temporal Model
  operatingSchedule: z.string().max(10_000).optional(),
  exclusionSchedule: z.string().max(10_000).optional(),
  lifetimeStart: z.number().int().positive().optional(),
  lifetimeEnd: z.number().int().positive().optional(),
  eventCountLimit: z.number().int().min(1).optional(),
  eventCountCurrent: z.number().int().min(0).optional(),
  jitterMaxMs: z.number().int().min(0).optional(),
  heartbeatMode: z.boolean().optional(),
  standingOrders: z.string().max(50_000).optional(),
  preWorkInstructions: z.string().max(50_000).optional(),
  closingInstructions: z.string().max(50_000).optional(),
  ackMaxChars: z.number().int().min(0).optional(),
  rotationConfig: z.string().max(1_000).optional(),
  backoffConfig: z.string().max(1_000).optional(),
  runOnceAtCreation: z.boolean().optional(),
  dstAdjustment: z.enum(["none", "skip", "double"]).optional(),
  sessionType: z.enum(["simple", "worktree"]).optional(),
  worktreeBranchName: z.string().max(255).nullable().optional(),
});

export function createSchedulesRoutes(
  getSchedulerService: () => SchedulerService | null,
  options?: {
    errorLogger?: ErrorLogger | null;
    /** #3842 R8: resolves the `X-Hapi-Session-Id` caller for the agent-
     *  escalation floor on create/update. Absent → a stamped caller is refused
     *  (fail closed); an unstamped request is unaffected. */
    getSyncEngine?: () => SyncEngine | null;
  }
): Hono<WebAppEnv> {
  const errorLogger = options?.errorLogger ?? null;
  const getSyncEngine = options?.getSyncEngine ?? (() => null);
  const app = new Hono<WebAppEnv>();

  function requireService(c: {
    json: (data: unknown, status?: number) => Response;
  }): SchedulerService | Response {
    const service = getSchedulerService();
    if (!service)
      return c.json({ error: "Scheduler service not available" }, 503);
    return service;
  }

  // GET /schedules — List all scheduled tasks
  // Enriches each schedule with repoIdentity resolved from its projectDirectory
  app.get(
    "/schedules",
    cataloged(
      defineCapability({
        id: "scheduler.list",
        domain: "scheduler",
        surface: "rest",
        description:
          "List every scheduled task in the caller's namespace, each enriched with the repo identity resolved from its project directory.",
        whenToUse:
          "When the user wants to see their scheduled or recurring tasks.",
        invocation: { kind: "rest", method: "GET", path: "/api/schedules" },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
        example:
          '{"name":"Nightly digest","prompt":"Summarize recent commits and open PRs","projectDirectory":"/home/matt/projects/app","scheduleType":"cron","cronExpression":"0 9 * * *","timezone":"America/New_York"}',
      })
    ),
    c => {
      const service = requireService(c);
      if (service instanceof Response) return service;

      const namespace = c.get("namespace");
      const schedules = service.getAllTasks(namespace).map(task => {
        const repoIdentity = resolveRepoIdentity(task.projectDirectory);
        return repoIdentity ? { ...task, repoIdentity } : task;
      });

      return c.json({ schedules });
    }
  );

  // POST /schedules — Create a new scheduled task
  app.post(
    "/schedules",
    cataloged(
      defineCapability({
        id: "scheduler.create",
        domain: "scheduler",
        surface: "rest",
        description:
          "Create a scheduled task that runs a prompt on a cron, interval, or one-shot timer in a chosen project directory.",
        whenToUse: "When the user wants to schedule recurring work.",
        invocation: { kind: "rest", method: "POST", path: "/api/schedules" },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
        example:
          '{"name":"Nightly digest","prompt":"Summarize recent commits and open PRs","projectDirectory":"/home/matt/projects/app","scheduleType":"cron","cronExpression":"0 9 * * *","timezone":"America/New_York"}',
      })
    ),
    async c => {
      const service = requireService(c);
      if (service instanceof Response) return service;

      // #3842 R8 (ruling NEW-3842-1 = b): scheduled sessions always run in the
      // bypass mode, so a non-bypass agent session cannot write a schedule
      // through the capability channel. Checked before any parse or write.
      const refusal = refuseAgentEscalation(c, getSyncEngine());
      if (refusal) return refusal;

      const namespace = c.get("namespace");
      const body = await c.req.json().catch(() => null);
      const parsed = createScheduleSchema.safeParse(body);

      if (!parsed.success) {
        return c.json(
          { error: "Invalid body", details: parsed.error.issues },
          400
        );
      }

      // Validate schedule-type-specific fields
      const data = parsed.data;
      if (data.scheduleType === "cron" && !data.cronExpression) {
        return c.json(
          { error: "cronExpression is required for cron schedule type" },
          400
        );
      }
      if (data.scheduleType === "at" && !data.scheduledAt) {
        return c.json(
          { error: "scheduledAt is required for at schedule type" },
          400
        );
      }
      if (data.scheduleType === "every" && !data.intervalMs) {
        return c.json(
          { error: "intervalMs is required for every schedule type" },
          400
        );
      }

      try {
        const schedule = service.createTask(data, namespace);
        return c.json({ schedule }, 201);
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "schedules-create",
          fallbackMessage: "Failed to create schedule",
          severity: "warn",
        });
      }
    }
  );

  // GET /schedules/:id — Get a specific scheduled task
  app.get(
    "/schedules/:id",
    cataloged(
      defineCapability({
        id: "scheduler.get",
        domain: "scheduler",
        surface: "rest",
        description:
          "Fetch one scheduled task by id within the caller's namespace.",
        whenToUse:
          "When the user wants the details of a single scheduled task.",
        invocation: { kind: "rest", method: "GET", path: "/api/schedules/:id" },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
        example:
          '{"name":"Nightly digest","prompt":"Summarize recent commits and open PRs","projectDirectory":"/home/matt/projects/app","scheduleType":"cron","cronExpression":"0 9 * * *","timezone":"America/New_York"}',
      })
    ),
    c => {
      const service = requireService(c);
      if (service instanceof Response) return service;

      const namespace = c.get("namespace");
      const id = c.req.param("id");
      const schedule = service.getTask(id, namespace);

      if (!schedule) {
        return c.json({ error: "Schedule not found" }, 404);
      }

      return c.json({ schedule });
    }
  );

  // PUT /schedules/:id — Update a scheduled task
  app.put(
    "/schedules/:id",
    cataloged(
      defineCapability({
        id: "scheduler.update",
        domain: "scheduler",
        surface: "rest",
        description:
          "Update a scheduled task's timing, prompt, enablement, or temporal-model layers.",
        whenToUse: "When the user wants to change an existing scheduled task.",
        invocation: { kind: "rest", method: "PUT", path: "/api/schedules/:id" },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
        example:
          '{"name":"Nightly digest","prompt":"Summarize recent commits and open PRs","projectDirectory":"/home/matt/projects/app","scheduleType":"cron","cronExpression":"0 9 * * *","timezone":"America/New_York"}',
      })
    ),
    async c => {
      const service = requireService(c);
      if (service instanceof Response) return service;

      // #3842 R8 (ruling NEW-3842-1 = b): scheduled sessions always run in the
      // bypass mode, so a non-bypass agent session cannot write a schedule
      // through the capability channel. Checked before any parse or write.
      const refusal = refuseAgentEscalation(c, getSyncEngine());
      if (refusal) return refusal;

      const namespace = c.get("namespace");
      const id = c.req.param("id");
      const body = await c.req.json().catch(() => null);
      const parsed = updateScheduleSchema.safeParse(body);

      if (!parsed.success) {
        return c.json(
          { error: "Invalid body", details: parsed.error.issues },
          400
        );
      }

      const schedule = service.updateTask(id, parsed.data, namespace);
      if (!schedule) {
        return c.json({ error: "Schedule not found" }, 404);
      }

      return c.json({ schedule });
    }
  );

  // DELETE /schedules/:id — Delete a scheduled task
  app.delete(
    "/schedules/:id",
    cataloged(
      defineCapability({
        id: "scheduler.delete",
        domain: "scheduler",
        surface: "rest",
        description:
          "Permanently delete a scheduled task by id. ?children=orphan (default) keeps its spawned sessions as independent top-level sessions; ?children=cascade archives and deletes them too.",
        whenToUse: "When the user wants to remove a scheduled task for good.",
        invocation: {
          kind: "rest",
          method: "DELETE",
          path: "/api/schedules/:id",
        },
        auth: "jwt",
        riskTier: "destructive",
        availability: { scope: "user" },
        example:
          '{"name":"Nightly digest","prompt":"Summarize recent commits and open PRs","projectDirectory":"/home/matt/projects/app","scheduleType":"cron","cronExpression":"0 9 * * *","timezone":"America/New_York"}',
      })
    ),
    async c => {
      const service = requireService(c);
      if (service instanceof Response) return service;

      const namespace = c.get("namespace");
      const id = c.req.param("id");
      // #3172: what happens to the schedule's spawned sessions. Defaults to the
      // non-destructive `orphan` (dissolve to top-level) — never a dangling link.
      const parsed = childDispositionSchema.safeParse(
        c.req.query("children") ?? "orphan"
      );
      if (!parsed.success) {
        return c.json(
          { error: 'Invalid children: expected "cascade" or "orphan"' },
          400
        );
      }

      const result = await service.deleteTaskWithChildren(
        id,
        namespace,
        parsed.data
      );
      if (!result) {
        return c.json({ error: "Schedule not found" }, 404);
      }

      return c.json({ success: true, children: result });
    }
  );

  // POST /schedules/:id/toggle — Enable/disable a task
  app.post(
    "/schedules/:id/toggle",
    cataloged(
      defineCapability({
        id: "scheduler.toggle",
        domain: "scheduler",
        surface: "rest",
        description:
          "Enable or disable a scheduled task, flipping whether its timer is armed.",
        whenToUse: "When the user wants to pause or resume a scheduled task.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/schedules/:id/toggle",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
        example:
          '{"name":"Nightly digest","prompt":"Summarize recent commits and open PRs","projectDirectory":"/home/matt/projects/app","scheduleType":"cron","cronExpression":"0 9 * * *","timezone":"America/New_York"}',
      })
    ),
    c => {
      const service = requireService(c);
      if (service instanceof Response) return service;

      const namespace = c.get("namespace");
      const id = c.req.param("id");

      const schedule = service.toggleTask(id, namespace);
      if (!schedule) {
        return c.json({ error: "Schedule not found" }, 404);
      }

      return c.json({ schedule });
    }
  );

  // POST /schedules/:id/run — Execute a task immediately
  app.post(
    "/schedules/:id/run",
    cataloged(
      defineCapability({
        id: "scheduler.run",
        domain: "scheduler",
        surface: "rest",
        description:
          "Execute a scheduled task immediately, out of band, and return its execution record.",
        whenToUse:
          "When the user wants to run a scheduled task now, off its normal schedule.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/schedules/:id/run",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
        example:
          '{"name":"Nightly digest","prompt":"Summarize recent commits and open PRs","projectDirectory":"/home/matt/projects/app","scheduleType":"cron","cronExpression":"0 9 * * *","timezone":"America/New_York"}',
      })
    ),
    async c => {
      const service = requireService(c);
      if (service instanceof Response) return service;

      const namespace = c.get("namespace");
      const id = c.req.param("id");

      const result = await service.runNow(id, namespace);
      if (!result.success) {
        return c.json(
          {
            error: result.error ?? "Execution failed",
            execution: result.execution,
          },
          result.execution.status === "failed" ? 500 : 409
        );
      }

      return c.json({ execution: result.execution });
    }
  );

  // GET /schedules/:id/history — Get execution history
  app.get(
    "/schedules/:id/history",
    cataloged(
      defineCapability({
        id: "scheduler.history",
        domain: "scheduler",
        surface: "rest",
        description:
          "Return the execution history for a scheduled task, newest first, with limit and offset paging.",
        whenToUse:
          "When the user wants to review a scheduled task's past runs.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/schedules/:id/history",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
        example:
          '{"name":"Nightly digest","prompt":"Summarize recent commits and open PRs","projectDirectory":"/home/matt/projects/app","scheduleType":"cron","cronExpression":"0 9 * * *","timezone":"America/New_York"}',
      })
    ),
    c => {
      const service = requireService(c);
      if (service instanceof Response) return service;

      const id = c.req.param("id");
      const limitStr = c.req.query("limit");
      const offsetStr = c.req.query("offset");
      const limit = limitStr ? parseInt(limitStr, 10) : 50;
      const offset = offsetStr ? parseInt(offsetStr, 10) : 0;

      const history = service.getExecutionHistory(
        id,
        isNaN(limit) ? 50 : limit,
        isNaN(offset) ? 0 : offset
      );

      return c.json({ history, limit, offset });
    }
  );

  // POST /schedules/executions/:execId/complete — a scheduled session declares
  // its own execution done so the reaper frees its slot promptly (#2701).
  // The call is injected into every non-heartbeat scheduled prompt.
  app.post(
    "/schedules/executions/:execId/complete",
    cataloged(
      defineCapability({
        id: "scheduler.complete-execution",
        domain: "scheduler",
        surface: "rest",
        description:
          "Mark a scheduled session's own execution completed so the reaper frees its concurrency slot promptly.",
        whenToUse:
          "Called by a scheduler-spawned session as its final task action; the exact call is injected into its prompt.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/schedules/executions/:execId/complete",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
        example: '{"sessionTag":"hapi-1790000000000-abcd1234"}',
      })
    ),
    async c => {
      const service = requireService(c);
      if (service instanceof Response) return service;

      const body = await c.req.json().catch(() => null);
      const parsed = completeExecutionSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "sessionTag is required" }, 400);
      }

      const result = service.completeExecution(
        c.req.param("execId"),
        c.get("namespace"),
        parsed.data.sessionTag
      );
      switch (result.kind) {
        case "ok":
          return c.json({ execution: result.execution });
        case "already":
          return c.json({
            execution: result.execution,
            alreadyCompleted: true,
          });
        case "not_found":
          return c.json({ error: "Execution not found" }, 404);
        case "forbidden":
          return c.json({ error: result.reason }, 403);
        case "conflict":
          return c.json({ error: result.reason }, 409);
      }
    }
  );

  return app;
}

const completeExecutionSchema = z.object({ sessionTag: z.string().min(1) });
