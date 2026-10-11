// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { defineCapability } from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";
import type { WebAppEnv } from "../middleware/auth";
import type { ClaudeModelCatalogService } from "../../services/claudeModelCatalog";

/**
 * Issue #2456: live Claude model catalog for the "More models" pickers.
 *
 * `GET /api/claude/models` → `{ models: ClaudeModelInfo[], source }`. The
 * service owns the live-fetch / cache / fallback logic (never throws), so this
 * route is a thin pass-through. JWT-authed (mounted with the authed routes) —
 * the pickers are post-login surfaces.
 */
export function createClaudeModelsRoutes(
  catalog: ClaudeModelCatalogService
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  app.get(
    "/claude/models",
    cataloged(
      defineCapability({
        id: "model-permission.claude-models",
        domain: "model-permission",
        surface: "rest",
        description:
          "Return the live Claude model catalog available to this node.",
        whenToUse: "When the UI shows selectable Claude models.",
        invocation: { kind: "rest", method: "GET", path: "/api/claude/models" },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const result = await catalog.getModels();
      return c.json(result);
    }
  );

  return app;
}
