// SPDX-License-Identifier: AGPL-3.0-only
import { reloadWhenVisible } from "./safe-reload";
import { errorReporter } from "./error-reporter";
import { versionPairKey } from "./app-version";

/**
 * Service-worker registration + update coordination (issue #1793).
 *
 * This module owns the ENTIRE service-worker lifecycle chain: register →
 * detect waiting SW → latch "update available" → banner prompt →
 * SKIP_WAITING → controllerchange → visibility-guarded reload.
 *
 * Registration is MANUAL (navigator.serviceWorker.register) instead of
 * vite-plugin-pwa's virtual:pwa-register, because the plugin's prompt-mode
 * registerSW() attaches its own closure-private, UNCONDITIONAL
 * `controlling`→window.location.reload() listener the moment a waiting SW is
 * detected — on the `waiting` event, NOT inside updateSW(true) (verified in
 * vite-plugin-pwa@1.2.0 dist/client/build/register.js). That listener cannot
 * be removed (its workbox-window instance is closure-private) and would fire
 * before this module's guarded path, bypassing reloadWhenVisible (R2) —
 * exactly the unguarded-background-reload class this issue eliminates.
 * vite.config.ts sets `injectRegister: false` so the plugin cannot inject a
 * registration script behind our back either.
 *
 * Deliberately a standalone module — NOT main.tsx — so the banner can import
 * it without re-executing main.tsx's top-level `main()` bootstrap.
 */

const SW_UPDATE_EVENT = "hapi:swUpdateAvailable";

// R9 (mount-race latch): the "waiting SW" signal can fire ~one microtask after
// register(), while render() is gated behind `await import("./sentry")`
// (main.tsx). A CustomEvent is one-shot, so a banner that only subscribes in a
// useEffect would miss an event dispatched before it mounted. The banner
// therefore reads this latch on mount AND subscribes for later events.
let swUpdatePending = false;
let waitingRegistration: ServiceWorkerRegistration | null = null;
let activating = false;
let activationTimer: ReturnType<typeof setTimeout> | null = null;

// How long a Reload tap waits for SKIP_WAITING → controllerchange before the
// stall fallback releases the tap latch and reloads through the guarded path.
// Long enough for a healthy activate (measured ~100ms), short enough that a
// user who tapped sees SOMETHING happen.
const ACTIVATION_STALL_TIMEOUT_MS = 4000;

// R2 single-owner reload chain state. `hadController` distinguishes the
// first-install clients.claim() (no reload wanted — the page just loaded the
// freshest assets) from a genuine SW swap; `controllerReloadFired` makes the
// reload one-shot so a rapid double-activation cannot stack reloads.
let hadController = false;
let controllerReloadFired = false;
let registrationCleanup: (() => void) | null = null;

// #3491: client/server version pairs this page already reported, so a pair
// yields one telemetry row however often the engine re-renders.
const reportedVersionMismatches = new Set<string>();

/**
 * #3491 one-shot guard for the AUTOMATIC activation, keyed per tab and port
 * (sessionStorage dies with the tab, so a later genuine deploy is not
 * suppressed). It must survive the reload because every latch above is a module
 * `let` that the reload wipes: without it, an automatic trigger plus the
 * stall fallback below reloads every ~4 s whenever iOS drops SKIP_WAITING.
 */
const MISMATCH_AUTO_KEY = `hapi:mismatch-auto-attempted::${
  typeof window !== "undefined" ? window.location.origin : ""
}`;

/** True once a waiting SW has been detected (read by the update surfaces on mount). */
export function isSwUpdatePending(): boolean {
  return swUpdatePending;
}

/**
 * Idempotently ask the browser to check for a fresh service worker (issue #3057).
 * Wraps the stored registration's `update()`. The update reload engine calls this
 * after a pipeline apply reports the target server is healthy: the swap made the
 * server serve fresh static assets, so an explicit `update()` triggers the SW
 * machinery (updatefound → statechange:installed → markSwUpdateAvailable), whose
 * `waiting` latch then drives the guarded activation via {@link activateSwUpdate}.
 * After the app's Refresh button reloads the page, the reloaded page calls it
 * 3 s and 8 s after it mounts (#3277).
 * Best-effort — a missing registration or a rejected `update()` is swallowed; the
 * engine's activation timeout + the banner's manual reload retry cover that
 * failure (R5/R6/R8).
 * Post-reload there is no waiting SW to find, so this is a safe no-op (no reload
 * loop).
 */
export function requestSwUpdateCheck(): void {
  void waitingRegistration?.update().catch(() => {});
}

/**
 * Store the SW registration so `activateSwUpdate()` can reach
 * `registration.waiting`. Exported for tests; production assigns it from
 * `registerServiceWorker()`.
 */
export function setSwRegistration(reg: ServiceWorkerRegistration | null): void {
  if (reg) waitingRegistration = reg;
}

/**
 * Latch "an update is available" and notify any already-mounted banner.
 * Idempotent — one latch, one telemetry row, one event regardless of how many
 * times it fires.
 */
export function markSwUpdateAvailable(): void {
  if (swUpdatePending) return;
  swUpdatePending = true;

  // R5(a): an SW update became available — benign, so info severity (does not
  // inflate the error dashboards).
  errorReporter.report({
    message: "Service worker update available",
    category: "sw-update",
    severity: "info",
  });

  window.dispatchEvent(new CustomEvent(SW_UPDATE_EVENT));
}

/** Subscribe to later update-available events; returns an unsubscribe fn. */
export function onSwUpdateAvailable(listener: () => void): () => void {
  window.addEventListener(SW_UPDATE_EVENT, listener);
  return () => window.removeEventListener(SW_UPDATE_EVENT, listener);
}

/**
 * Register the service worker and wire the full update chain. Called once from
 * main.tsx bootstrap. Installs THE ONLY `controllerchange` listener in the app,
 * so every SW-driven reload flows through reloadWhenVisible (R2) — including
 * the cross-tab case: another tab activates the new SW while this one is
 * backgrounded → the reload here defers until this tab is next visible.
 */
export function registerServiceWorker(): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return;
  }
  const swContainer = navigator.serviceWorker;

  hadController = swContainer.controller !== null;

  const onControllerChange = () => {
    // Any controllerchange resolves an in-flight Reload tap — disarm its
    // stall fallback so the tap path cannot double-reload.
    if (activationTimer !== null) {
      clearTimeout(activationTimer);
      activationTimer = null;
    }
    if (!hadController) {
      hadController = true;
      // First install claiming the page (sw.ts activate → clients.claim()) —
      // no reload wanted — UNLESS the user explicitly tapped Reload: the
      // banner CAN show on an uncontrolled page (the reg.waiting launch
      // branch below never checks controller state, and iOS relaunches a
      // PWA uncontrolled after SW eviction), and swallowing that tap's
      // controllerchange left the button doing nothing.
      if (!activating) return;
    }
    if (controllerReloadFired) return;
    controllerReloadFired = true;
    reloadWhenVisible("sw-update");
  };
  swContainer.addEventListener("controllerchange", onControllerChange);

  // vite-plugin-pwa serves the dev-mode SW at a fixed virtual path under
  // `bun run dev`; the built worker is always /sw.js (injectManifest,
  // filename: "sw.ts").
  const swUrl = import.meta.env.DEV ? "/dev-sw.js?dev-sw" : "/sw.js";

  let activeReg: ServiceWorkerRegistration | null = null;
  let updateTimer: ReturnType<typeof setInterval> | null = null;

  // Resume is exactly when an iOS PWA is most likely to have missed a deploy
  // (#1793) — check for a fresh SW on every return to foreground, so the
  // banner surfaces promptly instead of waiting for the hourly timer.
  const onVisibleUpdateCheck = () => {
    if (document.visibilityState === "visible" && activeReg) {
      void activeReg.update().catch(() => {});
    }
  };

  const doRegister = () => {
    swContainer
      .register(swUrl, {
        scope: "/",
        type: import.meta.env.DEV ? "module" : "classic",
      })
      .then(reg => {
        activeReg = reg;
        setSwRegistration(reg);

        // R9 belt-and-suspenders: a waiting SW may already exist at launch
        // (installed on a previous visit).
        if (reg.waiting) {
          markSwUpdateAvailable();
        }

        const watchInstalling = (installing: ServiceWorker) => {
          installing.addEventListener("statechange", () => {
            if (installing.state !== "installed") return;
            if (swContainer.controller) {
              // An old SW controls the page → the new one parked in `waiting`.
              markSwUpdateAvailable();
            } else {
              console.log("App ready for offline use");
            }
          });
        };

        // #4924: a page that loads while a new worker is still installing (for
        // example the reload from a stalled update tap) has already missed that
        // worker's `updatefound`, so watch it directly. A duplicate listener is
        // harmless: markSwUpdateAvailable() is idempotent.
        if (reg.installing) watchInstalling(reg.installing);

        reg.addEventListener("updatefound", () => {
          const installing = reg.installing;
          if (installing) watchInstalling(installing);
        });

        updateTimer = setInterval(
          () => {
            void reg.update().catch(() => {});
          },
          60 * 60 * 1000
        );
        document.addEventListener("visibilitychange", onVisibleUpdateCheck);
      })
      .catch((error: unknown) => {
        console.error("SW registration error:", error);
      });
  };

  if (document.readyState === "complete") {
    doRegister();
  } else {
    window.addEventListener("load", doRegister, { once: true });
  }

  registrationCleanup = () => {
    swContainer.removeEventListener("controllerchange", onControllerChange);
    window.removeEventListener("load", doRegister);
    document.removeEventListener("visibilitychange", onVisibleUpdateCheck);
    if (updateTimer !== null) clearInterval(updateTimer);
  };
}

/**
 * The banner's "tap to reload" handler (R8). Posts SKIP_WAITING to the waiting
 * SW (sw.ts activates it); the resulting `controllerchange` is handled by
 * registerServiceWorker()'s single guarded listener → reloadWhenVisible. Edge
 * case: the waiting SW is already gone (e.g. another tab activated it while
 * this tab's guarded reload is still deferred) → reload directly through the
 * same guarded path.
 *
 * Stall fallback: if controllerchange has not arrived within
 * ACTIVATION_STALL_TIMEOUT_MS (iOS can silently drop the message to a
 * terminated waiting worker), release the tap latch and reload through the
 * guarded path — a fresh page re-offers the banner and a fresh tap retries
 * the whole chain. Without this, one dropped message latched `activating`
 * forever and every later tap was a silent no-op for the life of the page.
 */
export function activateSwUpdate(): void {
  if (activating) return;
  activating = true;

  const waiting = waitingRegistration?.waiting ?? null;
  if (!waiting) {
    reloadWhenVisible("sw-update");
    return;
  }
  waiting.postMessage({ type: "SKIP_WAITING" });

  activationTimer = setTimeout(() => {
    activationTimer = null;
    activating = false;
    reloadWhenVisible("sw-update-stalled");
  }, ACTIVATION_STALL_TIMEOUT_MS);
}

/**
 * Record that this bundle is not the build the server runs (#3491). One
 * `client-version-mismatch` row per client/server pair per page, recorded to
 * `error_logs` for fleet tooling. A distinct category: `version-mismatch` is
 * already the store's optimistic-concurrency discriminator.
 *
 * Durable on purpose: the automatic activation usually reloads the page within
 * a few seconds of the detection, and `report()`'s 2 s batch debounce dies with
 * the page (measured on a worktree instance: the auto-reloaded page's row never
 * arrived). `reportBeforeReload()` persists to the outbox at once; the reloaded
 * page delivers it, and a page that stays delivers it on its next API success.
 */
export function reportClientVersionMismatch(
  client: string,
  server: string
): void {
  const pair = versionPairKey(client, server);
  if (reportedVersionMismatches.has(pair)) return;
  reportedVersionMismatches.add(pair);
  errorReporter.reportBeforeReload({
    message: `Client bundle v${client} differs from server v${server}`,
    category: "client-version-mismatch",
    severity: "warn",
    context: `client=${client} server=${server} waitingWorker=${swUpdatePending}`,
  });
}

/**
 * Whether this tab already auto-activated for `pair` (#3491). True when the
 * guard cannot be read: without a working store the guard cannot survive the
 * reload, so the automatic path stays off and the user's tap still works.
 */
export function hasMismatchAutoAttempted(pair: string): boolean {
  try {
    return sessionStorage.getItem(MISMATCH_AUTO_KEY) === pair;
  } catch {
    return true;
  }
}

/**
 * The automatic half of the version-mismatch flow (#3491): activate the
 * waiting worker once per client/server pair, without a tap. Returns true when
 * it started the activation.
 *
 * It refuses (returns false) when there is no waiting worker (a same-version
 * deploy cannot reach here, but a stale latch can), when this tab already tried
 * for the pair, or when the guard cannot be written. The guard is written and
 * read back BEFORE SKIP_WAITING is posted, so a reload — the normal one or the
 * stall fallback's — lands on a page that does not try again: that page offers
 * the tap instead (#1793 semantics). A later pair (A→B, then B→C) gets its own
 * single attempt.
 */
export function autoActivateSwUpdateForMismatch(pair: string): boolean {
  if (!waitingRegistration?.waiting) return false;
  if (hasMismatchAutoAttempted(pair)) return false;
  try {
    sessionStorage.setItem(MISMATCH_AUTO_KEY, pair);
    if (sessionStorage.getItem(MISMATCH_AUTO_KEY) !== pair) return false;
  } catch {
    return false;
  }
  activateSwUpdate();
  return true;
}

/**
 * Test-only reset of module state (mirrors ErrorReporter.dispose()'s test
 * intent). Removes the listeners/timer registerServiceWorker() installed so
 * they cannot accumulate across tests under isolate:false. Production never
 * calls this.
 */
export function resetSwUpdateForTests(): void {
  reportedVersionMismatches.clear();
  try {
    sessionStorage.removeItem(MISMATCH_AUTO_KEY);
  } catch {
    // no store, nothing to clear
  }
  swUpdatePending = false;
  waitingRegistration = null;
  activating = false;
  if (activationTimer !== null) {
    clearTimeout(activationTimer);
    activationTimer = null;
  }
  hadController = false;
  controllerReloadFired = false;
  registrationCleanup?.();
  registrationCleanup = null;
}
