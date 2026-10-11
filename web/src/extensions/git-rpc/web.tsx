// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Web entry point for `builtin.git-rpc` (issue #1281, Sub-Issue Q of epic
 * #1264).
 *
 * ## Why v0.1 contributes no slots (and `router.tsx` imports the routes directly)
 *
 * The file browser is a pair of real TanStack routes (`/sessions/$sessionId/files`
 * and `/sessions/$sessionId/file`), not a self-contained slot the host can mount.
 * The v0.1 `host.navigation.addRoute` API is DECLARED but UNCONSUMED: the web
 * host stores route specs (`WebExtensionHostImpl.getNavigationRoutes()`), but
 * nothing reads them — `web/src/ext/slots.tsx` `NavigationRoutes()` is a symbolic
 * no-op, and `router.tsx` builds its route tree STATICALLY at module-eval.
 *
 * Wiring `getNavigationRoutes()` into TanStack Router would break the build:
 * TanStack infers valid route paths from the static route tree (the `Register`
 * interface), so dynamically-added routes would leave the typed tree and make
 * `App.tsx`'s `matchRoute({ to: "/sessions/$sessionId/files" })` and
 * `SessionChat.tsx`'s `navigate({ to: ... })` fail typecheck.
 *
 * So — exactly like `builtin.scheduler` (#1274) — the router keeps importing the
 * route components directly, but from `@/extensions/git-rpc/routes/...`, which
 * makes the ownership boundary explicit even though the wiring is still a plain
 * import. Lifting these into real `navigation.addRoute` contributions is deferred
 * to a follow-up that first wires a `getNavigationRoutes()` consumer into
 * `router.tsx`; when that lands, the `host.navigation.addRoute` calls go here.
 *
 * The extension still needs a `web` entry point so F's codegen emits it into the
 * web registry and the loader honors its `extension_prefs` enable state (which,
 * with `requiredAtBuild: true`, always resolves to enabled).
 */
import type { WebRegister } from "@hapi/protocol/ext";

/**
 * No-op registration for v0.1 — see the file docstring. The file-browser routes
 * are consumed via a static import in `router.tsx`, not `host.navigation.addRoute`.
 */
export const register: WebRegister = async () => {
  // Intentionally empty. See the file docstring for why the routes are
  // static-imported by router.tsx rather than contributed via navigation.addRoute.
};
