import { defineConfig, type Plugin, type UserConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const base = process.env.VITE_BASE_URL || "/";
// Dev instance uses icons with red DEV badge, production uses clean icons
const isDev = process.env.VITE_INSTANCE_TYPE === "dev";

// Sentry source map upload: load conditionally to avoid build failures
// when @sentry/vite-plugin or its transitive deps have broken installs.
let sentryPlugin: Plugin | null = null;
if (process.env.SENTRY_AUTH_TOKEN && !isDev) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { sentryVitePlugin } = require("@sentry/vite-plugin");
    sentryPlugin = sentryVitePlugin({
      org: "solid-product-design",
      project: "hapimatic-web",
      authToken: process.env.SENTRY_AUTH_TOKEN,
      sourcemaps: {
        filesToDeleteAfterUpload: ["./dist/**/*.map"],
      },
    });
  } catch {
    console.warn(
      "[Sentry] @sentry/vite-plugin not available — skipping source map upload"
    );
  }
}
// The built manifest is the production identity: one web build is embedded in
// the binary that every instance runs, and nothing sets VITE_INSTANCE_TYPE. The
// server rewrites the manifest per request for the dev instance
// (server/src/web/instanceManifest.ts, #4797).
const iconsPath = isDev ? "icons" : "icons-production";
const appName = isDev ? "Hapimatic DEV" : "Hapimatic";

/**
 * The version the bundle embeds as `__APP_VERSION__` (#3491) — the `VERSION` in
 * `server/src/version.generated.ts`, which is what `/api/version` serves.
 * Never `web/package.json` (`0.1.0`): the client and server must share the
 * `1.0.xxxx` scheme or every client reads as out of date. The release build
 * (`build:single-exe:all`) never regenerates that file, so it is the one
 * version both sides share at build time.
 */
function readAppVersion(): string {
  const generated = readFileSync(
    resolve(__dirname, "../server/src/version.generated.ts"),
    "utf-8"
  );
  const match = generated.match(/export const VERSION = '([^']+)'/);
  if (!match) {
    throw new Error(
      "[app-version] server/src/version.generated.ts has no VERSION literal"
    );
  }
  return match[1];
}

/**
 * A production build refuses a version.generated.ts that disagrees with the
 * root package.json (the #1375/#3444 desync): `build:single-exe` regenerates the
 * file AFTER building the web, so its server would report the package.json
 * version while this bundle embedded the stale one, and every browser would show
 * a false "client X · server Y". The dev server only warns.
 */
function checkAppVersionParity(version: string, failOnMismatch: boolean): void {
  const rootPackage = JSON.parse(
    readFileSync(resolve(__dirname, "../package.json"), "utf-8")
  ) as { version?: string };
  if (rootPackage.version === version) return;
  const message =
    `[app-version] server/src/version.generated.ts says ${version} but ` +
    `package.json says ${rootPackage.version}. Run ` +
    "`bun run server/scripts/generate-version-info.ts` (or a version:* script).";
  if (failOnMismatch) throw new Error(message);
  console.warn(message);
}

/** Everything but the per-build `define` (#3491). */
const sharedConfig: UserConfig = {
  server: {
    host: true,
    allowedHosts: ["hapidev.weishu.me"],
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3006",
        changeOrigin: true,
      },
      "/socket.io": {
        target: "http://127.0.0.1:3006",
        ws: true,
      },
    },
  },
  plugins: [
    react(),
    VitePWA({
      // Issue #1793: SW registration is fully MANUAL (lib/sw-update.ts
      // registerServiceWorker) — even prompt-mode virtual:pwa-register attaches
      // a closure-private, unconditional controllerchange→location.reload() on
      // the `waiting` event that would bypass the visibility-guarded reload
      // (R2). injectRegister:false stops the plugin from injecting its own
      // registration script now that main.tsx no longer imports the virtual
      // module (the "auto" default would re-introduce the unguarded listener).
      // This pairs with sw.ts no longer force-`skipWaiting`ing on install, so a
      // freshly-deployed SW parks in `waiting` and surfaces the user-controlled
      // "tap to reload" affordance (the single UpdateAvailableBadge update bar,
      // #3057) instead of silently reloading the frozen/resumed iOS PWA to a
      // blank shell.
      registerType: "prompt",
      injectRegister: false,
      includeAssets: [
        `${iconsPath}/favicon-32x32.png`,
        `${iconsPath}/apple-touch-icon-180x180.png`,
        "mask-icon.svg",
      ],
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      manifest: {
        name: appName,
        short_name: appName,
        description: "Matt's AI-powered development assistant",
        theme_color: "#1E0A3E",
        background_color: "#1E0A3E",
        display: "standalone",
        orientation: "portrait",
        scope: base,
        start_url: base,
        icons: [
          {
            src: `${iconsPath}/pwa-64x64.png`,
            sizes: "64x64",
            type: "image/png",
          },
          {
            src: `${iconsPath}/pwa-192x192.png`,
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: `${iconsPath}/pwa-512x512.png`,
            sizes: "512x512",
            type: "image/png",
          },
          {
            src: `${iconsPath}/maskable-icon-512x512.png`,
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff,woff2}"],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024, // 4 MiB — main bundle crossed 3 MiB by ~1 KB (broke injectManifest at #1079 close); code-splitting is the real fix (follow-up)
      },
      devOptions: {
        enabled: true,
        type: "module",
      },
    }),
    // Sentry source map upload — MUST be last plugin per Sentry docs.
    // Loaded conditionally above to handle broken transitive deps in Bun.
    ...(sentryPlugin ? [sentryPlugin] : []),
  ],
  base,
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // #1162: emit sourcemaps only when the Sentry plugin will load to clean
    // them up. Mirrors the plugin gate at line 13 exactly. Without this,
    // builds without SENTRY_AUTH_TOKEN (or with VITE_INSTANCE_TYPE=dev) leak
    // .map files into web/dist/ → embedded into the single-exe binary →
    // served as /assets/*.map HTTP responses to end users.
    sourcemap: !!process.env.SENTRY_AUTH_TOKEN && !isDev,
  },
};

export default defineConfig(({ command }) => {
  const appVersion = readAppVersion();
  checkAppVersionParity(appVersion, command === "build");
  return {
    ...sharedConfig,
    // #3491: the bundle's own version, so the footer and the update flow can tell
    // a stale precached bundle from the server it talks to. Mirrored in
    // vitest.config.ts; read through getClientVersion() (@/lib/app-version).
    define: {
      __APP_VERSION__: JSON.stringify(appVersion),
    },
  };
});
