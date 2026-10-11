// SPDX-License-Identifier: MIT
/**
 * HTTP control server for daemon management
 * Provides endpoints for listing sessions, stopping sessions, and daemon shutdown
 */

import fastify, { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  serializerCompiler,
  validatorCompiler,
  ZodTypeProvider,
} from "fastify-type-provider-zod";
import { logger } from "@/ui/logger";
import { Metadata } from "@/api/types";
import { TrackedSession } from "./types";
import {
  SpawnSessionOptions,
  SpawnSessionResult,
  ForceRefreshReport,
} from "@/modules/common/rpcTypes";
import { randomBytes } from "node:crypto";
import { constantTimeEquals } from "@/utils/crypto";
import { JobStatusSchema, type JobStatus } from "@hapi/protocol";
import {
  DaemonCapSourceSchema,
  type DaemonCapSource,
} from "@hapi/protocol/schemas";
import { setSpawnPaused } from "./spawnPauseState";

export function startDaemonControlServer({
  getChildren,
  stopSession,
  spawnSession,
  requestShutdown,
  onHappySessionWebhook,
  forceRefreshAccount,
  getEffectiveCount,
  getJobs,
}: {
  getChildren: () => TrackedSession[];
  stopSession: (sessionId: string) => boolean;
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  requestShutdown: () => void;
  onHappySessionWebhook: (sessionId: string, metadata: Metadata) => void;
  /** Force-refresh harness handler (issue #1547). */
  forceRefreshAccount: (accountUuid: string) => Promise<ForceRefreshReport>;
  /** Daemon effective active-session count — the SAME number the spawn gate uses (issue #1477).
   *  #4417 adds `recommended` (warn-at count) and `source` (which resolver layer set the cap). */
  getEffectiveCount: () => Promise<{
    effectiveCount: number;
    trackedPids: number;
    activeTmuxWindows: number;
    max: number;
    recommended: number;
    source: DaemonCapSource;
  }>;
  /** #1964 (Sub-D): snapshot of this daemon process's runtime job registry. */
  getJobs: () => JobStatus[];
}): Promise<{ port: number; token: string; stop: () => Promise<void> }> {
  return new Promise(resolve => {
    const app = fastify({
      logger: false, // We use our own logger
    });

    // Set up Zod type provider
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>();

    // Defense-in-depth bearer token (issue #1738). The control server stays
    // bound to 127.0.0.1 (first trust boundary); this token is a second layer
    // so the mutating /force-refresh-account endpoint cannot be invoked without
    // it. Generated here, returned to run.ts, and persisted in daemon.state.json
    // for the same-machine client to read. Mirrors the federation pattern
    // (checkFederationToken + constantTimeEquals in
    // server/src/web/routes/federation/shared.ts).
    const controlToken = randomBytes(32).toString("base64url");

    // Global fail-closed auth hook — runs before routing, so a rejected request
    // never reaches a route handler (e.g. /force-refresh-account never rotates a
    // token without a valid bearer). Covers all endpoints uniformly.
    app.addHook("onRequest", async (request, reply) => {
      const authHeader = request.headers["authorization"];
      if (
        !authHeader?.startsWith("Bearer ") ||
        !constantTimeEquals(authHeader.slice("Bearer ".length), controlToken)
      ) {
        reply.code(401).send({ error: "unauthorized" });
      }
    });

    // Session reports itself after creation
    typed.post(
      "/session-started",
      {
        schema: {
          body: z.object({
            sessionId: z.string(),
            metadata: z.any(), // Metadata type from API
          }),
          response: {
            200: z.object({
              status: z.literal("ok"),
            }),
          },
        },
      },
      async request => {
        const { sessionId, metadata } = request.body;

        logger.debug(`[CONTROL SERVER] Session started: ${sessionId}`);
        onHappySessionWebhook(sessionId, metadata);

        return { status: "ok" as const };
      }
    );

    // List all tracked sessions
    typed.post(
      "/list",
      {
        schema: {
          response: {
            200: z.object({
              children: z.array(
                z.object({
                  startedBy: z.string(),
                  happySessionId: z.string(),
                  pid: z.number(),
                })
              ),
            }),
          },
        },
      },
      async () => {
        const children = getChildren();
        logger.debug(`[CONTROL SERVER] Listing ${children.length} sessions`);
        return {
          children: children
            .filter(child => child.happySessionId !== undefined)
            .map(child => ({
              startedBy: child.startedBy,
              happySessionId: child.happySessionId!,
              pid: child.pid,
            })),
        };
      }
    );

    // Stop specific session
    typed.post(
      "/stop-session",
      {
        schema: {
          body: z.object({
            sessionId: z.string(),
          }),
          response: {
            200: z.object({
              success: z.boolean(),
            }),
          },
        },
      },
      async request => {
        const { sessionId } = request.body;

        logger.debug(`[CONTROL SERVER] Stop session request: ${sessionId}`);
        const success = stopSession(sessionId);
        return { success };
      }
    );

    // Spawn new session
    typed.post(
      "/spawn-session",
      {
        schema: {
          body: z.object({
            directory: z.string(),
            sessionId: z.string().optional(),
            // Issue #1262: explicit opt-in to spawn-time port claim. Default-false.
            claimPort: z.boolean().optional(),
            sessionType: z.enum(["simple", "worktree"]).optional(),
            worktreeName: z.string().optional(),
            // hapimatic-private#4481: open the worktree on an existing branch.
            existingBranch: z
              .object({ name: z.string().min(1).max(255), remote: z.boolean() })
              .optional(),
            name: z.string().max(255).optional(),
          }),
          response: {
            200: z.object({
              success: z.boolean(),
              sessionId: z.string().optional(),
              approvedNewDirectoryCreation: z.boolean().optional(),
            }),
            409: z.object({
              success: z.boolean(),
              requiresUserApproval: z.boolean().optional(),
              actionRequired: z.string().optional(),
              directory: z.string().optional(),
            }),
            500: z.object({
              success: z.boolean(),
              error: z.string().optional(),
            }),
          },
        },
      },
      async (request, reply) => {
        const {
          directory,
          sessionId,
          claimPort,
          sessionType,
          worktreeName,
          existingBranch,
          name,
        } = request.body;

        logger.debug(
          `[CONTROL SERVER] Spawn session request: dir=${directory}, sessionId=${sessionId || "new"}, claimPort=${claimPort ?? "(default)"}`
        );

        let result;
        try {
          result = await spawnSession({
            directory,
            sessionId,
            claimPort,
            sessionType,
            worktreeName,
            existingBranch,
            name,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Internal error";
          logger.debug(`[CONTROL SERVER] Spawn session threw: ${message}`);
          reply.code(500);
          return {
            success: false,
            error: message,
          };
        }

        switch (result.type) {
          case "success":
            // Check if sessionId exists, if not return error
            if (!result.sessionId) {
              reply.code(500);
              return {
                success: false,
                error: "Failed to spawn session: no session ID returned",
              };
            }
            return {
              success: true,
              sessionId: result.sessionId,
              approvedNewDirectoryCreation: true,
            };

          case "requestToApproveDirectoryCreation":
            reply.code(409); // Conflict - user input needed
            return {
              success: false,
              requiresUserApproval: true,
              actionRequired: "CREATE_DIRECTORY",
              directory: result.directory,
            };

          case "error":
            reply.code(500);
            // Issue #1772: carry the error `code` (e.g. "at_capacity") on the
            // daemon-HTTP body for parity, so a CLI client can discriminate
            // without string-matching the message.
            return {
              success: false,
              error: result.errorMessage,
              ...(result.code ? { code: result.code } : {}),
            };
        }
      }
    );

    // Force-refresh a single account (issue #1547). Drives the on-demand
    // token-refresh test harness through the LIVE TokenRefreshService instance.
    // The response is the rich nested ForceRefreshReport — validated loosely
    // (z.any()) the same way /session-started accepts `metadata: z.any()`; the
    // typed `forceRefreshAccount` handler is the real contract.
    typed.post(
      "/force-refresh-account",
      {
        schema: {
          body: z.object({
            accountUuid: z.string(),
          }),
          response: {
            200: z.any(),
          },
        },
      },
      async request => {
        const { accountUuid } = request.body;
        logger.debug(`[CONTROL SERVER] Force-refresh request: ${accountUuid}`);
        return await forceRefreshAccount(accountUuid);
      }
    );

    // Effective active-session count (issue #1477). Returns the SAME number the
    // spawn gate uses to accept/reject spawns — max(tracked PIDs, active tmux
    // windows), excluding dead panes / idle shells (#603/#633). Gives callers
    // (hapi daemon status, agents) an authoritative capacity source instead of
    // `sessions list | length` (which counts stale/exited records). Computed by
    // the shared computeEffectiveCount() closure in run.ts. #4417 adds `recommended`
    // (the warn-at count, ≤ max) and `source` (which resolver layer set the cap) from
    // that same closure, so the meter and the gate can never disagree.
    typed.post(
      "/effective-count",
      {
        schema: {
          response: {
            200: z.object({
              effectiveCount: z.number(),
              trackedPids: z.number(),
              activeTmuxWindows: z.number(),
              max: z.number(),
              recommended: z.number(),
              source: DaemonCapSourceSchema,
            }),
          },
        },
      },
      async () => {
        logger.debug("[CONTROL SERVER] Effective-count request");
        return await getEffectiveCount();
      }
    );

    // Issue #1774 (Sub E, Task 10 / R9): spawn-quiesce control. The self-update
    // flow (server process) POSTs {paused:true} right before flipping the harness
    // symlink and {paused:false} in its finally, so a fresh `claude` cannot fork
    // mid-swap (the narrow spawn race — KD-2). Bearer-gated by the auth hook
    // above like every control endpoint. Inert until an update pauses.
    typed.post(
      "/spawn-paused",
      {
        schema: {
          body: z.object({ paused: z.boolean() }),
          response: {
            200: z.object({ ok: z.boolean(), paused: z.boolean() }),
          },
        },
      },
      async req => {
        const { paused } = req.body;
        setSpawnPaused(paused);
        logger.debug(`[CONTROL SERVER] spawn-paused set to ${paused}`);
        return { ok: true, paused };
      }
    );

    // Runtime job registry snapshot (#1964, Sub-Issue D). The server's System
    // Jobs portal pulls this localhost-only endpoint to surface the daemon
    // process's in-process supervised loops alongside the server's own.
    typed.post(
      "/jobs",
      {
        schema: {
          response: {
            200: z.object({ jobs: z.array(JobStatusSchema) }),
          },
        },
      },
      async () => {
        logger.debug("[CONTROL SERVER] Jobs snapshot request");
        return { jobs: getJobs() };
      }
    );

    // Stop daemon
    typed.post(
      "/stop",
      {
        schema: {
          response: {
            200: z.object({
              status: z.string(),
            }),
          },
        },
      },
      async () => {
        logger.debug("[CONTROL SERVER] Stop daemon request received");

        // Give time for response to arrive
        setTimeout(() => {
          logger.debug("[CONTROL SERVER] Triggering daemon shutdown");
          requestShutdown();
        }, 50);

        return { status: "stopping" };
      }
    );

    app.listen({ port: 0, host: "127.0.0.1" }, (err, address) => {
      if (err) {
        logger.debug("[CONTROL SERVER] Failed to start:", err);
        throw err;
      }

      const port = parseInt(address.split(":").pop()!);
      logger.debug(`[CONTROL SERVER] Started on port ${port}`);

      resolve({
        port,
        token: controlToken,
        stop: async () => {
          logger.debug("[CONTROL SERVER] Stopping server");
          await app.close();
          logger.debug("[CONTROL SERVER] Server stopped");
        },
      });
    });
  });
}
