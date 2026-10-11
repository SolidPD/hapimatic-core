// SPDX-License-Identifier: AGPL-3.0-only
import { lazy, Suspense } from "react";
import { createRoute, type AnyRoute } from "@tanstack/react-router";

/**
 * Dev-only `/design` component-catalog / pattern-lab route (Interface Design System
 * Sub-Issue H, #3036; epic #3028).
 *
 * The catalog is a DEVELOPMENT tool, never a product surface, so it must be excluded
 * from production builds — not shipped-but-toggleable. Exclusion is the access control
 * (R5): the caller registers this route only inside an `import.meta.env.DEV` branch in
 * `router.tsx`, so in a production build the branch is dead code, this factory call is
 * eliminated, and the lazily-imported `DesignCatalog` chunk below is never emitted.
 * Measured production bundle delta: ~0 (see `docs/design/design-system/catalog.md`).
 * This mirrors the `import.meta.env.DEV` dev-gate precedent at
 * `web/src/design/tokens.ts:132` (the `__applyAccent` console escape hatch).
 *
 * Exposed as a factory (like `makeLegacyAdminRedirects`) because the route needs the
 * app's `rootRoute` as its parent, which is a module-local const in `router.tsx`. The
 * `lazy(() => import("./DesignCatalog"))` is created INSIDE the factory so the dynamic
 * import is reachable only through this function — when the factory call is dead-code
 * eliminated in production, the catalog chunk goes with it. `TRoot` is generic so the
 * concrete `rootRoute` type flows through without a circular import from `router.tsx`.
 *
 * Contract + option evaluation: `docs/design/design-system/catalog.md`.
 */
export function makeDesignRoutes<TRoot extends AnyRoute>(rootRoute: TRoot) {
  const LazyDesignCatalog = lazy(() => import("./DesignCatalog"));

  function DesignCatalogRoute() {
    return (
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center text-[var(--app-muted)]">
            Loading catalog…
          </div>
        }
      >
        <LazyDesignCatalog />
      </Suspense>
    );
  }

  return [
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/design",
      component: DesignCatalogRoute,
    }),
  ];
}
