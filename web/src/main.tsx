// SPDX-License-Identifier: AGPL-3.0-only
import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import "./index.css";
import {
  getTelegramWebApp,
  isTelegramEnvironment,
  loadTelegramSdk,
} from "./hooks/useTelegram";
import { queryClient } from "./lib/query-client";
import { createAppRouter } from "./router";
import { errorReporter } from "./lib/error-reporter";
import { reloadWhenVisible } from "./lib/safe-reload";
import { registerServiceWorker } from "./lib/sw-update";
import { getLastRoute, saveLastRoute } from "./lib/route-persistence";
import { SplitViewProvider } from "./lib/split-view-context";
import { ThemeProvider } from "./design/ThemeProvider";
import { ThemePersistenceBridge } from "./design/ThemePersistenceBridge";
import { getStoredThemeId } from "./design/themePersistence";

declare global {
  interface Window {
    // Issue #1793: set true immediately after React's initial render() so the
    // bootstrap-independent mount-failure detector in index.html can cancel its
    // beacon/self-heal. `undefined` (never set) = React never mounted.
    __hapiReactMounted?: boolean;
  }
}

// Issue #1793 (R3): sessionStorage one-shot flag so a persistently-bad chunk
// cannot infinite-loop the recovery reload. Cleared on a successful mount.
const CHUNK_RELOAD_FLAG = "hapi:chunk-reload-once";

function getStartParam(): string | null {
  const query = new URLSearchParams(window.location.search);
  const fromQuery = query.get("startapp") || query.get("tgWebAppStartParam");
  if (fromQuery) return fromQuery;

  return getTelegramWebApp()?.initDataUnsafe?.start_param ?? null;
}

function getDeepLinkedSessionId(): string | null {
  const startParam = getStartParam();
  if (startParam?.startsWith("session_")) {
    return startParam.slice("session_".length);
  }
  return null;
}

function getInitialPath(): string {
  const sessionId = getDeepLinkedSessionId();
  return sessionId ? `/sessions/${sessionId}` : "/sessions";
}

async function bootstrap() {
  // Only load Telegram SDK in Telegram environment (with 3s timeout)
  const isTelegram = isTelegramEnvironment();
  if (isTelegram) {
    await loadTelegramSdk();
  }

  // Issue #1793 (R1/R2/R8): manual SW registration — virtual:pwa-register is
  // deliberately NOT imported. The plugin's prompt-mode registerSW() attaches a
  // closure-private, unconditional controllerchange→location.reload() on the
  // `waiting` event that would preempt the visibility-guarded reload (R2).
  // registerServiceWorker() owns the ENTIRE detect→prompt→activate→reload
  // chain through reloadWhenVisible; the single UpdateAvailableBadge update bar
  // (#3057) surfaces the non-blocking "tap to reload". (vite.config.ts
  // injectRegister:false keeps the plugin from injecting its own registration
  // script.)
  registerServiceWorker();

  // Global error handlers — report uncaught errors to server.
  // Using addEventListener (not assignment to window.onerror) so we coexist
  // with Sentry's global handlers installed via initSentry() — assignment
  // would overwrite them. Issue #1225 in-path bug fix.
  window.addEventListener("error", (event: ErrorEvent) => {
    errorReporter.report({
      message:
        typeof event.message === "string" ? event.message : "Unknown error",
      stack:
        event.error?.stack ??
        `${event.filename}:${event.lineno}:${event.colno}`,
      category: "uncaught-error",
      severity: "error",
    });
  });

  window.addEventListener(
    "unhandledrejection",
    (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      errorReporter.report({
        message:
          reason instanceof Error
            ? reason.message
            : String(reason ?? "Unhandled rejection"),
        stack: reason instanceof Error ? (reason.stack ?? null) : null,
        category: "unhandled-rejection",
        severity: "error",
      });
    }
  );

  // Route restoration priority chain:
  // 1. Telegram deep link (memory history) — highest priority
  // 2. Direct URL (pathname !== "/") — user typed or bookmarked a URL
  // 3. Saved route from localStorage — iOS PWA cold-start recovery
  // 4. Default "/" → redirects to /sessions via router
  if (!isTelegram && window.location.pathname === "/") {
    const savedRoute = getLastRoute();
    if (savedRoute) {
      window.history.replaceState(null, "", savedRoute);
    }
  }

  const history = isTelegram
    ? createMemoryHistory({ initialEntries: [getInitialPath()] })
    : undefined;
  const router = createAppRouter(history);

  // Initialize Sentry with TanStack Router integration (before render).
  // Issue #1793 (R3): Sentry is NON-ESSENTIAL and must never block React mount.
  // A hashed sentry-<hash>.js chunk that 404s after a deploy would otherwise
  // reject bootstrap() → React never mounts → bare `#1E0A3E` shell. try/catch →
  // beacon → fall through to render().
  try {
    const { initSentry } = await import("./sentry");
    initSentry(router);
  } catch (err) {
    errorReporter.report({
      message: `Sentry bootstrap import failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
      category: "chunk-load-error",
      severity: "error",
      context: "sentry-import",
    });
  }

  // Save current route on every navigation for iOS PWA cold-start recovery
  if (!isTelegram) {
    router.subscribe("onResolved", () => {
      saveLastRoute(router.state.location.pathname);
    });
  }

  // C3 (#1988): read the persisted theme id synchronously at bootstrap (mirrors the
  // getLastRoute() read above) so C1's ThemeProvider applies it via useLayoutEffect
  // BEFORE the first paint — no flash of the default mint theme. `undefined` (no
  // stored choice / storage unavailable) makes C1 fall back to DEFAULT_THEME_ID.
  const initialThemeId = getStoredThemeId();

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        {/* Runtime theme engine (#1986, C1) wraps the router so the whole app —
            the login screen and C2's future picker included — re-themes from one
            source. C3 (#1988) feeds the persisted initialThemeId (applied pre-paint)
            and mounts ThemePersistenceBridge to persist on every change. */}
        <ThemeProvider initialThemeId={initialThemeId}>
          {/* Persist-on-change bridge (C3 #1988): consumes useThemeSelection and
              writes activeThemeId to localStorage; renders nothing (R5 — no change to
              C1's provider). */}
          <ThemePersistenceBridge />
          {/* Split-view state is lifted into one shared instance above the router
              (#1043) so the top-bar SplitScreen toggle (in App/BrandedFrame) and the
              session-list panes (child routes) share a single source of truth. */}
          <SplitViewProvider>
            <RouterProvider router={router} />
          </SplitViewProvider>
        </ThemeProvider>
        {import.meta.env.DEV ? (
          <ReactQueryDevtools initialIsOpen={false} />
        ) : null}
      </QueryClientProvider>
    </React.StrictMode>
  );

  // Issue #1793 (R3/R5c): signal a successful React render so the index.html
  // bootstrap-independent mount-failure detector cancels its beacon/self-heal,
  // and reset the chunk-load one-shot reload guard now that we booted cleanly.
  window.__hapiReactMounted = true;
  try {
    sessionStorage.removeItem(CHUNK_RELOAD_FLAG);
  } catch {
    // sessionStorage unavailable — nothing to reset.
  }
}

/**
 * Load enabled web extensions BEFORE bootstrap() (issue #1270, Sub-Issue F,
 * locked §5h). Resolves enablement from F's pre-auth GET /api/extension-prefs and
 * populates the web extension host, so extension contributions are in place
 * before the app boots (before isTelegramEnvironment(), which #1283 depends on).
 * The empty registry makes this a no-op. Uses dynamic imports so the loader
 * plumbing stays out of the very first main.tsx chunk.
 */
async function loadExtensionsBeforeBootstrap(): Promise<void> {
  const { webExtensionHost } = await import("./ext/host");
  const { loadWebExtensions } = await import("./ext/loader");

  // Build the enable-state Map from RAW rows — an explicit `false` must survive
  // and not be masked by the manifest default (locked §5d). A failed fetch →
  // empty Map → every extension falls back to manifest.defaultEnabled.
  let enableState: ReadonlyMap<string, boolean> = new Map();
  try {
    const resp = await fetch("/api/extension-prefs");
    if (resp.ok) {
      const prefs = (await resp.json()) as { id: string; enabled: boolean }[];
      enableState = new Map(prefs.map(p => [p.id, p.enabled]));
    }
  } catch (err) {
    console.warn("[ext:loader] Failed to fetch extension_prefs:", err);
  }

  await loadWebExtensions(webExtensionHost, { enableState });

  // #1294: runtime FILESYSTEM web extensions — discovered via the server's
  // GET /api/ext-web-manifests, dynamic-imported from /ext-assets/<id>/dist/,
  // and registered into the SAME webExtensionHost. Inert unless
  // HAPI_FS_EXTENSIONS is on (discovery returns []); fail-soft inside the loader,
  // so a broken runtime extension never blocks bootstrap().
  const { loadRuntimeWebExtensions } = await import("./ext/runtimeLoader");
  await loadRuntimeWebExtensions(webExtensionHost);
}

/**
 * Issue #1793 (R3): a failed dynamic import (an evicted chunk after a deploy)
 * must never strand the PWA on the bare `#1E0A3E` shell. Register the recovery
 * handler BEFORE any dynamic import runs (the extension loaders, the Sentry
 * import, and lazy routes all use `import()`), then perform at most ONE clean
 * reload — visibility-guarded (R2, via reloadWhenVisible) and one-shot-guarded
 * via sessionStorage so a persistently-bad chunk cannot infinite-loop.
 */
function installChunkLoadRecovery(): void {
  window.addEventListener("vite:preloadError", event => {
    event.preventDefault();
    errorReporter.report({
      message: "Dynamic import (chunk) failed to load",
      category: "chunk-load-error",
      severity: "error",
      context: "vite:preloadError",
    });
    let alreadyReloaded = false;
    try {
      alreadyReloaded = sessionStorage.getItem(CHUNK_RELOAD_FLAG) !== null;
      if (!alreadyReloaded) sessionStorage.setItem(CHUNK_RELOAD_FLAG, "1");
    } catch {
      // sessionStorage unavailable — best-effort: reload once anyway (the
      // visibility gate still applies; only the loop guard is lost).
    }
    if (!alreadyReloaded) {
      reloadWhenVisible("chunk-load");
    }
  });
}

async function main() {
  installChunkLoadRecovery();

  // Extension pre-load is NON-ESSENTIAL to the core app mount. A failed
  // ext-loader chunk import (evicted after a deploy) must not block bootstrap()
  // → React must still mount (R3). The vite:preloadError handler above also
  // fires for it (beacon + one guarded reload).
  try {
    await loadExtensionsBeforeBootstrap();
  } catch (err) {
    console.error("Extension pre-load failed; continuing to bootstrap:", err);
  }

  await bootstrap();
}

main().catch(err => {
  // Last-resort: bootstrap() itself rejected → React did not mount. The
  // bootstrap-independent detector in index.html (Task 6) owns the telemetry for
  // this path, since errorReporter is not yet initialized pre-mount.
  console.error("Fatal bootstrap failure:", err);
});
