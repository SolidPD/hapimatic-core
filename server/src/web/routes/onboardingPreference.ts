// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { defineCapability } from "@hapi/protocol";
import { OnboardingStatePatchSchema } from "@hapi/protocol/schemas";
import { cataloged } from "../../capabilities/cataloged";
import type { WebAppEnv } from "../middleware/auth";
import {
  effectiveOnboardingState,
  mergeOnboardingPatch,
  readOnboardingState,
  updateOnboardingState,
} from "../../config/onboardingState";

const UNREADABLE_ERROR =
  "The settings file cannot be read; the onboarding state was not changed.";

/**
 * `GET/PUT /preferences/onboarding` — the node-local state of the in-app
 * onboarding tour (issue #3865). Its own file because
 * `routes/preferences.ts` sits at its `max-lines` ceiling.
 *
 * GET returns the EFFECTIVE state (`{ status: "completed" }` for an absent key or
 * a value that does not parse), so nothing but a stamped or explicitly written
 * `pending` opens the tour. PUT merges a patch over the effective state
 * (`mergeOnboardingPatch`: a dismissal never demotes `completed`), serialized
 * per settings file so overlapping requests cannot lose an update.
 * Both answer 503 when the settings file exists but cannot be parsed — that file
 * holds the instance's secrets and must not be rewritten with this one key.
 *
 * Mounted after the global JWT gate in `buildWebApp.ts` (the mount position is
 * the auth mechanism).
 */
export function createOnboardingPreferenceRoutes(
  settingsFile: string
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  app.get(
    "/preferences/onboarding",
    cataloged(
      defineCapability({
        id: "ui.onboarding-preference",
        domain: "ui",
        surface: "rest",
        description:
          "Read this instance's in-app onboarding tour state (pending, dismissed or completed, plus the last step reached).",
        whenToUse:
          "When the web app decides whether to present the first-run tour, or which label the Settings entry shows.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/preferences/onboarding",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const state = await readOnboardingState(settingsFile);
      if (state === "unreadable") {
        return c.json({ error: UNREADABLE_ERROR }, 503);
      }
      return c.json(state);
    }
  );

  app.put(
    "/preferences/onboarding",
    cataloged(
      defineCapability({
        id: "ui.set-onboarding-preference",
        domain: "ui",
        surface: "rest",
        description:
          "Record progress through this instance's in-app onboarding tour (the step reached, a dismissal, or completion).",
        whenToUse:
          "When the user advances, skips or finishes the first-run tour.",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/api/preferences/onboarding",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "Request body must be JSON" }, 400);
      }
      const parsed = OnboardingStatePatchSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { error: "Invalid onboarding state", details: parsed.error.issues },
          400
        );
      }

      const patch = parsed.data;
      const result = await updateOnboardingState(settingsFile, stored =>
        mergeOnboardingPatch(effectiveOnboardingState(stored), patch)
      );
      if (result.kind === "unreadable") {
        return c.json({ error: UNREADABLE_ERROR }, 503);
      }
      return c.json(result.state);
    }
  );

  return app;
}
