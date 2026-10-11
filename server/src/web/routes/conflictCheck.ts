// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { defineCapability } from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";
import {
  ConflictCheckRequestSchema,
  classifyBlastRadius,
  changeKindWeight,
  computeSeverity,
  isChurnIgnored,
  type ChangeKind,
  type ConflictOverlap,
} from "@hapi/protocol";
import type { WebAppEnv } from "../middleware/auth";
import type { ErrorLogger } from "../../logging/errorLogger";
import { createRateLimiter } from "../middleware/rateLimit";
import { logAndJson } from "./routeErrorHelper";

/**
 * Epic #1965 (File Conflict Monitor) Sub E / #1970 — orchestrator-local batch-conflict
 * endpoint. Given a set of `{ issue, footprint[] }` records, returns the file-overlap
 * groups (paths claimed by ≥2 distinct issues) each with a **severity hint**. The
 * rp1-home spawn gate (#1078) calls this BEFORE fanning out peer sessions — the
 * orchestrator already holds all footprints, so no live cross-node sync is needed (the
 * federation CRDT #1969 is the Phase-2 overkill this MVP path avoids).
 *
 * PURE + STATELESS (Key Decision KD1): no store, no SyncEngine/SSE, no federation — so
 * this factory takes NO `getStore` (unlike fileClaims/predictionAccuracy). Mounted under
 * `/api` AFTER the JWT auth middleware in `server.ts`, so unauthenticated requests are
 * rejected (401) by the global middleware — the factory implements no auth of its own.
 * The rate limiter is instantiated INSIDE the factory so each call (incl. tests) gets a
 * fresh bucket map.
 *
 * The severity formula (`conflictSeverity.ts` in @hapi/protocol) is shared with the web
 * UI renderer (#1971) to prevent cross-implementation drift, and is conformance-tested
 * against the canonical fixture vendored from rp1-home's `conflict_table.py`.
 *
 * KD3 — the endpoint returns the severity HINT only, NOT recommended-action: the action
 * (spec §5) depends on ordering knowledge (`ordering_known`/`predecessor_issue`) the
 * ORCHESTRATOR holds, not the stateless endpoint. #1078 computes the action from this
 * hint + its own issue-dependency ranking.
 */
export function createConflictCheckRoutes(options?: {
  errorLogger?: ErrorLogger | null;
}): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  const errorLogger = options?.errorLogger ?? null;
  const limiter = createRateLimiter({ name: "conflict-check" }); // env default 100/60s

  // POST /conflict-check : pure overlap + severity-hint computation. No persistence.
  app.post(
    "/conflict-check",
    limiter,
    cataloged(
      defineCapability({
        id: "files-git.conflict-check",
        domain: "files-git",
        surface: "rest",
        description:
          "Check whether a set of paths conflicts with other live sessions' claims and return the result.",
        whenToUse:
          "When a session checks for file-claim conflicts before editing.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/conflict-check",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const parsed = ConflictCheckRequestSchema.safeParse(
        await c.req.json().catch(() => null)
      );
      if (!parsed.success)
        return c.json(
          { error: "Invalid body", details: parsed.error.issues },
          400
        );

      try {
        const { repo, footprints, ignore } = parsed.data;
        const ignorePatterns = ignore ?? [];

        // path → (issue → the highest-weight change-kind that issue claims for it).
        const claimsByPath = new Map<string, Map<string, ChangeKind>>();
        const ignoredPaths = new Set<string>();

        for (const fp of footprints) {
          for (const { path, changeKind } of fp.footprint) {
            if (isChurnIgnored(path, ignorePatterns)) {
              ignoredPaths.add(path);
              continue; // churn-ignored paths never enter the overlap map (R2)
            }
            let byIssue = claimsByPath.get(path);
            if (!byIssue) {
              byIssue = new Map<string, ChangeKind>();
              claimsByPath.set(path, byIssue);
            }
            const prior = byIssue.get(fp.issue);
            // Within one issue, keep the higher-weight change-kind for the path.
            if (
              !prior ||
              changeKindWeight(changeKind) > changeKindWeight(prior)
            ) {
              byIssue.set(fp.issue, changeKind);
            }
          }
        }

        const overlaps: ConflictOverlap[] = [];
        for (const [path, byIssue] of claimsByPath) {
          if (byIssue.size < 2) continue; // a single claimant is not an overlap (R1)
          const issues = [...byIssue.keys()].sort();
          const concurrency = byIssue.size;
          // Resolved change-kind = the highest-weight kind among all claimants (KD5).
          let changeKind: ChangeKind = "edit";
          let maxWeight = -1;
          for (const kind of byIssue.values()) {
            const w = changeKindWeight(kind);
            if (w > maxWeight) {
              maxWeight = w;
              changeKind = kind;
            }
          }
          const blastRadius = classifyBlastRadius(path, repo);
          const severityScore =
            blastRadius * changeKindWeight(changeKind) * concurrency;
          overlaps.push({
            path,
            issues,
            changeKind,
            blastRadius,
            concurrency,
            severityScore,
            severity: computeSeverity(blastRadius, changeKind, concurrency),
          });
        }

        // Deterministic output: most severe first, then path alphabetical.
        overlaps.sort(
          (a, b) =>
            b.severityScore - a.severityScore || a.path.localeCompare(b.path)
        );

        return c.json(
          { overlaps, ignoredPaths: [...ignoredPaths].sort() },
          200
        );
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "conflict-check",
          fallbackMessage: "Failed to compute conflicts",
        });
      }
    }
  );

  return app;
}
