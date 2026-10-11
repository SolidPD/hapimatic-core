// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Web entry point for `builtin.error-log-viewer` (issue #1279, Sub-Issue O of epic
 * #1264).
 *
 * ## Why v0.1 contributes no slots (and `router.tsx` imports the route directly)
 *
 * The error-log viewer is a real TanStack route (`/error-logs`), not a self-contained
 * slot the host can mount. The v0.1 `host.navigation.addRoute` API is DECLARED but
 * UNCONSUMED: the web host stores route specs
 * (`WebExtensionHostImpl.getNavigationRoutes()`), but nothing reads them —
 * `web/src/ext/slots.tsx` `NavigationRoutes()` is a symbolic no-op, and `router.tsx`
 * builds its route tree STATICALLY at module-eval. Wiring `getNavigationRoutes()` into
 * TanStack Router would break the build: TanStack infers valid route paths from the
 * static route tree (the `Register` interface), so a dynamically-added `/error-logs`
 * would leave the typed tree and make navigations to it fail typecheck.
 *
 * So — exactly like `builtin.git-rpc` (#1281) and `builtin.scheduler` (#1274) — the
 * router keeps importing the route component directly, but from
 * `@/extensions/error-log-viewer/routes/error-logs`, which makes the ownership boundary
 * explicit even though the wiring is still a plain import. Lifting this into a real
 * `navigation.addRoute` contribution is deferred to a follow-up that first wires a
 * `getNavigationRoutes()` consumer into `router.tsx`.
 *
 * The extension still needs a `web` entry point so F's codegen emits it into the web
 * registry and the loader honors its `extension_prefs` enable state (which, with
 * `requiredAtBuild: true`, always resolves to enabled — #1042 requires `/error-logs` to
 * stay always-present).
 */
import type { WebRegister } from "@hapi/protocol/ext";

/**
 * No-op registration for v0.1 — see the file docstring. The `/error-logs` route is
 * consumed via a static import in `router.tsx`, not `host.navigation.addRoute`.
 */
export const register: WebRegister = async () => {
  // Intentionally empty. See the file docstring for why the route is static-imported
  // by router.tsx rather than contributed via navigation.addRoute.
};
