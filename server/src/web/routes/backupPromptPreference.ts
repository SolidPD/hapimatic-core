// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { defineCapability } from "@hapi/protocol";
import {
  BackupPromptPreferenceSchema,
  type BackupPromptPreference,
} from "@hapi/protocol/schemas";
import { cataloged } from "../../capabilities/cataloged";
import type { WebAppEnv } from "../middleware/auth";
import {
  readSettings,
  SettingsUnreadableError,
  updateSettings,
  type Settings,
} from "../../config/settings";

/** The settings key that holds `{ skipped }` (#4791). */
export const BACKUP_PROMPT_KEY = "backupPrompt";

const UNREADABLE_ERROR =
  "The settings file cannot be read; the backup prompt preference was not changed.";

type SettingsWithPrompt = Settings & Record<string, unknown>;

/** The effective preference: the stored value, or not skipped for anything else. */
function effectivePreference(settings: Settings): BackupPromptPreference {
  const parsed = BackupPromptPreferenceSchema.safeParse(
    (settings as SettingsWithPrompt)[BACKUP_PROMPT_KEY]
  );
  return parsed.success ? parsed.data : { skipped: false };
}

/**
 * `GET/PUT /preferences/backup-prompt` — whether the user skipped the app's
 * first-run backup-key step (#4791 R1, R4). Node-local: the value lives in this
 * instance's settings file, never on the gateway. Its own file because
 * `routes/preferences.ts` sits at its `max-lines` ceiling (the #3865 sibling
 * `onboardingPreference.ts` is here for the same reason).
 *
 * GET returns the effective value (`{ skipped: false }` for an absent key or a
 * value that does not parse). PUT goes through `updateSettings`, the one
 * serialized read-modify-write of the settings file, and writes nothing when the
 * value is unchanged. Both answer 503 when the settings file exists but cannot be
 * parsed: that file holds the instance's secrets and must never be rewritten with
 * this one key.
 *
 * Mounted after the global JWT gate in `buildWebApp.ts` (the mount position is
 * the auth mechanism).
 */
export function createBackupPromptPreferenceRoutes(
  settingsFile: string
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  app.get(
    "/preferences/backup-prompt",
    cataloged(
      defineCapability({
        id: "ui.backup-prompt-preference",
        domain: "ui",
        surface: "rest",
        description:
          "Read whether the user skipped this instance's first-run backup-key step.",
        whenToUse:
          "When the web app decides whether to present the first-run backup-key step.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/preferences/backup-prompt",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const settings = await readSettings(settingsFile);
      if (settings === null) {
        return c.json({ error: UNREADABLE_ERROR }, 503);
      }
      return c.json(effectivePreference(settings));
    }
  );

  app.put(
    "/preferences/backup-prompt",
    cataloged(
      defineCapability({
        id: "ui.set-backup-prompt-preference",
        domain: "ui",
        surface: "rest",
        description:
          "Record that the user skipped (or un-skipped) this instance's first-run backup-key step. Never acknowledges or touches the backup key itself.",
        whenToUse:
          "When the user skips the first-run backup-key step, so it is not presented again.",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/api/preferences/backup-prompt",
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
      const parsed = BackupPromptPreferenceSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          {
            error: "Invalid backup prompt preference",
            details: parsed.error.issues,
          },
          400
        );
      }

      const next = parsed.data;
      try {
        await updateSettings(settingsFile, current =>
          effectivePreference(current).skipped === next.skipped
            ? current
            : { ...current, [BACKUP_PROMPT_KEY]: next }
        );
      } catch (error) {
        if (error instanceof SettingsUnreadableError) {
          return c.json({ error: UNREADABLE_ERROR }, 503);
        }
        throw error;
      }
      return c.json(next);
    }
  );

  return app;
}
