import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
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

export default defineConfig({
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
});
