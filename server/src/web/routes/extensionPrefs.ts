// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { defineCapability } from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";

import { extensions } from "../../extensions.generated";
import type { Store } from "../../store";

/** One entry of the `GET /api/extension-prefs` payload. */
export interface ExtensionPrefEntry {
  id: string;
  enabled: boolean;
}

/**
 * `GET /api/extension-prefs` — read-only extension enable-state (Sub-Issue F of
 * epic #1264, locked contract §5a). F owns this route because E ships no HTTP
 * surface (locked §4).
 *
 * The payload is built from the RAW `extension_prefs` rows (so an explicit
 * `enabled: false` survives — locked §5d) merged with defaults for every
 * configured extension that has no row (resolved via `manifest.defaultEnabled`).
 * The web loader (`web/src/ext/loader.ts`) builds a `Map<string, boolean>` from
 * this list to decide which extensions to load.
 *
 * Mounted PRE-AUTH (locked §5a): the payload is a low-sensitivity id+enabled
 * list, and the Telegram Mini App (#1283) must resolve enablement BEFORE the
 * login flow. This route remains READ-ONLY and pre-auth.
 *
 * 🔴 DO NOT ADD A MUTATION ROUTE TO THIS FACTORY. Hono matches handlers in
 * REGISTRATION order, and this factory is mounted in `web/server.ts` BEFORE the
 * global `app.use("/api/*", createAuthMiddleware(...))` gate — so any handler
 * added here answers BEFORE that gate runs and is reachable UNAUTHENTICATED. The
 * trap is easy to miss because a `PUT` to this path returns 401 today: not
 * because the route is protected, but because no handler matches and the request
 * falls through to the global gate.
 *
 * Enable/disable writes therefore live in `./extensionAdmin`
 * (`createExtensionAdminRoutes`, issue #2329), mounted AFTER the gate:
 *   - `GET  /api/extension-registry`   — all runtimes' extensions + metadata
 *   - `PUT  /api/extension-prefs/:id`  — set one extension's enable state
 *
 * (History: epic #1264's locked contract §5a originally recorded "There is NO
 * mutation surface — enable/disable writes stay on E's server-side store API."
 * Issue #2329 deliberately reversed that to give the browser a control plane; the
 * pre-auth read posture of THIS route is unchanged.)
 */
export function createExtensionPrefsRoutes(store: Store): Hono {
  const app = new Hono();

  app.get(
    "/extension-prefs",
    cataloged(
      defineCapability({
        id: "harness-admin.get-extension-prefs",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Read the low-sensitivity extension enable-state map (public, read-only, pre-auth).",
        whenToUse:
          "When the login flow needs the enabled-extension set before auth.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/extension-prefs",
        },
        auth: "none",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    c => {
      const rows = store.extensionPrefs.list();
      const seen = new Set(rows.map(row => row.id));
      const result: ExtensionPrefEntry[] = rows.map(row => ({
        id: row.id,
        enabled: row.enabled,
      }));

      // Configured extensions without an explicit row resolve to their manifest
      // default. (Empty registry → nothing to add → `result` is just the rows.)
      for (const { manifest } of extensions) {
        if (!seen.has(manifest.id)) {
          result.push({ id: manifest.id, enabled: manifest.defaultEnabled });
        }
      }

      return c.json(result);
    }
  );

  return app;
}
