// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import {
  RecordPredictionAccuracyRequestSchema,
  PredictionAccuracyQuerySchema,
  defineCapability,
} from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";
import type { Store } from "../../store";
import type { WebAppEnv } from "../middleware/auth";
import type { ErrorLogger } from "../../logging/errorLogger";
import { createRateLimiter } from "../middleware/rateLimit";
import { logAndJson } from "./routeErrorHelper";

/**
 * Epic #1965 (File Conflict Monitor) Sub G / #1972 — prediction-accuracy
 * write/read API over the store's `predictionAccuracy` module. The rp1-home
 * closer POSTs a predicted + actual footprint for a closed issue; the server
 * computes precision/recall and persists it (idempotent replace on repo+issue).
 * The GET side serves the accuracy history that feeds the closer's report and
 * the churn ignore-list auto-suggestion.
 *
 * Store-direct (advisory metrics only — no SyncEngine/SSE). Mounted under `/api`
 * AFTER the JWT auth middleware in `server.ts`, so unauthenticated requests are
 * rejected (401) by the global middleware — the factory implements no auth of
 * its own. The rate limiter is instantiated INSIDE the factory so each call
 * (including tests) gets a fresh bucket map.
 */
export function createPredictionAccuracyRoutes(
  getStore: () => Store | null,
  options?: {
    errorLogger?: ErrorLogger | null;
  }
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  const errorLogger = options?.errorLogger ?? null;
  const limiter = createRateLimiter({ name: "prediction-accuracy" }); // env default 100/60s

  function requireStore(c: {
    json: (data: unknown, status?: number) => Response;
  }): Store | Response {
    const store = getStore();
    if (!store) return c.json({ error: "Store not available" }, 503);
    return store;
  }

  // POST /prediction-accuracy : compute + persist precision/recall for a
  // (repo, issue). Idempotent replace on the (repo, issue) key.
  app.post(
    "/prediction-accuracy",
    cataloged(
      defineCapability({
        id: "telemetry.prediction-accuracy-ingest",
        domain: "telemetry",
        surface: "rest",
        description: "Record a prediction-accuracy sample for the session.",
        whenToUse: "When the harness reports a prediction outcome.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/prediction-accuracy",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    limiter,
    async c => {
      const store = requireStore(c);
      if (store instanceof Response) return store;
      const parsed = RecordPredictionAccuracyRequestSchema.safeParse(
        await c.req.json().catch(() => null)
      );
      if (!parsed.success)
        return c.json(
          { error: "Invalid body", details: parsed.error.issues },
          400
        );
      try {
        const record = store.predictionAccuracy.recordAccuracy(parsed.data);
        return c.json({ record }, 200);
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "prediction-accuracy",
          fallbackMessage: "Failed to record prediction accuracy",
        });
      }
    }
  );

  // GET /prediction-accuracy?repo[&issue] : accuracy history for a repo (all
  // issues, newest first) or a single (repo, issue) record.
  app.get(
    "/prediction-accuracy",
    cataloged(
      defineCapability({
        id: "telemetry.prediction-accuracy-read",
        domain: "telemetry",
        surface: "rest",
        description: "Return the prediction-accuracy series.",
        whenToUse: "When the user views prediction-accuracy trends.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/prediction-accuracy",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
        // probe: needs ?repo= (#5212)
        probe: "skip",
      })
    ),
    limiter,
    c => {
      const store = requireStore(c);
      if (store instanceof Response) return store;
      const parsed = PredictionAccuracyQuerySchema.safeParse({
        repo: c.req.query("repo"),
        issue: c.req.query("issue"),
      });
      if (!parsed.success)
        return c.json(
          { error: "Invalid query", details: parsed.error.issues },
          400
        );
      try {
        const { repo, issue } = parsed.data;
        const records = issue
          ? [store.predictionAccuracy.getAccuracyByIssue(repo, issue)].filter(
              (r): r is NonNullable<typeof r> => r !== null
            )
          : store.predictionAccuracy.getAccuracyByRepo(repo);
        return c.json({ records }, 200);
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "prediction-accuracy",
          fallbackMessage: "Failed to query prediction accuracy",
        });
      }
    }
  );

  return app;
}
