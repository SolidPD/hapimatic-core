// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { z } from "zod";
import { McpStatusUpdateSchema, MetadataSchema } from "@hapi/protocol/schemas";
import {
  sessionNameSchema,
  defineCapability,
  type NotificationKind,
} from "@hapi/protocol";
import {
  SPEND_LIMIT_VARIANTS,
  canonicalizeErrorType,
  classifyApiLimitSignal,
  type SpendLimitVariant,
} from "@hapi/protocol/apiErrorClasses";
import { configuration } from "../../configuration";
import { constantTimeEquals } from "../../utils/crypto";
import { parseAccessToken } from "../../utils/accessToken";
import { createRateLimiter } from "../middleware/rateLimit";
import type { Machine, Session, SyncEngine } from "../../sync/syncEngine";
import type { Store } from "../../store";
import type { ErrorLogger } from "../../logging/errorLogger";
import type { RotationLeaseService } from "../../services/rotationLeaseService";
import type { SharedApiKeyService } from "../../services/sharedApiKeyService";
import type { Context } from "hono";
import { createCliApiKeyRoutes } from "./cliApiKeys";
import { logAndJson } from "./routeErrorHelper";
import { cataloged } from "../../capabilities/cataloged";
import {
  apiErrorNotification,
  promptBlockedNotification,
  toolErrorNotification,
} from "../../notifications/producerNotifications";

const bearerSchema = z.string().regex(/^Bearer\s+(.+)$/i);

// Issue #1098: tighten metadata validation at the boundary so attacker-
// supplied paths can't reach the engine. MetadataSchema enforces shape
// (absolute, no traversal, no NUL); the content blacklist runs later in
// applyDisabledServerToggle (UnsafePathError). Two-layer defense: shape
// here, content there.
const createOrLoadSessionSchema = z.object({
  tag: z.string().min(1),
  metadata: MetadataSchema,
  agentState: z.unknown().nullable().optional(),
});

const renameSessionSchema = z.object({
  name: sessionNameSchema,
  /** Set to true when rename originates from tmux to prevent sync loop */
  skipTmuxSync: z.boolean().optional(),
});

const updateLinkedIssueSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string().min(1).max(500),
    repo: z.string().min(1).max(200),
  })
  .nullable();

// Issue #2862 (Fix 1 / Task 4′): body for the CLI-token retroactive parent stamp.
// parentRelationship restricted to "spawn" (defaulted) per expert-review 2862-5 —
// see parentSchema in sessionMutationHandlers.ts for the rationale.
const updateParentSchema = z.object({
  parentSessionId: z.string().min(1).max(200),
  parentRelationship: z.literal("spawn").default("spawn"),
});

// Issue #1507: body for the daemon-triggered token-refresh restart endpoint.
const tokenRefreshSchema = z.object({
  accountUuid: z.string().uuid(),
  // Issue #4679: the daemon forces the restart of a session still busy past its
  // ceiling after a rotation (skips only the busy guard). Optional, so an older
  // daemon's body parses unchanged.
  force: z.boolean().optional(),
});

const cliErrorReportSchema = z.object({
  message: z.string().min(1).max(2000),
  stack: z.string().max(5000).nullish(),
  category: z.string().min(1).max(100),
  severity: z
    .enum(["debug", "info", "warn", "error", "fatal"])
    .default("error"),
  sessionId: z.string().max(200).nullish(),
  context: z.string().max(2000).nullish(),
});

// Issue #1449: manual-login account auto-capture broadcast. .strict() REJECTS
// any unknown key (e.g. accessToken/refreshToken) — defense ensuring the daemon
// never sends a token here (redacted identity fields only). No sessionId:
// account capture is machine/account-scoped, not session-scoped.
const cliAccountCapturedSchema = z
  .object({
    accountUuid: z.string().min(1).max(200),
    emailAddress: z.string().min(1).max(320),
    organizationName: z.string().max(500).optional(),
    isNewAccount: z.boolean(),
  })
  .strict();

const createOrLoadMachineSchema = z.object({
  id: z.string().min(1),
  metadata: z.unknown(),
  daemonState: z.unknown().nullable().optional(),
});

const getMessagesQuerySchema = z.object({
  afterSeq: z.coerce.number().int().min(0),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

// Issue #4914 (epic #4912): the CLI report categories that raise a user
// notification (and, for one release, their legacy toast SyncEvent) in addition
// to landing in error_logs, each mapped to its notification kind. Every other
// category is error-log only (Lane 3). Lineage: "tool-error" (#1078), the MCP
// toggle config failures (#1107) so a reverted toggle is visible instead of
// buried in /admin/error-logs, UserPromptSubmit hook blocks (#1348), the
// in-session cron usage warning (#1460), a PTY submit-Enter cancelled on
// teardown with an unsubmitted body (#1488 Gap 3), and Anthropic API error
// phases (#1233). The non-"tool-error" tool-style categories render as
// `tool-error` rows; the original category rides `context.category`.
const ERROR_REPORT_NOTIFICATION_KINDS: Readonly<
  Record<string, NotificationKind>
> = {
  "tool-error": "tool-error",
  "mcp-toggle-config-write": "tool-error",
  "mcp-toggle-config-corrupt": "tool-error",
  "mcp-toggle-config-lock-timeout": "tool-error",
  "cron-usage-warning": "tool-error",
  "pty-submit-dropped": "tool-error",
  "prompt-blocked": "prompt-blocked",
  "api-error": "api-error",
};

// Issue #1772: exported so the sibling `/cli`-mounted impact-artifact route
// factory can share the same namespace-typed Hono env.
export type CliEnv = {
  Variables: {
    namespace: string;
  };
};

/**
 * Resolve a session by ID (UUID) or tag within a namespace.
 *
 * The sessionIdOrTag parameter can be:
 * - A UUID (e.g., "ec6d2f7e-7318-40e3-8148-02b3acc99113") - tried first
 * - A tag (e.g., "hapi-1234567890-abc123") - tried as fallback
 * - A Claude SDK session id (claudeSessionId) - tried as a final
 *   namespace-scoped fallback (#1460). CLI detectors report session.sessionId,
 *   which is the claudeSessionId, so the toast-broadcast path lands here.
 *
 * This flexibility allows CLI hooks to use HAPI_SESSION_ID (which contains the tag)
 * when calling the API, without needing to look up the UUID first.
 */
// Issue #1772: exported so the impact-artifact submit route can confirm the
// posting session belongs to the CLI token's namespace, reusing the identical
// UUID → tag → claudeSessionId resolution (no second copy of this logic).
export function resolveSessionForNamespace(
  engine: SyncEngine,
  sessionIdOrTag: string,
  namespace: string
):
  | { ok: true; session: Session }
  | { ok: false; status: 403 | 404; error: string } {
  // Try by UUID first
  const sessionById = engine.getSessionByNamespace(sessionIdOrTag, namespace);
  if (sessionById) {
    return { ok: true, session: sessionById };
  }

  // Try by tag as fallback (for CLI hooks that use HAPI_SESSION_ID)
  const sessionByTag = engine.getSessionByTagAndNamespace(
    sessionIdOrTag,
    namespace
  );
  if (sessionByTag) {
    return { ok: true, session: sessionByTag };
  }

  // Issue #1460: try by claudeSessionId (the Claude SDK session id) as a final
  // fallback. CLI detectors (toolErrorDetector / userPromptBlockDetector /
  // cronUsageDetector) report session.sessionId, which is the claudeSessionId —
  // neither the Hapimatic UUID nor the tag. Without this, the #1107 namespace
  // check 404s on every detector report, silently skipping the tool-error /
  // prompt-blocked / cron-usage toast broadcast. Scoped to `namespace` so the
  // anti-spoofing property holds (a CLI token resolves only its own namespace).
  const sessionByClaudeId = engine
    .getSessionsByNamespace(namespace)
    .find(s => s.metadata?.claudeSessionId === sessionIdOrTag);
  if (sessionByClaudeId) {
    return { ok: true, session: sessionByClaudeId };
  }

  // Check if session exists but in different namespace (access denied)
  if (engine.getSession(sessionIdOrTag)) {
    return { ok: false, status: 403, error: "Session access denied" };
  }

  return { ok: false, status: 404, error: "Session not found" };
}

function resolveMachineForNamespace(
  engine: SyncEngine,
  machineId: string,
  namespace: string
):
  | { ok: true; machine: Machine }
  | { ok: false; status: 403 | 404; error: string } {
  const machine = engine.getMachineByNamespace(machineId, namespace);
  if (machine) {
    return { ok: true, machine };
  }
  if (engine.getMachine(machineId)) {
    return { ok: false, status: 403, error: "Machine access denied" };
  }
  return { ok: false, status: 404, error: "Machine not found" };
}

export function createCliRoutes(
  getSyncEngine: () => SyncEngine | null,
  options?: {
    store?: Store;
    errorLogger?: ErrorLogger | null;
    rotationLeaseService?: RotationLeaseService;
    /** #5127: resolves and fetches API keys homed on other federation nodes. */
    sharedApiKeyService?: SharedApiKeyService;
    /** #5127 test seam: the TCP peer of a request (Bun's getConnInfo). */
    getPeerAddress?: (c: Context) => string | undefined;
  }
): Hono<CliEnv> {
  const {
    store,
    errorLogger = null,
    rotationLeaseService,
    sharedApiKeyService,
    getPeerAddress,
  } = options ?? {};
  const app = new Hono<CliEnv>();

  app.use("*", async (c, next) => {
    const raw = c.req.header("authorization");
    if (!raw) {
      return c.json({ error: "Missing Authorization header" }, 401);
    }

    const parsed = bearerSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "Invalid Authorization header" }, 401);
    }

    const token = parsed.data.replace(/^Bearer\s+/i, "");
    const parsedToken = parseAccessToken(token);
    if (
      !parsedToken ||
      !constantTimeEquals(parsedToken.baseToken, configuration.cliApiToken)
    ) {
      return c.json({ error: "Invalid token" }, 401);
    }

    c.set("namespace", parsedToken.namespace);
    return await next();
  });

  // List all sessions for this namespace (used by daemon for tmux sync lookup)
  app.get(
    "/sessions",
    cataloged(
      defineCapability({
        id: "session-lifecycle.cli-list-sessions",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "List the namespace's sessions over the CLI-token surface; used by the local daemon for tmux-sync lookup.",
        whenToUse: "When the daemon or CLI reconciles its local session set.",
        invocation: { kind: "rest", method: "GET", path: "/cli/sessions" },
        auth: "cli-token",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    c => {
      const engine = getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not ready" }, 503);
      }

      const namespace = c.get("namespace");
      const sessions = engine.getSessionsByNamespace(namespace);
      return c.json({ sessions });
    }
  );

  app.post(
    "/sessions",
    cataloged(
      defineCapability({
        id: "session-lifecycle.cli-register-session",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Register a CLI/daemon-spawned session into the namespace over the CLI-token surface.",
        whenToUse: "When the daemon reports a newly spawned local session.",
        invocation: { kind: "rest", method: "POST", path: "/cli/sessions" },
        auth: "cli-token",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not ready" }, 503);
      }
      const json = await c.req.json().catch(() => null);
      const parsed = createOrLoadSessionSchema.safeParse(json);
      if (!parsed.success) {
        return c.json({ error: "Invalid body" }, 400);
      }

      const namespace = c.get("namespace");
      const session = engine.getOrCreateSession(
        parsed.data.tag,
        parsed.data.metadata,
        parsed.data.agentState ?? null,
        namespace
      );
      return c.json({ session });
    }
  );

  app.get(
    "/sessions/:id",
    cataloged(
      defineCapability({
        id: "session-lifecycle.cli-get-session",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Fetch one session's record by id over the CLI-token surface.",
        whenToUse:
          "When the daemon needs a single session's current server-side state.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/cli/sessions/:id",
        },
        auth: "cli-token",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    c => {
      const engine = getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not ready" }, 503);
      }
      const sessionId = c.req.param("id");
      const namespace = c.get("namespace");
      const resolved = resolveSessionForNamespace(engine, sessionId, namespace);
      if (!resolved.ok) {
        return c.json({ error: resolved.error }, resolved.status);
      }
      return c.json({ session: resolved.session });
    }
  );

  app.get(
    "/sessions/:id/messages",
    cataloged(
      defineCapability({
        id: "session-introspection.cli-session-messages",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Read one session's message history over the CLI-token surface.",
        whenToUse: "When the daemon syncs a session's transcript.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/cli/sessions/:id/messages",
        },
        auth: "cli-token",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    c => {
      const engine = getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not ready" }, 503);
      }
      const sessionId = c.req.param("id");
      const namespace = c.get("namespace");
      const resolved = resolveSessionForNamespace(engine, sessionId, namespace);
      if (!resolved.ok) {
        return c.json({ error: resolved.error }, resolved.status);
      }

      const parsed = getMessagesQuerySchema.safeParse(c.req.query());
      if (!parsed.success) {
        return c.json({ error: "Invalid query" }, 400);
      }

      const limit = parsed.data.limit ?? 200;
      // Use resolved.session.id (UUID), not sessionId which may be a tag
      const messages = engine.getMessagesAfter(resolved.session.id, {
        afterSeq: parsed.data.afterSeq,
        limit,
      });
      return c.json({ messages });
    }
  );

  // Rename session (used by daemon for tmux → Hapimatic sync)
  app.patch(
    "/sessions/:id",
    cataloged(
      defineCapability({
        id: "session-lifecycle.cli-update-session",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Patch a session's mutable fields over the CLI-token surface.",
        whenToUse:
          "When the daemon updates a local session's server-side metadata.",
        invocation: {
          kind: "rest",
          method: "PATCH",
          path: "/cli/sessions/:id",
        },
        auth: "cli-token",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not ready" }, 503);
      }
      const sessionId = c.req.param("id");
      const namespace = c.get("namespace");
      const resolved = resolveSessionForNamespace(engine, sessionId, namespace);
      if (!resolved.ok) {
        return c.json({ error: resolved.error }, resolved.status);
      }

      const body = await c.req.json().catch(() => null);
      const parsed = renameSessionSchema.safeParse(body);
      if (!parsed.success) {
        const message =
          parsed.error.issues[0]?.message ?? "Invalid body: name is required";
        return c.json({ error: message }, 400);
      }

      try {
        // Pass skipTmuxSync option to prevent infinite sync loops
        // Use resolved.session.id (UUID), not sessionId which may be a tag
        await engine.renameSession(resolved.session.id, parsed.data.name, {
          skipTmuxSync: parsed.data.skipTmuxSync,
        });
        return c.json({ ok: true });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to rename session";
        if (message.includes("concurrently") || message.includes("version")) {
          return logAndJson(c, error, 409, {
            errorLogger,
            category: "cli-rename-session",
            fallbackMessage: "Failed to rename session",
            severity: "warn",
          });
        }
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "cli-rename-session",
          fallbackMessage: "Failed to rename session",
          severity: "warn",
        });
      }
    }
  );

  // Issue #1507: daemon-triggered same-account token-refresh restart. Called by
  // the daemon's TokenRefreshService.onSuccessfulRefresh callback after a refresh
  // succeeds, to push the fresh token into the already-running bound process. The
  // /cli namespace uses CLI API token auth (no JWT), so the daemon calls it
  // without user credentials.
  app.post(
    "/sessions/:id/token-refresh",
    cataloged(
      defineCapability({
        id: "session-lifecycle.cli-session-token-refresh",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Refresh a session's account token and restart it over the CLI-token surface.",
        whenToUse:
          "When a session's credential must be rotated without losing its identity.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/cli/sessions/:id/token-refresh",
        },
        auth: "cli-token",
        riskTier: "mutating",
        availability: { scope: "user" },
        probe: "skip",
      })
    ),
    async c => {
      const engine = getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not ready" }, 503);
      }
      const sessionId = c.req.param("id");
      const namespace = c.get("namespace");
      const resolved = resolveSessionForNamespace(engine, sessionId, namespace);
      if (!resolved.ok) {
        return c.json({ error: resolved.error }, resolved.status);
      }

      const body = await c.req.json().catch(() => null);
      const parsed = tokenRefreshSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "Invalid body: expected { accountUuid }" }, 400);
      }

      try {
        // Use resolved.session.id (UUID), not sessionId which may be a tag.
        const result = await engine.tokenRefreshRestart(
          resolved.session.id,
          parsed.data.accountUuid,
          { force: parsed.data.force }
        );
        if (result.type === "success") {
          return c.json({ ok: true });
        }
        if (result.type === "deferred") {
          // 202 Accepted: session is busy (or the instance is at capacity);
          // the daemon retries.
          return c.json(
            { ok: false, deferred: true, reason: result.reason },
            202
          );
        }
        return c.json(
          { ok: false, error: result.message, code: result.code },
          500
        );
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "cli-token-refresh-restart",
          fallbackMessage: "Failed to restart session for token refresh",
          severity: "warn",
        });
      }
    }
  );

  // Update linked issue (used by hooks for auto-linking issues)
  app.put(
    "/sessions/:id/linked-issue",
    cataloged(
      defineCapability({
        id: "session-introspection.cli-set-linked-issue",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Set or clear a session's linked GitHub issue over the CLI-token surface.",
        whenToUse:
          "When a workflow skill links a session to the issue it is working.",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/cli/sessions/:id/linked-issue",
        },
        auth: "cli-token",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not ready" }, 503);
      }
      const sessionId = c.req.param("id");
      const namespace = c.get("namespace");
      const resolved = resolveSessionForNamespace(engine, sessionId, namespace);
      if (!resolved.ok) {
        return c.json({ error: resolved.error }, resolved.status);
      }

      const body = await c.req.json().catch(() => null);
      const parsed = updateLinkedIssueSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { error: "Invalid body: expected { number, title, repo } or null" },
          400
        );
      }

      try {
        // Use resolved.session.id (UUID), not sessionId which may be a tag
        await engine.updateSessionLinkedIssue(resolved.session.id, parsed.data);
        return c.json({ ok: true });
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "cli-update-linked-issue",
          fallbackMessage: "Failed to update linked issue",
          severity: "warn",
        });
      }
    }
  );

  // Issue #2862 (Fix 1 / Task 4′): retroactively stamp a session's managed-peer
  // parent over the CLI-token surface. This is the route the CROSS-REPO orphan-
  // adoption caller (rp1-home spawn-with-link.sh — authenticates with CLI_API_TOKEN
  // and passes a TAG) will use to heal an orphan whose spawn timed out after the
  // daemon succeeded. Local-only (no federation proxy); resolves BOTH the target
  // and the parent tag→uuid so grouping.ts matches. Mirrors the linked-issue route.
  app.put(
    "/sessions/:id/parent",
    cataloged(
      defineCapability({
        id: "session-introspection.cli-set-parent",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Set a session's managed-peer parent link (parentSessionId + spawn relationship) over the CLI-token surface.",
        whenToUse:
          "When orphan-adoption heals the parent stamp of a session whose spawn timed out after the daemon succeeded.",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/cli/sessions/:id/parent",
        },
        auth: "cli-token",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not ready" }, 503);
      }
      const sessionId = c.req.param("id");
      const namespace = c.get("namespace");
      const resolved = resolveSessionForNamespace(engine, sessionId, namespace);
      if (!resolved.ok) {
        return c.json({ error: resolved.error }, resolved.status);
      }

      const body = await c.req.json().catch(() => null);
      const parsed = updateParentSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          {
            error:
              'Invalid body: expected { parentSessionId: string, parentRelationship?: "spawn" }',
          },
          400
        );
      }

      // Resolve the parent tag→uuid so the stored parentSessionId is the canonical
      // uuid grouping.ts matches on; unresolved (already a uuid, or unknown) is
      // stored as-is. Reject self-parent (mirrors PARENT_MUTATION.preHook).
      const parentResolved =
        engine.getSessionByNamespace(parsed.data.parentSessionId, namespace) ??
        engine.getSessionByTagAndNamespace(
          parsed.data.parentSessionId,
          namespace
        );
      const parentSessionId = parentResolved?.id ?? parsed.data.parentSessionId;
      if (parentSessionId === resolved.session.id) {
        return c.json({ error: "A session cannot be its own parent" }, 400);
      }

      try {
        // Use resolved.session.id (UUID), not sessionId which may be a tag
        await engine.updateSessionParentRelationship(
          resolved.session.id,
          parentSessionId,
          parsed.data.parentRelationship
        );
        return c.json({ ok: true });
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "cli-update-parent",
          fallbackMessage: "Failed to update session parent",
          severity: "warn",
        });
      }
    }
  );

  // Clear linked issue from ALL sessions that have a specific issue linked
  // Used by issue-approval-detector hook when closing an issue
  app.delete(
    "/linked-issues/:number",
    cataloged(
      defineCapability({
        id: "session-introspection.cli-delete-linked-issue",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Remove a linked-issue association by issue number over the CLI-token surface.",
        whenToUse: "When a session finishes an issue and unlinks it.",
        invocation: {
          kind: "rest",
          method: "DELETE",
          path: "/cli/linked-issues/:number",
        },
        auth: "cli-token",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not ready" }, 503);
      }

      const issueNumber = parseInt(c.req.param("number"), 10);
      if (isNaN(issueNumber) || issueNumber <= 0) {
        return c.json({ error: "Invalid issue number" }, 400);
      }

      const namespace = c.get("namespace");
      const sessions = engine.getSessionsByNamespace(namespace);

      let clearedCount = 0;
      const errors: string[] = [];

      for (const session of sessions) {
        if (session.linkedIssue?.number === issueNumber) {
          try {
            await engine.updateSessionLinkedIssue(session.id, null);
            clearedCount++;
          } catch (error) {
            const errMessage =
              error instanceof Error ? error.message : "unknown";
            errors.push(
              `Failed to clear from session ${session.id}: ${errMessage}`
            );
            if (errorLogger) {
              errorLogger.warn(
                `Failed to clear linked issue from session ${session.id}`,
                {
                  category: "cli-clear-linked-issues",
                  stack: error instanceof Error ? error.stack : null,
                  context: { sessionId: session.id, issueNumber },
                }
              );
            } else {
              console.warn(
                `[cli-clear-linked-issues] session ${session.id}: ${errMessage}`
              );
            }
          }
        }
      }

      return c.json({
        ok: true,
        clearedCount,
        errors: errors.length > 0 ? errors : undefined,
      });
    }
  );

  app.post(
    "/machines",
    cataloged(
      defineCapability({
        id: "machine-daemon.cli-register-machine",
        domain: "machine-daemon",
        surface: "rest",
        description:
          "Register or upsert a machine record for the local daemon over the CLI-token surface.",
        whenToUse: "When a daemon comes online and announces its machine.",
        invocation: { kind: "rest", method: "POST", path: "/cli/machines" },
        auth: "cli-token",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not ready" }, 503);
      }
      const json = await c.req.json().catch(() => null);
      const parsed = createOrLoadMachineSchema.safeParse(json);
      if (!parsed.success) {
        return c.json({ error: "Invalid body" }, 400);
      }

      const namespace = c.get("namespace");
      const existing = engine.getMachine(parsed.data.id);
      if (existing && existing.namespace !== namespace) {
        return c.json({ error: "Machine access denied" }, 403);
      }
      const machine = engine.getOrCreateMachine(
        parsed.data.id,
        parsed.data.metadata,
        parsed.data.daemonState ?? null,
        namespace
      );
      return c.json({ machine });
    }
  );

  app.get(
    "/machines/:id",
    cataloged(
      defineCapability({
        id: "machine-daemon.cli-get-machine",
        domain: "machine-daemon",
        surface: "rest",
        description:
          "Fetch one machine record by id over the CLI-token surface.",
        whenToUse:
          "When the daemon needs a machine's current server-side state.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/cli/machines/:id",
        },
        auth: "cli-token",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    c => {
      const engine = getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not ready" }, 503);
      }
      const machineId = c.req.param("id");
      const namespace = c.get("namespace");
      const resolved = resolveMachineForNamespace(engine, machineId, namespace);
      if (!resolved.ok) {
        return c.json({ error: resolved.error }, resolved.status);
      }
      return c.json({ machine: resolved.machine });
    }
  );

  app.post(
    "/mcp-status",
    cataloged(
      defineCapability({
        id: "mcp.cli-update-status",
        domain: "mcp",
        surface: "rest",
        description:
          "Push the session's live MCP server status into the sync engine over the CLI-token surface.",
        whenToUse: "When a session's MCP connection state changes.",
        invocation: { kind: "rest", method: "POST", path: "/cli/mcp-status" },
        auth: "cli-token",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const json = await c.req.json().catch(() => null);
      const parsed = McpStatusUpdateSchema.safeParse(json);
      if (!parsed.success) {
        return c.json({ error: "Invalid MCP status data" }, 400);
      }
      const engine = getSyncEngine();
      if (!engine) {
        return c.json({ ok: false, error: "Sync engine not available" }, 503);
      }
      engine.updateMcpStatus(parsed.data);
      return c.json({ ok: true });
    }
  );

  if (store) {
    const errorReportsLimiter = createRateLimiter({
      name: "cli-error-reports",
    });

    app.post(
      "/error-reports",
      cataloged(
        defineCapability({
          id: "messaging.cli-error-report",
          domain: "messaging",
          surface: "rest",
          description:
            "Ingest a CLI-side error report into the error-logs store over the CLI-token surface (mounted only when the store is configured).",
          whenToUse:
            "When the CLI captures a client-side error to surface in the web UI.",
          invocation: {
            kind: "rest",
            method: "POST",
            path: "/cli/error-reports",
          },
          auth: "cli-token",
          riskTier: "mutating",
          availability: { scope: "user", mountedWhen: "store" },
        })
      ),
      errorReportsLimiter,
      async c => {
        const json = await c.req.json().catch(() => null);
        const parsed = cliErrorReportSchema.safeParse(json);
        if (!parsed.success) {
          return c.json({ error: "Invalid body" }, 400);
        }

        const namespace = c.get("namespace");
        const data = parsed.data;

        const entry = store.errorLogs.createEntry({
          severity: data.severity,
          category: data.category,
          source: "cli",
          message: data.message,
          stack: data.stack ?? null,
          sessionId: data.sessionId ?? null,
          namespace,
          context: data.context ?? null,
        });

        // Issue #1078 (extended in #1107, #4914): for a notification category
        // tied to a session, raise a user notification (#4914) and broadcast the
        // legacy toast SyncEvent. Persistence is unchanged (the entry above goes
        // to error_logs, so every notify() below passes mirror:false to avoid a
        // second row). See ERROR_REPORT_NOTIFICATION_KINDS above for the set.
        // Object.hasOwn: a category such as "toString" must never match.
        if (
          Object.hasOwn(ERROR_REPORT_NOTIFICATION_KINDS, data.category) &&
          data.sessionId
        ) {
          const engine = getSyncEngine();
          if (!engine) {
            console.warn(
              "[cli/error-reports] tool-error broadcast skipped: sync engine unavailable",
              { sessionId: data.sessionId, namespace }
            );
          } else {
            // Hardening: validate that the supplied sessionId actually belongs to
            // the caller's namespace before broadcasting a tool-error toast that
            // claims to come from that session. Without this check, a CLI token
            // can spoof tool-error toasts referencing arbitrary sessions in its
            // namespace (UI-spoofing surface).
            const resolved = resolveSessionForNamespace(
              engine,
              data.sessionId,
              namespace
            );
            if (!resolved.ok) {
              console.warn(
                "[cli/error-reports] tool-error broadcast skipped: sessionId not in caller namespace",
                {
                  sessionId: data.sessionId,
                  namespace,
                  status: resolved.status,
                }
              );
            } else if (data.category === "prompt-blocked") {
              // Issue #1348: synthesize prompt-blocked SyncEvent. UserPromptSubmit
              // hook blocks use a different context schema than tool-error
              // ({hookEvent, blockedReason, originalPrompt}) so they get their
              // own SyncEvent variant and toast surface. See #1078 / cli/src/
              // claude/utils/userPromptBlockDetector.ts for the producer side.
              let blockedReason = data.message;
              let originalPrompt: string | undefined;

              if (data.context) {
                try {
                  const ctx = JSON.parse(data.context) as Record<
                    string,
                    unknown
                  >;
                  if (typeof ctx.blockedReason === "string") {
                    blockedReason = ctx.blockedReason;
                  }
                  if (typeof ctx.originalPrompt === "string") {
                    originalPrompt = ctx.originalPrompt;
                  }
                } catch (err) {
                  // Fall back to message if context is not parseable (mirrors
                  // the tool-error path's defensive parse below).
                  console.warn(
                    "[cli/error-reports] prompt-blocked context JSON parse failed; degraded toast will be sent",
                    {
                      sessionId: data.sessionId,
                      namespace,
                      error: err instanceof Error ? err.message : String(err),
                    }
                  );
                  if (errorLogger) {
                    errorLogger.warn(
                      "[cli/error-reports] prompt-blocked context JSON parse failed",
                      {
                        category: "cli-error-report-parse",
                        stack: err instanceof Error ? err.stack : null,
                        context: {
                          sessionId: data.sessionId,
                          namespace,
                        },
                      }
                    );
                  }
                }
              }

              // TODO(#4912): legacy prompt-blocked SyncEvent, kept for one
              // release so a pre-#4915 web client still toasts. Remove its
              // SSE/web delivery once Sub C (#4915) has shipped for a release.
              engine.handleRealtimeEvent({
                type: "prompt-blocked",
                sessionId: resolved.session.id,
                namespace,
                data: {
                  hookEvent: "UserPromptSubmit",
                  blockedReason: blockedReason.slice(0, 2000),
                  originalPrompt: originalPrompt?.slice(0, 500),
                },
              });
              // #4914: AFTER the namespace check above (the #1107 rule) and
              // keyed by the resolved session UUID, never the raw report id.
              engine.notifyUser({
                ...promptBlockedNotification({
                  sessionId: resolved.session.id,
                  blockedReason,
                  originalPrompt,
                }),
                namespace,
                mirror: false,
              });
            } else if (data.category === "api-error") {
              // Issue #1233 (Epic #1231): Anthropic API error visibility. The
              // context schema differs from tool-error/prompt-blocked
              // ({phase, errorType, retryAttempt?, maxRetries?, requestId?}), so
              // it gets its own SyncEvent variant + toast surface. #1232 (Sub-
              // Issue A) is the producer of these reports. Payload is NESTED
              // (locked contract LC-1) — #1234 reads event.data.*.
              let phase: "retrying" | "exhausted" | "recovered" | "give-up" =
                "exhausted";
              let errorType = "unknown";
              let retryAttempt: number | undefined;
              let maxRetries: number | undefined;
              let requestId: string | undefined;
              // #4936: spend-limit detail + the fields an older CLI sends, used
              // below to re-classify its report with the shared classifier.
              let limitVariant: SpendLimitVariant | undefined;
              let resumesAt: number | undefined;
              let apiErrorStatus: number | undefined;
              let errorCode: string | undefined;
              let innerText: string | undefined;

              if (data.context) {
                try {
                  const ctx = JSON.parse(data.context) as Record<
                    string,
                    unknown
                  >;
                  if (
                    typeof ctx.phase === "string" &&
                    ["retrying", "exhausted", "recovered", "give-up"].includes(
                      ctx.phase
                    )
                  ) {
                    phase = ctx.phase as typeof phase;
                  }
                  if (typeof ctx.errorType === "string")
                    errorType = ctx.errorType;
                  if (typeof ctx.retryAttempt === "number")
                    retryAttempt = ctx.retryAttempt;
                  if (typeof ctx.maxRetries === "number")
                    maxRetries = ctx.maxRetries;
                  if (typeof ctx.requestId === "string")
                    requestId = ctx.requestId;
                  if (
                    typeof ctx.limitVariant === "string" &&
                    (SPEND_LIMIT_VARIANTS as readonly string[]).includes(
                      ctx.limitVariant
                    )
                  ) {
                    limitVariant = ctx.limitVariant as SpendLimitVariant;
                  }
                  if (
                    typeof ctx.resumesAt === "number" &&
                    Number.isFinite(ctx.resumesAt) &&
                    ctx.resumesAt > 0
                  ) {
                    resumesAt = ctx.resumesAt;
                  }
                  if (typeof ctx.apiErrorStatus === "number")
                    apiErrorStatus = ctx.apiErrorStatus;
                  if (typeof ctx.errorCode === "string")
                    errorCode = ctx.errorCode;
                  if (typeof ctx.innerText === "string")
                    innerText = ctx.innerText;
                } catch (err) {
                  // R6 fail-soft (mirrors the prompt-blocked/tool-error path):
                  // degrade to phase="exhausted", errorType="unknown" and still
                  // broadcast, so the user sees a visible warning instead of a
                  // silent drop.
                  console.warn(
                    "[cli/error-reports] api-error context JSON parse failed; degraded broadcast will be sent",
                    {
                      sessionId: data.sessionId,
                      namespace,
                      error: err instanceof Error ? err.message : String(err),
                    }
                  );
                  if (errorLogger) {
                    errorLogger.warn(
                      "[cli/error-reports] api-error context JSON parse failed",
                      {
                        category: "cli-error-report-parse",
                        stack: err instanceof Error ? err.stack : null,
                        context: {
                          sessionId: data.sessionId,
                          namespace,
                        },
                      }
                    );
                  }
                }
              }

              // #4936 version-skew re-check: a tmux/pty session keeps the CLI
              // binary it was spawned with, so after a deploy an older CLI still
              // reports a spend cap as `rate_limit_error` / `unknown`. Re-run
              // the SAME shared classifier on what it sent (status + the first
              // 500 chars of the rendered text, which hold the whole cap
              // sentence) and upgrade a match to the terminal class.
              if (
                phase === "exhausted" &&
                canonicalizeErrorType(errorType) !== "spend_limit_error"
              ) {
                const recheck = classifyApiLimitSignal({
                  status: apiErrorStatus,
                  errorCode,
                  text: innerText,
                });
                if (recheck.kind === "spend-limit") {
                  errorType = "spend_limit_error";
                  limitVariant = recheck.variant;
                  resumesAt = recheck.resumesAt ?? undefined;
                }
              }

              // TODO(#4912): legacy api-error SyncEvent, kept for one release
              // so a pre-#4915 web client still toasts. Remove its SSE/web
              // delivery once Sub C (#4915) has shipped for a release. Server
              // consumers: AutoRecoveryService + OrphanGrantObserver +
              // SpendLimitNoticeObserver + sessionStateWaiter — keep the
              // internal event or migrate them first.
              engine.handleRealtimeEvent({
                type: "api-error",
                sessionId: resolved.session.id,
                namespace,
                data: {
                  phase,
                  errorType,
                  retryAttempt,
                  maxRetries,
                  requestId,
                  ...(limitVariant !== undefined ? { limitVariant } : {}),
                  ...(resumesAt !== undefined ? { resumesAt } : {}),
                },
              });
              engine.notifyUser({
                ...apiErrorNotification({
                  sessionId: resolved.session.id,
                  phase,
                  errorType,
                  retryAttempt,
                  maxRetries,
                  requestId,
                  limitVariant,
                  resumesAt,
                }),
                namespace,
                mirror: false,
              });
            } else {
              let toolName = "unknown";
              let toolUseId = "";
              let errorContent = data.message;

              if (data.context) {
                try {
                  const ctx = JSON.parse(data.context) as Record<
                    string,
                    unknown
                  >;
                  if (typeof ctx.toolName === "string") toolName = ctx.toolName;
                  if (typeof ctx.toolUseId === "string")
                    toolUseId = ctx.toolUseId;
                  if (typeof ctx.errorContent === "string") {
                    errorContent = ctx.errorContent;
                  }
                  // Issue #1107: mcp-toggle-config-* reports use a different
                  // context schema ({projectDir, serverName, enabled, ...}) and
                  // have no toolName/toolUseId. Synthesize a meaningful label
                  // from serverName so the toast doesn't read "unknown: ...".
                  if (
                    toolName === "unknown" &&
                    typeof ctx.serverName === "string"
                  ) {
                    toolName = `MCP toggle: ${ctx.serverName}`;
                  }
                } catch (err) {
                  // Fall back to message if context is not parseable.
                  console.warn(
                    "[cli/error-reports] tool-error context JSON parse failed; degraded toast will be sent",
                    {
                      sessionId: data.sessionId,
                      namespace,
                      error: err instanceof Error ? err.message : String(err),
                    }
                  );
                  if (errorLogger) {
                    errorLogger.warn(
                      "[cli/error-reports] tool-error context JSON parse failed",
                      {
                        category: "cli-error-report-parse",
                        stack: err instanceof Error ? err.stack : null,
                        context: {
                          sessionId: data.sessionId,
                          namespace,
                        },
                      }
                    );
                  }
                }
              }

              // TODO(#4912): legacy tool-error SyncEvent, kept for one release
              // so a pre-#4915 web client still toasts. Remove its SSE/web
              // delivery once Sub C (#4915) has shipped for a release. Server
              // consumers: InitiativeEventObserver — keep the internal event or
              // migrate it first.
              engine.handleRealtimeEvent({
                type: "tool-error",
                sessionId: resolved.session.id,
                namespace,
                data: {
                  toolName,
                  toolUseId,
                  errorContent: errorContent.slice(0, 2000),
                },
              });
              // A known-benign class (#1612 R5) is dropped by notify()'s
              // kind-level suppression rule; the legacy event above still fires.
              engine.notifyUser({
                ...toolErrorNotification({
                  sessionId: resolved.session.id,
                  category: data.category,
                  toolName,
                  toolUseId,
                  errorContent,
                }),
                namespace,
                mirror: false,
              });
            }
          }
        }

        return c.json({ id: entry.id }, 201);
      }
    );
  }

  // Issue #1449: manual-login account auto-capture -> live dropdown SSE.
  // Non-session-scoped (machine/account level), so this sits OUTSIDE the
  // `if (store)` block (no error_logs persistence) and needs no
  // resolveSessionForNamespace. Mirrors the /cli/error-reports broadcast shape
  // (#1078): validate -> getSyncEngine() guard -> handleRealtimeEvent.
  const accountCapturedLimiter = createRateLimiter({
    name: "cli-account-captured",
  });

  app.post(
    "/account-captured",
    cataloged(
      defineCapability({
        id: "accounts.cli-account-captured",
        domain: "accounts",
        surface: "rest",
        description:
          "Record that an Anthropic account credential was captured on this node over the CLI-token surface; the body carries only the account uuid.",
        whenToUse:
          "When a browser-login capture completes on the host and reports back.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/cli/account-captured",
        },
        auth: "cli-token",
        riskTier: "mutating",
        availability: { scope: "user" },
        probe: "skip",
      })
    ),
    accountCapturedLimiter,
    async c => {
      const json = await c.req.json().catch(() => null);
      const parsed = cliAccountCapturedSchema.safeParse(json);
      if (!parsed.success) {
        return c.json({ error: "Invalid body" }, 400);
      }

      const engine = getSyncEngine();
      if (!engine) {
        // Tolerant (matches error-reports): the account is already persisted in
        // the CLI's AccountStore; this SSE is the live-update path only. Don't
        // fail the daemon's POST over a transiently-unavailable engine.
        console.warn(
          "[cli/account-captured] broadcast skipped: sync engine unavailable"
        );
        return c.json({ ok: true }, 200);
      }

      engine.handleRealtimeEvent({
        type: "account-captured",
        accountUuid: parsed.data.accountUuid,
        emailAddress: parsed.data.emailAddress,
        organizationName: parsed.data.organizationName,
        isNewAccount: parsed.data.isNewAccount,
        namespace: c.get("namespace"),
      });

      return c.json({ ok: true }, 200);
    }
  );

  // ─── Issue #1644: daemon-facing cross-machine rotation-lease endpoints ──
  //
  // The daemon's rotationLeaseClient POSTs here before any proactive
  // (TokenRefreshService.tick) or recovery tier-b (isolatedSnapshotRecovery)
  // rotation. The `app.use("*")` middleware above already gates these by
  // cliApiToken. The body carries only `accountUuid`; the server stamps the
  // holder (federationConfig.nodeId) inside RotationLeaseService, so the CLI
  // stays node-agnostic. When the service is not wired (e.g. a minimal test
  // harness), fail open — granting machine-local rotation preserves #1635.
  // #5127: shared API keys across federation nodes — the identity and secret
  // routes a session's daemon, launcher and apiKeyHelper call (./cliApiKeys.ts).
  // Mounted here so the CLI-token middleware above runs first.
  app.route(
    "/",
    createCliApiKeyRoutes(getSyncEngine, {
      errorLogger,
      sharedApiKeyService,
      getPeerAddress,
      resolveSession: resolveSessionForNamespace,
    })
  );

  const accountLeaseSchema = z.object({ accountUuid: z.string().uuid() });

  app.post(
    "/account-lease/acquire",
    cataloged(
      defineCapability({
        id: "accounts.cli-account-lease-acquire",
        domain: "accounts",
        surface: "rest",
        description:
          "Acquire a load-balancing lease on an Anthropic account for a session over the CLI-token surface.",
        whenToUse:
          "When a spawning session needs an account bound under the multi-account balancer.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/cli/account-lease/acquire",
        },
        auth: "cli-token",
        riskTier: "mutating",
        availability: { scope: "user" },
        probe: "skip",
      })
    ),
    async c => {
      const json = await c.req.json().catch(() => null);
      const parsed = accountLeaseSchema.safeParse(json);
      if (!parsed.success) {
        return c.json({ error: "Invalid body" }, 400);
      }
      if (!rotationLeaseService) {
        return c.json(
          { granted: true, holder: null, reason: "service-unavailable" },
          200
        );
      }
      const r = await rotationLeaseService.acquire(parsed.data.accountUuid);
      return c.json(
        { granted: r.granted, holder: r.holder, reason: r.reason },
        200
      );
    }
  );

  app.post(
    "/account-lease/heartbeat",
    cataloged(
      defineCapability({
        id: "accounts.cli-account-lease-heartbeat",
        domain: "accounts",
        surface: "rest",
        description:
          "Renew an in-flight account lease over the CLI-token surface so the balancer keeps it assigned.",
        whenToUse:
          "While a session holds an account lease and must keep it alive.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/cli/account-lease/heartbeat",
        },
        auth: "cli-token",
        riskTier: "mutating",
        availability: { scope: "user" },
        probe: "skip",
      })
    ),
    async c => {
      const json = await c.req.json().catch(() => null);
      const parsed = accountLeaseSchema.safeParse(json);
      if (!parsed.success) {
        return c.json({ error: "Invalid body" }, 400);
      }
      if (!rotationLeaseService) {
        return c.json(
          { granted: true, holder: null, reason: "service-unavailable" },
          200
        );
      }
      const r = await rotationLeaseService.heartbeat(parsed.data.accountUuid);
      return c.json(
        { granted: r.granted, holder: r.holder, reason: r.reason },
        200
      );
    }
  );

  app.post(
    "/account-lease/release",
    cataloged(
      defineCapability({
        id: "accounts.cli-account-lease-release",
        domain: "accounts",
        surface: "rest",
        description:
          "Release an account lease back to the balancer over the CLI-token surface.",
        whenToUse: "When a session ends and returns its account to the pool.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/cli/account-lease/release",
        },
        auth: "cli-token",
        riskTier: "mutating",
        availability: { scope: "user" },
        probe: "skip",
      })
    ),
    async c => {
      const json = await c.req.json().catch(() => null);
      const parsed = accountLeaseSchema.safeParse(json);
      if (!parsed.success) {
        return c.json({ error: "Invalid body" }, 400);
      }
      if (!rotationLeaseService) {
        return c.json(
          { granted: true, holder: null, reason: "service-unavailable" },
          200
        );
      }
      const r = await rotationLeaseService.release(parsed.data.accountUuid);
      return c.json(
        { granted: r.granted, holder: r.holder, reason: r.reason },
        200
      );
    }
  );

  return app;
}
