// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines -- Grandfathered god-file (Epic 0, #2077); decomposition verdict tracked in claudedocs/architecture-hotspot-review.md. */
import {
  defineCapability,
  getPermissionModesForFlavor,
  isModelModeAllowedForFlavor,
  isPermissionModeAllowedForFlavor,
  toSessionSummary,
  type SessionSummary,
} from "@hapi/protocol";
import {
  EffortLevelSchema,
  ModelModeSchema,
  PermissionModeSchema,
  RelaunchRequestSchema,
  SetModelRequestSchema,
  SetPermissionModeRequestSchema,
} from "@hapi/protocol/schemas";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { SyncEngine, Session } from "../../sync/syncEngine";
import { reconcile, listForNamespace } from "../../sync/pendingSpawns";
import type { WebAppEnv } from "../middleware/auth";
import { createRateLimiter } from "../middleware/rateLimit";
import { requireSessionFromParam, requireSyncEngine } from "./guards";
import { cataloged } from "../../capabilities/cataloged";
import { logAndJson } from "./routeErrorHelper";
import type { NodeRegistry } from "../../federation/nodeRegistry";
import type { SessionService } from "../../services/sessionService";
import {
  BULK_SESSION_MAX_IDS,
  BulkSessionResultSchema,
  type BulkSessionResult,
} from "@hapi/protocol/bulkSessionResult";
import {
  runBulkDelete,
  runBulkSessionAction,
  type BulkSessionAction,
} from "./bulkSessionActions";
import type { PaymentMethodTarget } from "../../sync/accountRestart";
import {
  EMOJI_MUTATION,
  LINKED_ISSUE_MUTATION,
  PARENT_MUTATION,
  NEEDS_REVIEW_OVERRIDE_MUTATION,
  AUTO_RECOVER_MUTATION,
  UI_COLLAPSE_STATE_MUTATION,
  NOTES_MUTATION,
  VIEW_MUTATION,
  PROMPT_DRAFT_MUTATION,
  RENAME_MUTATION,
  CEILING_OVERRIDE_MUTATION,
  resolveClientInvalidBody,
} from "./sessionMutationHandlers";
import type { AccountService } from "../../services/accountService";
import type { ErrorLogger } from "../../logging/errorLogger";
import { scanSlashCommandsFromFilesystem } from "../../utils/slashCommands";
import {
  recordSessionsLatency,
  getSessionsP95Ms,
} from "../../metrics/sessionsMetrics";

const permissionModeSchema = z.object({
  mode: PermissionModeSchema,
});

const mcpToggleSchema = z.object({
  serverName: z.string().min(1),
  enabled: z.boolean(),
});

const mcpSetDesiredSchema = z.object({
  desired: z.record(z.string(), z.boolean()),
});

// Issue #1451 (Sub-Issue E): set an existing session's Anthropic account.
// Issue #4823: the payment-method target — EXACTLY ONE of a subscription account
// (`accountUuid`) or a node-vault Anthropic API key (`apiKeyId`, the vault id —
// never the key; same bounds as the spawn body). Both or neither → 400.
const setSessionAccountSchema = z
  .object({
    accountUuid: z.string().uuid().optional(),
    apiKeyId: z.string().min(1).max(200).optional(),
  })
  .refine(
    b => (b.accountUuid === undefined) !== (b.apiKeyId === undefined),
    "Send exactly one of accountUuid or apiKeyId"
  );

const modelModeSchema = z.object({
  model: ModelModeSchema,
});

// Issue #2456: in-session reasoning-effort change (wires #2455's disabled Effort
// row live) and specific pinned raw-model change ("More models" flyout).
const effortSchema = z.object({
  effort: EffortLevelSchema,
});
const rawModelSchema = z.object({
  rawModel: z.string().min(1).max(200),
});

// Issue #2082: the 8 per-session field-mutation schemas moved to the shared
// sessionMutationHandlers descriptor table (single source of truth for both
// the client routes below and the federation receivers).

const branchSessionSchema = z.object({
  branchLabel: z.string().max(255).optional(),
});

// Issue #1325: server-backed queue route schemas.
const enqueueQueuedMessageBodySchema = z.object({
  body: z.string().min(1).max(50_000),
  clientGeneratedId: z.string().min(1).max(200).nullable().optional(),
});

const updateQueuedMessageBodySchema = z.object({
  body: z.string().min(1).max(50_000),
});

// #1032: per-namespace coalescing map for in-flight /api/sessions computations.
// When many clients poll simultaneously under memory pressure, we only want
// one sqlite read + one sort + one serialize per namespace, not N.
const inFlightSessionsByNamespace = new Map<
  string,
  Promise<SessionSummary[]>
>();

// Test-only helpers. Not exported for production use.
export function resetInFlightMapForTesting(): void {
  inFlightSessionsByNamespace.clear();
}
export function getInFlightMapSizeForTesting(): number {
  return inFlightSessionsByNamespace.size;
}

// Rate-limited warn-log gate for the sessions-slow detector (#1032). One
// warn per namespace per minute keeps error_logs useful during a storm.
const SLOW_THRESHOLD_MS = 1000;
const SLOW_LOG_INTERVAL_MS = 60_000;
const lastSlowLogAtByNamespace = new Map<string, number>();

function computeSessions(
  engine: SyncEngine,
  namespace: string
): SessionSummary[] {
  const getPendingCount = (s: Session) =>
    s.agentState?.requests ? Object.keys(s.agentState.requests).length : 0;

  const allSessions = engine.getSessionsByNamespace(namespace);
  const messageCounts = engine.getMessageCountsByNamespace(namespace);
  const branchCounts = engine.getChildBranchCounts(namespace);

  const real = allSessions
    .sort((a, b) => {
      // Active sessions first
      if (a.active !== b.active) {
        return a.active ? -1 : 1;
      }
      // Within active sessions, sort by pending requests count
      const aPending = getPendingCount(a);
      const bPending = getPendingCount(b);
      if (a.active && aPending !== bPending) {
        return bPending - aPending;
      }
      // Then by updatedAt
      return b.updatedAt - a.updatedAt;
    })
    .map(s =>
      toSessionSummary(
        s,
        messageCounts.get(s.id),
        branchCounts.get(s.id),
        // #1804 (A2): resolve the linked-issue workflow badge server-side so the
        // Row-1 state badge rides the summary (no per-card client query).
        engine.getSessionWorkflowBadge(s.id)
      )
    );

  // Issue #1565 (Option B): merge server-side spawning/failed placeholders so
  // CLI + web read the spawn lifecycle uniformly. Reconcile by exact id first
  // (drop a placeholder once its real session — same hapiSessionId — appears),
  // then prepend remaining placeholders so a freshly-spawning session shows at top.
  // Reconcile by the real session's TAG (== the pre-generated hapiSessionId the
  // placeholder is keyed on) AND id — the surfaced session id is a different
  // happySessionId UUID, so id-only matching would never reconcile (issue #1565).
  reconcile(
    namespace,
    new Set(
      real.flatMap(s => [s.id, s.tag]).filter((v): v is string => Boolean(v))
    )
  );
  const placeholders = listForNamespace(namespace);
  return placeholders.length > 0 ? [...placeholders, ...real] : real;
}

export function createSessionsRoutes(
  getSyncEngine: () => SyncEngine | null,
  options?: {
    getNodeRegistry?: () => NodeRegistry | null;
    federationApiToken?: string | null;
    getSessionService?: () => SessionService | null;
    getAccountService?: () => AccountService | null;
    errorLogger?: ErrorLogger | null;
  }
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  const errorLogger = options?.errorLogger ?? null;

  app.get(
    "/sessions",
    cataloged(
      defineCapability({
        id: "session-introspection.list",
        domain: "session-introspection",
        surface: "rest",
        description:
          "List the caller's sessions (active first), each enriched with message and branch counts plus its workflow badge.",
        whenToUse:
          "When the user wants to see their running and past sessions.",
        invocation: { kind: "rest", method: "GET", path: "/api/sessions" },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
        telemetry: "off",
      })
    ),
    async c => {
      // #1032: bail out early if the client already gave up waiting. No point
      // running sqlite or sort work that will never be read. Under the blocked-
      // event-loop pathology this removes the largest source of CLOSE-WAIT.
      if (c.req.raw.signal.aborted) {
        // 499 is the nginx "client closed request" code; Hono's StatusCode
        // union doesn't include it, so construct the response directly.
        return new Response(null, { status: 499 });
      }

      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) {
        return engine;
      }

      const namespace = c.get("namespace");

      // #1032: coalesce concurrent computations. If another request is already
      // computing this namespace's session list, await its result instead of
      // re-running everything. The map entry is cleared via `.finally()`
      // chained AFTER `.set()` below so we never serve a stale resolved
      // Promise — this is request-deduplication, not a TTL cache.
      //
      // #1068: the cleanup MUST happen after `set()` on the Promise settle
      // event, not inside an async IIFE. If the `finally { delete }` is
      // written inside an IIFE body, it executes in the microtask queue
      // immediately after the synchronous body resolves, BEFORE the
      // surrounding `if (!existing) { set }` runs — leaving a permanently
      // cached resolved Promise that serves stale data forever.
      const existing = inFlightSessionsByNamespace.get(namespace);
      const computation =
        existing ??
        Promise.resolve().then(() => computeSessions(engine, namespace));
      if (!existing) {
        inFlightSessionsByNamespace.set(namespace, computation);
        // Defence-in-depth: only delete if the Map entry still points at this
        // computation. Given the `if (!existing)` guard a later computation
        // can't replace the entry before ours settles, but the guard is cheap.
        void computation.finally(() => {
          if (inFlightSessionsByNamespace.get(namespace) === computation) {
            inFlightSessionsByNamespace.delete(namespace);
          }
        });
      }

      const started = performance.now();
      const sessions = await computation;
      const elapsedMs = performance.now() - started;

      // #1032: record latency for the /api/health sessionsP95Ms metric and
      // warn-log any namespace whose p95 crossed the slow threshold. Logging
      // is rate-limited per namespace to keep the error_logs table sane.
      recordSessionsLatency(namespace, elapsedMs);
      const p95 = getSessionsP95Ms(namespace);
      if (errorLogger && p95 !== null && p95 > SLOW_THRESHOLD_MS) {
        const now = Date.now();
        const lastAt = lastSlowLogAtByNamespace.get(namespace) ?? 0;
        if (now - lastAt >= SLOW_LOG_INTERVAL_MS) {
          lastSlowLogAtByNamespace.set(namespace, now);
          errorLogger.warn(
            `/api/sessions p95=${p95.toFixed(0)}ms over ${SLOW_THRESHOLD_MS}ms threshold`,
            {
              category: "sessions-slow",
              context: { namespace, p95Ms: p95 },
            }
          );
        }
      }

      // One more abort check before sending. If the client bailed while we
      // were waiting on the coalesced promise, skip the serialize+send step.
      if (c.req.raw.signal.aborted) {
        // 499 is the nginx "client closed request" code; Hono's StatusCode
        // union doesn't include it, so construct the response directly.
        return new Response(null, { status: 499 });
      }

      return c.json({ sessions });
    }
  );

  app.get(
    "/sessions/:id",
    cataloged(
      defineCapability({
        id: "session-introspection.detail",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Fetch one session's full detail including agentState for permission rendering, with proxy fallback to the owning node.",
        whenToUse:
          "When the user opens a session and needs its complete state.",
        invocation: { kind: "rest", method: "GET", path: "/api/sessions/:id" },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) {
        return engine;
      }

      const sessionResult = requireSessionFromParam(c, engine);
      if (sessionResult instanceof Response) {
        // Federation fallback: proxy to remote node for full session detail
        // (including agentState, which is needed for permission rendering)
        const registry = options?.getNodeRegistry?.();
        if (registry) {
          const sessionId = c.req.param("id");
          const node = registry.findNodeForSession(sessionId);
          if (node) {
            const headers: Record<string, string> = {};
            if (options?.federationApiToken) {
              headers["Authorization"] = `Bearer ${options.federationApiToken}`;
            }
            try {
              const resp = await fetch(
                `${node.url}/api/federation/sessions/${encodeURIComponent(sessionId)}`,
                { headers }
              );
              if (resp.ok) {
                const body = (await resp.json()) as {
                  session?: Record<string, unknown>;
                  messageCount?: number;
                };
                // Enrich with the owning node's identity so the web client's
                // instance view shows the correct nodeLabel. Without this, the
                // remote node's /federation/sessions/:id returns a raw Session
                // with no nodeId/nodeLabel, and the React fallback to
                // localNode.nodeLabel mislabels the badge as the hub (#825).
                // Mirrors the cached SessionSummary fallback below and the
                // enrichment in nodeRegistry.getAllRemoteSessions().
                const nodeSummary = registry
                  .getNodeSummaries()
                  .find(s => s.nodeId === node.nodeId);
                if (body.session && nodeSummary) {
                  body.session = {
                    ...body.session,
                    nodeId: nodeSummary.nodeId,
                    nodeLabel: nodeSummary.nodeLabel,
                    nodeUrl: nodeSummary.url,
                    nodeStatus: nodeSummary.status,
                  };
                }
                return c.json(body as Record<string, unknown>);
              }
            } catch {
              // Proxy failed — fall through to cached summary below
            }
          }

          // Final fallback: return cached SessionSummary if proxy failed.
          // Normalize metadata.notes to top-level notes so the frontend's
          // session.notes access works (SessionSummary stores notes inside
          // metadata, but Session has it top-level). The value is opaque here —
          // a legacy string or a JSON-serialized NotesContent envelope (#1075);
          // the server passes it through verbatim and clients decode via
          // parseNotes().
          const remoteSessions = registry.getAllRemoteSessions();
          const remote = remoteSessions.find(s => s.id === sessionId);
          if (remote) {
            return c.json({
              session: {
                ...remote,
                notes: remote.metadata?.notes ?? undefined,
                persistedView: remote.metadata?.persistedView ?? undefined,
                promptDraft: remote.metadata?.promptDraft ?? undefined,
              },
              messageCount: remote.messageCount ?? 0,
            });
          }
        }
        return sessionResult;
      }

      const messageCount = engine.getMessageCountForSession(
        sessionResult.sessionId
      );
      return c.json({ session: sessionResult.session, messageCount });
    }
  );

  app.post(
    "/sessions/:id/abort",
    cataloged(
      defineCapability({
        id: "session-lifecycle.abort-session",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Abort the running turn of an active session, with proxy fallback to the session's owning federation node.",
        whenToUse: "When the user stops a session's in-progress work.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/sessions/:id/abort",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) {
        return engine;
      }

      const sessionResult = requireSessionFromParam(c, engine, {
        requireActive: true,
      });
      if (!(sessionResult instanceof Response)) {
        await engine.abortSession(sessionResult.sessionId);
        return c.json({ ok: true });
      }

      // Federation fallback: proxy abort to the remote node
      const registry = options?.getNodeRegistry?.();
      if (registry) {
        const sessionId = c.req.param("id");
        const node = registry.findNodeForSession(sessionId);
        if (node) {
          const headers: Record<string, string> = {
            "Content-Type": "application/json",
          };
          if (options?.federationApiToken) {
            headers["Authorization"] = `Bearer ${options.federationApiToken}`;
          }
          const resp = await fetch(
            `${node.url}/api/federation/sessions/${encodeURIComponent(sessionId)}/abort`,
            { method: "POST", headers, body: "{}" }
          );
          if (resp.ok) {
            return c.json({ ok: true });
          }
          const body = await resp.json().catch(() => ({}));
          return c.json(
            body as Record<string, unknown>,
            resp.status as 400 | 404 | 409 | 500 | 503
          );
        }
      }

      return sessionResult;
    }
  );

  app.post(
    "/sessions/:id/archive",
    cataloged(
      defineCapability({
        id: "session-lifecycle.archive",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Archive a live session for later reconnect, reaping its launcher window while preserving the reconnect target.",
        whenToUse:
          "When the user disconnects a session but may resume it later.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/sessions/:id/archive",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) {
        return engine;
      }

      const sessionResult = requireSessionFromParam(c, engine, {
        requireActive: true,
      });
      if (!(sessionResult instanceof Response)) {
        // #1603: manual archive is a TERMINAL archive (no respawn follows) —
        // reap the launcher's hapimatic-remote window B so its claude does not
        // orphan when the session is archived but never deleted.
        // #2683: this is the DELIBERATE archive-for-reconnect of a LIVE session
        // (the requireActive gate above guarantees the session is alive) —
        // preserveForReconnect tags window A `@hapi_archive` so the daemon's
        // orphan reconciliation reaper preserves it for reconnect. Window B is
        // still reaped by reapRemoteWindow; only window A (the reconnect target)
        // is tagged and preserved.
        await engine.archiveSession(sessionResult.sessionId, {
          reapRemoteWindow: true,
          preserveForReconnect: true,
        });
        return c.json({ ok: true });
      }

      // Federation fallback: proxy archive to the remote node
      const registry = options?.getNodeRegistry?.();
      if (registry) {
        const sessionId = c.req.param("id");
        const node = registry.findNodeForSession(sessionId);
        if (node) {
          const headers: Record<string, string> = {
            "Content-Type": "application/json",
          };
          if (options?.federationApiToken) {
            headers["Authorization"] = `Bearer ${options.federationApiToken}`;
          }
          const resp = await fetch(
            `${node.url}/api/federation/sessions/${encodeURIComponent(sessionId)}/archive`,
            { method: "POST", headers, body: "{}" }
          );
          if (resp.ok) {
            // Immediately update cached session state so subsequent
            // client queries see the session as inactive without waiting
            // for the next poll cycle.
            registry.markSessionInactive(sessionId);
            return c.json({ ok: true });
          }
          const body = await resp.json().catch(() => ({}));
          return c.json(
            body as Record<string, unknown>,
            resp.status as 400 | 404 | 409 | 500 | 503
          );
        }
      }

      return sessionResult;
    }
  );

  app.post(
    "/sessions/:id/reconnect",
    cataloged(
      defineCapability({
        id: "session-lifecycle.reconnect",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Respawn a disconnected session via resume, surfacing capacity, account-health, and worktree-deleted terminal states.",
        whenToUse:
          "When the user resumes a previously archived or disconnected session.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/sessions/:id/reconnect",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) {
        return engine;
      }

      // Session must exist but must NOT be active
      const sessionResult = requireSessionFromParam(c, engine);
      if (!(sessionResult instanceof Response)) {
        if (sessionResult.session.active) {
          return c.json({ error: "Session is already active" }, 400);
        }

        // Issue #2301 (Task 4): forward the request abort signal so a client
        // disconnect cancels reconnectSession's bounded wait-for-slot poll.
        const result = await engine.reconnectSession(
          sessionResult.sessionId,
          c.req.raw.signal
        );
        if (result.type === "success") {
          return c.json({ ok: true, newSessionId: result.newSessionId });
        }

        // Issue #1698 (G3-b surfacing): a reconnect refused by the pre-spawn
        // account-health gate returns code "account_unrefreshable" → HTTP 409
        // (not a generic 500) so the UI shows the re-login CTA. reconnectSession
        // also emitted the session-scoped SSE toast event for this case.
        if (result.code === "account_unrefreshable") {
          return c.json({ error: result.message, code: result.code }, 409);
        }

        // Issue #1778: the session's working directory (worktree) was deleted out
        // from under it — a terminal, unrecoverable state. Return 502 with the
        // code so the web client surfaces an actionable "worktree deleted" message
        // instead of looping the reconnect spinner. Parity with the federated
        // node-to-node path (sessionLifecycle.ts), which returns the same shape.
        if (result.code === "cwd_missing") {
          return c.json({ error: result.message, code: result.code }, 502);
        }
        // Issue #2300 (R2): a reconnect refused because the node is at capacity
        // carries code "at_capacity" (minted at the daemon gate, #1772; threaded
        // through sessionRespawn's generic return, #2300 Task 2). Surface it as a
        // 409 (retryable capacity conflict) so the UI ends the spinner and shows an
        // actionable "node full — free a slot" message instead of looping. Parity
        // with the account_unrefreshable (409) and cwd_missing (502) branches above.
        if (result.code === "at_capacity") {
          return c.json({ error: result.message, code: result.code }, 409);
        }

        return c.json({ error: result.message }, 500);
      }

      // Federation fallback: proxy reconnect to the remote node
      const registry = options?.getNodeRegistry?.();
      if (registry) {
        const sessionId = c.req.param("id");
        const node = registry.findNodeForSession(sessionId);
        if (node) {
          const result = await registry.reconnectOnNode(node.nodeId, sessionId);
          if (result.type === "success") {
            return c.json({ ok: true, newSessionId: result.newSessionId });
          }
          // Issue #1778: thread the terminal error code (e.g. "cwd_missing") to
          // the client so the UI can show an actionable message rather than
          // spinning. reconnectOnNode now surfaces the node's code (was dropped).
          return c.json({ error: result.message, code: result.code }, 502);
        }
      }

      return sessionResult;
    }
  );

  app.post(
    "/sessions/:id/branch",
    cataloged(
      defineCapability({
        id: "session-lifecycle.branch",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Fork a session's conversation history into a new branched session, optionally under a supplied branch label.",
        whenToUse:
          "When the user explores an alternate path from an existing session.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/sessions/:id/branch",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) {
        return engine;
      }

      // Parse optional branch label from request body
      let branchLabel: string | undefined;
      try {
        const body = await c.req.json();
        const parsed = branchSessionSchema.safeParse(body);
        if (parsed.success) {
          branchLabel = parsed.data.branchLabel;
        }
      } catch {
        // Empty body is fine — branchLabel is optional
      }

      // Session must exist (can be active or inactive — branching forks history)
      const sessionResult = requireSessionFromParam(c, engine);
      if (!(sessionResult instanceof Response)) {
        const result = await engine.branchSession(
          sessionResult.sessionId,
          branchLabel
        );
        if (result.type === "success") {
          return c.json({ ok: true, newSessionId: result.newSessionId });
        }

        return c.json({ error: result.message }, 500);
      }

      // Federation fallback: proxy branch to the remote node
      const registry = options?.getNodeRegistry?.();
      if (registry) {
        const sessionId = c.req.param("id");
        const node = registry.findNodeForSession(sessionId);
        if (node) {
          const result = await registry.branchOnNode(
            node.nodeId,
            sessionId,
            branchLabel
          );
          if (result.type === "success") {
            return c.json({ ok: true, newSessionId: result.newSessionId });
          }
          return c.json({ error: result.message }, 502);
        }
      }

      return sessionResult;
    }
  );

  app.post(
    "/sessions/:id/switch",
    cataloged(
      defineCapability({
        id: "session-lifecycle.switch-remote",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Switch an active session's terminal to remote mode so it can be driven from the web client.",
        whenToUse:
          "When the user takes over a local terminal session from the web UI.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/sessions/:id/switch",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) {
        return engine;
      }

      const sessionResult = requireSessionFromParam(c, engine, {
        requireActive: true,
      });
      if (sessionResult instanceof Response) {
        return sessionResult;
      }

      await engine.switchSession(sessionResult.sessionId, "remote");
      return c.json({ ok: true });
    }
  );

  const mcpToggleLimiter = createRateLimiter({ name: "mcp-toggle" });

  /**
   * POST /sessions/:id/mcp-toggle — Toggle an MCP server on a remote-mode
   * Claude session (issue #1077). Local-mode sessions return 501 with
   * code:"local_mode_not_supported". Federated sessions are proxied via
   * sessionService to the owning node.
   */
  app.post(
    "/sessions/:id/mcp-toggle",
    cataloged(
      defineCapability({
        id: "mcp.session-toggle",
        domain: "mcp",
        surface: "rest",
        description:
          "Toggle a single MCP server on or off for a remote-mode session, proxied to the owning node.",
        whenToUse:
          "When the user enables or disables one MCP server on a session.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/sessions/:id/mcp-toggle",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    mcpToggleLimiter,
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) {
        return engine;
      }

      const body = await c.req.json().catch(() => null);
      const parsed = mcpToggleSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { ok: false, error: "Invalid body", code: "invalid_request" },
          400
        );
      }

      const sessionId = c.req.param("id");
      const namespace = c.get("namespace");

      const localSession = engine.getSession(sessionId);
      if (localSession && localSession.namespace !== namespace) {
        return c.json(
          { ok: false, error: "Session not found", code: "session_not_found" },
          404
        );
      }

      const service = options?.getSessionService?.();
      if (!service) {
        return c.json(
          { ok: false, error: "Session service unavailable", code: "unknown" },
          503
        );
      }

      const result = await service.mcpToggle(
        sessionId,
        parsed.data.serverName,
        parsed.data.enabled,
        namespace
      );

      if (result.ok) {
        return c.json(result, 200);
      }
      if (result.code === "local_mode_not_supported") {
        return c.json(result, 501);
      }
      if (result.code === "session_not_found") {
        return c.json(result, 404);
      }
      if (result.code === "invalid_request") {
        return c.json(result, 400);
      }
      return c.json(result, 409);
    }
  );

  const setModelLimiter = createRateLimiter({ name: "set-model" });

  /**
   * POST /sessions/:id/set-model — set the model family/mode on a session
   * (issue #2256). Reaches the landed #2421 runClaude "set-model" handler via
   * the federation-aware SessionService → SyncEngine → rpcGateway chain. Unlike
   * mcp-toggle there is NO 501 branch: the handler is registered on EVERY
   * launcher class, so a session with no live SDK query degrades to a durable
   * pin apply (method:"config") rather than a local-mode rejection. Federated
   * sessions are proxied via sessionService to the owning node.
   */
  app.post(
    "/sessions/:id/set-model",
    cataloged(
      defineCapability({
        id: "model-permission.session-set-model",
        domain: "model-permission",
        surface: "rest",
        description:
          "Set a session's model family or mode live through the federation-aware session service and RPC chain.",
        whenToUse: "When the user changes which model a session runs.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/sessions/:id/set-model",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    setModelLimiter,
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) {
        return engine;
      }

      const body = await c.req.json().catch(() => null);
      const parsed = SetModelRequestSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { ok: false, error: "Invalid body", code: "invalid_request" },
          400
        );
      }

      const sessionId = c.req.param("id");
      const namespace = c.get("namespace");

      const localSession = engine.getSession(sessionId);
      if (localSession && localSession.namespace !== namespace) {
        return c.json(
          { ok: false, error: "Session not found", code: "session_not_found" },
          404
        );
      }

      const service = options?.getSessionService?.();
      if (!service) {
        return c.json(
          { ok: false, error: "Session service unavailable", code: "unknown" },
          503
        );
      }

      const result = await service.setModel(
        sessionId,
        parsed.data.modelMode,
        namespace
      );

      if (result.ok) {
        return c.json(result, 200);
      }
      if (result.code === "session_not_found") {
        return c.json(result, 404);
      }
      if (result.code === "invalid_request") {
        return c.json(result, 400);
      }
      return c.json(result, 409);
    }
  );

  const setPermissionModeLimiter = createRateLimiter({
    name: "set-permission-mode",
  });

  /**
   * POST /sessions/:id/set-permission-mode — set the permission mode on a session
   * (issue #2346). Mirrors mcp-toggle (NOT set-model): the handler is launcher-
   * registered, so this route KEEPS the 501 local_mode_not_supported branch (a
   * non-sdk / local-mode session rejects) and a 409 no_active_query. Federated
   * sessions proxy to the owning node via sessionService. The mode is validated
   * against the closed PermissionMode enum at the schema boundary (KD-3) → a typo
   * is a 400, never a silently-ignored control request.
   */
  app.post(
    "/sessions/:id/set-permission-mode",
    cataloged(
      defineCapability({
        id: "model-permission.session-set-permission-mode",
        domain: "model-permission",
        surface: "rest",
        description:
          "Set a session's permission mode live, rejecting a mode not allowed for the session flavor and proxying to the owner.",
        whenToUse: "When the user changes a session's permission mode live.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/sessions/:id/set-permission-mode",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    setPermissionModeLimiter,
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) {
        return engine;
      }

      const body = await c.req.json().catch(() => null);
      const parsed = SetPermissionModeRequestSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { ok: false, error: "Invalid body", code: "invalid_request" },
          400
        );
      }

      const sessionId = c.req.param("id");
      const namespace = c.get("namespace");

      const localSession = engine.getSession(sessionId);
      if (localSession && localSession.namespace !== namespace) {
        return c.json(
          { ok: false, error: "Session not found", code: "session_not_found" },
          404
        );
      }

      const service = options?.getSessionService?.();
      if (!service) {
        return c.json(
          { ok: false, error: "Session service unavailable", code: "unknown" },
          503
        );
      }

      const result = await service.setPermissionMode(
        sessionId,
        parsed.data.mode,
        namespace
      );

      if (result.ok) {
        return c.json(result, 200);
      }
      if (result.code === "local_mode_not_supported") {
        return c.json(result, 501);
      }
      if (result.code === "session_not_found") {
        return c.json(result, 404);
      }
      if (result.code === "invalid_request") {
        return c.json(result, 400);
      }
      return c.json(result, 409);
    }
  );

  /**
   * GET /sessions/:id/token-stats — server-authoritative session token totals
   * (`v_session_totals`) + the per-turn breakdown (issue #1671, epic #1662
   * Sub I). Local sessions read directly; remote sessions proxy to the owning
   * node (mirrors getMcpBatchState). Cross-namespace LOCAL sessions return 404
   * (no existence leak, #1097). The web client falls back to its client-side
   * aggregate (R7) on any non-200.
   */
  app.get(
    "/sessions/:id/token-stats",
    cataloged(
      defineCapability({
        id: "session-introspection.token-stats",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Return server-authoritative token totals and the per-turn token breakdown for a session.",
        whenToUse: "When rendering a session's token-usage footer or status.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/sessions/:id/token-stats",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
        telemetry: "off",
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) {
        return engine;
      }

      const sessionId = c.req.param("id");
      const namespace = c.get("namespace");

      const localSession = engine.getSession(sessionId);
      if (localSession && localSession.namespace !== namespace) {
        return c.json({ error: "Session not found" }, 404);
      }

      const sessionService = options?.getSessionService?.();
      if (sessionService) {
        const result = await sessionService.getSessionTokenStats(
          sessionId,
          namespace
        );
        if (result.type === "not-found") {
          return c.json({ error: "Session not found" }, 404);
        }
        if (result.type === "error") {
          return c.json(
            { error: result.message },
            result.status as 400 | 404 | 500 | 502 | 503
          );
        }
        return c.json(result.data);
      }

      // Fallback: SessionService not wired (e.g. unit tests) — local node only.
      if (!localSession) {
        return c.json({ error: "Session not found" }, 404);
      }
      return c.json(engine.getSessionTokenStats(sessionId));
    }
  );

  /**
   * GET /sessions/:id/workflow-state — per-turn workflow chip data + session
   * checkpoint badge from captured label events (issue #1672, epic #1662 Sub J).
   * Local sessions read `v_workflow_state` + `turn_events` label rows directly;
   * remote sessions proxy to the owning node (mirrors token-stats). Cross-namespace
   * LOCAL sessions return 404 (no existence leak, #1097). The web client renders
   * nothing (R7) on any non-200.
   */
  app.get(
    "/sessions/:id/workflow-state",
    cataloged(
      defineCapability({
        id: "session-introspection.workflow-state",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Return per-turn workflow chip data and a session's checkpoint badge derived from captured label events.",
        whenToUse: "When rendering a session's workflow badges and chips.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/sessions/:id/workflow-state",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
        telemetry: "off",
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) {
        return engine;
      }

      const sessionId = c.req.param("id");
      const namespace = c.get("namespace");

      const localSession = engine.getSession(sessionId);
      if (localSession && localSession.namespace !== namespace) {
        return c.json({ error: "Session not found" }, 404);
      }

      const sessionService = options?.getSessionService?.();
      if (sessionService) {
        const result = await sessionService.getSessionWorkflowState(
          sessionId,
          namespace
        );
        if (result.type === "not-found") {
          return c.json({ error: "Session not found" }, 404);
        }
        if (result.type === "error") {
          return c.json(
            { error: result.message },
            result.status as 400 | 404 | 500 | 502 | 503
          );
        }
        return c.json(result.data);
      }

      // Fallback: SessionService not wired (e.g. unit tests) — local node only.
      if (!localSession) {
        return c.json({ error: "Session not found" }, 404);
      }
      return c.json(engine.getSessionWorkflowState(sessionId));
    }
  );

  /**
   * POST /sessions/:id/account — Set the Anthropic account for an existing
   * session (issue #1451, Sub-Issue E). E validates the request and returns the
   * { ok, restartRequired } contract; Sub-Issue J (#1456) wires the actual
   * session.switchAccount() persistence + process restart.
   */
  app.post(
    "/sessions/:id/account",
    cataloged(
      defineCapability({
        id: "accounts.session-switch",
        domain: "accounts",
        surface: "rest",
        description:
          "Switch an existing session's payment method on its owning node — a subscription account or a node-vault Anthropic API key — restarting or staging the session process.",
        whenToUse:
          "When the user changes which account or Anthropic API key a session runs under.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/sessions/:id/account",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) {
        return engine;
      }

      const body = await c.req.json().catch(() => null);
      const parsed = setSessionAccountSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { ok: false, error: "Invalid body", code: "invalid_request" },
          400
        );
      }

      const sessionId = c.req.param("id");
      const namespace = c.get("namespace");

      // Issue #1456 (Sub-Issue J): federation-aware. A cross-namespace LOCAL
      // session returns 404 (no existence leak, mirrors mcp-toggle/#1097). A
      // non-local session is NOT rejected here — SessionService.switchAccount
      // proxies it to the owning node, which validates the account against its
      // own store and performs the kill+respawn locally.
      const localSession = engine.getSession(sessionId);
      if (localSession && localSession.namespace !== namespace) {
        return c.json(
          { ok: false, error: "Session not found", code: "session_not_found" },
          404
        );
      }

      const service = options?.getSessionService?.();
      if (!service) {
        return c.json(
          { ok: false, error: "Session service unavailable", code: "unknown" },
          503
        );
      }

      // Account existence + refreshability (and, issue #4823, an API-key target's
      // vault entry + launcher / local-mode / agent fitness) are validated inside
      // the engine on the OWNING node — the account record and the vault live
      // where the session runs. A key target for a peer-owned session is refused
      // by the service before any proxy (keys are node-local).
      const target: PaymentMethodTarget =
        parsed.data.apiKeyId !== undefined
          ? { kind: "api-key", apiKeyId: parsed.data.apiKeyId }
          : { kind: "account", accountUuid: parsed.data.accountUuid! };
      const result = await service.switchPaymentMethod(
        sessionId,
        target,
        namespace,
        // Issue #2299 (Task 4): forward the request abort signal so a client
        // disconnect cancels switchAccount's bounded pre-kill capacity wait.
        c.req.raw.signal
      );
      if (result.type === "success") {
        // issue #3633: a DISCONNECTED session was STAGED (no relaunch) — answer
        // { restartRequired: false, staged: true }. The `staged` key appears ONLY
        // on the staged branch, so the ACTIVE-session envelope stays byte-identical
        // { ok:true, restartRequired:true } (regression lock in sessions.test.ts).
        return c.json({
          ok: true,
          restartRequired: !result.staged,
          ...(result.staged ? { staged: true } : {}),
        });
      }
      if (result.type === "not-found") {
        return c.json(
          { ok: false, error: "Session not found", code: "session_not_found" },
          404
        );
      }
      return c.json(
        { ok: false, error: result.message, code: result.code },
        result.status as 400 | 404 | 409 | 500 | 502 | 503
      );
    }
  );

  /**
   * POST /sessions/:id/mcp-set-desired — Submit a partial desired-state
   * map for the session's MCP servers (issue #989 follow-up). The
   * server-side worker reconciles desired vs current and toggles only
   * the names that differ. Survives client backgrounding.
   */
  app.post(
    "/sessions/:id/mcp-set-desired",
    cataloged(
      defineCapability({
        id: "mcp.set-desired",
        domain: "mcp",
        surface: "rest",
        description:
          "Submit a partial desired-state map for a session's MCP servers; the server reconciles and toggles only the differences.",
        whenToUse:
          "When the user sets several MCP servers on a session at once.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/sessions/:id/mcp-set-desired",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) return engine;

      const body = await c.req.json().catch(() => null);
      const parsed = mcpSetDesiredSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { ok: false, error: "Invalid body", code: "invalid_request" },
          400
        );
      }

      const sessionId = c.req.param("id");
      const namespace = c.get("namespace");

      const localSession = engine.getSession(sessionId);
      if (localSession && localSession.namespace !== namespace) {
        return c.json(
          { ok: false, error: "Session not found", code: "session_not_found" },
          404
        );
      }

      const service = options?.getSessionService?.();
      if (!service) {
        return c.json(
          { ok: false, error: "Session service unavailable", code: "unknown" },
          503
        );
      }

      const result = await service.setMcpDesired(
        sessionId,
        parsed.data.desired,
        namespace
      );
      if (result.type === "success") {
        return c.json({ ok: true, snapshot: result.snapshot }, 200);
      }
      if (result.type === "not-found") {
        return c.json(
          { ok: false, error: "Session not found", code: "session_not_found" },
          404
        );
      }
      return c.json(
        { ok: false, error: result.message, code: "transport_failed" },
        result.status as 400 | 500 | 502 | 503
      );
    }
  );

  /**
   * GET /sessions/:id/mcp-batch-state — Read the current MCP batch
   * snapshot for a session. Useful when the client connects mid-batch
   * (e.g. after refresh) and needs to render progress without waiting
   * for the next SSE event.
   */
  app.get(
    "/sessions/:id/mcp-batch-state",
    cataloged(
      defineCapability({
        id: "mcp.batch-state",
        domain: "mcp",
        surface: "rest",
        description:
          "Read the current MCP batch reconciliation snapshot for a session so a reconnecting client can render progress.",
        whenToUse: "When a client connects mid-batch and needs MCP progress.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/sessions/:id/mcp-batch-state",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) return engine;

      const sessionId = c.req.param("id");
      const namespace = c.get("namespace");

      const localSession = engine.getSession(sessionId);
      if (localSession && localSession.namespace !== namespace) {
        return c.json({ error: "Session not found" }, 404);
      }

      const service = options?.getSessionService?.();
      if (!service) {
        return c.json({ error: "Session service unavailable" }, 503);
      }

      const result = await service.getMcpBatchState(sessionId, namespace);
      if (result.type === "success") {
        return c.json({ snapshot: result.snapshot });
      }
      if (result.type === "not-found") {
        return c.json({ error: "Session not found" }, 404);
      }
      return c.json(
        { error: result.message },
        result.status as 400 | 500 | 502 | 503
      );
    }
  );

  // Round 11 (epic #3285, 2026-09-07): the four live-plane config routes below
  // accept a DISCONNECTED session too — applySessionConfig stages the change on
  // the session's durable pins and reconnectSession applies it on the respawn.
  app.post(
    "/sessions/:id/permission-mode",
    cataloged(
      defineCapability({
        id: "model-permission.session-permission-mode",
        domain: "model-permission",
        surface: "rest",
        description:
          "Apply a session's permission mode as durable config, staging it for a disconnected session's next respawn.",
        whenToUse:
          "When the user sets a session's permission mode from the config plane.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/sessions/:id/permission-mode",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) {
        return engine;
      }

      const body = await c.req.json().catch(() => null);
      const parsed = permissionModeSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "Invalid body" }, 400);
      }

      const sessionId = c.req.param("id");
      const namespace = c.get("namespace");

      // #1097: local cross-namespace → 404 (no existence leak). A remote
      // cross-namespace request is rejected authoritatively at the receiver.
      const localSession = engine.getSession(sessionId);
      if (localSession && localSession.namespace !== namespace) {
        return c.json({ error: "Session not found" }, 404);
      }

      // #3083: resolve the session for the hub-side flavor fast-path. A remote-owned
      // session is resolved from the hub's cached summaries; the findNodeForSession
      // fallback covers a cached-but-not-interesting session (the receiver validates
      // authoritatively). NO !active guard — round-11 (#3285) stages a disconnected
      // session via engine.applySessionConfig → stageSessionConfig.
      const registry = options?.getNodeRegistry?.();
      const view =
        localSession ??
        registry?.getAllRemoteSessions().find(s => s.id === sessionId);
      const canValidateOnHub = view !== undefined;
      if (!view && !registry?.findNodeForSession(sessionId)) {
        return c.json({ error: "Session not found" }, 404);
      }

      const mode = parsed.data.mode;
      if (canValidateOnHub) {
        const flavor = view.metadata?.flavor ?? "claude";
        const allowedModes = getPermissionModesForFlavor(flavor);
        if (allowedModes.length === 0) {
          return c.json(
            { error: "Permission mode not supported for session flavor" },
            400
          );
        }
        if (!isPermissionModeAllowedForFlavor(mode, flavor)) {
          return c.json(
            { error: "Invalid permission mode for session flavor" },
            400
          );
        }
      }

      const service = options?.getSessionService?.();
      if (!service) {
        return c.json({ error: "Session service not available" }, 503);
      }
      const result = await service.applySessionConfig(
        sessionId,
        { permissionMode: mode },
        namespace
      );
      if (result.type === "success") {
        return c.json({ ok: true });
      }
      if (result.type === "not-found") {
        return c.json({ error: "Session not found" }, 404);
      }
      if (localSession) {
        return logAndJson(c, new Error(result.message), 409, {
          errorLogger,
          category: "sessions-permission-mode",
          fallbackMessage: "Failed to apply permission mode",
        });
      }
      return c.json(
        { error: result.message },
        result.status as 400 | 404 | 409 | 500 | 502 | 503
      );
    }
  );

  app.post(
    "/sessions/:id/model",
    cataloged(
      defineCapability({
        id: "model-permission.session-model",
        domain: "model-permission",
        surface: "rest",
        description:
          "Apply a session's model mode as durable config via applySessionConfig, staging it for a disconnected respawn.",
        whenToUse:
          "When the user sets a session's model from the config plane.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/sessions/:id/model",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) {
        return engine;
      }

      const body = await c.req.json().catch(() => null);
      const parsed = modelModeSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "Invalid body" }, 400);
      }

      const sessionId = c.req.param("id");
      const namespace = c.get("namespace");

      // #1097: local cross-namespace → 404. #3083: resolve for the hub flavor
      // fast-path; NO !active guard (round-11 stages a disconnected session).
      const localSession = engine.getSession(sessionId);
      if (localSession && localSession.namespace !== namespace) {
        return c.json({ error: "Session not found" }, 404);
      }
      const registry = options?.getNodeRegistry?.();
      const view =
        localSession ??
        registry?.getAllRemoteSessions().find(s => s.id === sessionId);
      const canValidateOnHub = view !== undefined;
      if (!view && !registry?.findNodeForSession(sessionId)) {
        return c.json({ error: "Session not found" }, 404);
      }

      if (canValidateOnHub) {
        const flavor = view.metadata?.flavor ?? "claude";
        if (!isModelModeAllowedForFlavor(parsed.data.model, flavor)) {
          return c.json(
            { error: "Model mode is only supported for Claude sessions" },
            400
          );
        }
      }

      const service = options?.getSessionService?.();
      if (!service) {
        return c.json({ error: "Session service not available" }, 503);
      }
      const result = await service.applySessionConfig(
        sessionId,
        { modelMode: parsed.data.model },
        namespace
      );
      if (result.type === "success") {
        // Issue #3769 (AC2): surface whether the pick reached the live SDK query
        // ("sdk") or only the durable pin ("config") — additive; old clients ignore it.
        return c.json({ ok: true, method: result.method });
      }
      if (result.type === "not-found") {
        return c.json({ error: "Session not found" }, 404);
      }
      if (localSession) {
        return logAndJson(c, new Error(result.message), 409, {
          errorLogger,
          category: "sessions-model-mode",
          fallbackMessage: "Failed to apply model mode",
        });
      }
      return c.json(
        { error: result.message },
        result.status as 400 | 404 | 409 | 500 | 502 | 503
      );
    }
  );

  // Issue #2456: in-session reasoning-effort change (Claude only). Mirrors the
  // /model route — applySessionConfig respawns a tmux/pty session with the new
  // --hapi-effort, or the SDK launcher re-queries on the next message.
  app.post(
    "/sessions/:id/effort",
    cataloged(
      defineCapability({
        id: "model-permission.session-effort",
        domain: "model-permission",
        surface: "rest",
        description:
          "Apply a Claude session's reasoning-effort level as durable config, respawning or re-querying on the next message.",
        whenToUse: "When the user changes a session's reasoning effort.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/sessions/:id/effort",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) {
        return engine;
      }

      const body = await c.req.json().catch(() => null);
      const parsed = effortSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "Invalid body" }, 400);
      }

      const sessionId = c.req.param("id");
      const namespace = c.get("namespace");

      // #1097: local cross-namespace → 404. #3083: resolve for the hub flavor
      // fast-path; NO !active guard (round-11 stages a disconnected session).
      const localSession = engine.getSession(sessionId);
      if (localSession && localSession.namespace !== namespace) {
        return c.json({ error: "Session not found" }, 404);
      }
      const registry = options?.getNodeRegistry?.();
      const view =
        localSession ??
        registry?.getAllRemoteSessions().find(s => s.id === sessionId);
      const canValidateOnHub = view !== undefined;
      if (!view && !registry?.findNodeForSession(sessionId)) {
        return c.json({ error: "Session not found" }, 404);
      }

      if (canValidateOnHub) {
        const flavor = view.metadata?.flavor ?? "claude";
        if (flavor !== "claude") {
          return c.json(
            { error: "Reasoning effort is only supported for Claude sessions" },
            400
          );
        }
      }

      const service = options?.getSessionService?.();
      if (!service) {
        return c.json({ error: "Session service not available" }, 503);
      }
      const result = await service.applySessionConfig(
        sessionId,
        { effort: parsed.data.effort },
        namespace
      );
      if (result.type === "success") {
        // Issue #3769 (AC2): additive method (an effort-only Apply never fires the
        // live model switch → "config").
        return c.json({ ok: true, method: result.method });
      }
      if (result.type === "not-found") {
        return c.json({ error: "Session not found" }, 404);
      }
      if (localSession) {
        return logAndJson(c, new Error(result.message), 409, {
          errorLogger,
          category: "sessions-effort",
          fallbackMessage: "Failed to apply reasoning effort",
        });
      }
      return c.json(
        { error: result.message },
        result.status as 400 | 404 | 409 | 500 | 502 | 503
      );
    }
  );

  // Issue #2456: in-session specific pinned raw-model change (Claude only,
  // "More models"). applySessionConfig clears any family modelMode pin and
  // respawns tmux/pty with --hapi-raw-model (SDK re-queries next message).
  app.post(
    "/sessions/:id/raw-model",
    cataloged(
      defineCapability({
        id: "model-permission.session-raw-model",
        domain: "model-permission",
        surface: "rest",
        description:
          "Pin a Claude session to a specific raw model, clearing any family-mode pin, via durable applySessionConfig.",
        whenToUse:
          "When the user picks a specific model from the More models flyout.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/sessions/:id/raw-model",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) {
        return engine;
      }

      const body = await c.req.json().catch(() => null);
      const parsed = rawModelSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "Invalid body" }, 400);
      }

      const sessionId = c.req.param("id");
      const namespace = c.get("namespace");

      // #1097: local cross-namespace → 404. #3083: resolve for the hub flavor
      // fast-path; NO !active guard (round-11 stages a disconnected session).
      const localSession = engine.getSession(sessionId);
      if (localSession && localSession.namespace !== namespace) {
        return c.json({ error: "Session not found" }, 404);
      }
      const registry = options?.getNodeRegistry?.();
      const view =
        localSession ??
        registry?.getAllRemoteSessions().find(s => s.id === sessionId);
      const canValidateOnHub = view !== undefined;
      if (!view && !registry?.findNodeForSession(sessionId)) {
        return c.json({ error: "Session not found" }, 404);
      }

      if (canValidateOnHub) {
        const flavor = view.metadata?.flavor ?? "claude";
        if (flavor !== "claude") {
          return c.json(
            { error: "Model selection is only supported for Claude sessions" },
            400
          );
        }
      }

      const service = options?.getSessionService?.();
      if (!service) {
        return c.json({ error: "Session service not available" }, 503);
      }
      const result = await service.applySessionConfig(
        sessionId,
        { rawModel: parsed.data.rawModel },
        namespace
      );
      if (result.type === "success") {
        // Issue #3769 (AC2): additive method — a "More models" raw-model pick on
        // an SDK session reports "sdk" when the live switch fires.
        return c.json({ ok: true, method: result.method });
      }
      if (result.type === "not-found") {
        return c.json({ error: "Session not found" }, 404);
      }
      if (localSession) {
        return logAndJson(c, new Error(result.message), 409, {
          errorLogger,
          category: "sessions-raw-model",
          fallbackMessage: "Failed to apply model selection",
        });
      }
      return c.json(
        { error: result.message },
        result.status as 400 | 404 | 409 | 500 | 502 | 503
      );
    }
  );

  /**
   * POST /sessions/:id/relaunch — issue #2149. Relaunch an active session with
   * new spawn-frozen params (launcher / safeMode) via teardown + `--resume`
   * respawn through the `spawnSession` choke point. The live-plane params (model /
   * permission-mode / MCP / effort / rawModel) apply in place via their own
   * routes — NOT this one. Federation-aware (mirrors /account): a cross-namespace
   * LOCAL session returns 404 (no existence leak); a remote session is proxied by
   * SessionService.relaunch to the owning node, which relaunches locally.
   */
  app.post(
    "/sessions/:id/relaunch",
    cataloged(
      defineCapability({
        id: "session-lifecycle.relaunch",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Relaunch an active session with new spawn-frozen params (launcher, safe mode) via teardown and resume respawn.",
        whenToUse:
          "When the user changes a session's launcher or safe-mode setting.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/sessions/:id/relaunch",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) {
        return engine;
      }

      const body = await c.req.json().catch(() => null);
      const parsed = RelaunchRequestSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "Invalid body", code: "invalid_request" }, 400);
      }

      const sessionId = c.req.param("id");
      const namespace = c.get("namespace");

      // Cross-namespace LOCAL session → 404 (no existence leak, mirrors /account).
      // A non-local session is proxied by SessionService.relaunch to its owner.
      const localSession = engine.getSession(sessionId);
      if (localSession && localSession.namespace !== namespace) {
        return c.json(
          { error: "Session not found", code: "session_not_found" },
          404
        );
      }

      const service = options?.getSessionService?.();
      if (!service) {
        return c.json(
          { error: "Session service unavailable", code: "unknown" },
          503
        );
      }

      const result = await service.relaunch(sessionId, parsed.data, namespace);
      if (result.type === "success") {
        return c.json({ ok: true });
      }
      if (result.type === "not-found") {
        return c.json(
          { error: "Session not found", code: "session_not_found" },
          404
        );
      }
      return c.json(
        { error: result.message, code: result.code },
        result.status as 400 | 404 | 409 | 500 | 502 | 503
      );
    }
  );

  app.patch(
    "/sessions/:id",
    cataloged(
      defineCapability({
        id: "session-lifecycle.rename",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Rename a session's display title through the shared session-mutation handler with federation cache update.",
        whenToUse: "When the user renames a session.",
        invocation: {
          kind: "rest",
          method: "PATCH",
          path: "/api/sessions/:id",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) {
        return engine;
      }

      const body = await c.req.json().catch(() => null);
      const parsed = RENAME_MUTATION.schema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { error: resolveClientInvalidBody(RENAME_MUTATION, parsed.error) },
          400
        );
      }

      const sessionId = c.req.param("id");
      const namespace = c.get("namespace");

      // Issue #1097: reject local cross-namespace requests with 404 (no
      // existence leak). Federated cross-namespace is rejected at the receiver
      // via the X-Hapi-Caller-Namespace header.
      const localSession = engine.getSession(sessionId);
      if (localSession && localSession.namespace !== namespace) {
        return c.json({ error: "Session not found" }, 404);
      }

      // Issue #2082: SessionService is always wired in production (server.ts);
      // the null path is only reachable when getSyncEngine() is null, which
      // requireSyncEngine already 503s above. The field mutation + cache-update
      // are encoded once in the shared sessionMutationHandlers module.
      const sessionService = options?.getSessionService?.();
      if (!sessionService) {
        return c.json({ error: "Session service not available" }, 503);
      }

      const { name, options: renameOptions } = RENAME_MUTATION.extractValue(
        parsed.data
      );
      const result = await sessionService.rename(
        sessionId,
        name,
        renameOptions,
        namespace
      );
      if (result.type === "success") return c.json({ ok: true });
      if (result.type === "not-found")
        return c.json({ error: "Session not found" }, 404);
      return c.json(
        { error: result.message },
        result.status as 400 | 500 | 502
      );
    }
  );

  app.post(
    "/sessions/bulk-delete",
    cataloged(
      defineCapability({
        id: "session-lifecycle.bulk-delete",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Delete up to 100 sessions by id in one request, partitioning local and remote nodes and skipping active sessions; returns one result per session.",
        whenToUse: "When the user clears out several sessions at once.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/sessions/bulk-delete",
        },
        auth: "jwt",
        riskTier: "destructive",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) {
        return engine;
      }

      const body = await c.req.json().catch(() => null);
      const parsed = z
        .object({ ids: z.array(z.string().uuid()).min(1).max(100) })
        .safeParse(body);

      if (!parsed.success) {
        return c.json(
          { error: "Invalid request body", details: parsed.error.issues },
          400
        );
      }

      const namespace = c.get("namespace");
      const registry = options?.getNodeRegistry?.() ?? null;

      // #3815 Task 1b: one result per session (`results`, additive). Local ids
      // are namespace-checked before the engine sees them; remote ids are
      // deleted per SESSION (registry.deleteOnNode) so each has an outcome.
      let results: BulkSessionResult;
      try {
        results = await runBulkDelete({
          ids: parsed.data.ids,
          engine,
          namespace,
          registry,
        });
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "sessions-bulk-delete",
          fallbackMessage: "Failed to delete sessions",
        });
      }

      // The numeric fields keep their pre-#3815 meaning for peers and scripts
      // that read them: `deleted` = sessions removed, `skipped` = every
      // requested session that was NOT removed. `remoteErrors` keeps the
      // messages of remote failures that are not a refusal.
      const deleted = results.filter(r => r.ok).length;
      const remoteErrors = results
        .filter(r => !r.ok && !r.skipped && r.error !== undefined)
        .map(r => r.error as string);
      return c.json({
        ok: true,
        deleted,
        skipped: results.length - deleted,
        ...(remoteErrors.length > 0 ? { remoteErrors } : {}),
        results,
      });
    }
  );

  // #3815: Stop turn and Disconnect over a selection — one route and one
  // honest risk tier each (a capability carries a single `riskTier`, so one
  // `/sessions/bulk` route could not describe three grades). Delete stays on
  // `/sessions/bulk-delete` (destructive). Body and 100-id cap match it.
  const bulkActionBodySchema = z.object({
    ids: z.array(z.string().uuid()).min(1).max(BULK_SESSION_MAX_IDS),
  });

  const handleBulkAction =
    (action: BulkSessionAction) =>
    async (c: Context<WebAppEnv>): Promise<Response> => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) {
        return engine;
      }

      const body = await c.req.json().catch(() => null);
      const parsed = bulkActionBodySchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { error: "Invalid request body", details: parsed.error.issues },
          400
        );
      }

      const results = await runBulkSessionAction({
        action,
        ids: parsed.data.ids,
        engine,
        namespace: c.get("namespace"),
        registry: options?.getNodeRegistry?.() ?? null,
      });
      const checked = BulkSessionResultSchema.safeParse(results);
      if (!checked.success) {
        return logAndJson(c, checked.error, 500, {
          errorLogger,
          category: `sessions-bulk-${action}`,
          fallbackMessage: "Bulk action produced an invalid result",
        });
      }
      return c.json({ ok: true, results: checked.data });
    };

  app.post(
    "/sessions/bulk-abort",
    cataloged(
      defineCapability({
        id: "session-lifecycle.bulk-abort",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Stop the running turn of up to 100 sessions by id, each on its owning federation node, leaving every session connected; returns one result per session.",
        whenToUse:
          "When the user stops the work of several sessions at once (select mode Stop turn, or a fleet-wide stop).",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/sessions/bulk-abort",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    handleBulkAction("abort")
  );

  app.post(
    "/sessions/bulk-archive",
    cataloged(
      defineCapability({
        id: "session-lifecycle.bulk-archive",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Disconnect (archive for reconnect) up to 100 sessions by id, each on its owning federation node; returns one result per session.",
        whenToUse:
          "When the user disconnects several sessions at once from select mode.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/sessions/bulk-archive",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    handleBulkAction("archive")
  );

  app.delete(
    "/sessions/:id",
    cataloged(
      defineCapability({
        id: "session-lifecycle.delete",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Delete an inactive or orphaned session and evict it from caches, with proxy fallback to the owning node.",
        whenToUse: "When the user permanently removes a single session.",
        invocation: {
          kind: "rest",
          method: "DELETE",
          path: "/api/sessions/:id",
        },
        auth: "jwt",
        riskTier: "destructive",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) {
        return engine;
      }

      const sessionResult = requireSessionFromParam(c, engine);
      if (!(sessionResult instanceof Response)) {
        // Local session found — proceed with local delete
        // #1443: orphaned sessions (CWD gone) bypass the active-check — they are
        // unrecoverable and must be deletable even when cached active:true.
        if (
          sessionResult.session.active &&
          !engine.isSessionOrphaned(sessionResult.sessionId)
        ) {
          return c.json(
            { error: "Cannot delete active session. Archive it first." },
            409
          );
        }

        try {
          await engine.deleteSession(sessionResult.sessionId);
          return c.json({ ok: true });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Failed to delete session";
          const status = message.includes("active") ? 409 : 500;
          return logAndJson(c, error, status, {
            errorLogger,
            category: "sessions-delete",
            fallbackMessage: "Failed to delete session",
          });
        }
      }

      // Federation fallback: proxy delete to the remote node
      const registry = options?.getNodeRegistry?.();
      if (registry) {
        const sessionId = c.req.param("id");
        const node = registry.findNodeForSession(sessionId);
        if (node) {
          const headers: Record<string, string> = {};
          if (options?.federationApiToken) {
            headers["Authorization"] = `Bearer ${options.federationApiToken}`;
          }
          const resp = await fetch(
            `${node.url}/api/federation/sessions/${encodeURIComponent(sessionId)}`,
            { method: "DELETE", headers }
          );
          if (resp.ok) {
            // Immediately remove from cache so subsequent queries
            // reflect the deletion without waiting for re-poll
            registry.evictSessionFromCache(sessionId);
            return c.json({ ok: true });
          }
          const body = await resp.json().catch(() => ({}));
          return c.json(
            body as Record<string, unknown>,
            resp.status as 400 | 404 | 409 | 500 | 503
          );
        }
      }

      return sessionResult;
    }
  );

  app.put(
    "/sessions/:id/notes",
    cataloged(
      defineCapability({
        id: "session-lifecycle.notes",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Set a session's freeform notes field through the shared mutation handler with cross-device sync.",
        whenToUse: "When the user edits a session's notes.",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/api/sessions/:id/notes",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) {
        return engine;
      }

      const body = await c.req.json().catch(() => null);
      const parsed = NOTES_MUTATION.schema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { error: resolveClientInvalidBody(NOTES_MUTATION, parsed.error) },
          400
        );
      }

      const sessionId = c.req.param("id");
      const namespace = c.get("namespace");

      // Issue #1097: reject local cross-namespace requests with 404 (no
      // existence leak). Federated cross-namespace is rejected at the receiver
      // via the X-Hapi-Caller-Namespace header.
      const localSession = engine.getSession(sessionId);
      if (localSession && localSession.namespace !== namespace) {
        return c.json({ error: "Session not found" }, 404);
      }

      // Issue #2082: SessionService is always wired in production (server.ts);
      // the null path is only reachable when getSyncEngine() is null, which
      // requireSyncEngine already 503s above. The field mutation + cache-update
      // are encoded once in the shared sessionMutationHandlers module.
      const sessionService = options?.getSessionService?.();
      if (!sessionService) {
        return c.json({ error: "Session service not available" }, 503);
      }

      const result = await sessionService.updateNotes(
        sessionId,
        NOTES_MUTATION.extractValue(parsed.data),
        namespace
      );
      if (result.type === "success") return c.json({ ok: true });
      if (result.type === "not-found")
        return c.json({ error: "Session not found" }, 404);
      return c.json(
        { error: result.message },
        result.status as 400 | 500 | 502
      );
    }
  );

  // Issue #3286 (View Picker): persist the selected view (chat|terminal|desktop|
  // files). Symmetric to /notes — the field mutation + federation cache-update are
  // encoded once in VIEW_MUTATION; cross-device sync rides the existing SSE flow.
  app.put(
    "/sessions/:id/view",
    cataloged(
      defineCapability({
        id: "session-lifecycle.view",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Persist a session's selected view (chat, terminal, desktop, or files) so it syncs across devices.",
        whenToUse: "When the user switches a session's view pane.",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/api/sessions/:id/view",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) {
        return engine;
      }

      const body = await c.req.json().catch(() => null);
      const parsed = VIEW_MUTATION.schema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { error: resolveClientInvalidBody(VIEW_MUTATION, parsed.error) },
          400
        );
      }

      const sessionId = c.req.param("id");
      const namespace = c.get("namespace");

      // Issue #1097: reject local cross-namespace requests with 404 (no existence
      // leak). Federated cross-namespace is rejected at the receiver via the
      // X-Hapi-Caller-Namespace header.
      const localSession = engine.getSession(sessionId);
      if (localSession && localSession.namespace !== namespace) {
        return c.json({ error: "Session not found" }, 404);
      }

      const sessionService = options?.getSessionService?.();
      if (!sessionService) {
        return c.json({ error: "Session service not available" }, 503);
      }

      const result = await sessionService.updateView(
        sessionId,
        VIEW_MUTATION.extractValue(parsed.data),
        namespace
      );
      if (result.type === "success") return c.json({ ok: true });
      if (result.type === "not-found")
        return c.json({ error: "Session not found" }, 404);
      return c.json(
        { error: result.message },
        result.status as 400 | 500 | 502
      );
    }
  );

  app.put(
    "/sessions/:id/prompt-draft",
    cataloged(
      defineCapability({
        id: "session-lifecycle.prompt-draft",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Persist a session's unsent prompt draft so composer text survives reloads and syncs across devices.",
        whenToUse: "When the user types into the composer without sending yet.",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/api/sessions/:id/prompt-draft",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) {
        return engine;
      }

      const body = await c.req.json().catch(() => null);
      const parsed = PROMPT_DRAFT_MUTATION.schema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          {
            error: resolveClientInvalidBody(
              PROMPT_DRAFT_MUTATION,
              parsed.error
            ),
          },
          400
        );
      }

      const sessionId = c.req.param("id");
      const namespace = c.get("namespace");

      // Issue #1097: reject local cross-namespace requests with 404 (no
      // existence leak). Federated cross-namespace is rejected at the receiver
      // via the X-Hapi-Caller-Namespace header.
      const localSession = engine.getSession(sessionId);
      if (localSession && localSession.namespace !== namespace) {
        return c.json({ error: "Session not found" }, 404);
      }

      // Issue #2082: SessionService is always wired in production (server.ts);
      // the null path is only reachable when getSyncEngine() is null, which
      // requireSyncEngine already 503s above. The field mutation + cache-update
      // are encoded once in the shared sessionMutationHandlers module.
      const sessionService = options?.getSessionService?.();
      if (!sessionService) {
        return c.json({ error: "Session service not available" }, 503);
      }

      const result = await sessionService.updatePromptDraft(
        sessionId,
        PROMPT_DRAFT_MUTATION.extractValue(parsed.data),
        namespace
      );
      if (result.type === "success") return c.json({ ok: true });
      if (result.type === "not-found")
        return c.json({ error: "Session not found" }, 404);
      return c.json(
        { error: result.message },
        result.status as 400 | 500 | 502
      );
    }
  );

  app.put(
    "/sessions/:id/emoji",
    cataloged(
      defineCapability({
        id: "session-lifecycle.emoji",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Set a session's emoji marker through the shared mutation handler with federation cache update.",
        whenToUse: "When the user assigns an emoji to a session.",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/api/sessions/:id/emoji",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) {
        return engine;
      }

      const body = await c.req.json().catch(() => null);
      const parsed = EMOJI_MUTATION.schema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { error: resolveClientInvalidBody(EMOJI_MUTATION, parsed.error) },
          400
        );
      }

      const sessionId = c.req.param("id");
      const namespace = c.get("namespace");

      // Issue #1097: reject local cross-namespace requests with 404 (no
      // existence leak). Federated cross-namespace is rejected at the receiver
      // via the X-Hapi-Caller-Namespace header.
      const localSession = engine.getSession(sessionId);
      if (localSession && localSession.namespace !== namespace) {
        return c.json({ error: "Session not found" }, 404);
      }

      // Issue #2082: SessionService is always wired in production (server.ts);
      // the null path is only reachable when getSyncEngine() is null, which
      // requireSyncEngine already 503s above. The field mutation + cache-update
      // are encoded once in the shared sessionMutationHandlers module.
      const sessionService = options?.getSessionService?.();
      if (!sessionService) {
        return c.json({ error: "Session service not available" }, 503);
      }

      const result = await sessionService.updateEmoji(
        sessionId,
        EMOJI_MUTATION.extractValue(parsed.data),
        namespace
      );
      if (result.type === "success") return c.json({ ok: true });
      if (result.type === "not-found")
        return c.json({ error: "Session not found" }, 404);
      return c.json(
        { error: result.message },
        result.status as 400 | 500 | 502
      );
    }
  );

  app.put(
    "/sessions/:id/linked-issue",
    cataloged(
      defineCapability({
        id: "session-lifecycle.linked-issue",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Link a session to a GitHub issue, rejecting a second active session that already claimed the same issue.",
        whenToUse: "When the user associates a session with an issue.",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/api/sessions/:id/linked-issue",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) {
        return engine;
      }

      const body = await c.req.json().catch(() => null);
      const parsed = LINKED_ISSUE_MUTATION.schema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          {
            error: resolveClientInvalidBody(
              LINKED_ISSUE_MUTATION,
              parsed.error
            ),
          },
          400
        );
      }

      const sessionId = c.req.param("id");
      const namespace = c.get("namespace");

      // Issue #1097: reject local cross-namespace requests with 404 (no
      // existence leak). Federated cross-namespace is rejected at the receiver
      // via the X-Hapi-Caller-Namespace header.
      const localSession = engine.getSession(sessionId);
      if (localSession && localSession.namespace !== namespace) {
        return c.json({ error: "Session not found" }, 404);
      }

      // Issue #2082: SessionService is always wired in production (server.ts);
      // the null path is only reachable when getSyncEngine() is null, which
      // requireSyncEngine already 503s above. The field mutation + cache-update
      // are encoded once in the shared sessionMutationHandlers module.
      const sessionService = options?.getSessionService?.();
      if (!sessionService) {
        return c.json({ error: "Session service not available" }, 503);
      }

      const result = await sessionService.updateLinkedIssue(
        sessionId,
        LINKED_ISSUE_MUTATION.extractValue(parsed.data),
        namespace
      );
      if (result.type === "success") return c.json({ ok: true });
      if (result.type === "not-found")
        return c.json({ error: "Session not found" }, 404);
      // Issue #1584: 409 = another active session already linked to this issue.
      return c.json(
        { error: result.message },
        result.status as 400 | 409 | 500 | 502
      );
    }
  );

  // Issue #2862 (Fix 1): the retroactive, federation-aware managed-peer parent
  // stamp. There is no other post-spawn write path for parentSessionId, so this
  // is the surface orphan-adoption uses to heal a session whose spawn timed out
  // client-side after the daemon succeeded. Mirrors the linked-issue hub route.
  app.put(
    "/sessions/:id/parent",
    cataloged(
      defineCapability({
        id: "session-lifecycle.parent",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Retroactively set a session's managed-peer parent link (parentSessionId + spawn relationship) so an orphan whose spawn timed out after success groups under its PM.",
        whenToUse:
          "When healing the parent stamp of a session created by a spawn that timed out client-side after the daemon succeeded (orphan-adoption).",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/api/sessions/:id/parent",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) {
        return engine;
      }

      const body = await c.req.json().catch(() => null);
      const parsed = PARENT_MUTATION.schema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { error: resolveClientInvalidBody(PARENT_MUTATION, parsed.error) },
          400
        );
      }

      const sessionId = c.req.param("id");
      const namespace = c.get("namespace");

      // Issue #1097: reject local cross-namespace requests with 404 (no existence
      // leak). Federated cross-namespace is rejected at the receiver via the
      // X-Hapi-Caller-Namespace header.
      const localSession = engine.getSession(sessionId);
      if (localSession && localSession.namespace !== namespace) {
        return c.json({ error: "Session not found" }, 404);
      }

      // Expert-review 2862-5: resolve parentSessionId uuid-then-tag HERE (layer 1,
      // which has the namespace + full registry view), then forward the RESOLVED
      // uuid — applyLocal runs on the OWNING peer, which may not know the parent,
      // so resolving there would fail-open to "no link" cross-node. A value that
      // does not resolve locally (already a canonical uuid, or a remote-node PM)
      // is forwarded unchanged so the client-side grouping can still match it.
      const value = PARENT_MUTATION.extractValue(parsed.data);
      const resolvedParent =
        engine.getSessionByNamespace(value.parentSessionId, namespace) ??
        engine.getSessionByTagAndNamespace(value.parentSessionId, namespace);
      const resolvedValue = {
        parentSessionId: resolvedParent?.id ?? value.parentSessionId,
        parentRelationship: value.parentRelationship,
      };

      const sessionService = options?.getSessionService?.();
      if (!sessionService) {
        return c.json({ error: "Session service not available" }, 503);
      }

      const result = await sessionService.updateParent(
        sessionId,
        resolvedValue,
        namespace
      );
      if (result.type === "success") return c.json({ ok: true });
      if (result.type === "not-found")
        return c.json({ error: "Session not found" }, 404);
      return c.json(
        { error: result.message },
        result.status as 400 | 409 | 500 | 502
      );
    }
  );

  app.put(
    "/sessions/:id/needs-review-override",
    cataloged(
      defineCapability({
        id: "session-lifecycle.needs-review-override",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Override a session's needs-review flag through the shared session-mutation handler.",
        whenToUse: "When the user marks a session reviewed or needing review.",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/api/sessions/:id/needs-review-override",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) {
        return engine;
      }

      const body = await c.req.json().catch(() => null);
      const parsed = NEEDS_REVIEW_OVERRIDE_MUTATION.schema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          {
            error: resolveClientInvalidBody(
              NEEDS_REVIEW_OVERRIDE_MUTATION,
              parsed.error
            ),
          },
          400
        );
      }

      const sessionId = c.req.param("id");
      const namespace = c.get("namespace");

      // Issue #1097: reject local cross-namespace requests with 404 (no
      // existence leak). Federated cross-namespace is rejected at the receiver
      // via the X-Hapi-Caller-Namespace header.
      const localSession = engine.getSession(sessionId);
      if (localSession && localSession.namespace !== namespace) {
        return c.json({ error: "Session not found" }, 404);
      }

      // Issue #2082: SessionService is always wired in production (server.ts);
      // the null path is only reachable when getSyncEngine() is null, which
      // requireSyncEngine already 503s above. The field mutation + cache-update
      // are encoded once in the shared sessionMutationHandlers module.
      const sessionService = options?.getSessionService?.();
      if (!sessionService) {
        return c.json({ error: "Session service not available" }, 503);
      }

      const result = await sessionService.updateNeedsReviewOverride(
        sessionId,
        NEEDS_REVIEW_OVERRIDE_MUTATION.extractValue(parsed.data),
        namespace
      );
      if (result.type === "success") return c.json({ ok: true });
      if (result.type === "not-found")
        return c.json({ error: "Session not found" }, 404);
      return c.json(
        { error: result.message },
        result.status as 400 | 500 | 502
      );
    }
  );

  // ─── PUT /sessions/:id/auto-recover ─────────────────────────────
  app.put(
    "/sessions/:id/auto-recover",
    cataloged(
      defineCapability({
        id: "session-lifecycle.auto-recover",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Set whether a session auto-recovers after an API error, rejecting unparseable bodies without mutating.",
        whenToUse: "When the user toggles a session's auto-recover behavior.",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/api/sessions/:id/auto-recover",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) {
        return engine;
      }

      // R4 (#1235): `.catch(() => undefined)` — deliberately NOT the sibling
      // routes' `.catch(() => null)`. This schema ACCEPTS null, so the sibling
      // sentinel would turn unparseable JSON into a state-clearing 200;
      // z.boolean().nullable() rejects undefined → 400, no mutation.
      const body = await c.req.json().catch(() => undefined);
      const parsed = AUTO_RECOVER_MUTATION.schema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          {
            error: resolveClientInvalidBody(
              AUTO_RECOVER_MUTATION,
              parsed.error
            ),
          },
          400
        );
      }

      const sessionId = c.req.param("id");
      const namespace = c.get("namespace");

      // Issue #1097: reject local cross-namespace requests with 404 (no
      // existence leak). Federated cross-namespace is rejected at the receiver
      // via the X-Hapi-Caller-Namespace header.
      const localSession = engine.getSession(sessionId);
      if (localSession && localSession.namespace !== namespace) {
        return c.json({ error: "Session not found" }, 404);
      }

      // Issue #2082: SessionService is always wired in production (server.ts);
      // hard-503 when missing. The field mutation + cache-update are encoded
      // once in the shared sessionMutationHandlers module.
      const sessionService = options?.getSessionService?.();
      if (!sessionService) {
        return c.json({ error: "Session service not available" }, 503);
      }

      const result = await sessionService.updateAutoRecoverFromApiError(
        sessionId,
        AUTO_RECOVER_MUTATION.extractValue(parsed.data),
        namespace
      );
      if (result.type === "success") return c.json({ ok: true });
      if (result.type === "not-found")
        return c.json({ error: "Session not found" }, 404);
      return c.json(
        { error: result.message },
        result.status as 400 | 500 | 502
      );
    }
  );

  // ─── PUT /sessions/:id/ceiling-override ─────────────────────────
  app.put(
    "/sessions/:id/ceiling-override",
    cataloged(
      defineCapability({
        id: "session-lifecycle.ceiling-override",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Set or clear a session's per-session runaway-guard ceiling override (a partial ceiling config, or null to clear), federation-aware.",
        whenToUse:
          "When raising or lowering a specific session's token/iteration ceiling, or clearing its override.",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/api/sessions/:id/ceiling-override",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) {
        return engine;
      }

      // The schema ACCEPTS null (clear the override), so — like /auto-recover —
      // use `.catch(() => undefined)`: unparseable JSON becomes undefined, which
      // the nullable schema rejects → 400 (never a state-clearing 200).
      const body = await c.req.json().catch(() => undefined);
      const parsed = CEILING_OVERRIDE_MUTATION.schema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          {
            error: resolveClientInvalidBody(
              CEILING_OVERRIDE_MUTATION,
              parsed.error
            ),
          },
          400
        );
      }

      const sessionId = c.req.param("id");
      const namespace = c.get("namespace");

      // Issue #1097: reject local cross-namespace requests with 404 (no
      // existence leak). Federated cross-namespace is rejected at the receiver
      // via the X-Hapi-Caller-Namespace header.
      const localSession = engine.getSession(sessionId);
      if (localSession && localSession.namespace !== namespace) {
        return c.json({ error: "Session not found" }, 404);
      }

      const sessionService = options?.getSessionService?.();
      if (!sessionService) {
        return c.json({ error: "Session service not available" }, 503);
      }

      const result = await sessionService.updateCeilingOverride(
        sessionId,
        CEILING_OVERRIDE_MUTATION.extractValue(parsed.data),
        namespace
      );
      if (result.type === "success") return c.json({ ok: true });
      if (result.type === "not-found")
        return c.json({ error: "Session not found" }, 404);
      return c.json(
        { error: result.message },
        result.status as 400 | 500 | 502
      );
    }
  );

  // ─── PUT /sessions/:id/ui-collapse-state ────────────────────────
  app.put(
    "/sessions/:id/ui-collapse-state",
    cataloged(
      defineCapability({
        id: "session-lifecycle.ui-collapse-state",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Persist a session's UI collapse state through the shared mutation handler with cross-device sync.",
        whenToUse: "When the user collapses or expands a session's UI panels.",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/api/sessions/:id/ui-collapse-state",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) {
        return engine;
      }

      const body = await c.req.json().catch(() => null);
      const parsed = UI_COLLAPSE_STATE_MUTATION.schema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          {
            error: resolveClientInvalidBody(
              UI_COLLAPSE_STATE_MUTATION,
              parsed.error
            ),
          },
          400
        );
      }

      const sessionId = c.req.param("id");
      const namespace = c.get("namespace");

      // Issue #1097: reject local cross-namespace requests with 404 (no
      // existence leak). Federated cross-namespace is rejected at the receiver
      // via the X-Hapi-Caller-Namespace header.
      const localSession = engine.getSession(sessionId);
      if (localSession && localSession.namespace !== namespace) {
        return c.json({ error: "Session not found" }, 404);
      }

      // Issue #2082: SessionService is always wired in production (server.ts);
      // the null path is only reachable when getSyncEngine() is null, which
      // requireSyncEngine already 503s above. The field mutation + cache-update
      // are encoded once in the shared sessionMutationHandlers module.
      const sessionService = options?.getSessionService?.();
      if (!sessionService) {
        return c.json({ error: "Session service not available" }, 503);
      }

      const result = await sessionService.updateUiCollapseState(
        sessionId,
        UI_COLLAPSE_STATE_MUTATION.extractValue(parsed.data),
        namespace
      );
      if (result.type === "success") return c.json({ ok: true });
      if (result.type === "not-found")
        return c.json({ error: "Session not found" }, 404);
      return c.json(
        { error: result.message },
        result.status as 400 | 500 | 502
      );
    }
  );

  app.get(
    "/sessions/:id/slash-commands",
    cataloged(
      defineCapability({
        id: "session-introspection.slash-commands",
        domain: "session-introspection",
        surface: "rest",
        description:
          "List the slash commands and skills available to a session, falling back to a filesystem scan when offline.",
        whenToUse: "When populating a session's slash-command menu.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/sessions/:id/slash-commands",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) {
        return engine;
      }

      // Session must exist but doesn't need to be active
      const sessionResult = requireSessionFromParam(c, engine);
      if (!(sessionResult instanceof Response)) {
        // Local session found — handle locally
        const agent = sessionResult.session.metadata?.flavor ?? "claude";

        try {
          const result = await engine.listSlashCommands(
            sessionResult.sessionId,
            agent
          );
          if (result.success) {
            return c.json(result);
          }
          // RPC failed (session offline) — fall through to filesystem scan
        } catch (err) {
          console.debug(
            `[sessions] RPC listSlashCommands failed for ${sessionResult.sessionId}, falling through to filesystem scan: ${err instanceof Error ? err.message : String(err)}`
          );
        }

        // Filesystem fallback: scan commands/skills directly
        // These are user-global and don't require an active CLI session
        try {
          const fsResult = await scanSlashCommandsFromFilesystem();
          return c.json(fsResult);
        } catch (err) {
          console.error(
            `[sessions] Filesystem slash command scan failed: ${err instanceof Error ? err.message : String(err)}`
          );
          return c.json({
            success: false,
            error: "Failed to scan slash commands from filesystem",
          });
        }
      }

      // Federation fallback: proxy to remote node
      const registry = options?.getNodeRegistry?.();
      if (registry) {
        const sessionId = c.req.param("id");
        const node = registry.findNodeForSession(sessionId);
        if (node) {
          const headers: Record<string, string> = {};
          if (options?.federationApiToken) {
            headers["Authorization"] = `Bearer ${options.federationApiToken}`;
          }
          try {
            const resp = await fetch(
              `${node.url}/api/federation/sessions/${encodeURIComponent(sessionId)}/slash-commands`,
              { headers }
            );
            if (resp.ok) {
              const body = await resp.json();
              return c.json(body as Record<string, unknown>);
            }
            return c.json({
              success: false,
              error: `Remote node returned ${resp.status}`,
            });
          } catch (err) {
            console.warn(
              `[sessions] Federation proxy for slash commands failed: ${err instanceof Error ? err.message : String(err)}`
            );
            return c.json({ success: false, error: "Remote node unreachable" });
          }
        }
      }

      return sessionResult;
    }
  );

  // ─── Issue #1325: server-backed message queue routes ─────────────
  // GET    /sessions/:id/queue          → list queued messages
  // POST   /sessions/:id/queue/enqueue  → append a message
  // PATCH  /sessions/:id/queue/:pos     → edit message at position
  // DELETE /sessions/:id/queue/:pos     → remove message at position
  // DELETE /sessions/:id/queue          → clear the queue
  //
  // Pattern mirrors /sessions/:id/emoji exactly: namespace check (#1097),
  // SessionService for unified local/remote routing, no NodeRegistry
  // cache update (Task 13 deferred — clients refetch via SSE).

  app.get(
    "/sessions/:id/queue",
    cataloged(
      defineCapability({
        id: "messaging.queue-list",
        domain: "messaging",
        surface: "rest",
        description:
          "List the messages currently queued for delivery to a session.",
        whenToUse: "When the user views a session's pending message queue.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/sessions/:id/queue",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) return engine;

      const sessionId = c.req.param("id");
      const namespace = c.get("namespace");

      const localSession = engine.getSession(sessionId);
      if (localSession && localSession.namespace !== namespace) {
        return c.json({ error: "Session not found" }, 404);
      }

      const service = options?.getSessionService?.();
      if (!service) {
        return c.json({ error: "Session service not available" }, 503);
      }

      const result = await service.listQueuedMessages(sessionId, namespace);
      if (result.type === "success") {
        return c.json({ messages: result.messages });
      }
      if (result.type === "not-found") {
        return c.json({ error: "Session not found" }, 404);
      }
      return c.json(
        { error: result.message },
        result.status as 400 | 500 | 502
      );
    }
  );

  app.post(
    "/sessions/:id/queue/enqueue",
    cataloged(
      defineCapability({
        id: "messaging.queue-enqueue",
        domain: "messaging",
        surface: "rest",
        description:
          "Append a message to a session's server-backed delivery queue for later drain.",
        whenToUse: "When the user queues a message for a busy session.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/sessions/:id/queue/enqueue",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) return engine;

      const body = await c.req.json().catch(() => null);
      const parsed = enqueueQueuedMessageBodySchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          {
            error:
              "Invalid body: expected { body: string (1-50000), clientGeneratedId?: string|null }",
          },
          400
        );
      }

      const sessionId = c.req.param("id");
      const namespace = c.get("namespace");

      const localSession = engine.getSession(sessionId);
      if (localSession && localSession.namespace !== namespace) {
        return c.json({ error: "Session not found" }, 404);
      }

      const service = options?.getSessionService?.();
      if (!service) {
        return c.json({ error: "Session service not available" }, 503);
      }

      const result = await service.enqueueMessage(
        sessionId,
        namespace,
        parsed.data.body,
        parsed.data.clientGeneratedId ?? null
      );
      if (result.type === "success") {
        return c.json({ ok: true, result: result.result, row: result.row });
      }
      if (result.type === "not-found") {
        return c.json({ error: "Session not found" }, 404);
      }
      return c.json(
        { error: result.message },
        result.status as 400 | 500 | 502
      );
    }
  );

  app.patch(
    "/sessions/:id/queue/:position",
    cataloged(
      defineCapability({
        id: "messaging.queue-update",
        domain: "messaging",
        surface: "rest",
        description:
          "Edit the body of a queued message at a given position in a session's delivery queue.",
        whenToUse: "When the user edits a message still waiting in the queue.",
        invocation: {
          kind: "rest",
          method: "PATCH",
          path: "/api/sessions/:id/queue/:position",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) return engine;

      const positionParam = c.req.param("position");
      const position = Number.parseInt(positionParam, 10);
      if (!Number.isInteger(position) || position < 0) {
        return c.json(
          { error: "Invalid position: expected non-negative integer" },
          400
        );
      }

      const body = await c.req.json().catch(() => null);
      const parsed = updateQueuedMessageBodySchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { error: "Invalid body: expected { body: string (1-50000) }" },
          400
        );
      }

      const sessionId = c.req.param("id");
      const namespace = c.get("namespace");

      const localSession = engine.getSession(sessionId);
      if (localSession && localSession.namespace !== namespace) {
        return c.json({ error: "Session not found" }, 404);
      }

      const service = options?.getSessionService?.();
      if (!service) {
        return c.json({ error: "Session service not available" }, 503);
      }

      const result = await service.updateQueuedMessageAt(
        sessionId,
        namespace,
        position,
        parsed.data.body
      );
      if (result.type === "success") {
        return c.json({ ok: true, row: result.row });
      }
      if (result.type === "not-found") {
        return c.json({ error: "Queued message not found" }, 404);
      }
      return c.json(
        { error: result.message },
        result.status as 400 | 500 | 502
      );
    }
  );

  app.delete(
    "/sessions/:id/queue/:position",
    cataloged(
      defineCapability({
        id: "messaging.queue-remove",
        domain: "messaging",
        surface: "rest",
        description:
          "Remove a single queued message at a given position from a session's delivery queue.",
        whenToUse: "When the user deletes one message from the queue.",
        invocation: {
          kind: "rest",
          method: "DELETE",
          path: "/api/sessions/:id/queue/:position",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) return engine;

      const positionParam = c.req.param("position");
      const position = Number.parseInt(positionParam, 10);
      if (!Number.isInteger(position) || position < 0) {
        return c.json(
          { error: "Invalid position: expected non-negative integer" },
          400
        );
      }

      const sessionId = c.req.param("id");
      const namespace = c.get("namespace");

      const localSession = engine.getSession(sessionId);
      if (localSession && localSession.namespace !== namespace) {
        return c.json({ error: "Session not found" }, 404);
      }

      const service = options?.getSessionService?.();
      if (!service) {
        return c.json({ error: "Session service not available" }, 503);
      }

      const result = await service.removeQueuedMessageAt(
        sessionId,
        namespace,
        position
      );
      if (result.type === "success") {
        return c.json({ ok: true, removed: true });
      }
      if (result.type === "not-found") {
        return c.json({ error: "Queued message not found" }, 404);
      }
      return c.json(
        { error: result.message },
        result.status as 400 | 500 | 502
      );
    }
  );

  app.delete(
    "/sessions/:id/queue",
    cataloged(
      defineCapability({
        id: "messaging.queue-clear",
        domain: "messaging",
        surface: "rest",
        description:
          "Clear every queued message from a session's delivery queue in a single request.",
        whenToUse: "When the user empties a session's message queue.",
        invocation: {
          kind: "rest",
          method: "DELETE",
          path: "/api/sessions/:id/queue",
        },
        auth: "jwt",
        riskTier: "destructive",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) return engine;

      const sessionId = c.req.param("id");
      const namespace = c.get("namespace");

      const localSession = engine.getSession(sessionId);
      if (localSession && localSession.namespace !== namespace) {
        return c.json({ error: "Session not found" }, 404);
      }

      const service = options?.getSessionService?.();
      if (!service) {
        return c.json({ error: "Session service not available" }, 503);
      }

      const result = await service.clearQueuedMessages(sessionId, namespace);
      if (result.type === "success") {
        return c.json({ ok: true, count: result.count });
      }
      if (result.type === "not-found") {
        return c.json({ error: "Session not found" }, 404);
      }
      return c.json(
        { error: result.message },
        result.status as 400 | 500 | 502
      );
    }
  );

  // POST /sessions/:id/queue/drain — Task 17 manual-fire drain (Send Queue button)
  app.post(
    "/sessions/:id/queue/drain",
    cataloged(
      defineCapability({
        id: "messaging.queue-drain",
        domain: "messaging",
        surface: "rest",
        description:
          "Manually drain the head of a session's message queue, sending queued messages to the session now.",
        whenToUse:
          "When the user presses Send Queue to flush pending messages.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/sessions/:id/queue/drain",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) return engine;

      const sessionId = c.req.param("id");
      const namespace = c.get("namespace");

      const localSession = engine.getSession(sessionId);
      if (localSession && localSession.namespace !== namespace) {
        return c.json({ error: "Session not found" }, 404);
      }

      const service = options?.getSessionService?.();
      if (!service) {
        return c.json({ error: "Session service not available" }, 503);
      }

      const result = await service.drainQueueHead(sessionId, namespace);
      if (result.type === "success") {
        return c.json({
          ok: true,
          sent: result.sent,
          remaining: result.remaining,
        });
      }
      if (result.type === "not-found") {
        return c.json({ error: "Session not found" }, 404);
      }
      return c.json(
        { error: result.message },
        result.status as 400 | 500 | 502
      );
    }
  );

  return app;
}
