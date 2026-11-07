// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { defineCapability } from "@hapi/protocol";
import {
  DefaultSpawnPermissionModePreferencePatchSchema,
  DefaultSpawnPermissionModePreferenceSchema,
} from "@hapi/protocol/schemas";
import {
  DEFAULT_SPAWN_PERMISSION_MODE,
  type PermissionMode,
} from "@hapi/protocol/modes";
import { cataloged } from "../../capabilities/cataloged";
import {
  readSettings,
  SettingsUnreadableError,
  updateSettings,
  type Settings,
} from "../../config/settings";
import type { SyncEngine } from "../../sync/syncEngine";
import type { WebAppEnv } from "../middleware/auth";
import { refuseAgentEscalation } from "./agentEscalation";

/** The `settings.json` key that holds the node's default spawn permission mode. */
export const DEFAULT_SPAWN_PERMISSION_MODE_KEY =
  "defaultSpawnPermissionModePreference";

/**
 * Read the node's effective default spawn permission mode (#6218) — the ONE
 * server-side accessor for both the spawn path (injected into
 * `syncEngine.spawnSession`, where it resolves a request that names no posture)
 * and the GET route below, so the value Settings displays and the value spawns
 * act on can never diverge (#2486).
 *
 * Fails CLOSED toward the shared non-YOLO default on every uncertain path: an
 * absent key, an unreadable file, or a malformed value all read as
 * {@link DEFAULT_SPAWN_PERMISSION_MODE}. Only an explicitly stored mode — a
 * deliberate operator choice — can make an omitted posture YOLO. Never throws.
 */
export async function readDefaultSpawnPermissionModePreference(
  settingsFile: string
): Promise<PermissionMode> {
  try {
    const settings = await readSettings(settingsFile);
    if (settings === null) return DEFAULT_SPAWN_PERMISSION_MODE;
    const raw = (settings as Settings & Record<string, unknown>)[
      DEFAULT_SPAWN_PERMISSION_MODE_KEY
    ];
    if (raw === undefined || raw === null) return DEFAULT_SPAWN_PERMISSION_MODE;
    const parsed = DefaultSpawnPermissionModePreferenceSchema.safeParse(raw);
    return parsed.success ? parsed.data.mode : DEFAULT_SPAWN_PERMISSION_MODE;
  } catch {
    return DEFAULT_SPAWN_PERMISSION_MODE;
  }
}

/**
 * `GET/PUT /preferences/default-spawn-permission-mode` — the node's default
 * spawn permission mode (issue #6218). Its own file because
 * `routes/preferences.ts` sits at its `max-lines` ceiling.
 *
 * Node-local by design: it is NOT part of federation preference sync, so an
 * operator machine can keep YOLO while a fresh install or a customer VM gets
 * the shared one-step-below-YOLO default.
 *
 * The PUT is floored like a YOLO spawn (`refuseAgentEscalation`): a session that
 * is not in a bypass permission mode cannot change it through the capability
 * channel, or it could make every future spawn on its node start in YOLO. The
 * write goes through `updateSettings`, the serialized read-modify-write of
 * `settings.json`, and answers 503 (writing nothing) when that file exists but
 * cannot be parsed.
 *
 * Mounted after the global JWT gate in `buildWebApp.ts` (the mount position is
 * the auth mechanism).
 */
export function createSpawnPermissionPreferenceRoutes(
  settingsFile: string,
  opts: { getSyncEngine?: () => SyncEngine | null } = {}
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  app.get(
    "/preferences/default-spawn-permission-mode",
    cataloged(
      defineCapability({
        id: "machine-daemon.default-spawn-permission-mode-preference",
        domain: "machine-daemon",
        surface: "rest",
        description:
          "Read this node's default spawn permission mode: the posture a new session starts in when the request names none.",
        whenToUse:
          "When showing the default spawn permission mode or pre-selecting it on the Create page.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/preferences/default-spawn-permission-mode",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => {
      return c.json({
        mode: await readDefaultSpawnPermissionModePreference(settingsFile),
      });
    }
  );

  app.put(
    "/preferences/default-spawn-permission-mode",
    cataloged(
      defineCapability({
        id: "machine-daemon.set-default-spawn-permission-mode-preference",
        domain: "machine-daemon",
        surface: "rest",
        description:
          "Set this node's default spawn permission mode (default, accept, YOLO or plan; each harness gets its equivalent).",
        whenToUse:
          "When the user changes the default spawn permission mode in Settings.",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/api/preferences/default-spawn-permission-mode",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const refusal = refuseAgentEscalation(c, opts.getSyncEngine?.() ?? null);
      if (refusal) return refusal;

      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "Request body must be JSON" }, 400);
      }
      const parsed =
        DefaultSpawnPermissionModePreferencePatchSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { error: "Invalid preference", details: parsed.error.issues },
          400
        );
      }

      const { mode } = parsed.data;
      try {
        await updateSettings(settingsFile, current => ({
          ...current,
          [DEFAULT_SPAWN_PERMISSION_MODE_KEY]: { mode },
        }));
      } catch (error) {
        if (error instanceof SettingsUnreadableError) {
          return c.json(
            {
              error:
                "The settings file cannot be read; the default spawn permission mode was not changed.",
            },
            503
          );
        }
        throw error;
      }
      return c.json({ mode });
    }
  );

  return app;
}
