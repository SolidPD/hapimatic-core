// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Runtime Job Registry API (issue #1963, epic #1960, Sub-Issue C — producer surface).
 *
 * GET /jobs — snapshot of every in-process supervised loop's status row
 *   ({ name, node, kind, intervalMs, lastTickAt, status, lastError }).
 *
 * This is the in-process-loop read surface Sub-Issue D (#1964, the System Jobs
 * portal) consumes — D maps each row into a `kind: "in-process-loop"` System
 * Jobs row and owns the federation aggregation + per-node grouping. Kept minimal
 * here as the contract/smoke-test surface (the in-process getter is the actual
 * contract; this route just exposes it). Mounted under `/api` so it inherits the
 * JWT auth middleware.
 */

import { Hono } from "hono";
import { defineCapability } from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";
import type { JobRegistry } from "@hapi/protocol";
import type { WebAppEnv } from "../middleware/auth";

export function createJobsRoutes(
  getJobRegistry: () => JobRegistry | null
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  // GET /jobs — the runtime job registry snapshot for this node's process.
  app.get(
    "/jobs",
    cataloged(
      defineCapability({
        id: "machine-daemon.jobs",
        domain: "machine-daemon",
        surface: "rest",
        description: "List the node's registered system jobs and their state.",
        whenToUse: "When the user views scheduled/system jobs.",
        invocation: { kind: "rest", method: "GET", path: "/api/jobs" },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    c => {
      const registry = getJobRegistry();
      return c.json({ jobs: registry ? registry.list() : [] });
    }
  );

  return app;
}
