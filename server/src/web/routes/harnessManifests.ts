// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { defineCapability } from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";
import { HARNESS_MANIFESTS } from "@hapi/protocol";
import type { WebAppEnv } from "../middleware/auth";

/**
 * Issue #3121 (epic #3117 Sub-Issue E): harness capability-manifest catalog for
 * the Create-page capability-disclosure chips.
 *
 * `GET /api/harness-manifests` → `{ manifests: Record<AgentFlavor, HarnessManifest> }`.
 * Returns all four stock-4 manifests straight from the #3118 registry
 * (`shared/src/harnessManifests/`, barrel-exported by `@hapi/protocol` per expert
 * ruling D1a). This is the SAME artifact the Extensions page (#3120) and the
 * projection compiler (#3122) consume — there is no parallel hand-maintained
 * capability copy (R3). The server imports the registry directly because
 * `server` may depend on `@hapi/protocol` but NOT on `cli`.
 *
 * Static per server-process lifetime; a thin pass-through modeled on
 * `createClaudeModelsRoutes` / `createOutputStylesRoutes`. JWT-authed by mount
 * position — mounted with the authed routes below the global JWT gate, so the
 * mount position IS the auth mechanism (the Create page is a post-login surface).
 * Read-only: no session, federation, or sync-engine coupling.
 */
export function createHarnessManifestsRoutes(): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  app.get(
    "/harness-manifests",
    cataloged(
      defineCapability({
        id: "harness-admin.manifests",
        domain: "harness-admin",
        surface: "rest",
        description: "Return the static harness manifest set.",
        whenToUse: "When the client resolves harness manifests.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/harness-manifests",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      return c.json({ manifests: HARNESS_MANIFESTS });
    }
  );

  return app;
}
