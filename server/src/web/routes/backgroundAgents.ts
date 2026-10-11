// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { defineCapability } from "@hapi/protocol";
import { AgentTranscriptQuerySchema } from "@hapi/protocol/schemas";
import type { WebAppEnv } from "../middleware/auth";
import { requireSyncEngine } from "./guards";
import { cataloged } from "../../capabilities/cataloged";
import { getKnownSecretLiterals } from "../../services/knownSecretLiterals";
import type { SyncEngine } from "../../sync/syncEngine";
import type { SessionService } from "../../services/sessionService";
import { agentTranscriptPage } from "../../sync/transcript/agentTranscriptPage";

/**
 * Background-agent peek route (issue #4386, R3/R4). Serves one background
 * agent's `subagents/agent-<id>.jsonl` from the owning node's disk, newest-first
 * and scrubbed, through the transcript-serve seam (see `agentTranscriptPage`).
 *
 * **Gate = token-stats, NOT requireSessionFromParam.** `engine.getSession(id)`;
 * a missing session OR one in another namespace answers **404 `Session not
 * found`** (never 403 — that form leaks no existence, #1097). Local sessions
 * only: a federated session has no local record and answers the same 404 until
 * #4387 moves the read behind `SessionService`.
 *
 * **Never `readonly` (#3837 R12).** Historical conversation content must not be
 * generically invocable, so the capability is the sensitive-read tier
 * (`riskTier: "mutating"`) and the route is listed in the never-readonly catalog
 * test (`shared/src/capabilityCatalog/never-readonly.test.ts`).
 */

/** This node's known instance tokens (cached by the service), as the transcript routes use. */
const defaultLiterals = (): readonly string[] =>
  getKnownSecretLiterals({ ownToken: null });

export function createBackgroundAgentsRoutes(
  getSyncEngine: () => SyncEngine | null,
  getLiterals: () => readonly string[] = defaultLiterals,
  // Issue #4387: federation-aware peek. When wired, the route proxies a
  // federated session's read to the owning node via SessionService; when
  // absent (unit tests) it falls back to the local on-disk reader below.
  getSessionService?: () => SessionService | null
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  const numQuery = (raw: string | undefined): number | undefined => {
    if (raw === undefined || raw === "") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  const strQuery = (raw: string | undefined): string | undefined =>
    raw === undefined || raw === "" ? undefined : raw;

  app.get(
    "/sessions/:id/background-agents/:agentId/transcript",
    cataloged(
      defineCapability({
        id: "session-introspection.background-agent-transcript",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Read one background agent's sub-transcript (tool calls + reasoning) newest-first, secret tokens and approval nonces masked, tool results capped. Read-only. Namespace-scoped, local sessions only.",
        whenToUse:
          "When peeking into a background agent from the Background Agents modal.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/sessions/:id/background-agents/:agentId/transcript",
        },
        auth: "jwt",
        // Historical conversation content → never readonly (#3837 R12).
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) return engine;

      const sessionId = c.req.param("id");
      const agentId = c.req.param("agentId");
      const namespace = c.get("namespace");

      // Sender-side gate (#4387, federation checklist step 4): a cross-namespace
      // LOCAL session → 404 (no existence leak, never 403). A session that is
      // NOT local is NOT rejected here — it may be federated, so it falls
      // through to SessionService, which proxies the read to the owning node
      // (the receiver re-asserts namespace ownership there). This replaces
      // #4386's local-only `!localSession → 404` gate.
      const localSession = engine.getSession(sessionId);
      if (localSession && localSession.namespace !== namespace) {
        return c.json({ error: "Session not found" }, 404);
      }

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

      // Federation-aware read (#4387): local → #4386's on-disk reader; federated
      // → proxy to the owning node. The whole validated query is forwarded
      // unchanged so #4388's `after` live-tail crosses the hub untouched.
      const sessionService = getSessionService?.();
      if (sessionService) {
        const result = await sessionService.getAgentTranscriptPage(
          sessionId,
          agentId,
          parsed.data,
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
        literals: getLiterals(),
      });
      if (!result.ok) {
        return c.json({ error: result.error }, result.status);
      }
      return c.json(result.page);
    }
  );

  return app;
}
