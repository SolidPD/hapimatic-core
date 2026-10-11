// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

import { Hono } from "hono";
import { defineCapability } from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";

/**
 * MIME map for runtime-served extension bundle assets. `.js`/`.mjs` MUST be
 * `text/javascript` for a browser ESM `import()` to accept the module (a wrong
 * type — e.g. the SPA fallback's `text/html` — hard-fails the import).
 */
const EXT_ASSET_MIME: Record<string, string> = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".map": "application/json",
  ".json": "application/json",
};

/** Safe extension-id shape (dir name segment) — no path separators or `..`. */
const SAFE_ID = /^[a-zA-Z0-9._-]+$/;

/**
 * `GET /ext-assets/<id>/*` — serve a runtime filesystem extension's built
 * bundle assets from `<extensionsDir>/<id>/dist/` (issue #1294, epic #1264
 * Phase 2). This is the HTTP surface the browser dynamic-imports each web
 * extension entry from — a Vite-ignored runtime-URL import of
 * `/ext-assets/<id>/dist/<entry>` (see `web/src/ext/runtimeLoader.ts`).
 *
 * Mounted OUTSIDE `/api`, so it is NOT behind the JWT middleware (which is
 * `/api/*`-scoped) — bundles are publicly fetchable like the app's own
 * `/assets/*`. That is the intended v0.1 posture (trusted/`builtin.*` +
 * Tailscale exposure); a stricter gate would need a per-route check here.
 *
 * 🔴 MOUNT ORDER (load-bearing): this route MUST be registered in `createWebApp`
 * BEFORE the `if (options.embeddedAssetMap)` compiled branch (which `return`s the
 * app) — otherwise a compiled binary never reaches it and serves `index.html`
 * for `/ext-assets/*` URLs. See the mount site in `server.ts`.
 *
 * Guarantees (R1):
 * - correct `Content-Type` per file extension;
 * - path-traversal rejection (403) via an id allowlist + a resolved-path
 *   containment check against `<extensionsDir>/<id>/dist/`;
 * - explicit `404` for a missing file — NEVER a fall-through to the SPA
 *   `index.html` catch-all (which answers `200 text/html` and would corrupt the
 *   `import()` with a MIME mismatch, R17).
 *
 * Gated behind `HAPI_FS_EXTENSIONS` (`opts.fsEnabled`): with the flag OFF the
 * route 404s everything, so it is inert and behavior is byte-identical to today
 * (R6).
 */
export function createExtAssetsRoutes(opts: {
  extensionsDir: string;
  fsEnabled: boolean;
}): Hono {
  const app = new Hono();

  app.get(
    "/ext-assets/*",
    cataloged(
      defineCapability({
        id: "harness-admin.ext-assets",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Serve a static asset for an enabled extension by path (public, binary).",
        whenToUse: "When the browser fetches an extension's asset.",
        invocation: { kind: "rest", method: "GET", path: "/ext-assets/*" },
        auth: "none",
        riskTier: "readonly",
        availability: { scope: "user" },
        probe: "skip",
      })
    ),
    c => {
      if (!opts.fsEnabled) {
        return c.text("Not found", 404);
      }

      // Path shape: /ext-assets/<id>/<subpath...>. Parse the id (first segment
      // after the prefix) and the remaining subpath manually — robust across
      // Hono wildcard-param quirks.
      const rest = decodeURIComponent(c.req.path).replace(
        /^\/ext-assets\//,
        ""
      );
      const slash = rest.indexOf("/");
      if (slash <= 0) {
        return c.text("Not found", 404);
      }
      const id = rest.slice(0, slash);
      const subpath = rest.slice(slash + 1);

      // Id guard: reject anything that could escape the per-extension dir (an id
      // of `..` would otherwise relocate distRoot and pass its own containment
      // check — guard BOTH the id and the resolved path).
      if (!SAFE_ID.test(id) || id === "." || id === "..") {
        return c.text("Forbidden", 403);
      }

      // The URL subpath already includes the leading `dist/` segment
      // (`/ext-assets/<id>/dist/<file>`), so resolve from the extension ROOT and
      // constrain the result to that extension's `dist/` dir. This double role of
      // the guard also blocks requests for `manifest.json` or any sibling file
      // that lives OUTSIDE `dist/`.
      const extRoot = resolve(opts.extensionsDir, id);
      const distRoot = resolve(extRoot, "dist");
      const target = resolve(extRoot, subpath);

      // Containment check: the resolved target MUST stay under `<...>/<id>/dist/`.
      if (target !== distRoot && !target.startsWith(distRoot + sep)) {
        return c.text("Forbidden", 403);
      }

      if (!existsSync(target) || !statSync(target).isFile()) {
        // Explicit 404 — do NOT fall through to the SPA index.html catch-all (R17).
        return c.text("Not found", 404);
      }

      const dot = target.lastIndexOf(".");
      const ext = dot >= 0 ? target.slice(dot) : "";
      const mime = EXT_ASSET_MIME[ext] ?? "application/octet-stream";
      const body = readFileSync(target);
      return new Response(body, { headers: { "Content-Type": mime } });
    }
  );

  return app;
}
