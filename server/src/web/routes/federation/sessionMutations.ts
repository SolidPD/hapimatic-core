// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { z } from "zod";
import {
  defineCapability,
  isModelModeAllowedForFlavor,
  isPermissionModeAllowedForFlavor,
} from "@hapi/protocol";
import {
  AgentTranscriptQuerySchema,
  ApplySessionConfigSchema,
  RelaunchRequestSchema,
} from "@hapi/protocol/schemas";
import { agentTranscriptPage } from "../../../sync/transcript/agentTranscriptPage";
import { getKnownSecretLiterals } from "../../../services/knownSecretLiterals";
import type { WebAppEnv } from "../../middleware/auth";
import type { FederationDeps } from "./shared";
import { checkCallerNamespace, checkFederationToken } from "./shared";
import { cataloged } from "../../../capabilities/cataloged";
import { logAndJson } from "../routeErrorHelper";
import { runCapabilityInvoke } from "../capabilityPolicy";
import {
  SESSION_FIELD_MUTATIONS,
  RENAME_MUTATION,
  registerFederationFieldReceiver,
  resolveClientInvalidBody,
} from "../sessionMutationHandlers";

export function createSessionMutationRoutes(
  deps: FederationDeps
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  // ─── Schemas ───
  // Issue #2082: the 8 per-session field-mutation schemas moved to the shared
  // `sessionMutationHandlers` descriptor table (single source of truth for both
  // the client route and these receivers). The rename receiver + the 7 looped
  // PUT receivers reference `<descriptor>.schema`. Only the non-field receiver
  // schemas (mcp-toggle / mcp-set-desired / account) remain local.
  const federationMcpToggleSchema = z.object({
    serverName: z.string().min(1),
    enabled: z.boolean(),
  });

  // Issue #2256: set-model federation receiver schema (field is `modelMode`,
  // matching the landed #2421 handler contract).
  const federationSetModelSchema = z.object({
    modelMode: z.string().min(1),
  });

  // Issue #2346: set-permission-mode federation receiver schema. Field is `mode`;
  // kept as z.string() here — the client route's SetPermissionModeRequestSchema
  // and the CLI resolvePermissionMode enum-validate it; the receiver only forwards.
  const federationSetPermissionModeSchema = z.object({
    mode: z.string().min(1),
  });

  const federationMcpSetDesiredSchema = z.object({
    desired: z.record(z.string(), z.boolean()),
  });

  const federationAccountSchema = z.object({
    accountUuid: z.string(),
  });

  // ─── Node-to-node endpoint: PATCH /federation/sessions/:id (rename) ─
  app.patch(
    "/federation/sessions/:id",
    cataloged(
      defineCapability({
        id: "session-lifecycle.api-federation-sessions-rename",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Rename a session on the federation node that owns it. Peer-incoming receiver; the hub proxies here when the target session runs on this node.",
        whenToUse:
          "When a rename must be applied to a session whose process lives on a remote federation node.",
        invocation: {
          kind: "rest",
          method: "PATCH",
          path: "/api/federation/sessions/:id",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const engine = deps.getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not connected" }, 503);
      }

      const sessionId = c.req.param("id");
      const session = engine.getSession(sessionId);
      if (!session) {
        return c.json({ error: "Session not found" }, 404);
      }

      const nsCheck = checkCallerNamespace(c, session);
      if (nsCheck) return nsCheck;

      const body = await c.req.json().catch(() => null);
      const parsed = RENAME_MUTATION.schema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { error: resolveClientInvalidBody(RENAME_MUTATION, parsed.error) },
          400
        );
      }

      try {
        await RENAME_MUTATION.applyLocal(
          engine,
          sessionId,
          RENAME_MUTATION.extractValue(parsed.data)
        );
        return c.json({ ok: true });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to rename session";
        if (message.includes("concurrently") || message.includes("version")) {
          return logAndJson(c, error, 409, {
            errorLogger: deps.errorLogger ?? null,
            category: "federation-rename-session",
            fallbackMessage: "Failed to rename session",
          });
        }
        return logAndJson(c, error, 500, {
          errorLogger: deps.errorLogger ?? null,
          category: "federation-rename-session",
          fallbackMessage: "Failed to rename session",
        });
      }
    }
  );

  // ─── Node-to-node endpoint: GET /federation/sessions/:id/token-stats ─
  // Issue #1671 (epic #1662, Sub I): peer-incoming READ of the owning node's
  // `v_session_totals` + per-turn breakdown. A per-session token-stats read must
  // not leak another namespace's data, so checkCallerNamespace is applied (404
  // on mismatch, mirroring the mutation receivers).
  app.get(
    "/federation/sessions/:id/token-stats",
    cataloged(
      defineCapability({
        id: "session-introspection.api-federation-sessions-token-stats",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Read a session's token-usage totals and per-turn breakdown from the node that owns it. Peer-incoming receiver behind namespace ownership.",
        whenToUse:
          "When the hub needs token statistics for a session whose process lives on a remote federation node.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/federation/sessions/:id/token-stats",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const engine = deps.getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not connected" }, 503);
      }

      const sessionId = c.req.param("id");
      const session = engine.getSession(sessionId);
      if (!session) {
        return c.json({ error: "Session not found" }, 404);
      }

      const nsCheck = checkCallerNamespace(c, session);
      if (nsCheck) return nsCheck;

      return c.json(engine.getSessionTokenStats(sessionId));
    }
  );

  // ─── Node-to-node endpoint: GET /federation/sessions/:id/workflow-state ─
  // Issue #1672 (epic #1662, Sub J): peer-incoming READ of the owning node's
  // `v_workflow_state` badge + per-turn label events. Mirrors the token-stats
  // receiver — checkCallerNamespace guards against cross-namespace leakage.
  app.get(
    "/federation/sessions/:id/workflow-state",
    cataloged(
      defineCapability({
        id: "session-introspection.api-federation-sessions-workflow-state",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Read a session's workflow-state badge and per-turn label events from the node that owns it. Peer-incoming receiver behind namespace ownership.",
        whenToUse:
          "When the hub needs the workflow-state badge for a session whose process lives on a remote federation node.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/federation/sessions/:id/workflow-state",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const engine = deps.getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not connected" }, 503);
      }

      const sessionId = c.req.param("id");
      const session = engine.getSession(sessionId);
      if (!session) {
        return c.json({ error: "Session not found" }, 404);
      }

      const nsCheck = checkCallerNamespace(c, session);
      if (nsCheck) return nsCheck;

      return c.json(engine.getSessionWorkflowState(sessionId));
    }
  );

  // ─── Node-to-node endpoint: GET /federation/sessions/:id/background-agents/:agentId/transcript ─
  // Issue #4387 (epic #4382, Sub E): peer-incoming READ of ONE background
  // agent's sub-transcript, served newest-first and REDACTED from the owning
  // node's disk via #4386's reader (`agentTranscriptPage`, which validates the
  // agentId, guards path-traversal, caps and scrubs). The owning node redacts
  // before anything crosses — the hub never sees raw text. checkCallerNamespace
  // guards against cross-namespace leakage (404 on mismatch, mirroring the
  // token-stats / workflow-state receivers). Cataloged at the sensitive-read
  // tier (riskTier "mutating", #3837 R12 — historical conversation content is
  // never generically invocable), matching #4386's local route.
  const numQuery = (raw: string | undefined): number | undefined => {
    if (raw === undefined || raw === "") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  const strQuery = (raw: string | undefined): string | undefined =>
    raw === undefined || raw === "" ? undefined : raw;

  app.get(
    "/federation/sessions/:id/background-agents/:agentId/transcript",
    cataloged(
      defineCapability({
        id: "session-introspection.api-federation-sessions-background-agent-transcript",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Read one background agent's sub-transcript (newest-first, scrubbed, capped) from the node that owns the session. Peer-incoming receiver behind namespace ownership.",
        whenToUse:
          "When the hub needs a background agent's peek pages for a session whose process lives on a remote federation node.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/federation/sessions/:id/background-agents/:agentId/transcript",
        },
        auth: "federation-token",
        // Historical conversation content → never readonly (#3837 R12), same
        // tier as #4386's local route.
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const engine = deps.getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not connected" }, 503);
      }

      const sessionId = c.req.param("id");
      const agentId = c.req.param("agentId");
      const session = engine.getSession(sessionId);
      if (!session) {
        return c.json({ error: "Session not found" }, 404);
      }

      const nsCheck = checkCallerNamespace(c, session);
      if (nsCheck) return nsCheck;

      const parsed = AgentTranscriptQuerySchema.safeParse({
        limit: numQuery(c.req.query("limit")),
        before: strQuery(c.req.query("before")),
        after: strQuery(c.req.query("after")),
        full: strQuery(c.req.query("full")),
      });
      if (!parsed.success) {
        return c.json(
          { error: "Invalid query", details: parsed.error.issues },
          400
        );
      }

      const paths = engine.getAgentTranscriptPaths(sessionId);
      if (!paths) {
        return c.json({ error: "transcript not yet available" }, 404);
      }

      const result = await agentTranscriptPage({
        subagentsDir: paths.subagentsDir,
        ccSessionId: paths.ccSessionId,
        agentId,
        query: {
          limit: parsed.data.limit,
          before: parsed.data.before,
          after: parsed.data.after,
          full: parsed.data.full === "1",
        },
        literals: getKnownSecretLiterals({ ownToken: null }),
      });
      if (!result.ok) {
        return c.json({ error: result.error }, result.status);
      }
      return c.json(result.page);
    }
  );

  // ─── Node-to-node endpoints: the 7 uniform PUT field receivers ─
  // Issue #2082: loop the shared descriptor table. Each PUT receiver is
  // token → engine-null → getSession → checkCallerNamespace → schema →
  // engine.update → logAndJson. rename is PATCH (dynamic 400 +
  // concurrency→409), so it keeps its hand-written receiver above.
  for (const descriptor of SESSION_FIELD_MUTATIONS) {
    if (descriptor.method !== "PUT") continue;
    registerFederationFieldReceiver(
      app,
      deps,
      descriptor,
      checkCallerNamespace
    );
  }

  // ─── Node-to-node endpoint: POST /federation/sessions/:id/mcp-toggle ─
  // (closes the federation gap left by issue #1077 — the route was
  // expected by SessionService.mcpToggle but never implemented)
  app.post(
    "/federation/sessions/:id/mcp-toggle",
    cataloged(
      defineCapability({
        id: "mcp.api-federation-sessions-mcp-toggle",
        domain: "mcp",
        surface: "rest",
        description:
          "Enable or disable one MCP server for a session on the node that owns it. Peer-incoming receiver; the hub proxies here for a remote-owned session.",
        whenToUse:
          "When toggling an MCP server for a session whose process lives on a remote federation node.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/sessions/:id/mcp-toggle",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const engine = deps.getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not connected" }, 503);
      }

      const sessionId = c.req.param("id");
      const session = engine.getSession(sessionId);
      if (!session) {
        return c.json(
          { ok: false, error: "Session not found", code: "session_not_found" },
          404
        );
      }

      const nsCheck = checkCallerNamespace(c, session, true);
      if (nsCheck) return nsCheck;

      const body = await c.req.json().catch(() => null);
      const parsed = federationMcpToggleSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { ok: false, error: "Invalid body", code: "invalid_request" },
          400
        );
      }

      try {
        const result = await engine.mcpToggle(
          sessionId,
          parsed.data.serverName,
          parsed.data.enabled
        );
        if (result.ok) return c.json(result, 200);
        if (result.code === "local_mode_not_supported")
          return c.json(result, 501);
        return c.json(result, 409);
      } catch (err) {
        deps.errorLogger?.warn("[Federation] mcpToggle failed", {
          category: "federation-mcp-toggle",
          stack: err instanceof Error ? err.stack : null,
          context: { sessionId },
        });
        return c.json(
          {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            code: "transport_failed",
          },
          409
        );
      }
    }
  );

  // ─── Node-to-node endpoint: POST /federation/sessions/:id/set-model ─
  // Issue #2256: federation half of set-model, mirroring the mcp-toggle
  // receiver above. No 501 branch (the runClaude "set-model" handler exists on
  // every launcher class → method:"config" when no live query). Federation
  // receivers call engine.* directly (never SessionService).
  app.post(
    "/federation/sessions/:id/set-model",
    cataloged(
      defineCapability({
        id: "model-permission.api-federation-sessions-set-model",
        domain: "model-permission",
        surface: "rest",
        description:
          "Change the model mode for a session on the node that owns it. Peer-incoming receiver; the hub proxies here for a remote-owned session.",
        whenToUse:
          "When switching the model for a session whose process lives on a remote federation node.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/sessions/:id/set-model",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const engine = deps.getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not connected" }, 503);
      }

      const sessionId = c.req.param("id");
      const session = engine.getSession(sessionId);
      if (!session) {
        return c.json(
          { ok: false, error: "Session not found", code: "session_not_found" },
          404
        );
      }

      const nsCheck = checkCallerNamespace(c, session, true);
      if (nsCheck) return nsCheck;

      const body = await c.req.json().catch(() => null);
      const parsed = federationSetModelSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { ok: false, error: "Invalid body", code: "invalid_request" },
          400
        );
      }

      try {
        const result = await engine.setModel(sessionId, parsed.data.modelMode);
        if (result.ok) return c.json(result, 200);
        return c.json(result, 409);
      } catch (err) {
        deps.errorLogger?.warn("[Federation] setModel failed", {
          category: "federation-set-model",
          stack: err instanceof Error ? err.stack : null,
          context: { sessionId },
        });
        return c.json(
          {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            code: "transport_failed",
          },
          409
        );
      }
    }
  );

  // ─── Node-to-node endpoint: POST /federation/sessions/:id/set-permission-mode ─
  // Issue #2346: federation half of set-permission-mode, mirroring the mcp-toggle
  // receiver (KEEPS the 501 local_mode_not_supported branch — unlike set-model,
  // whose handler exists on every launcher). Federation receivers call engine.*
  // directly (never SessionService — see server/CLAUDE.md audience boundary).
  app.post(
    "/federation/sessions/:id/set-permission-mode",
    cataloged(
      defineCapability({
        id: "model-permission.api-federation-sessions-set-permission-mode",
        domain: "model-permission",
        surface: "rest",
        description:
          "Change the permission mode for a session on the node that owns it. Peer-incoming receiver; the hub proxies here for a remote-owned session.",
        whenToUse:
          "When changing the permission mode for a session whose process lives on a remote federation node.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/sessions/:id/set-permission-mode",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const engine = deps.getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not connected" }, 503);
      }

      const sessionId = c.req.param("id");
      const session = engine.getSession(sessionId);
      if (!session) {
        return c.json(
          { ok: false, error: "Session not found", code: "session_not_found" },
          404
        );
      }

      const nsCheck = checkCallerNamespace(c, session, true);
      if (nsCheck) return nsCheck;

      const body = await c.req.json().catch(() => null);
      const parsed = federationSetPermissionModeSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { ok: false, error: "Invalid body", code: "invalid_request" },
          400
        );
      }

      try {
        const result = await engine.setPermissionMode(
          sessionId,
          parsed.data.mode
        );
        if (result.ok) return c.json(result, 200);
        if (result.code === "local_mode_not_supported")
          return c.json(result, 501);
        return c.json(result, 409);
      } catch (err) {
        deps.errorLogger?.warn("[Federation] setPermissionMode failed", {
          category: "federation-set-permission-mode",
          stack: err instanceof Error ? err.stack : null,
          context: { sessionId },
        });
        return c.json(
          {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            code: "transport_failed",
          },
          409
        );
      }
    }
  );

  // ─── Node-to-node endpoint: POST /federation/sessions/:id/capabilities/:method ─
  // Issue #2419 (epic #2416 Sub-Issue C — TRUST-CRITICAL): federation half of the
  // generic capability invoke. The hub proxies here when THIS node owns the
  // session. KD-3: the receiver re-runs the FULL fail-closed gate + input
  // validation + dispatch (`runCapabilityInvoke`) — a peer's gate result is
  // never trusted. Federation receivers call engine.* directly (never
  // SessionService — see server/CLAUDE.md "SessionService Audience Boundary").
  app.post(
    "/federation/sessions/:id/capabilities/:method",
    cataloged(
      defineCapability({
        id: "session-introspection.api-federation-sessions-capabilities-invoke",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Invoke a named session capability on the node that owns the session, re-running the full fail-closed gate. Peer-incoming receiver; a peer's gate result is never trusted.",
        whenToUse:
          "When the hub proxies a generic capability invoke to a session whose process lives on a remote federation node.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/sessions/:id/capabilities/:method",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const engine = deps.getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not connected" }, 503);
      }

      const sessionId = c.req.param("id");
      const method = c.req.param("method");
      const session = engine.getSession(sessionId);
      if (!session) {
        return c.json(
          { ok: false, error: "Session not found", code: "session_not_found" },
          404
        );
      }

      // Re-assert namespace ownership on the owning node (envelope-shape 404).
      const nsCheck = checkCallerNamespace(c, session, true);
      if (nsCheck) return nsCheck;

      const body = await c.req.json().catch(() => undefined);
      // Federation leg: only the forwarded namespace is known (no userId) —
      // [1B-17]. It is guaranteed present here (checkCallerNamespace passed).
      const caller = {
        namespace: c.req.header("x-hapi-caller-namespace") ?? null,
      };
      const result = await runCapabilityInvoke({
        engine,
        sessionId,
        method,
        body,
        caller,
        logger: deps.errorLogger ?? null,
      });
      return c.json(result.body, result.status);
    }
  );

  // ─── Node-to-node endpoint: POST /federation/sessions/:id/account ─
  // Issue #1456 (Sub-Issue J): federation half of the mid-session account
  // switch. SessionService.switchAccount on the HUB proxies here when this node
  // owns the session; validate caller namespace, then call engine.switchAccount
  // directly (federation receivers call engine.*, never SessionService — see
  // server/CLAUDE.md "SessionService Audience Boundary").
  app.post(
    "/federation/sessions/:id/account",
    cataloged(
      defineCapability({
        id: "accounts.api-federation-sessions-account",
        domain: "accounts",
        surface: "rest",
        description:
          "Switch the Anthropic account bound to a session on the node that owns it, restarting the session process. Peer-incoming receiver for a remote-owned session.",
        whenToUse:
          "When switching the account for a session whose process lives on a remote federation node.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/sessions/:id/account",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const engine = deps.getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not connected" }, 503);
      }

      const sessionId = c.req.param("id");
      const session = engine.getSession(sessionId);
      if (!session) {
        return c.json(
          { ok: false, error: "Session not found", code: "session_not_found" },
          404
        );
      }

      const nsCheck = checkCallerNamespace(c, session, true);
      if (nsCheck) return nsCheck;

      const body = await c.req.json().catch(() => null);
      const parsed = federationAccountSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { ok: false, error: "Invalid body", code: "invalid_request" },
          400
        );
      }

      try {
        const result = await engine.switchAccount(
          sessionId,
          parsed.data.accountUuid
        );
        if (result.type === "success") {
          // Issue #1517: return the new accountUuid + claudeAccount so the HUB's
          // SessionService.switchAccount can update its NodeRegistry cache for
          // this peer-owned session (R6) — else other clients stay stale ~10s.
          // Issue #4823: plus the new `authBinding`, so a key→account switch of
          // a peer-owned key session stops naming the key in the hub cache. The
          // body carries no key field: an account binds the session now.
          return c.json(
            {
              ok: true,
              restartRequired: true,
              accountEmail: result.accountEmail,
              accountUuid: result.accountUuid,
              claudeAccount: result.claudeAccount,
              authBinding: result.authBinding,
            },
            200
          );
        }
        const code = result.code ?? "unknown";
        return c.json(
          { ok: false, error: result.message, code },
          code === "account_not_found" || code === "session_not_found"
            ? 404
            : code === "unknown"
              ? 500
              : 409
        );
      } catch (err) {
        deps.errorLogger?.warn("[Federation] switchAccount failed", {
          category: "federation-account-switch",
          stack: err instanceof Error ? err.stack : null,
          context: { sessionId },
        });
        return c.json(
          {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            code: "transport_failed",
          },
          409
        );
      }
    }
  );

  // ─── Node-to-node endpoint: POST /federation/sessions/:id/relaunch ───
  // Issue #2149: federation half of the launcher/safeMode relaunch.
  // SessionService.relaunch on the HUB proxies here when this node owns the
  // session; validate caller namespace, then call engine.relaunchSession directly
  // (federation receivers call engine.*, never SessionService — server/CLAUDE.md
  // "SessionService Audience Boundary"). Placed in sessionMutations.ts for the
  // STRICT checkCallerNamespace guard, NOT sessionLifecycle.ts (whose receivers
  // skip it — the pre-#1097 gap the directive's Task 12 warns against inheriting).
  app.post(
    "/federation/sessions/:id/relaunch",
    cataloged(
      defineCapability({
        id: "session-lifecycle.api-federation-sessions-relaunch",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Relaunch a session on the node that owns it, applying a new launcher or safe-mode selection and restarting the process. Peer-incoming receiver for a remote-owned session.",
        whenToUse:
          "When relaunching a session whose process lives on a remote federation node.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/sessions/:id/relaunch",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
        probe: "skip",
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const engine = deps.getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not connected" }, 503);
      }

      const sessionId = c.req.param("id");
      const session = engine.getSession(sessionId);
      if (!session) {
        return c.json(
          { ok: false, error: "Session not found", code: "session_not_found" },
          404
        );
      }

      const nsCheck = checkCallerNamespace(c, session, true);
      if (nsCheck) return nsCheck;

      const body = await c.req.json().catch(() => null);
      const parsed = RelaunchRequestSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { ok: false, error: "Invalid body", code: "invalid_request" },
          400
        );
      }

      try {
        const result = await engine.relaunchSession(sessionId, parsed.data);
        if (result.type === "success") {
          return c.json({ ok: true }, 200);
        }
        const code = result.code ?? "unknown";
        return c.json(
          { ok: false, error: result.message, code },
          code === "not_found"
            ? 404
            : code === "relaunch_and_rollback_failed"
              ? 502
              : code === "unknown"
                ? 500
                : 409
        );
      } catch (err) {
        deps.errorLogger?.warn("[Federation] relaunch failed", {
          category: "federation-relaunch",
          stack: err instanceof Error ? err.stack : null,
          context: { sessionId },
        });
        return c.json(
          {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            code: "transport_failed",
          },
          409
        );
      }
    }
  );

  // ─── Node-to-node endpoint: POST /federation/sessions/:id/apply-config ────
  // Issue #3083: receiver for the four §4.2 live-plane config mutations
  // (permission-mode / model / effort / raw-model). The hub's
  // SessionService.applySessionConfig proxies here for a remote-owned session.
  app.post(
    "/federation/sessions/:id/apply-config",
    cataloged(
      defineCapability({
        id: "model-permission.api-federation-sessions-apply-config",
        domain: "model-permission",
        surface: "rest",
        description:
          "Apply live-plane config (permission mode, model, effort, raw model) to a session on the node that owns it, validated per session flavor. Peer-incoming receiver.",
        whenToUse:
          "When applying a config change to a session whose process lives on a remote federation node.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/sessions/:id/apply-config",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
        probe: "skip",
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const engine = deps.getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not connected" }, 503);
      }

      const sessionId = c.req.param("id");
      const session = engine.getSession(sessionId);
      if (!session) {
        return c.json(
          { ok: false, error: "Session not found", code: "session_not_found" },
          404
        );
      }

      const nsCheck = checkCallerNamespace(c, session, true);
      if (nsCheck) return nsCheck;

      const body = await c.req.json().catch(() => null);
      const parsed = ApplySessionConfigSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { ok: false, error: "Invalid body", code: "invalid_request" },
          400
        );
      }

      // Ruling A-D5: the receiver is authoritative for per-flavor validation — the
      // only place that holds BOTH the session's namespace and its metadata.flavor.
      // engine.applySessionConfig validates nothing, so without this a peer-token
      // caller could set Claude-only fields on a codex session. NO !active guard:
      // engine.applySessionConfig routes a disconnected session to stageSessionConfig
      // (round-11, #3285), so a remote disconnected session stages here.
      const flavor = session.metadata?.flavor ?? "claude";
      const cfg = parsed.data;
      if (
        (cfg.permissionMode !== undefined &&
          !isPermissionModeAllowedForFlavor(cfg.permissionMode, flavor)) ||
        (cfg.modelMode !== undefined &&
          !isModelModeAllowedForFlavor(cfg.modelMode, flavor)) ||
        ((cfg.effort !== undefined || cfg.rawModel !== undefined) &&
          flavor !== "claude")
      ) {
        return c.json(
          {
            ok: false,
            error: "Config not supported for this session flavor",
            code: "invalid_request",
          },
          400
        );
      }

      try {
        // Issue #3769 (Task 1d): forward the owning node's live-apply method to
        // the hub additively, so a remote-owned session's /model route can report
        // {ok:true, method:"sdk"} just like a local one.
        const { method } = await engine.applySessionConfig(
          sessionId,
          parsed.data
        );
        return c.json({ ok: true, method }, 200);
      } catch (err) {
        deps.errorLogger?.warn("[Federation] apply-config failed", {
          category: "federation-apply-config",
          stack: err instanceof Error ? err.stack : null,
          context: { sessionId },
        });
        return c.json(
          {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            code: "transport_failed",
          },
          409
        );
      }
    }
  );

  // ─── Node-to-node endpoint: POST /federation/sessions/:id/mcp-set-desired ─
  app.post(
    "/federation/sessions/:id/mcp-set-desired",
    cataloged(
      defineCapability({
        id: "mcp.api-federation-sessions-mcp-set-desired",
        domain: "mcp",
        surface: "rest",
        description:
          "Set the desired enabled/disabled state for a batch of MCP servers on a session on the node that owns it. Peer-incoming receiver for a remote-owned session.",
        whenToUse:
          "When applying a batch MCP desired-state change to a session whose process lives on a remote federation node.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/sessions/:id/mcp-set-desired",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const engine = deps.getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not connected" }, 503);
      }

      const sessionId = c.req.param("id");
      const session = engine.getSession(sessionId);
      if (!session) {
        return c.json({ error: "Session not found" }, 404);
      }

      const nsCheck = checkCallerNamespace(c, session);
      if (nsCheck) return nsCheck;

      const body = await c.req.json().catch(() => null);
      const parsed = federationMcpSetDesiredSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "Invalid body" }, 400);
      }

      try {
        const snapshot = engine.setMcpDesired(sessionId, parsed.data.desired);
        return c.json({ ok: true, snapshot });
      } catch (err) {
        return logAndJson(c, err, 500, {
          errorLogger: deps.errorLogger ?? null,
          category: "federation-set-mcp-desired",
          fallbackMessage: "Failed to set MCP desired",
        });
      }
    }
  );

  // ─── Node-to-node endpoint: GET /federation/sessions/:id/mcp-batch-state ─
  app.get(
    "/federation/sessions/:id/mcp-batch-state",
    cataloged(
      defineCapability({
        id: "mcp.api-federation-sessions-mcp-batch-state",
        domain: "mcp",
        surface: "rest",
        description:
          "Read the in-flight MCP batch-apply snapshot for a session from the node that owns it. Peer-incoming receiver behind namespace ownership.",
        whenToUse:
          "When the hub needs the MCP batch-state snapshot for a session whose process lives on a remote federation node.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/federation/sessions/:id/mcp-batch-state",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const engine = deps.getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not connected" }, 503);
      }

      const sessionId = c.req.param("id");
      const session = engine.getSession(sessionId);
      if (!session) {
        return c.json({ error: "Session not found" }, 404);
      }

      const nsCheck = checkCallerNamespace(c, session);
      if (nsCheck) return nsCheck;

      return c.json({ snapshot: engine.getMcpBatchState(sessionId) });
    }
  );

  return app;
}
