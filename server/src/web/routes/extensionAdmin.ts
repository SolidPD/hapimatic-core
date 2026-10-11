// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { z } from "zod";
import { defineCapability } from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";

import { extensionsMetadata } from "@hapi/protocol/extensionsMetadata";
import type { ExtensionMetadata, ExtensionSummary } from "@hapi/protocol/ext";

import type { WebAppEnv } from "../middleware/auth";
import type { Store } from "../../store";

/**
 * Extension control plane — the AUTHENTICATED read + mutate surface (issue #2329,
 * Sub-Issue D of epic #2325). Backs the Admin → Extensions page.
 *
 * ## 🔴 Auth comes from the MOUNT POSITION — do not add an inline middleware
 *
 * This factory takes NO `jwtSecret` on purpose. It is mounted in
 * `web/server.ts` AFTER the global `app.use("/api/*", createAuthMiddleware(...))`
 * gate, so every route here is JWT-gated positionally. Hono matches handlers in
 * REGISTRATION order, which is the whole mechanism:
 *
 *   - `createExtensionPrefsRoutes` is registered BEFORE the gate → its `GET
 *     /extension-prefs` answers pre-auth (deliberate; locked contract §5a — the
 *     Telegram Mini App, #1283, must resolve enablement before login).
 *   - THIS factory is registered AFTER the gate → the gate runs first.
 *
 * The mutation deliberately lives here and NOT in `./extensionPrefs` for exactly
 * that reason: a `PUT` added to that pre-auth factory would inherit its
 * registration position and become reachable UNAUTHENTICATED. That is the
 * primary failure mode issue #2329 exists to avoid, and it is easy to walk into
 * because a `PUT` to that path returns 401 *today* — not because the route is
 * protected, but because no handler matches and the request falls through to the
 * global gate.
 *
 * `health.ts` shows the alternative (an inline `app.use(path, createAuthMiddleware(...))`
 * inside a pre-auth-mounted factory). That works, but only while the middleware
 * stays registered before the handler — protection by convention rather than by
 * construction. Mount position is the stronger guarantee.
 *
 * **If you move this mount above the global gate, `extensionAdmin.test.ts`'s
 * auth-differential test fails.** That test is the regression guard.
 */

/** `PUT /extension-prefs/:id` request body. */
const ExtensionPrefUpdateSchema = z.object({
  enabled: z.boolean(),
});

/** Index the generated metadata registry by id for O(1) lookup. */
const METADATA_BY_ID: ReadonlyMap<string, ExtensionMetadata> = new Map(
  extensionsMetadata.map(entry => [entry.id, entry])
);

/**
 * Explicit CLI-extension-id → harness-descriptor-id map (issue #3313, ruling
 * D4(a)). The extension ids are `builtin.agent-<flavor>`; the harness-update
 * registry (`server/src/harness/registry.ts`) keys claude's descriptor as
 * `claude-code` (NOT bare `claude`) and the rest as the bare flavor. An entry
 * here lets `toSummary` read that extension's PROBED installed version out of
 * the #1769 detection store (`store.harness.getDetectionState`).
 *
 * Deliberately EXPLICIT (not a `.replace("builtin.agent-", "")` derivation) so
 * the `claude` → `claude-code` exception is visible and a typo can't silently
 * miss. The `builtin.agent-claude` / `builtin.agent-opencode` rows are
 * forward-compatible: those extension ids do not exist in the generated
 * registry today (Claude is the core backend, not a composable extension; the
 * opencode agent extension is still landing), so they are inert until such an
 * extension is composed in — at which point it maps to the right descriptor
 * with no further change. Catalog CLIs (`catalog.harness-*`) are ABSENT by
 * design: they get no descriptor in this issue, so `probedVersion` stays null
 * and the page renders the honest "unprobed" fallback (R3, ruling D5).
 */
const EXTENSION_TO_HARNESS_ID: Readonly<Record<string, string>> = {
  "builtin.agent-claude": "claude-code",
  "builtin.agent-codex": "codex",
  "builtin.agent-gemini": "gemini",
  "builtin.agent-opencode": "opencode",
};

/**
 * Resolve one extension's EFFECTIVE enable state + its probed CLI version.
 *
 * A `requiredAtBuild` extension reports `enabled: true` regardless of any
 * persisted row, because every loader short-circuits its enable check on that
 * flag (`server/src/ext/loader.ts`, `web/src/ext/loader.ts`,
 * `cli/src/ext/loader.ts`). Reporting the row value instead would render a lie in
 * the UI — an extension shown "off" that is in fact loaded on every boot.
 *
 * `probedVersion` (issue #3313): for a CLI extension whose id maps to a harness
 * descriptor, the installed-binary version persisted by the #1769 poll, keyed by
 * `nodeId` (the SAME `federationConfig?.nodeId ?? "standalone"` the poll writes
 * under). `null` for every non-mapped extension (no descriptor) or when
 * detection has not yet succeeded. The wrapper manifest `version` is UNCHANGED.
 */
function toSummary(
  meta: ExtensionMetadata,
  store: Store,
  nodeId: string
): ExtensionSummary {
  const row = store.extensionPrefs.getOrNull(meta.id);
  const harnessId = EXTENSION_TO_HARNESS_ID[meta.id];
  const probedVersion = harnessId
    ? (store.harness.getDetectionState(nodeId, harnessId)?.installed_version ??
      null)
    : null;
  return {
    ...meta,
    enabled: meta.requiredAtBuild
      ? true
      : (row?.enabled ?? meta.defaultEnabled),
    hasExplicitPref: row !== null,
    probedVersion,
  };
}

export function createExtensionAdminRoutes(
  store: Store,
  nodeId: string
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  /**
   * `GET /extension-registry` — every extension composed into this build, with
   * its metadata and effective enable state.
   *
   * Distinct from the pre-auth `GET /api/extension-prefs`, which is driven by the
   * SERVER registry alone and so cannot see web-only (`builtin.analytics`,
   * `builtin.error-log-viewer`, `builtin.tool-views`) or CLI-only
   * (`builtin.agent-codex`, `builtin.agent-gemini`) extensions, carries no
   * `requiredAtBuild` flag, and echoes orphan rows for de-registered extensions.
   * This route is registry-driven, so an orphan row (e.g. `builtin.session-notes`
   * after #2328 removed it from `extensions.config.ts`) never appears.
   */
  app.get(
    "/extension-registry",
    cataloged(
      defineCapability({
        id: "harness-admin.extension-registry",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Return the extension registry (available + installed extensions with prefs).",
        whenToUse: "When the operator opens the extensions admin page.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/extension-registry",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "operator" },
      })
    ),
    c => {
      const result: ExtensionSummary[] = extensionsMetadata.map(meta =>
        toSummary(meta, store, nodeId)
      );
      return c.json(result);
    }
  );

  /**
   * `PUT /extension-prefs/:id` — set one extension's enable state.
   *
   * Writes through the EXISTING `ExtensionPrefsStore.set()` upsert; no new
   * storage layer. `config` is omitted from the write so an existing row's config
   * survives (see that method's field semantics: omitted ≠ explicit null).
   *
   * A `requiredAtBuild` extension is REJECTED with 409 rather than persisted: the
   * loaders short-circuit on that flag, so an `enabled: false` row for one would
   * be durable state with no effect — the "silently failing to toggle" case.
   */
  app.put(
    "/extension-prefs/:id",
    cataloged(
      defineCapability({
        id: "harness-admin.set-extension-prefs",
        domain: "harness-admin",
        surface: "rest",
        description: "Set the admin preferences for one extension by id.",
        whenToUse: "When the operator changes an extension's admin settings.",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/api/extension-prefs/:id",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      const id = c.req.param("id");

      const meta = METADATA_BY_ID.get(id);
      if (!meta) {
        return c.json(
          { error: "Unknown extension", id, code: "unknown_extension" },
          404
        );
      }

      if (meta.requiredAtBuild) {
        return c.json(
          {
            error:
              "Extension is required at build time and cannot be enabled or disabled",
            id,
            code: "required_at_build",
          },
          409
        );
      }

      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        return c.json(
          { error: "Invalid request", details: "Body is not valid JSON" },
          400
        );
      }

      const parsed = ExtensionPrefUpdateSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json(
          { error: "Invalid request", details: parsed.error.issues },
          400
        );
      }

      // Omit `config` so the existing row's config column is preserved.
      store.extensionPrefs.set(id, { enabled: parsed.data.enabled });

      return c.json(toSummary(meta, store, nodeId));
    }
  );

  return app;
}
