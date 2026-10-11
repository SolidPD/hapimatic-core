// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { defineCapability } from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";
import type { HarnessDescriptor, HarnessDetectionState } from "@hapi/protocol";
import type { WebAppEnv } from "../middleware/auth";
import { parseChangelogSpan } from "../../harness/changelogParser";

/**
 * Raw changelog display route (issue #1771, epic #1769).
 *
 *   GET /api/harness/:harnessId/changelog — the parsed verbatim bullets for the
 *        `installed < v <= latest` span of a harness, reusing #1770's already-
 *        fetched changelog text (NO network fetch of its own, R2).
 *
 * Mounted under `/api` AFTER the global JWT middleware in `server.ts` (same
 * posture as #1770's `GET /api/harness/status`): the response carries this
 * node's installed/latest version state, so the mount position IS the auth
 * mechanism. The parser owns the `ChangelogSpan` shape and encodes every
 * degraded case (R3/R4/capping) in `available`/`reason`; this route only emits
 * the ad-hoc 503 (source absent) and 404 (unknown harness) bodies, which are
 * deliberately NOT `ChangelogSpan`.
 */

/**
 * The late-bound data seam this route consumes. Assembled at the mount site
 * (`server.ts`) from #1770's `store.harness` accessors + the committed registry
 * — a function-bag (the watchdog/late-bound-getter convention), NOT a parallel
 * type home. The descriptor/state types are #1770's (`shared/src/harness.ts`);
 * this issue re-declares none.
 */
export interface HarnessChangelogSource {
  /** The node the poll persisted state under (federationConfig?.nodeId ??
   *  "standalone" — the SAME expression #1770's poll uses). */
  node_id: string;
  /** The committed harness registry (`server/src/harness/registry.ts`, #1770). */
  registry: HarnessDescriptor[];
  getDetectionState(
    node_id: string,
    harness_id: string
  ): HarnessDetectionState | null;
  getChangelogText(node_id: string, harness_id: string): string | null;
}

export function createHarnessChangelogRoutes(
  getChangelogSource: () => HarnessChangelogSource | null
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  app.get(
    "/harness/:harnessId/changelog",
    cataloged(
      defineCapability({
        id: "harness-admin.changelog",
        domain: "harness-admin",
        surface: "rest",
        description: "Return the raw changelog for a harness version by id.",
        whenToUse: "When the user views a harness release's changelog.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/harness/:harnessId/changelog",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "operator" },
      })
    ),
    c => {
      // R6: #1770's data source not wired at all → 503 (distinct from R3's 200s).
      // Retained for the Fallback Preservation Rule even though the production
      // mount always supplies a source (#1770 is merged).
      const source = getChangelogSource();
      if (!source) {
        return c.json(
          { error: "Harness update data not available", reason: "not-ready" },
          503
        );
      }

      const harnessId = c.req.param("harnessId");
      const descriptor = source.registry.find(d => d.id === harnessId);
      if (!descriptor) {
        return c.json({ error: "Unknown harness", harness_id: harnessId }, 404);
      }

      const url = descriptor.changelog?.url;
      const changelogUrl =
        typeof url === "string" && url.length > 0 ? url : null;

      // R3: the descriptor has no usable changelog source at all. Delegate the
      // span shape to the parser (empty text + null URL → "no-changelog-source").
      if (!changelogUrl) {
        return c.json(
          parseChangelogSpan({
            rawText: "",
            installed: null,
            latest: null,
            harnessId,
            changelogUrl: null,
          })
        );
      }

      // R2: the ONLY data source is #1770's cached text — no fetch here. Empty
      // text (poll not run / fetch failed) degrades to "not-cached" (200) inside
      // the parser, never a 503.
      const state = source.getDetectionState(source.node_id, harnessId);
      const text = source.getChangelogText(source.node_id, harnessId);
      const span = parseChangelogSpan({
        rawText: text ?? "",
        installed: state?.installed_version ?? null,
        latest: state?.latest_version ?? null,
        harnessId,
        changelogUrl,
      });

      // R4/R5 telemetry: a non-zero drift count means the served content had
      // non-bullet lines (partial format shift). The content is still served
      // verbatim — this is a signal, not a failure.
      if (span.drift_line_count > 0) {
        console.warn(
          `[harness-changelog] ${harnessId}: ${span.drift_line_count} non-bullet line(s) retained raw (possible changelog format drift)`
        );
      }

      return c.json(span);
    }
  );

  return app;
}
