// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { defineCapability } from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";
import type { WebAppEnv } from "../middleware/auth";
import type { SyncEngine } from "../../sync/syncEngine";
import type { SSEManager } from "../../sse/sseManager";
import {
  readSettings,
  writeSettings,
  type Settings,
} from "../../config/settings";
import {
  loadCeilingGuardConfig,
  saveCeilingGuardConfig,
} from "../../config/ceilingGuardConfig";
// #4613: the node-LOCAL time-log zone (no federation resolution) — the A-local
// fallback buildView shows for the timeLogTimezone key before any global write.
import { readLocalTimeLogTimezone } from "../../config/timeLogConfig";
import {
  SETTING_REGISTRY,
  buildView,
  resolveEffective,
  type SettingsSyncService,
} from "../../services/settingsSyncService";
import {
  AUTO_RECOVER_DEFAULT_ENABLED,
  AUTO_SELECT_OPTIMAL_ACCOUNT_DEFAULT_ENABLED,
  AUTO_SWITCH_ON_RATE_LIMIT_DEFAULT_ENABLED,
  AutoRecoverPreferencePatchSchema,
  AutoSelectOptimalAccountPreferencePatchSchema,
  AutoSwitchOnRateLimitPreferencePatchSchema,
  CeilingGuardConfigPatchSchema,
  CHAT_SECTIONS_DEFAULT,
  ChatDetailLevelSchema,
  ChatSectionsPreferenceSchema,
  CreateSessionDefaultsSchema,
  CreateSessionPreferencesSchema,
  DEFAULT_OUTPUT_STYLE_DEFAULT,
  DefaultModelPreferenceSchema,
  DefaultOutputStylePreferenceSchema,
  FEDERATION_SETTING_KEYS,
  FederationSettingPatchSchema,
  FederationSettingsBlockSchema,
  migrateChatDetailLevelToSections,
  OpenRouterFavoritesSchema,
  SearchFilterPreferencesSchema,
  TERMINAL_KEYBOARD_EXPANDED_DEFAULT,
} from "@hapi/protocol/schemas";
import type {
  AutoRecoverPreference,
  AutoSelectOptimalAccountPreference,
  AutoSwitchOnRateLimitPreference,
  ChatSectionsPreference,
  FederationSettingKey,
  FederationSettingsBlock,
} from "@hapi/protocol/schemas";

/** #2624 (Sub-Issue B): optional wiring for the federation-global settings
 * layer. When absent (standalone route construction, e.g. in tests that only
 * exercise A's surface), the two A-key PUTs fall back to A's direct writes and
 * the /preferences/federation-settings 🌐 surface returns 503. */
export interface PreferencesRouteOptions {
  getSettingsSyncService?: () => SettingsSyncService | null;
  // #3018: chat-sections change propagation. A GLOBAL write publishes a host-global
  // invalidation via the SyncEngine (federation subscribers + local SSE); an
  // `inherit:false` node-local override and the no-sync-service fallback use the
  // SSEManager directly (node-only, never federated). Both getters are optional so
  // standalone/test route construction that only exercises the write surface can omit
  // them — the notification is simply skipped.
  getSyncEngine?: () => SyncEngine | null;
  getSseManager?: () => SSEManager | null;
}

export function createPreferencesRoutes(
  settingsFile: string,
  opts?: PreferencesRouteOptions
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  // GET /preferences/search-filter — read search/filter bar state
  app.get(
    "/preferences/search-filter",
    cataloged(
      defineCapability({
        id: "session-introspection.search-filter-preference",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Read the persisted session-list search and filter bar state (query, active filters, sort) for the web UI.",
        whenToUse:
          "When restoring the session list's search and filter controls to their saved state.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/preferences/search-filter",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const settings = await readSettings(settingsFile);
      const raw = (settings as Settings & Record<string, unknown>)
        ?.searchFilterPreferences;
      const parsed = SearchFilterPreferencesSchema.safeParse(raw ?? {});
      return c.json(
        parsed.success ? parsed.data : SearchFilterPreferencesSchema.parse({})
      );
    }
  );

  // PUT /preferences/search-filter — update search/filter bar state
  app.put(
    "/preferences/search-filter",
    cataloged(
      defineCapability({
        id: "session-introspection.set-search-filter-preference",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Persist the session-list search and filter bar state (query, active filters, sort) for the web UI.",
        whenToUse:
          "When the user changes the session list search or filter controls and the state should persist.",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/api/preferences/search-filter",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const body = await c.req.json();
      const parsed = SearchFilterPreferencesSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { error: "Invalid preferences", details: parsed.error.issues },
          400
        );
      }

      const settings = (await readSettings(settingsFile)) ?? {};
      (settings as Settings & Record<string, unknown>).searchFilterPreferences =
        parsed.data;
      await writeSettings(settingsFile, settings);

      return c.json(parsed.data);
    }
  );

  // ── Auto-recover from API errors (epic #1231 sub-issue E) ──

  // GET /preferences/auto-recover — the server-authoritative effective value,
  // the FULL object `{ enabled, classOverrides? }` (#2487 D, ruling D1).
  // Delegates to `readAutoRecoverPreferences` (the SAME accessor the recovery
  // service uses) so the master toggle, the per-class list, and the recovery
  // decision can never diverge on any path: absent/missing key → shared default
  // (`enabled: true`), malformed value or malformed file → fail-closed
  // (`enabled: false`) with per-field-salvaged class overrides (#2486 / Task 5).
  app.get(
    "/preferences/auto-recover",
    cataloged(
      defineCapability({
        id: "session-lifecycle.auto-recover-preference",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Read the auto-recover-from-API-errors preference (master toggle plus per-error-class overrides) the recovery service acts on.",
        whenToUse:
          "When showing or checking whether sessions automatically recover after API errors.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/preferences/auto-recover",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const pref = await readAutoRecoverPreferences(settingsFile);
      return c.json(pref);
    }
  );

  // PUT /preferences/auto-recover — MERGE a partial over the stored preference
  // (#2487 D, ruling D1 — THE CRITICAL fix). Before this, a `{enabled}`-only PUT
  // silently wiped every per-class opt-out (whole-key replace) and
  // `classOverrides` could never round-trip. Semantics (R7): an OMITTED key
  // means "unchanged" — changing/clearing a class requires an explicit boolean;
  // omission never clears it. `enabled` and `classOverrides` merge independently,
  // so a `{classOverrides}`-only body does not reset the master and a
  // `{enabled}`-only body does not erase the class map.
  app.put(
    "/preferences/auto-recover",
    cataloged(
      defineCapability({
        id: "session-lifecycle.set-auto-recover-preference",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Merge a partial update into the auto-recover preference (master toggle and per-error-class overrides); omitted keys stay unchanged.",
        whenToUse:
          "When the user enables, disables, or scopes automatic session recovery from API errors.",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/api/preferences/auto-recover",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const body = await c.req.json();
      // Patch schema: `enabled` has NO default here, so a `{classOverrides}`-only
      // body does not fabricate `enabled: true` and reset the master (R7 reverse).
      const parsed = AutoRecoverPreferencePatchSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { error: "Invalid preferences", details: parsed.error.issues },
          400
        );
      }
      const patch = parsed.data;

      const settings = (await readSettings(settingsFile)) ?? {};
      // Merge over the RAW stored value (not the fail-closed-resolved accessor) so
      // a WRITE never persists a fail-closed placeholder — fail closed on READ
      // ONLY (Task 5(e)). Absent/malformed stored fields fall back to the shared
      // default, never to `false`.
      const rawStored = (settings as Settings & Record<string, unknown>)
        .autoRecoverPreference;
      const storedObj: Record<string, unknown> =
        rawStored && typeof rawStored === "object"
          ? (rawStored as Record<string, unknown>)
          : {};
      const storedEnabled =
        typeof storedObj.enabled === "boolean"
          ? storedObj.enabled
          : AUTO_RECOVER_DEFAULT_ENABLED;
      const storedClassOverrides = salvageClassOverrides(
        storedObj.classOverrides
      );

      const mergedEnabled = patch.enabled ?? storedEnabled;
      const mergedClassOverrides = {
        ...(storedClassOverrides ?? {}),
        ...(patch.classOverrides ?? {}),
      };
      const merged: AutoRecoverPreference =
        Object.keys(mergedClassOverrides).length > 0
          ? { enabled: mergedEnabled, classOverrides: mergedClassOverrides }
          : { enabled: mergedEnabled };

      (settings as Settings & Record<string, unknown>).autoRecoverPreference =
        merged;
      await writeSettings(settingsFile, settings);

      return c.json(merged);
    }
  );

  // ── Runaway-session ceiling guard (issue #1905) ──

  // GET /preferences/ceiling-guard — the server-authoritative effective config:
  // the stored global settings merged over the generous defaults, with the
  // `HAPI_CEILING_GUARD_ENABLED` env kill-switch applied.
  app.get(
    "/preferences/ceiling-guard",
    cataloged(
      defineCapability({
        id: "session-lifecycle.ceiling-guard-preference",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Read the global runaway-session ceiling-guard config (enable toggle, uncached-token + iteration + cost ceilings, hard-stop toggle).",
        whenToUse:
          "When showing or checking the global token/iteration ceiling that hard-stops runaway sessions.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/preferences/ceiling-guard",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const config = await loadCeilingGuardConfig(settingsFile);
      return c.json(config);
    }
  );

  // PUT /preferences/ceiling-guard — MERGE a partial over the stored config (an
  // omitted key means "unchanged"; a `null` clears that ceiling dimension). Also
  // refreshes the running SyncEngine's cached config so the change takes effect
  // at the next turn boundary WITHOUT a restart — the synchronous finalize check
  // reads the cached value while the config loader is async (1905-3).
  app.put(
    "/preferences/ceiling-guard",
    cataloged(
      defineCapability({
        id: "session-lifecycle.set-ceiling-guard-preference",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Merge a partial update into the global runaway-session ceiling-guard config; omitted keys stay unchanged, null clears a ceiling dimension.",
        whenToUse:
          "When the user enables/disables the runaway guard or tunes the global token/iteration/cost ceilings.",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/api/preferences/ceiling-guard",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const body = await c.req.json();
      const parsed = CeilingGuardConfigPatchSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { error: "Invalid preferences", details: parsed.error.issues },
          400
        );
      }

      const merged = await saveCeilingGuardConfig(settingsFile, parsed.data);
      // Refresh the running engine's cached config (runtime-updatable, no
      // restart). No-op when the engine is not wired (standalone/test factory).
      opts?.getSyncEngine?.()?.setCeilingGuardConfig(merged);
      return c.json(merged);
    }
  );

  // ── Auto-switch account on rate limit (#3618) ──

  // GET /preferences/auto-switch-on-rate-limit — the server-authoritative
  // effective value `{ enabled }`. Delegates to the SAME accessor the switch
  // service reads (`readAutoSwitchOnRateLimitPreference`) so the toggle the UI
  // shows and the value the service acts on can never diverge: absent key →
  // default (OFF); unreadable/malformed → fail-closed (OFF).
  app.get(
    "/preferences/auto-switch-on-rate-limit",
    cataloged(
      defineCapability({
        id: "accounts.auto-switch-on-rate-limit-preference",
        domain: "accounts",
        surface: "rest",
        description:
          "Read whether a session automatically switches to another Anthropic account when the current one hits a rate limit.",
        whenToUse:
          "When showing or checking the auto-switch-account-on-rate-limit setting.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/preferences/auto-switch-on-rate-limit",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => {
      return c.json(await readAutoSwitchOnRateLimitPreference(settingsFile));
    }
  );

  // PUT /preferences/auto-switch-on-rate-limit — MERGE a partial `{ enabled? }`
  // over the stored value (an omitted key means "unchanged"). Mirrors the
  // auto-recover PUT: merge over the RAW stored value so a WRITE never persists a
  // fail-closed placeholder — fail closed on READ only.
  app.put(
    "/preferences/auto-switch-on-rate-limit",
    cataloged(
      defineCapability({
        id: "accounts.set-auto-switch-on-rate-limit-preference",
        domain: "accounts",
        surface: "rest",
        description:
          "Enable or disable automatically switching a session to another Anthropic account when the current account is rate-limited.",
        whenToUse:
          "When the user turns account auto-switch-on-rate-limit on or off.",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/api/preferences/auto-switch-on-rate-limit",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const body = await c.req.json();
      const parsed = AutoSwitchOnRateLimitPreferencePatchSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { error: "Invalid preferences", details: parsed.error.issues },
          400
        );
      }
      const patch = parsed.data;

      const settings = (await readSettings(settingsFile)) ?? {};
      const rawStored = (settings as Settings & Record<string, unknown>)
        .autoSwitchOnRateLimitPreference;
      const storedObj: Record<string, unknown> =
        rawStored && typeof rawStored === "object"
          ? (rawStored as Record<string, unknown>)
          : {};
      const storedEnabled =
        typeof storedObj.enabled === "boolean"
          ? storedObj.enabled
          : AUTO_SWITCH_ON_RATE_LIMIT_DEFAULT_ENABLED;

      const merged: AutoSwitchOnRateLimitPreference = {
        enabled: patch.enabled ?? storedEnabled,
      };

      (
        settings as Settings & Record<string, unknown>
      ).autoSwitchOnRateLimitPreference = merged;
      await writeSettings(settingsFile, settings);

      return c.json(merged);
    }
  );

  // GET /preferences/auto-select-optimal-account — the server-authoritative
  // effective `{ enabled }` (#3611); delegates to the SAME accessor the daemon
  // resolver reads so the UI toggle and spawn behavior cannot diverge (#2486).
  app.get(
    "/preferences/auto-select-optimal-account",
    cataloged(
      defineCapability({
        id: "accounts.auto-select-optimal-account-preference",
        domain: "accounts",
        surface: "rest",
        description: "Read the auto-select-optimal-account opt-in.",
        whenToUse: "When showing the auto-select-optimal-account setting.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/preferences/auto-select-optimal-account",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => {
      return c.json({
        enabled: await readAutoSelectOptimalAccountPreference(settingsFile),
      });
    }
  );

  // PUT /preferences/auto-select-optimal-account — MERGE `{ enabled? }` over the
  // RAW stored value (omitted key = "unchanged"), mirroring the auto-switch PUT.
  app.put(
    "/preferences/auto-select-optimal-account",
    cataloged(
      defineCapability({
        id: "accounts.set-auto-select-optimal-account-preference",
        domain: "accounts",
        surface: "rest",
        description:
          "Enable or disable auto-select-optimal-account for spawns.",
        whenToUse: "When the user toggles optimal-account auto-selection.",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/api/preferences/auto-select-optimal-account",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const body = await c.req.json();
      const parsed =
        AutoSelectOptimalAccountPreferencePatchSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { error: "Invalid preferences", details: parsed.error.issues },
          400
        );
      }
      const settings = (await readSettings(settingsFile)) ?? {};
      const rawStored = (settings as Settings & Record<string, unknown>)
        .autoSelectOptimalAccountPreference;
      const storedObj: Record<string, unknown> =
        rawStored && typeof rawStored === "object"
          ? (rawStored as Record<string, unknown>)
          : {};
      const storedEnabled =
        typeof storedObj.enabled === "boolean"
          ? storedObj.enabled
          : AUTO_SELECT_OPTIMAL_ACCOUNT_DEFAULT_ENABLED;
      const merged: AutoSelectOptimalAccountPreference = {
        enabled: parsed.data.enabled ?? storedEnabled,
      };
      (
        settings as Settings & Record<string, unknown>
      ).autoSelectOptimalAccountPreference = merged;
      await writeSettings(settingsFile, settings);
      return c.json(merged);
    }
  );

  // ── Create-Session page UI state (server-persisted accordion sections) ──

  // GET /preferences/create-session — read the expand/collapse section state
  app.get(
    "/preferences/create-session",
    cataloged(
      defineCapability({
        id: "session-lifecycle.create-session-preference",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Read the Create-Session page UI state (which configuration accordion sections are expanded or collapsed).",
        whenToUse:
          "When restoring the Create-Session page's expanded/collapsed section layout.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/preferences/create-session",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const settings = await readSettings(settingsFile);
      const raw = (settings as Settings & Record<string, unknown>)
        ?.createSessionPreferences;
      const parsed = CreateSessionPreferencesSchema.safeParse(raw ?? {});
      return c.json(
        parsed.success ? parsed.data : CreateSessionPreferencesSchema.parse({})
      );
    }
  );

  // PUT /preferences/create-session — update the section state
  app.put(
    "/preferences/create-session",
    cataloged(
      defineCapability({
        id: "session-lifecycle.set-create-session-preference",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Persist the Create-Session page UI state (expanded/collapsed configuration sections).",
        whenToUse:
          "When the user expands or collapses sections on the Create-Session page.",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/api/preferences/create-session",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const body = await c.req.json();
      const parsed = CreateSessionPreferencesSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { error: "Invalid preferences", details: parsed.error.issues },
          400
        );
      }

      const settings = (await readSettings(settingsFile)) ?? {};
      (
        settings as Settings & Record<string, unknown>
      ).createSessionPreferences = parsed.data;
      await writeSettings(settingsFile, settings);

      return c.json(parsed.data);
    }
  );

  // ── Create-Session per-field saved defaults (bookmark feature) ──
  // Sibling of /preferences/create-session, under its OWN settings key so the
  // two fire-and-forget writers can never clobber each other's blob.

  // GET /preferences/create-defaults — read the bookmarked field defaults
  app.get(
    "/preferences/create-defaults",
    cataloged(
      defineCapability({
        id: "session-lifecycle.create-defaults-preference",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Read the saved per-field default values that pre-fill the Create-Session form for new sessions.",
        whenToUse:
          "When pre-filling the Create-Session form with the user's bookmarked field defaults.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/preferences/create-defaults",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const settings = await readSettings(settingsFile);
      const raw = (settings as Settings & Record<string, unknown>)
        ?.createSessionDefaults;
      const parsed = CreateSessionDefaultsSchema.safeParse(raw ?? {});
      return c.json(
        parsed.success ? parsed.data : CreateSessionDefaultsSchema.parse({})
      );
    }
  );

  // PUT /preferences/create-defaults — replace the bookmarked field defaults
  app.put(
    "/preferences/create-defaults",
    cataloged(
      defineCapability({
        id: "session-lifecycle.set-create-defaults-preference",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Replace the saved per-field Create-Session default values that pre-fill the new-session form.",
        whenToUse:
          "When the user saves or clears the default values used to pre-fill new sessions.",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/api/preferences/create-defaults",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const body = await c.req.json();
      const parsed = CreateSessionDefaultsSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { error: "Invalid preferences", details: parsed.error.issues },
          400
        );
      }

      const settings = (await readSettings(settingsFile)) ?? {};
      (settings as Settings & Record<string, unknown>).createSessionDefaults =
        parsed.data;
      await writeSettings(settingsFile, settings);

      return c.json(parsed.data);
    }
  );

  // ── OpenRouter favorited model ids (#1975) ──

  // GET /preferences/openrouter-favorites — read favorited model ids.
  app.get(
    "/preferences/openrouter-favorites",
    cataloged(
      defineCapability({
        id: "model-permission.openrouter-favorites-preference",
        domain: "model-permission",
        surface: "rest",
        description:
          "Read the user's list of favorited OpenRouter model ids surfaced in the model picker.",
        whenToUse:
          "When populating the OpenRouter model picker with the user's favorites.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/preferences/openrouter-favorites",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const settings = await readSettings(settingsFile);
      const raw = (settings as Settings & Record<string, unknown>)
        ?.openRouterFavorites;
      const parsed = OpenRouterFavoritesSchema.safeParse(raw ?? {});
      return c.json(
        parsed.success ? parsed.data : OpenRouterFavoritesSchema.parse({})
      );
    }
  );

  // PUT /preferences/openrouter-favorites — update favorited model ids.
  app.put(
    "/preferences/openrouter-favorites",
    cataloged(
      defineCapability({
        id: "model-permission.set-openrouter-favorites-preference",
        domain: "model-permission",
        surface: "rest",
        description:
          "Update the list of favorited OpenRouter model ids surfaced in the model picker.",
        whenToUse:
          "When the user favorites or unfavorites an OpenRouter model.",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/api/preferences/openrouter-favorites",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const body = await c.req.json();
      const parsed = OpenRouterFavoritesSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { error: "Invalid preferences", details: parsed.error.issues },
          400
        );
      }
      const settings = (await readSettings(settingsFile)) ?? {};
      (settings as Settings & Record<string, unknown>).openRouterFavorites =
        parsed.data;
      await writeSettings(settingsFile, settings);
      return c.json(parsed.data);
    }
  );

  // ── Configurable default model (#2456, R5) ──

  // GET /preferences/default-model — read the node-local default-model choice.
  app.get(
    "/preferences/default-model",
    cataloged(
      defineCapability({
        id: "model-permission.default-model-preference",
        domain: "model-permission",
        surface: "rest",
        description:
          "Read the node-local default model that a default-mode session resolves to when no explicit model is chosen.",
        whenToUse:
          "When showing the configured default model or resolving what a default-mode session will use.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/preferences/default-model",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const settings = await readSettings(settingsFile);
      const raw = (settings as Settings & Record<string, unknown>)
        ?.defaultModelPreference;
      const parsed = DefaultModelPreferenceSchema.safeParse(raw ?? {});
      return c.json(
        parsed.success ? parsed.data : DefaultModelPreferenceSchema.parse({})
      );
    }
  );

  // PUT /preferences/default-model — set what a "default"-mode session resolves
  // to. Behavioral at spawn (the create route threads it when no explicit model
  // is chosen) and drives the `Default (X)` resolution indicator.
  app.put(
    "/preferences/default-model",
    cataloged(
      defineCapability({
        id: "model-permission.set-default-model-preference",
        domain: "model-permission",
        surface: "rest",
        description:
          "Set the node-local default model that a default-mode session resolves to at spawn when no explicit model is chosen.",
        whenToUse:
          "When the user changes which model new default-mode sessions should use.",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/api/preferences/default-model",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const body = await c.req.json();
      const parsed = DefaultModelPreferenceSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { error: "Invalid preferences", details: parsed.error.issues },
          400
        );
      }
      const settings = (await readSettings(settingsFile)) ?? {};
      (settings as Settings & Record<string, unknown>).defaultModelPreference =
        parsed.data;
      await writeSettings(settingsFile, settings);
      return c.json(parsed.data);
    }
  );

  // ── Chat sections + default output style (#2988 S1 / #2623 A) ───────────
  // Chat sections (#2988, epic #2987 S1) SUPERSEDES the retired chatDetailLevel
  // enum with a per-category matrix. GET delegates to the shared accessor (so
  // S2's chat renderer reads the same value the UI shows) and one-time-migrates
  // any legacy chatDetailLevel value; PUT full-replaces the matrix (no partial
  // merge). Default output style (#2623 A) is unchanged, below.

  app.get(
    "/preferences/chat-sections",
    cataloged(
      defineCapability({
        id: "session-introspection.chat-sections-preference",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Read the effective chat-sections display matrix controlling which content categories the chat renderer shows.",
        whenToUse:
          "When rendering a session's chat with the user's saved section-visibility preferences.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/preferences/chat-sections",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => {
      return c.json(await readChatSections(settingsFile));
    }
  );

  app.put(
    "/preferences/chat-sections",
    cataloged(
      defineCapability({
        id: "session-introspection.set-chat-sections-preference",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Replace the chat-sections display matrix controlling which content categories the chat renderer shows; federation-inherit aware.",
        whenToUse:
          "When the user changes which chat content sections are visible.",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/api/preferences/chat-sections",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const body = await c.req.json();
      const parsed = ChatSectionsPreferenceSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { error: "Invalid preferences", details: parsed.error.issues },
          400
        );
      }
      // [expert-review 2026-08-05: 2623-3] DO-NOT-WRITE guard: a MALFORMED
      // settings file resolves to `null`; overwriting it would clobber a corrupt
      // settings.json down to this one key. A MISSING file resolves to `{}` and is
      // safe to write (creates it).
      const settings = await readSettings(settingsFile);
      if (settings === null) {
        return c.json(
          { error: "Settings file is unreadable; refusing to overwrite" },
          500
        );
      }
      // #2624 (B): inherit-aware write through the sync layer — while inheriting
      // (🌐 on) a GLOBAL write (persist + best-effort peer fan-out, R3); while not
      // inheriting a node-local override write only (R4). The stored
      // `chatSectionsPreference` key is the pre-federation fallback (R2) and the
      // rollback surface.
      const svc = opts?.getSettingsSyncService?.();
      if (svc) {
        const block = await svc.readBlock();
        if (block.inheritFlags.chatSections !== false) {
          await svc.writeGlobalValue("chatSections", parsed.data);
          // #3018: GLOBAL write → publisher-backed host-global invalidation, reaching
          // federation subscribers AND local browsers. Emitted ONLY after the write
          // resolves (a rejected write throws and skips this).
          opts?.getSyncEngine?.()?.emitChatSectionsChanged();
        } else {
          await svc.writeLocalValue("chatSections", parsed.data);
          // #3018: `inherit:false` node-local override → node-local SSE only. A direct
          // broadcast keeps the override out of federation (R2a scope isolation); it
          // must NOT go through SyncEngine.emitChatSectionsChanged().
          opts?.getSseManager?.()?.broadcast({ type: "chat-sections-changed" });
        }
        return c.json(parsed.data);
      }
      // Fallback (no sync service threaded): direct write to the stored key.
      (settings as Settings & Record<string, unknown>).chatSectionsPreference =
        parsed.data;
      await writeSettings(settingsFile, settings);
      // #3018: no federation settings service in this mode → node-local SSE only, the
      // bounded behavior for a standalone node. Emitted only after the write resolves.
      opts?.getSseManager?.()?.broadcast({ type: "chat-sections-changed" });
      return c.json(parsed.data);
    }
  );

  app.get(
    "/preferences/default-output-style",
    cataloged(
      defineCapability({
        id: "model-permission.default-output-style-preference",
        domain: "model-permission",
        surface: "rest",
        description:
          "Read the default Claude output style applied to new sessions from the Create page.",
        whenToUse:
          "When showing or applying the default output style for a new session.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/preferences/default-output-style",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => {
      return c.json({ style: await readDefaultOutputStyle(settingsFile) });
    }
  );

  app.put(
    "/preferences/default-output-style",
    cataloged(
      defineCapability({
        id: "model-permission.set-default-output-style-preference",
        domain: "model-permission",
        surface: "rest",
        description:
          "Set the default Claude output style applied to new sessions; federation-inherit aware.",
        whenToUse:
          "When the user changes the default output style for new sessions.",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/api/preferences/default-output-style",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const body = await c.req.json();
      const parsed = DefaultOutputStylePreferenceSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { error: "Invalid preferences", details: parsed.error.issues },
          400
        );
      }
      // [expert-review 2026-08-05: 2623-3] DO-NOT-WRITE guard (see above).
      const settings = await readSettings(settingsFile);
      if (settings === null) {
        return c.json(
          { error: "Settings file is unreadable; refusing to overwrite" },
          500
        );
      }
      // #2624 (B): inherit-aware write through the sync layer (see the
      // chat-detail-level PUT above for the full rationale).
      const svc = opts?.getSettingsSyncService?.();
      if (svc) {
        const block = await svc.readBlock();
        if (block.inheritFlags.defaultOutputStyle !== false) {
          await svc.writeGlobalValue("defaultOutputStyle", parsed.data);
        } else {
          await svc.writeLocalValue("defaultOutputStyle", parsed.data);
        }
        return c.json(parsed.data);
      }
      // Fallback (no sync service threaded): A's original direct write.
      (
        settings as Settings & Record<string, unknown>
      ).defaultOutputStylePreference = parsed.data;
      await writeSettings(settingsFile, settings);
      return c.json(parsed.data);
    }
  );

  // ── Federation-global settings 🌐 view + per-key patch (#2624, B) ───────
  // Browser-facing (JWT-mounted) surface for the per-setting inherit toggle
  // [expert-review 2026-08-05: 2624-1] — the fed-token receiver in
  // routes/federation/settingsSync.ts is unreachable by the browser's JWT.

  // The per-key A-default fallbacks buildView needs (R5), hoisted so the GET and
  // the PUT cannot drift (#4548 — previously two identical literals). A
  // federation-native key (terminalKeyboardExpanded) has no A-local storage, so
  // its fallback is the shared default constant.
  async function federationView(block: FederationSettingsBlock) {
    return buildView(block, {
      chatSections: await readChatSections(settingsFile),
      defaultOutputStyle: { style: await readDefaultOutputStyle(settingsFile) },
      timeLogTimezone: await readLocalTimeLogTimezone(settingsFile),
      terminalKeyboardExpanded: TERMINAL_KEYBOARD_EXPANDED_DEFAULT,
    });
  }

  // GET /preferences/federation-settings — per-key effective value, 🌐 state,
  // and provenance ("global" | "local" | "default"). The UI hydrates from this.
  app.get(
    "/preferences/federation-settings",
    cataloged(
      defineCapability({
        id: "federation.federation-settings-preference",
        domain: "federation",
        surface: "rest",
        description:
          "Read every federation-global setting's effective value, inherit (global vs local) state, and provenance for the settings UI.",
        whenToUse:
          "When hydrating the federation settings panel with per-key values and inherit state.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/preferences/federation-settings",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const svc = opts?.getSettingsSyncService?.();
      if (!svc) {
        return c.json({ error: "Settings sync unavailable" }, 503);
      }
      const block = await svc.readBlock();
      return c.json(await federationView(block));
    }
  );

  // PUT /preferences/federation-settings/:key — `{ value?, inherit? }`.
  // `inherit` is the ONLY path that flips 🌐 (setInheritFlag); `value` follows
  // the same inheriting/not-inheriting write semantics as A's PUTs above. When
  // both are present the flag applies FIRST, so `{inherit:false, value}` writes
  // a local override and `{inherit:true, value}` writes a global. Responds with
  // the fresh view — the client re-hydrates from it, so toggling 🌐 back ON
  // re-adopts the current federation-global value (R8).
  app.put(
    "/preferences/federation-settings/:key",
    cataloged(
      defineCapability({
        id: "federation.set-federation-setting",
        domain: "federation",
        surface: "rest",
        description:
          "Update one federation-global setting by key: set its value and/or flip its inherit (global vs node-local override) flag.",
        whenToUse:
          "When the user changes a federation-global setting's value or its inherit toggle.",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/api/preferences/federation-settings/:key",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const svc = opts?.getSettingsSyncService?.();
      if (!svc) {
        return c.json({ error: "Settings sync unavailable" }, 503);
      }
      const key = c.req.param("key");
      if (!(FEDERATION_SETTING_KEYS as readonly string[]).includes(key)) {
        return c.json({ error: `Unknown federation setting: ${key}` }, 404);
      }
      const fedKey = key as FederationSettingKey;
      const parsed = FederationSettingPatchSchema.safeParse(await c.req.json());
      if (!parsed.success) {
        return c.json(
          { error: "Invalid patch", details: parsed.error.issues },
          400
        );
      }
      const patch = parsed.data;
      if (patch.value === undefined && patch.inherit === undefined) {
        return c.json({ error: "Patch must set value and/or inherit" }, 400);
      }
      // [expert-review 2026-08-05: 2623-3] DO-NOT-WRITE guard, same contract as
      // A's PUTs (the service's own unreadable guard would silently no-op and
      // this route would then claim success for a write that never landed).
      if ((await readSettings(settingsFile)) === null) {
        return c.json(
          { error: "Settings file is unreadable; refusing to overwrite" },
          500
        );
      }
      if (patch.inherit !== undefined) {
        await svc.setInheritFlag(fedKey, patch.inherit);
      }
      if (patch.value !== undefined) {
        const vparsed = SETTING_REGISTRY[fedKey].schema.safeParse(patch.value);
        if (!vparsed.success) {
          return c.json(
            { error: "Invalid value", details: vparsed.error.issues },
            400
          );
        }
        const block = await svc.readBlock();
        if (block.inheritFlags[fedKey] !== false) {
          await svc.writeGlobalValue(fedKey, vparsed.data);
        } else {
          await svc.writeLocalValue(fedKey, vparsed.data);
        }
      }
      const block = await svc.readBlock();
      return c.json(await federationView(block));
    }
  );

  return app;
}

/**
 * Read the node-local configurable default model (#2456, R5). Returns the
 * configured model alias/id, or `undefined` when the user has never set one
 * (→ the binary's own default-mode resolution / #1506 entitled pin applies).
 * Never throws — file I/O or parse errors degrade silently to `undefined`.
 */
export async function readDefaultModelPreference(
  settingsFile: string
): Promise<string | undefined> {
  try {
    const settings = await readSettings(settingsFile);
    const raw = (settings as (Settings & Record<string, unknown>) | null)
      ?.defaultModelPreference;
    const parsed = DefaultModelPreferenceSchema.safeParse(raw ?? {});
    return parsed.success ? parsed.data.model : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Per-field-salvage parse of a stored `classOverrides` map (#2487 D, Task 5(f)
 * — per-field salvage, the preferred fail-closed granularity). Keeps
 * boolean-valued entries; a non-boolean entry is coerced to `false` (opt-out),
 * so ONE corrupt class entry can never ARM that class NOR disarm the master /
 * other classes — an all-or-nothing `safeParse` would fail the whole object and
 * disarm even today's `overloaded_error`. Returns `undefined` when there is no
 * usable map.
 */
function salvageClassOverrides(
  raw: unknown
): Record<string, boolean> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    // Non-boolean → `false`: an unreadable opt-out signal fails CLOSED (never
    // arms), at CLASS granularity.
    out[key] = typeof value === "boolean" ? value : false;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Read the FULL auto-recover preference (`{ enabled, classOverrides? }`) — the
 * SINGLE server-side accessor for BOTH the recovery service (`autoRecoveryService`,
 * epic #1231 sub-issue C / issue #1234, and #2487 D's per-class resolution) AND
 * the UI (`GET /preferences/auto-recover` delegates here) — so the value the
 * backend acts on and the value the UI displays can never diverge (#2486).
 *
 * Fail-closed direction (unchanged from #2486, extended per Task 5(f)):
 *   - UNREADABLE settings file (`readSettings` → `null`): `{ enabled: false }` —
 *     a service that injects prompts into running sessions must NOT arm on
 *     unreadable config. (`readSettings` swallows a JSON parse error into `null`
 *     rather than throwing; a MISSING file returns `{}`, so absent-key ≠
 *     unreadable and the absent-key default `true` applies.)
 *   - `enabled` present but malformed (non-boolean): fail closed to `false`.
 *   - `classOverrides` per-field salvaged (see `salvageClassOverrides`) — one
 *     corrupt entry never disarms the master or another class.
 * Never throws.
 */
export async function readAutoRecoverPreferences(
  settingsFile: string
): Promise<AutoRecoverPreference> {
  try {
    const settings = await readSettings(settingsFile);
    if (settings === null) return { enabled: false }; // unreadable → fail closed
    const raw = (settings as Settings & Record<string, unknown>)
      .autoRecoverPreference;
    if (raw === undefined || raw === null) {
      return { enabled: AUTO_RECOVER_DEFAULT_ENABLED }; // absent key → default
    }
    if (typeof raw !== "object") return { enabled: false }; // malformed → closed
    const obj = raw as Record<string, unknown>;
    let enabled: boolean;
    if (obj.enabled === undefined) enabled = AUTO_RECOVER_DEFAULT_ENABLED;
    else if (typeof obj.enabled === "boolean") enabled = obj.enabled;
    else enabled = false; // present but malformed → fail closed
    const classOverrides = salvageClassOverrides(obj.classOverrides);
    return classOverrides ? { enabled, classOverrides } : { enabled };
  } catch {
    return { enabled: false };
  }
}

/**
 * Back-compat boolean accessor — the master effective value only. Delegates to
 * {@link readAutoRecoverPreferences} (that direction works; the reverse cannot —
 * a `boolean` structurally cannot carry the class map). Preserved for callers
 * that only need the master toggle.
 */
export async function readAutoRecoverPreference(
  settingsFile: string
): Promise<boolean> {
  return (await readAutoRecoverPreferences(settingsFile)).enabled;
}

/**
 * Read the "Auto-switch account on rate limit" preference `{ enabled }` (#3618)
 * — the SINGLE server-side accessor for BOTH the `AutoSwitchOnRateLimitService`
 * (which reads it FRESH per switch decision — an admin toggle is an instant
 * kill-switch) AND the UI (`GET /preferences/auto-switch-on-rate-limit`
 * delegates here), so the value the backend acts on and the value the UI shows
 * can never diverge (the #2486 discipline).
 *
 * Fail-closed direction — this feature actively kills and respawns a running
 * session, so EVERY uncertain path resolves to OFF:
 *   - UNREADABLE settings file (`readSettings` → `null`): `{ enabled: false }`.
 *   - ABSENT key (missing file returns `{}` / never-set key): the default
 *     constant `AUTO_SWITCH_ON_RATE_LIMIT_DEFAULT_ENABLED` (currently `false`).
 *   - present but malformed (`enabled` non-boolean, or a non-object value):
 *     `{ enabled: false }`.
 * Never throws.
 */
export async function readAutoSwitchOnRateLimitPreference(
  settingsFile: string
): Promise<{ enabled: boolean }> {
  try {
    const settings = await readSettings(settingsFile);
    if (settings === null) return { enabled: false }; // unreadable → fail closed
    const raw = (settings as Settings & Record<string, unknown>)
      .autoSwitchOnRateLimitPreference;
    if (raw === undefined || raw === null) {
      return { enabled: AUTO_SWITCH_ON_RATE_LIMIT_DEFAULT_ENABLED }; // absent → default (OFF)
    }
    if (typeof raw !== "object") return { enabled: false }; // malformed → closed
    const obj = raw as Record<string, unknown>;
    if (obj.enabled === undefined) {
      return { enabled: AUTO_SWITCH_ON_RATE_LIMIT_DEFAULT_ENABLED };
    }
    if (typeof obj.enabled === "boolean") return { enabled: obj.enabled };
    return { enabled: false }; // present but malformed → fail closed
  } catch {
    return { enabled: false };
  }
}

/**
 * Read the effective "Auto-select the optimal account" opt-in (#3611) — the SINGLE
 * server-side accessor for BOTH the daemon-spawn resolver (delivered on the spawn
 * RPC via `syncEngine.spawnSession`'s injected reader) AND the UI (the GET route
 * delegates here), so they cannot diverge (#2486). Fail-CLOSED to `false` on every
 * uncertain path (unreadable → false; absent key → default OFF; malformed → false)
 * so an unwired/unreadable preference runs NO pick — byte-identical to #3023 (R3).
 * Never throws.
 */
export async function readAutoSelectOptimalAccountPreference(
  settingsFile: string
): Promise<boolean> {
  try {
    const settings = await readSettings(settingsFile);
    if (settings === null) return false; // unreadable → fail closed
    const raw = (settings as Settings & Record<string, unknown>)
      .autoSelectOptimalAccountPreference;
    if (raw === undefined || raw === null) {
      return AUTO_SELECT_OPTIMAL_ACCOUNT_DEFAULT_ENABLED; // absent → default (OFF)
    }
    if (typeof raw !== "object") return false; // malformed → closed
    const obj = raw as Record<string, unknown>;
    if (obj.enabled === undefined) {
      return AUTO_SELECT_OPTIMAL_ACCOUNT_DEFAULT_ENABLED;
    }
    if (typeof obj.enabled === "boolean") return obj.enabled;
    return false; // present but malformed → fail closed
  } catch {
    return false;
  }
}

/**
 * Read the effective chat-sections matrix (#2988, epic #2987 Sub-Issue S1) — the
 * SINGLE server-side accessor the GET route delegates to (so S2's chat renderer
 * reads the same value the Preferences UI displays), with a one-time read
 * migration from the retired `chatDetailLevel` enum.
 *
 * Resolution order (fail-TO-default; cosmetic pref, never fail-closed, never
 * throws):
 *   1. the federation-effective `chatSections` value (inherit ? global :
 *      override) via `resolveEffective` — THE single effective-value read path (R1);
 *   2. a directly-stored `chatSectionsPreference` (the no-sync-service fallback
 *      PUT path / a post-migration write);
 *   3. a legacy FEDERATION-stored `chatDetailLevel` — the LIVE prod storage
 *      location, since #2624's PUT wrote ONLY the federation block, so the local
 *      `chatDetailLevelPreference` is dead in prod (expert-review 2026-08-16 R1).
 *      `chatDetailLevel` left the typed registry (Task 3), so read the RAW record;
 *   4. a legacy node-local `chatDetailLevelPreference` (pre-#2624 nodes);
 *   5. the shared default `CHAT_SECTIONS_DEFAULT`.
 * Steps 3/4 map the enum → matrix via `migrateChatDetailLevelToSections` (R2), so
 * a user's pre-deploy setting renders equivalently post-deploy with no action.
 *
 * NOTE (expert-review 2026-08-16 R17): a legacy `inheritFlags.chatDetailLevel` is
 * honored for the global-vs-override selection in step 3, so the VALUE migrates
 * correctly. The 🌐 inherit-flag DISPLAY under the new `chatSections` key defaults
 * to "inheriting" until the operator next toggles it — an accepted one-time
 * federation reconciliation (nodes update in lockstep; see OR1 / ruling D2).
 */
export async function readChatSections(
  settingsFile: string
): Promise<ChatSectionsPreference> {
  try {
    const settings = await readSettings(settingsFile);
    const rec = (settings ?? {}) as Settings & Record<string, unknown>;

    const blockParsed = FederationSettingsBlockSchema.safeParse(
      rec.federationSettings ?? {}
    );
    const block = blockParsed.success ? blockParsed.data : null;

    // 1. federation-effective chatSections value (the single effective-value
    //    read path — so every consumer sees federated updates without plumbing).
    if (block) {
      const eff = resolveEffective(block, "chatSections");
      if (eff !== undefined) {
        const effParsed = ChatSectionsPreferenceSchema.safeParse(eff);
        if (effParsed.success) return effParsed.data;
      }
    }

    // 2. a directly-stored chatSectionsPreference (fallback PUT / post-migration).
    const rawSections = rec.chatSectionsPreference;
    if (rawSections !== undefined) {
      const parsed = ChatSectionsPreferenceSchema.safeParse(rawSections);
      if (parsed.success) return parsed.data;
    }

    // 3. legacy FEDERATION-stored chatDetailLevel — the live prod migration path.
    //    Read the RAW record (the key left the typed registry) and honor the
    //    legacy inherit flag for the global-vs-override selection.
    if (block) {
      const inheriting = block.inheritFlags.chatDetailLevel !== false;
      const legacyFed = inheriting
        ? block.globalValues.chatDetailLevel?.value
        : block.localOverrides.chatDetailLevel;
      if (legacyFed !== undefined) {
        const legacyParsed = ChatDetailLevelSchema.safeParse(legacyFed);
        if (legacyParsed.success) {
          return migrateChatDetailLevelToSections(legacyParsed.data.level);
        }
        // #3003 F2: a legacy federation value was present but unparseable. Log it
        // (an operator otherwise gets no signal that a user's setting silently
        // reverted) and IGNORE it — control falls through to step 4 (node-local),
        // which may still migrate, and only then to the shared default. Never
        // throws; the fail-to-default return contract is unchanged.
        console.warn(
          "[preferences] readChatSections: ignoring unparseable legacy federation chatDetailLevel value (falling through to node-local / default migration)"
        );
      }
    }

    // 4. legacy node-local chatDetailLevelPreference (pre-#2624 nodes).
    const legacyLocal = rec.chatDetailLevelPreference;
    if (legacyLocal !== undefined) {
      const legacyParsed = ChatDetailLevelSchema.safeParse(legacyLocal);
      if (legacyParsed.success) {
        return migrateChatDetailLevelToSections(legacyParsed.data.level);
      }
      // #3003 F2: a legacy node-local value was present but unparseable. Log it
      // and IGNORE it — control falls through to the shared default next (this is
      // the last legacy source). Never throws; return contract unchanged.
      console.warn(
        "[preferences] readChatSections: ignoring unparseable legacy node-local chatDetailLevelPreference value (falling through to default)"
      );
    }

    // 5. shared default.
    return CHAT_SECTIONS_DEFAULT;
  } catch {
    return CHAT_SECTIONS_DEFAULT;
  }
}

/**
 * Read the effective default output style (#2623) — the accessor the GET route
 * delegates to, consumed by #2626 (D) as the Create-page default. Fail-TO-default
 * to `DEFAULT_OUTPUT_STYLE_DEFAULT` on absent/malformed/unreadable. Never throws.
 */
export async function readDefaultOutputStyle(
  settingsFile: string
): Promise<string> {
  try {
    const settings = await readSettings(settingsFile);
    const rec = (settings ?? {}) as Settings & Record<string, unknown>;
    // #2624 (B): federation-effective value first (R1) — see
    // readChatSections above for the full rationale.
    const blockParsed = FederationSettingsBlockSchema.safeParse(
      rec.federationSettings ?? {}
    );
    if (blockParsed.success) {
      const eff = resolveEffective(blockParsed.data, "defaultOutputStyle");
      if (eff !== undefined) {
        const effParsed = DefaultOutputStylePreferenceSchema.safeParse(eff);
        if (effParsed.success) return effParsed.data.style;
      }
    }
    const raw = rec.defaultOutputStylePreference;
    const parsed = DefaultOutputStylePreferenceSchema.safeParse(raw ?? {});
    return parsed.success ? parsed.data.style : DEFAULT_OUTPUT_STYLE_DEFAULT;
  } catch {
    return DEFAULT_OUTPUT_STYLE_DEFAULT;
  }
}

/**
 * Issue #2627 (Sub-Issue E, R5): if the node-local default output style equals
 * `name`, reset it to `DEFAULT_OUTPUT_STYLE_DEFAULT`. This is the delete-degrade
 * path — deleting a custom style that is the current default must degrade the
 * default (do NOT rely on D's fail-open, which only covers the key-omitted
 * case). Returns `true` iff a reset was written. Never throws — a settings I/O
 * error degrades to "no reset" (a spawn naming the missing style still
 * fail-opens to `default` via D's #2626 loader).
 */
export async function resetDefaultOutputStyleIfEquals(
  settingsFile: string,
  name: string
): Promise<boolean> {
  try {
    const current = await readDefaultOutputStyle(settingsFile);
    if (current !== name) return false;
    const settings = await readSettings(settingsFile);
    if (settings === null) return false;
    // #2624 (B): when the effective default resolves from the federationSettings
    // block, resetting A's local key cannot degrade it — report "no reset"
    // (truthful `defaultReset: false` to the UI) and let D's spawn-time
    // fail-open cover the missing style. Degrading the federation-GLOBAL on a
    // LOCAL file delete would be wrong the other way: peers may still have the
    // style. Known E/B interplay limitation — documented in the #2624 PR notes.
    const blockParsed = FederationSettingsBlockSchema.safeParse(
      (settings as Settings & Record<string, unknown>).federationSettings ?? {}
    );
    if (
      blockParsed.success &&
      resolveEffective(blockParsed.data, "defaultOutputStyle") !== undefined
    ) {
      return false;
    }
    (
      settings as Settings & Record<string, unknown>
    ).defaultOutputStylePreference = { style: DEFAULT_OUTPUT_STYLE_DEFAULT };
    await writeSettings(settingsFile, settings);
    return true;
  } catch {
    return false;
  }
}
