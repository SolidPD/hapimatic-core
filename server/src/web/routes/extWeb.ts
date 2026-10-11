// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { defineCapability } from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";
import type { Capability } from "@hapi/protocol/ext";

import { extensions } from "../../extensions.generated";
import { scanFilesystemWebExtensions } from "../../ext/fsWebLoader";
import type { Store } from "../../store";

/** One entry of the `GET /api/ext-web-manifests` payload. */
export interface ExtWebManifestEntry {
  id: string;
  /** Relative path (under `dist/`) to the web ESM entry point. */
  webEntry: string;
  /** Relative stylesheet paths (under `dist/`) for `<link>` injection. */
  styles: string[];
  /** Always `true` — disabled extensions are OMITTED from the payload (R4). */
  enabled: boolean;
  /**
   * Declared privileged capabilities (issue #1291, ADR-0003). The browser's
   * runtime web loader default-deny gates this untrusted extension against them.
   */
  capabilities: Capability[];
}

/**
 * `GET /api/ext-web-manifests` — runtime WEB-extension discovery (issue #1294,
 * epic #1264 Phase 2). The browser cannot scan the filesystem, and the existing
 * `GET /api/extension-prefs` is driven by the BUILD-TIME `extensions.generated`
 * registry — so it never lists filesystem extensions. This route is the web
 * analogue of the server-side `scanFilesystemExtensions`: it enumerates the
 * filesystem extensions declaring a `web` entry and ships the ones the browser
 * should load.
 *
 * Gated behind `HAPI_FS_EXTENSIONS` (via `opts.fsEnabled`): with the flag OFF
 * (default) it returns `[]`, so the web runtime loader is inert and behavior is
 * byte-identical to today (R6). With the flag ON, it resolves each extension's
 * effective enable state via `store.extensionPrefs.get(id, defaultEnabled)` and
 * OMITS disabled extensions (R4) — a disabled extension's id and bundle path
 * never leave the server.
 *
 * Mounted PRE-AUTH (mirrors `GET /api/extension-prefs`): the payload is a
 * low-sensitivity id/path/styles list, and the web loader runs before login.
 * This route is READ-ONLY.
 *
 * 🔴 DO NOT ADD A MUTATION ROUTE TO THIS FACTORY — same reasoning as its sibling
 * `./extensionPrefs`: Hono matches handlers in REGISTRATION order, and this
 * factory is mounted before the global JWT gate in `web/server.ts`, so a handler
 * added here would answer UNAUTHENTICATED. Enable/disable writes live in
 * `./extensionAdmin` (`PUT /api/extension-prefs/:id`, issue #2329), mounted after
 * the gate.
 */
export function createExtWebRoutes(
  store: Store,
  opts: { extensionsDir: string; fsEnabled: boolean }
): Hono {
  const app = new Hono();

  app.get(
    "/ext-web-manifests",
    cataloged(
      defineCapability({
        id: "harness-admin.ext-web-manifests",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Return the web manifests for enabled extensions (public, read-only).",
        whenToUse: "When the web client loads extension web bundles.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/ext-web-manifests",
        },
        auth: "none",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    c => {
      if (!opts.fsEnabled) {
        return c.json([] as ExtWebManifestEntry[]);
      }

      // Seed the builtin-id guard from the build-time registry so a filesystem
      // extension cannot shadow a compiled builtin in the browser.
      const builtinIds = new Set(extensions.map(e => e.manifest.id));
      const discovered = scanFilesystemWebExtensions(
        opts.extensionsDir,
        builtinIds
      );

      const result: ExtWebManifestEntry[] = [];
      for (const info of discovered) {
        const enabled = store.extensionPrefs.get(
          info.id,
          info.defaultEnabled
        ).enabled;
        if (!enabled) continue; // R4: omit disabled — never disclose its path
        result.push({
          id: info.id,
          webEntry: info.webEntry,
          styles: info.styles,
          enabled: true,
          capabilities: info.capabilities,
        });
      }

      return c.json(result);
    }
  );

  return app;
}
