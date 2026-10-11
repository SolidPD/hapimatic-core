// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Web entry point for `builtin.analytics` (issue #1282, Sub-Issue R of epic #1264).
 *
 * ## Why v0.1 contributes no slots (and `router.tsx` imports the route directly)
 *
 * The analytics dashboard is a real TanStack route (`/settings/analytics`), not a
 * self-contained slot the host can mount. The v0.1 `host.navigation.addRoute` API is
 * DECLARED but UNCONSUMED: the web host stores route specs
 * (`WebExtensionHostImpl.getNavigationRoutes()`), but nothing reads them —
 * `web/src/ext/slots.tsx` `NavigationRoutes()` is a symbolic no-op, and `router.tsx`
 * builds its route tree STATICALLY at module-eval. Wiring `getNavigationRoutes()` into
 * TanStack Router would break the build: TanStack infers valid route paths from the
 * static route tree (the `Register` interface), so a dynamically-added analytics route
 * would leave the typed tree and make `web/src/routes/settings/index.tsx`'s
 * `navigate({ to: "/settings/analytics" })` fail typecheck — a regression
 * `web/src/routes/settings/index.test.tsx` asserts against.
 *
 * So — exactly like `builtin.error-log-viewer` (#1279), `builtin.git-rpc` (#1281), and
 * `builtin.scheduler` (#1274) — the router keeps importing the route component
 * directly, but from `@/extensions/analytics/routes/analytics`, which makes the
 * ownership boundary explicit even though the wiring is still a plain import. Lifting
 * this into a real `navigation.addRoute` contribution is deferred to a follow-up that
 * first wires a `getNavigationRoutes()` consumer into `router.tsx`.
 *
 * ## Why the router's import stays LAZY (unlike error-log-viewer's static import)
 *
 * `router.tsx` reaches this route through `lazy(() => import(...))`, which Vite
 * code-splits into its own chunk. That boundary predates the migration and is
 * preserved verbatim — only the specifier changed. The analytics bundle pulls in
 * eleven panel components and their charting, so keeping it out of the initial bundle
 * matters more here than it did for the single-component error-log viewer.
 *
 * The extension still needs a `web` entry point so F's codegen emits it into the web
 * registry and the loader honors its `extension_prefs` enable state (which, with
 * `requiredAtBuild: true`, always resolves to enabled — #1042 requires the analytics
 * page, now at `/settings/analytics`, to stay always-present).
 */
import type { WebRegister } from "@hapi/protocol/ext";

/**
 * No-op registration for v0.1 — see the file docstring. The `/analytics` route is
 * consumed via a static (lazy) import in `router.tsx`, not `host.navigation.addRoute`.
 */
export const register: WebRegister = async () => {
  // Intentionally empty. See the file docstring for why the route is imported by
  // router.tsx rather than contributed via navigation.addRoute.
};
