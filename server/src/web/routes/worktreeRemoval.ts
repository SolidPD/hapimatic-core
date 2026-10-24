// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `POST /api/machines/:machineId/worktrees/remove` — the operator-only removal
 * behind the `remove_worktree` MCP tool (issue #4450, epic #4403 member D).
 *
 * The route is `destructive` with `availability: { scope: "operator" }`, so the
 * generic invoker (`hapi_call`) refuses it twice and the catalog hides it from a
 * user caller. The MCP tool posts here directly with `X-Hapi-Session-Id`.
 *
 * What it allows (operator ruling G4 = A, G5 = A1; 4450-D1 = A): a session
 * removes the idle worktree of a session IT SPAWNED, and nothing else. The
 * server decides the owner from its own records — never from the request:
 *   R1  the caller derives operator scope NOW, else 404 (no existence oracle);
 *   R2  the owner is the one session whose recorded worktree path is the
 *       target's real path on that machine; base path and branch come from it;
 *   R3  refused: the caller's own worktree (or one holding the caller's cwd),
 *       a worktree inside which any other recorded session's cwd lies (active
 *       or not, on any machine), an active owner, no or several owners;
 *   R4  the owner's parent is the caller with `parentRelationship: "spawn"`,
 *       and the owner has a tag, which the daemon matches against the
 *       worktree's `.worktree-meta.json` (`cleanup-idle-worktree`).
 * The daemon then refuses a live, claimed, protected or unverifiable worktree
 * and only moves it to `.trash` (recoverable). Every attempt is logged (R6); a
 * removal marks the owner orphaned (R10).
 *
 * A machine whose daemon-reported host is not THIS server's hostname is
 * refused: the real path compare is meaningful only on the daemon's own
 * filesystem. The host is what the daemon reports; the daemon re-checks every
 * path on its own filesystem either way.
 */
import { Hono } from "hono";
import { realpath as fsRealpath } from "node:fs/promises";
import { hostname } from "node:os";
import { resolve, sep } from "node:path";
import { z } from "zod";
import { defineCapability } from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";
import {
  isOperatorCaller,
  type ScopeDeps,
} from "../../capabilities/availabilityContext";
import type { ErrorLogger } from "../../logging/errorLogger";
import type { Session, SyncEngine } from "../../sync/syncEngine";
import type { WebAppEnv } from "../middleware/auth";
import { CALLER_SESSION_HEADER, resolveCallerSession } from "./agentEscalation";
import { requireMachine } from "./guards";

/** The engine calls this route makes (structural, so tests pass a fake). */
export type WorktreeRemovalEngine = Pick<
  SyncEngine,
  | "getSession"
  | "getSessionByTagAndNamespace"
  | "getSessions"
  | "getMachine"
  | "cleanupIdleWorktree"
  | "markSessionOrphaned"
>;

export interface WorktreeRemovalOptions {
  errorLogger?: ErrorLogger;
  /** Test seam for the operator-scope inputs (default: the real host). */
  scopeDeps?: ScopeDeps;
  /** Test seam: this host's name (default `os.hostname()`). */
  getHostname?: () => string;
}

export const REMOVE_IDLE_WORKTREE_ENTRY = defineCapability({
  id: "machine-daemon.remove-idle-worktree",
  domain: "machine-daemon",
  surface: "rest",
  description:
    "Move the idle worktree of a session you spawned to .trash (recoverable); operator hosts only.",
  whenToUse: "To remove a spawned peer's idle worktree (remove_worktree).",
  invocation: {
    kind: "rest",
    method: "POST",
    path: "/api/machines/:machineId/worktrees/remove",
  },
  auth: "jwt",
  riskTier: "destructive",
  availability: { scope: "operator" },
  example: '{"worktreePath":"/home/matt/projects/app/.worktrees/peer-1"}',
});

const bodySchema = z.object({ worktreePath: z.string().min(1) });

/** `child` is `parent` or inside it (both already real, absolute paths). */
function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(`${parent}${sep}`);
}

/** The real path of `p`, or its lexical absolute form when it cannot be resolved. */
async function realOrResolved(p: string): Promise<string> {
  try {
    return await fsRealpath(p);
  } catch {
    return resolve(p);
  }
}

export function createWorktreeRemovalRoutes(
  getSyncEngine: () => WorktreeRemovalEngine | null,
  options: WorktreeRemovalOptions = {}
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  const getHostname = options.getHostname ?? hostname;

  app.post(
    "/machines/:machineId/worktrees/remove",
    cataloged(REMOVE_IDLE_WORKTREE_ENTRY),
    async c => {
      const machineId = c.req.param("machineId");
      const audit: Record<string, unknown> = { machineId };

      /** Answer AND log (R6) — every outcome passes through here. */
      const finish = (
        status: 200 | 400 | 404 | 409 | 503,
        code: string,
        body: Record<string, unknown>
      ): Response => {
        options.errorLogger?.info(
          `[remove_worktree] ${code} machine=${machineId} path=${String(audit.worktreePath ?? "?")}`,
          {
            category: "worktree-removal",
            sessionId: (audit.callerSessionId as string | undefined) ?? null,
            namespace: c.get("namespace") ?? null,
            requestPath: c.req.path,
            requestMethod: "POST",
            statusCode: status,
            context: { ...audit, outcome: code },
          }
        );
        return c.json(body, status);
      };
      const refuse = (
        status: 400 | 404 | 409 | 503,
        code: string,
        error: string
      ): Response => finish(status, code, { ok: false, code, error });

      // R1: decided first. The answer is the app's own unknown-route 404
      // (as adminVms does), so a non-operator learns nothing about this route.
      if (!isOperatorCaller(c, options.scopeDeps)) {
        finish(404, "not_operator", {});
        return c.notFound();
      }
      const engine = getSyncEngine();
      if (!engine) return refuse(503, "not_ready", "Sync engine unavailable");

      const parsed = bodySchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return refuse(400, "invalid_request", "worktreePath is required");
      }
      audit.worktreePath = parsed.data.worktreePath;

      if (!c.req.header(CALLER_SESSION_HEADER)) {
        return refuse(
          400,
          "caller_session_required",
          `${CALLER_SESSION_HEADER} is required`
        );
      }
      const caller = resolveCallerSession(c, engine);
      if (!caller) {
        return refuse(400, "caller_session_unknown", "Unknown caller session");
      }
      audit.callerSessionId = caller.id;

      const machine = requireMachine(c, engine as SyncEngine, machineId);
      if (machine instanceof Response) {
        return finish(machine.status as 404, "machine_unavailable", {
          ok: false,
          code: "machine_unavailable",
          error: "Machine not found",
        });
      }
      if (machine.metadata?.host !== getHostname()) {
        return refuse(
          409,
          "remote_machine_refused",
          "Only a machine whose daemon runs on this server host is supported"
        );
      }

      const target = await realOrResolved(parsed.data.worktreePath);
      audit.realPath = target;

      // R3: never the caller's own worktree, nor one holding the caller's cwd.
      const callerPaths = [
        caller.metadata?.worktree?.worktreePath,
        caller.metadata?.path,
      ].filter((p): p is string => typeof p === "string" && p.length > 0);
      for (const p of callerPaths) {
        if (isInside(await realOrResolved(p), target)) {
          return refuse(
            409,
            "own_worktree",
            "A session cannot remove its own worktree"
          );
        }
      }

      // R2: the owner is the one session that recorded this worktree here.
      const owners: Session[] = [];
      const users: Session[] = [];
      for (const s of engine.getSessions()) {
        const wt = s.metadata?.worktree?.worktreePath;
        if (
          wt &&
          s.metadata?.machineId === machineId &&
          (await realOrResolved(wt)) === target
        ) {
          owners.push(s);
          continue;
        }
        const cwd = s.metadata?.path;
        if (cwd && isInside(await realOrResolved(cwd), target)) users.push(s);
      }
      if (owners.length !== 1) {
        return refuse(
          409,
          "worktree_owner_unknown",
          owners.length === 0
            ? "No session recorded this worktree on this machine"
            : "Several sessions recorded this worktree"
        );
      }
      const owner = owners[0];
      audit.ownerSessionId = owner.id;
      if (owner.active || users.length > 0) {
        return refuse(
          409,
          "worktree_in_use",
          owner.active
            ? "The owning session is still active"
            : "Another recorded session's cwd is inside this worktree"
        );
      }

      // R4: only a peer the caller spawned, and only one with a tag to match.
      if (
        owner.namespace !== caller.namespace ||
        owner.parentSessionId !== caller.id ||
        owner.parentRelationship !== "spawn"
      ) {
        return refuse(
          409,
          "worktree_owner_mismatch",
          "The worktree belongs to a session the caller did not spawn"
        );
      }
      const worktree = owner.metadata?.worktree;
      if (!owner.tag || !worktree?.basePath || !worktree.branch) {
        return refuse(
          409,
          "worktree_owner_unknown",
          "The owning session has no tag or worktree record"
        );
      }

      const result = await engine.cleanupIdleWorktree(machineId, {
        basePath: worktree.basePath,
        worktreePath: target,
        branch: worktree.branch,
        expectedOwnerTag: owner.tag,
        sessionId: owner.id,
      });
      if (!result.success) {
        // The daemon prefixes a stable code; anything else is relayed as-is.
        const code =
          /^([a-z][a-z_]*): /.exec(result.message)?.[1] ?? "daemon_refused";
        return refuse(409, code, result.message);
      }

      // R10: the owner's cwd is gone; the persisted audit line is the record.
      engine.markSessionOrphaned(
        owner.id,
        "worktree removed by remove_worktree"
      );
      audit.holdingPath = result.holdingPath;
      return finish(200, "removed", {
        ok: true,
        ownerSessionId: owner.id,
        holdingPath: result.holdingPath ?? null,
        recover: "scripts/hapi-worktree.sh recover <name-or-branch>",
      });
    }
  );

  return app;
}
