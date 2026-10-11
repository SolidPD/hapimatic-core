// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import type { PorterStatusResponse } from "@hapi/protocol/porter";
import { defineCapability } from "@hapi/protocol";
import type { WebAppEnv } from "../middleware/auth";
import { cataloged } from "../../capabilities/cataloged";

/**
 * Configuration Porter exposure status (issue #4533, epic #4290).
 *
 * `GET /porter/status` — mounted under `/api` in `buildWebApp.ts` BEHIND the
 * Porter exposure gate (`middleware/porterExposure.ts`) and after the global
 * JWT gate. The route is therefore reachable ONLY when Porter is exposed, and
 * always answers 200 `{ exposed: true }`; a withheld instance answers the
 * gate's 404 `porter_withheld` instead. The web Settings row and the
 * Configuration page probe this endpoint and treat loading, error and 404 alike
 * as withheld (fail-closed).
 */
export function createPorterStatusRoutes(): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  app.get(
    "/porter/status",
    cataloged(
      defineCapability({
        id: "porter.exposure-status",
        domain: "porter",
        surface: "rest",
        description:
          "Report whether Configuration Porter is exposed on this instance (200 when exposed; 404 porter_withheld when withheld).",
        whenToUse:
          "Before showing or invoking Configuration Porter, to learn whether this instance exposes it.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/porter/status",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "operator" },
      })
    ),
    c => {
      const body: PorterStatusResponse = { exposed: true };
      return c.json(body);
    }
  );

  return app;
}
