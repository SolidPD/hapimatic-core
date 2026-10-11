// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Heartbeat API Routes
 *
 * GET  /heartbeat/status       — Current heartbeat service state
 * POST /heartbeat/trigger      — Fire an immediate out-of-cycle heartbeat
 * PUT  /heartbeat/config       — Update heartbeat configuration
 * GET  /heartbeat/config       — Read heartbeat configuration
 * GET  /heartbeat/history      — Recent heartbeat tick results
 * GET  /heartbeat/instructions — Read instructions file contents
 * PUT  /heartbeat/instructions — Write instructions file contents
 */

import { readFile, writeFile } from "node:fs/promises";
import { Hono } from "hono";
import { defineCapability } from "@hapi/protocol";
import type { WebAppEnv } from "../../web/middleware/auth";
import type { HeartbeatService } from "./heartbeatService";
// #1274: the scheduler moved into `builtin.scheduler`. This is a TYPE-only
// import across the core→extension boundary, kept until #1275 relocates these
// heartbeat routes into `builtin.heartbeat`, which will read the scheduler
// handle from `host.services.get("scheduler")` instead.
import type { SchedulerService } from "../scheduler/scheduler/schedulerService";
import type { ErrorLogger } from "../../logging/errorLogger";
import { logAndJson } from "../../web/routes/routeErrorHelper";
import { cataloged } from "../../capabilities/cataloged";
import {
  saveHeartbeatConfig,
  loadHeartbeatConfig,
  hasHeartbeatConfig,
  deleteHeartbeatConfig,
} from "../../config/heartbeatConfig";
import { configuration } from "../../configuration";

export function createHeartbeatRoutes(
  getHeartbeatService: () => HeartbeatService | null,
  getSchedulerService?: () => SchedulerService | null,
  options?: { errorLogger?: ErrorLogger | null }
): Hono<WebAppEnv> {
  const errorLogger = options?.errorLogger ?? null;
  const app = new Hono<WebAppEnv>();

  /** Find the DB heartbeat task if one exists (means scheduler is handling heartbeat) */
  function findHeartbeatTask() {
    const scheduler = getSchedulerService?.();
    if (!scheduler) return null;
    const tasks = scheduler.getAllTasks("default");
    return tasks.find(t => t.heartbeatMode && t.enabled) ?? null;
  }

  function requireService(c: {
    json: (data: unknown, status?: number) => Response;
  }): HeartbeatService | Response {
    const service = getHeartbeatService();
    if (!service)
      return c.json({ error: "Heartbeat service not available" }, 503);
    return service;
  }

  // GET /heartbeat/status
  app.get(
    "/heartbeat/status",
    cataloged(
      defineCapability({
        id: "harness-admin.heartbeat-status",
        domain: "harness-admin",
        surface: "rest",
        description: "Return the heartbeat extension's current status.",
        whenToUse: "When the UI shows heartbeat health.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/heartbeat/status",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
        telemetry: "off",
      })
    ),
    c => {
      // If scheduler has a heartbeat task, construct status from scheduler state
      const dbTask = findHeartbeatTask();
      if (dbTask) {
        return c.json({
          enabled: dbTask.enabled,
          running: true,
          lastTickAt: dbTask.lastExecutedAt,
          nextTickAt: dbTask.nextExecutionAt,
          sessionId: dbTask.lastSessionId,
          beatsSinceRotation: dbTask.eventCountCurrent,
          consecutiveFailures: dbTask.consecutiveErrors,
          currentInterval: dbTask.intervalMs ?? 0,
          activeHoursActive: true, // Scheduler handles this via temporal filter
          source: "scheduler",
        });
      }

      const service = requireService(c);
      if (service instanceof Response) return service;
      return c.json(service.getStatus());
    }
  );

  // POST /heartbeat/trigger
  app.post(
    "/heartbeat/trigger",
    cataloged(
      defineCapability({
        id: "harness-admin.heartbeat-trigger",
        domain: "harness-admin",
        surface: "rest",
        description: "Trigger a heartbeat run now.",
        whenToUse: "When the user forces a heartbeat.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/heartbeat/trigger",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      // If scheduler has a heartbeat task, run it via scheduler
      const dbTask = findHeartbeatTask();
      if (dbTask) {
        const scheduler = getSchedulerService?.();
        if (!scheduler) {
          return c.json({ error: "Scheduler not available" }, 503);
        }
        const result = await scheduler.runNow(dbTask.id, dbTask.namespace);
        return c.json({
          success: result.success,
          timestamp: Date.now(),
          durationMs: 0,
          error: result.error,
          source: "scheduler",
        });
      }

      const service = requireService(c);
      if (service instanceof Response) return service;

      const result = await service.triggerNow();
      return c.json(result);
    }
  );

  // PUT /heartbeat/config
  app.put(
    "/heartbeat/config",
    cataloged(
      defineCapability({
        id: "harness-admin.heartbeat-set-config",
        domain: "harness-admin",
        surface: "rest",
        description: "Update the heartbeat configuration.",
        whenToUse: "When the user changes heartbeat settings.",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/api/heartbeat/config",
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

      // Persist to settings.json
      await saveHeartbeatConfig(configuration.dataDir, body);

      // Notify service of config change
      await service.updateConfig(body);

      // Return updated config
      const config = await loadHeartbeatConfig(configuration.dataDir);
      return c.json({ config });
    }
  );

  // GET /heartbeat/history
  app.get(
    "/heartbeat/history",
    cataloged(
      defineCapability({
        id: "harness-admin.heartbeat-history",
        domain: "harness-admin",
        surface: "rest",
        description: "Return the heartbeat run history.",
        whenToUse: "When the user reviews heartbeat history.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/heartbeat/history",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    c => {
      // If scheduler has a heartbeat task, return execution history from DB
      const dbTask = findHeartbeatTask();
      if (dbTask) {
        const scheduler = getSchedulerService?.();
        if (scheduler) {
          const executions = scheduler.getExecutionHistory(dbTask.id, 50);
          // Map to heartbeat history format for backward compatibility
          const history = executions.map(e => ({
            timestamp: e.scheduledFor,
            success: e.status === "delivered",
            skipped: e.status === "skipped",
            skipReason: e.status === "skipped" ? e.errorMessage : undefined,
            durationMs:
              e.completedAt && e.startedAt ? e.completedAt - e.startedAt : 0,
            error: e.status === "failed" ? e.errorMessage : undefined,
            sessionId: e.sessionId,
            beatNumber: 0, // Not tracked in scheduler
          }));
          return c.json({ history, source: "scheduler" });
        }
      }

      const service = requireService(c);
      if (service instanceof Response) return service;
      return c.json({ history: service.getHistory() });
    }
  );

  // GET /heartbeat/config
  app.get(
    "/heartbeat/config",
    cataloged(
      defineCapability({
        id: "harness-admin.heartbeat-get-config",
        domain: "harness-admin",
        surface: "rest",
        description: "Return the heartbeat configuration.",
        whenToUse: "When the UI loads heartbeat settings.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/heartbeat/config",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const exists = await hasHeartbeatConfig(configuration.dataDir);
      if (!exists) {
        return c.json({ config: null });
      }
      const config = await loadHeartbeatConfig(configuration.dataDir);
      return c.json({ config });
    }
  );

  // DELETE /heartbeat/config
  app.delete(
    "/heartbeat/config",
    cataloged(
      defineCapability({
        id: "harness-admin.heartbeat-delete-config",
        domain: "harness-admin",
        surface: "rest",
        description: "Reset/delete the heartbeat configuration.",
        whenToUse: "When the user clears heartbeat config.",
        invocation: {
          kind: "rest",
          method: "DELETE",
          path: "/api/heartbeat/config",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const service = getHeartbeatService();
      if (service) {
        service.stop();
      }
      await deleteHeartbeatConfig(configuration.dataDir);
      return c.json({ success: true });
    }
  );

  // GET /heartbeat/instructions — Read instructions file contents
  app.get(
    "/heartbeat/instructions",
    cataloged(
      defineCapability({
        id: "harness-admin.heartbeat-get-instructions",
        domain: "harness-admin",
        surface: "rest",
        description: "Return the heartbeat instructions.",
        whenToUse: "When the UI loads heartbeat instructions.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/heartbeat/instructions",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const config = await loadHeartbeatConfig(configuration.dataDir);
      try {
        const content = await readFile(config.instructionsFile, "utf-8");
        return c.json({ content });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return c.json({ content: "" });
        }
        return logAndJson(c, err, 500, {
          errorLogger,
          category: "heartbeat-read-instructions",
          fallbackMessage: "Failed to read instructions file",
          severity: "warn",
        });
      }
    }
  );

  // PUT /heartbeat/instructions — Write instructions file contents
  app.put(
    "/heartbeat/instructions",
    cataloged(
      defineCapability({
        id: "harness-admin.heartbeat-set-instructions",
        domain: "harness-admin",
        surface: "rest",
        description: "Update the heartbeat instructions.",
        whenToUse: "When the user edits heartbeat instructions.",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/api/heartbeat/instructions",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const body = await c.req.json();
      if (
        !body ||
        typeof body !== "object" ||
        typeof body.content !== "string"
      ) {
        return c.json(
          { error: "Request body must contain 'content' string" },
          400
        );
      }

      const config = await loadHeartbeatConfig(configuration.dataDir);
      try {
        await writeFile(config.instructionsFile, body.content, "utf-8");
        return c.json({ success: true });
      } catch (err) {
        return logAndJson(c, err, 500, {
          errorLogger,
          category: "heartbeat-write-instructions",
          fallbackMessage: "Failed to write instructions file",
          severity: "warn",
        });
      }
    }
  );

  return app;
}
