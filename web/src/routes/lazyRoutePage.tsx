// SPDX-License-Identifier: AGPL-3.0-only
import type { ComponentType, ReactElement } from "react";
import {
  lazyWithPreload,
  type PreloadableComponent,
} from "@/lib/lazyWithPreload";

/** The loading fallback every lazy route page shows (#3098). */
export function routeFallback(label: string): ReactElement {
  return (
    <div className="flex h-full items-center justify-center text-[var(--app-muted)]">
      {label}
    </div>
  );
}

/**
 * A route page loaded on demand, with its own loading fallback (#3098).
 *
 * TanStack Router calls a route component's `preload()` and waits for it before
 * it renders the route (router-core's `loadRouteChunk`), keeping the current
 * screen up meanwhile, so a navigation renders the page at once, without the
 * fallback. The `<Suspense>` covers a render before the module has loaded,
 * which a test or a wrapper component can do: TanStack wraps a non-root route
 * in Suspense only when it sets `pendingComponent` or `wrapInSuspense`, and this
 * app sets neither, so a bare `React.lazy` page would blank the content area.
 * React's `lazy` is used rather than TanStack's `lazyRouteComponent`, whose own
 * reload-on-failure would compete with main.tsx's `vite:preloadError` recovery.
 *
 * routes/lazyPages.tsx preloads most pages (all but Analytics) from the
 * screens that lead to them, so the router usually does not have to wait for
 * the chunk either.
 *
 * Call it at module scope, once per page, so the lazy component is stable.
 */
export function lazyRoutePage(
  load: () => Promise<{ default: ComponentType }>,
  label: string
): PreloadableComponent<object> {
  return lazyWithPreload(load, { fallback: routeFallback(label) });
}
