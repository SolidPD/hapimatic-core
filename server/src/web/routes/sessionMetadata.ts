// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { SessionMetadataQuerySchema, defineCapability } from "@hapi/protocol";
import type { SyncEngine } from "../../sync/syncEngine";
import type { WebAppEnv } from "../middleware/auth";
import { cataloged } from "../../capabilities/cataloged";

/**
 * Admin session-metadata query routes (issue #1675, epic #1662 Sub M).
 *
 * Node-local, read-only query surface over the per-turn telemetry DB (#1663),
 * consumed by the `?section=session-metadata` admin-drawer section. Mounted under
 * `/api` AFTER the global JWT middleware in `server.ts`, so both endpoints are
 * JWT-gated. Node-global reads (no namespace filter) — consistent with Sub L's
 * federation telemetry aggregate and the documented bulk-read authorization tier
 * (server/CLAUDE.md "Federation Authorization Model").
 *
 * The CROSS-NODE view (all-nodes scope) is served by Sub L's existing
 * `GET /api/federation/telemetry/aggregate`; these routes are the node-local
 * surface that additionally serves the event-kind filter (which L cannot — its
 * substrate carries only `v_session_totals` rollups, no `turn_events`).
 */
export function createSessionMetadataRoutes(
  getSyncEngine: () => SyncEngine | null
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  function requireSyncEngine(c: {
    json: (data: unknown, status?: number) => Response;
  }): SyncEngine | Response {
    const engine = getSyncEngine();
    if (!engine) return c.json({ error: "Sync engine not available" }, 503);
    return engine;
  }

  const numQuery = (raw: string | undefined): number | undefined => {
    if (raw === undefined || raw === "") return undefined;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : undefined;
  };
  const strQuery = (raw: string | undefined): string | undefined =>
    raw === undefined || raw === "" ? undefined : raw;

  // GET /session-metadata/turns — node-local per-turn query, all six filters.
  app.get(
    "/session-metadata/turns",
    cataloged(
      defineCapability({
        id: "telemetry.session-metadata-turns",
        domain: "telemetry",
        surface: "rest",
        description:
          "Query per-turn session telemetry (event kind, model, account, repo, timing) across sessions with filters, for the admin metadata view.",
        whenToUse:
          "When inspecting per-turn telemetry for sessions in the admin drawer.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/session-metadata/turns",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    c => {
      const engine = requireSyncEngine(c);
      if (engine instanceof Response) return engine;

      const parsed = SessionMetadataQuerySchema.safeParse({
        sessionId: strQuery(c.req.query("sessionId")),
        fromMs: numQuery(c.req.query("from")),
        toMs: numQuery(c.req.query("to")),
        repo: strQuery(c.req.query("repo")),
        modelId: strQuery(c.req.query("model")),
        accountId: strQuery(c.req.query("account")),
        eventKind: strQuery(c.req.query("eventKind")),
        limit: numQuery(c.req.query("limit")),
        offset: numQuery(c.req.query("offset")),
      });
      if (!parsed.success) {
        return c.json(
          { error: "Invalid query", details: parsed.error.issues },
          400
        );
      }

      return c.json({ turns: engine.querySessionMetadataTurns(parsed.data) });
    }
  );

  // GET /session-metadata/filter-options — distinct filter dropdown values.
  app.get(
    "/session-metadata/filter-options",
    cataloged(
      defineCapability({
        id: "telemetry.session-metadata-filter-options",
        domain: "telemetry",
        surface: "rest",
        description:
          "Return the distinct filter values (repos, models, accounts, event kinds) available for the session-metadata telemetry query.",
        whenToUse:
          "When populating the session-metadata filter dropdowns in the admin drawer.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/session-metadata/filter-options",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    c => {
      const engine = requireSyncEngine(c);
      if (engine instanceof Response) return engine;
      return c.json(engine.getSessionMetadataFilterOptions());
    }
  );

  return app;
}
