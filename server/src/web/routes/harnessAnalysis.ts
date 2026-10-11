// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import {
  IMPACT_CONTRACT_VERSION,
  defineCapability,
  type UpdateSpan,
} from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";
import { harnessRegistry } from "../../harness/registry";
import { parseChangelogSpan } from "../../harness/changelogParser";
import type { WebAppEnv } from "../middleware/auth";
import type { Store } from "../../store";
import type { ImpactService } from "../../selfUpdate/impactService";

/**
 * Consumer web API for the impact analysis (issue #1772, Task 7). JWT-authed,
 * mounted under `/api` AFTER the global JWT gate — these are the surfaces
 * #1773's admin-drawer panel calls. snake_case on the wire, epoch-ms number
 * timestamps, NO camelizing mapper (the artifact reaches the browser raw).
 *
 *   POST /api/harness/:harnessId/analyze         — trigger the analysis
 *   GET  /api/harness/:harnessId/analysis?range= — the discriminated envelope
 *
 * The `UpdateSpan` is assembled SERVER-SIDE from the trusted committed
 * descriptor (`coupling_watch_areas`/`analysis_repos`) + #1770's detection state
 * (installed→latest) + #1771's parsed changelog — the watch-areas + repos come
 * from the registry, NEVER the client (now that #1770 has landed, this replaces
 * the OR1 accept-span-in-body fallback).
 */

export type BuildSpanResult =
  | { ok: true; span: UpdateSpan }
  | { ok: false; error: string };

/**
 * Build the UpdateSpan for a harness's PENDING update (installed→latest). Pure —
 * reads the registry + store, assembles the trusted span. Exported for unit test.
 */
export function buildUpdateSpanForPendingUpdate(
  harnessId: string,
  nodeId: string,
  store: Store
): BuildSpanResult {
  const descriptor = harnessRegistry.find(d => d.id === harnessId);
  if (!descriptor) return { ok: false, error: `Unknown harness: ${harnessId}` };

  const state = store.harness.getDetectionState(nodeId, harnessId);
  if (!state || !state.installed_version || !state.latest_version) {
    return {
      ok: false,
      error: "No detection state for this harness — run a version check first",
    };
  }
  if (state.installed_version === state.latest_version) {
    return { ok: false, error: "Already up to date — nothing to analyze" };
  }

  const rawText = store.harness.getChangelogText(nodeId, harnessId);
  const changelog = parseChangelogSpan({
    rawText: rawText ?? "",
    installed: state.installed_version,
    latest: state.latest_version,
    harnessId,
    changelogUrl: descriptor.changelog.url,
  });

  return {
    ok: true,
    span: {
      harness_id: harnessId,
      from_version: state.installed_version,
      to_version: state.latest_version,
      changelog_versions: changelog.versions,
      coupling_watch_areas: descriptor.coupling_watch_areas,
      analysis_repos: descriptor.analysis_repos,
      contract_version: IMPACT_CONTRACT_VERSION,
    },
  };
}

export function createHarnessAnalysisRoutes(opts: {
  getImpactService: () => ImpactService | null;
  getStore: () => Store | null;
  nodeId: string;
}): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  // Trigger an analysis for the harness's pending update. Responds PROMPTLY
  // after spawn+seed — the watchdog runs detached (never holds the request open).
  app.post(
    "/harness/:harnessId/analyze",
    cataloged(
      defineCapability({
        id: "harness-admin.analyze",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Analyze a specific harness build/version for update impact.",
        whenToUse:
          "When the operator requests an impact analysis for a harness version.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/harness/:harnessId/analyze",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      const service = opts.getImpactService();
      const store = opts.getStore();
      if (!service || !store) return c.json({ error: "Not ready" }, 503);

      const harnessId = c.req.param("harnessId");
      const built = buildUpdateSpanForPendingUpdate(
        harnessId,
        opts.nodeId,
        store
      );
      if (!built.ok) return c.json({ error: built.error }, 409);

      const outcome = await service.startAnalysis(built.span);
      switch (outcome.status) {
        case "analyzing":
          // A duplicate in-flight trigger returns the EXISTING session id here
          // (the orchestrator's guard), never a second spawn.
          return c.json({ status: "analyzing", session_id: outcome.sessionId });
        case "at_capacity":
          // R6 — a clear UI state, never a spinner.
          return c.json({ status: "at_capacity" });
        case "failed":
          // R7 — surface "failed" (the UI shows retry), never an infinite spinner.
          return c.json({ status: "failed" });
      }
    }
  );

  // The discriminated status envelope for a specific range.
  app.get(
    "/harness/:harnessId/analysis",
    cataloged(
      defineCapability({
        id: "harness-admin.get-analysis",
        domain: "harness-admin",
        surface: "rest",
        description: "Return a harness version's stored analysis.",
        whenToUse: "When the operator reviews a harness analysis result.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/harness/:harnessId/analysis",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "operator" },
      })
    ),
    c => {
      const service = opts.getImpactService();
      if (!service) return c.json({ error: "Not ready" }, 503);

      const harnessId = c.req.param("harnessId");
      const range = c.req.query("range");
      const parts = (range ?? "").split("..");
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        return c.json(
          { error: "range query param required, format: <from>..<to>" },
          400
        );
      }
      const envelope = service.getAnalysisStatus(harnessId, parts[0], parts[1]);
      return c.json(envelope);
    }
  );

  return app;
}
