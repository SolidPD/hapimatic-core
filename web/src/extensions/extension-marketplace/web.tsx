// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Web entry point for `builtin.extension-marketplace` (issue #1292, PR-2).
 *
 * No-op registration for v0.1 — the `/extensions` route is consumed via a static import in
 * `router.tsx` (from `@/extensions/extension-marketplace/routes/extensions`), exactly like
 * `builtin.error-log-viewer` (#1279) and `builtin.analytics` (#1282). The v0.1
 * `host.navigation.addRoute` API is declared but UNCONSUMED (TanStack Router builds its route tree
 * statically at module-eval), so nothing is contributed here. The extension still needs a `web`
 * entry point so codegen emits it into the web registry.
 */
import type { WebRegister } from "@hapi/protocol/ext";

export const register: WebRegister = async () => {
  // Intentionally empty. See the file docstring for why the route is static-imported by router.tsx.
};
