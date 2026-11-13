// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import {
  CompactAtPreferencePatchSchema,
  claudeOverrideForPercent,
  compactAtEffectivePoints,
  defineCapability,
  type CompactAtPreferenceResponse,
} from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";
import type { WebAppEnv } from "../middleware/auth";
import { createRateLimiter } from "../middleware/rateLimit";
import {
  CompactAtValidationError,
  readCompactAt,
  saveCompactAt,
  type CompactAtState,
} from "../../config/compactAtConfig";
import {
  SETTINGS_UNREADABLE_MESSAGE,
  SettingsUnreadableError,
} from "../../config/settings";

/** The GET / PUT body (R9): the resolved value plus each display window's point. */
export function compactAtResponse(
  state: CompactAtState
): CompactAtPreferenceResponse {
  const body: CompactAtPreferenceResponse = {
    enabled: state.enabled,
    percent: state.percent,
    source: state.source,
    claudeOverride: claudeOverrideForPercent(state.percent),
    effective: compactAtEffectivePoints(state.percent),
  };
  if (state.seededFrom !== undefined) body.seededFrom = state.seededFrom;
  if (state.seededAt !== undefined) body.seededAt = state.seededAt;
  return body;
}

/**
 * `GET/PUT /preferences/compact-at` — this node's "compact at" percentage for
 * every Claude session it starts (issue #6570 R9). Its own file because
 * `routes/preferences.ts` sits at its `max-lines` ceiling (the
 * `backupPromptPreference.ts` / `onboardingPreference.ts` precedent).
 *
 * GET delegates to `readCompactAt`, the same shared accessor the session wrapper
 * uses, and adds the Claude Code value and the firing point for the 1M and 200K
 * windows. PUT merges `{ enabled?, percent? }` through `saveCompactAt`
 * (`updateSettings`): a percent outside 50–95 or a fraction is a 400, an
 * unreadable settings.json is a 500 with nothing written. A change reaches
 * sessions started afterwards; a running session keeps the value it started with.
 *
 * Mounted after the global JWT gate in `buildWebApp.ts` (the mount position is
 * the auth mechanism). The limiter is created per factory call.
 */
export function createCompactAtPreferenceRoutes(
  settingsFile: string
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  const limiter = createRateLimiter({ name: "compact-at" });

  app.get(
    "/preferences/compact-at",
    cataloged(
      defineCapability({
        id: "session-lifecycle.compact-at-preference",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Read this node's compact-at percentage and the token point where a session compacts",
        whenToUse:
          "When showing or checking when Claude sessions on this machine compact their context.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/preferences/compact-at",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => c.json(compactAtResponse(await readCompactAt(settingsFile)))
  );

  app.put(
    "/preferences/compact-at",
    cataloged(
      defineCapability({
        id: "session-lifecycle.set-compact-at-preference",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Set this node's compact-at percentage (a whole number from 50 to 95) or switch it off, for Claude sessions started afterwards",
        whenToUse:
          "When the user changes when Claude sessions on this machine compact their context.",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/api/preferences/compact-at",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    limiter,
    async c => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "Invalid JSON body" }, 400);
      }
      const parsed = CompactAtPreferencePatchSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { error: "Invalid preferences", details: parsed.error.issues },
          400
        );
      }
      try {
        const state = await saveCompactAt(settingsFile, parsed.data);
        return c.json(compactAtResponse(state));
      } catch (error) {
        if (error instanceof SettingsUnreadableError) {
          return c.json({ error: SETTINGS_UNREADABLE_MESSAGE }, 500);
        }
        if (error instanceof CompactAtValidationError) {
          return c.json(
            { error: "Invalid preferences", details: error.message },
            400
          );
        }
        throw error;
      }
    }
  );

  return app;
}
