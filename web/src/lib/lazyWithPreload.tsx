// SPDX-License-Identifier: AGPL-3.0-only
import {
  lazy,
  Suspense,
  useState,
  type ComponentType,
  type LazyExoticComponent,
  type ReactElement,
  type ReactNode,
} from "react";

export type PreloadableComponent<P extends object> = ((
  props: P
) => ReactElement) & {
  /** Starts loading the module; resolves once it has loaded. */
  readonly preload: () => Promise<void>;
};

type LazyWithPreloadOptions<P extends object> = {
  /** Shown while the module loads. */
  fallback: ReactNode;
  /**
   * Rendered in place of the component when its module fails to load. Leave it
   * out to let the failure reach the nearest error boundary. (In a build, the
   * failed import has already fired `vite:preloadError`, and main.tsx's handler
   * reloads the app once per boot.)
   */
  onLoadError?: ComponentType<P>;
};

/**
 * A component loaded on demand that renders synchronously once its module has
 * loaded (#3098).
 *
 * React 19 keeps a Suspense fallback on screen for at least 300 ms after it
 * commits, even when the chunk arrives in 10 ms (measured: a settings page
 * appeared at 389 ms on its first visit, 55 ms on its second). A screen that
 * leads to this component calls `preload()` ahead of time, so the first visit
 * mounts without suspending, as it did when the code was in the main bundle.
 */
export function lazyWithPreload<P extends object>(
  load: () => Promise<{ default: ComponentType<P> } | undefined>,
  { fallback, onLoadError }: LazyWithPreloadOptions<P>
): PreloadableComponent<P> {
  let loaded: ComponentType<P> | null = null;
  let pending: Promise<ComponentType<P>> | null = null;

  const start = (): Promise<ComponentType<P>> => {
    pending ??= load()
      .then(module => {
        // main.tsx cancels `vite:preloadError` (it reloads the app instead), and
        // a cancelled preload error makes the import resolve to undefined.
        if (!module?.default) throw new Error("Lazy module failed to load");
        loaded = module.default;
        return module.default;
      })
      .catch((error: unknown) => {
        // A later direct preload() call may try again. The router caches a
        // rejected route preload for the page's lifetime, so for route pages
        // the recovery is main.tsx's reload, not this retry.
        pending = null;
        throw error;
      });
    return pending;
  };

  const LazyComponent = lazy(() =>
    start().then(
      component => ({ default: component }),
      (error: unknown) => {
        if (onLoadError) return { default: onLoadError };
        throw error;
      }
    )
  );

  function Preloadable(props: P): ReactElement {
    // Chosen once per mount: switching from the Suspense path to the loaded
    // component on a later render would remount it and lose its state.
    const [Ready] = useState<ComponentType<P> | null>(() => loaded);
    if (Ready) return <Ready {...props} />;
    return (
      <Suspense fallback={fallback}>
        <LazyComponent {...props} />
      </Suspense>
    );
  }

  return Object.assign(Preloadable, {
    preload: (): Promise<void> => start().then(() => undefined),
  });
}

/**
 * `React.lazy` that renders `onLoadError`, never the error boundary, when its
 * module fails to load (#6450). For a component that suspends under its
 * caller's own Suspense, whose fallback differs per instance (the code block a
 * pin card replaces, the markdown a compact message would replace), which
 * `lazyWithPreload`'s one module-level fallback cannot express. main.tsx
 * cancels `vite:preloadError`, so a failed import usually resolves to
 * undefined rather than rejecting; both lead to `onLoadError`.
 */
export function lazyWithLoadError<P extends object>(
  load: () => Promise<{ default: ComponentType<P> } | undefined>,
  onLoadError: ComponentType<P>
): LazyExoticComponent<ComponentType<P>> {
  return lazy(() =>
    load().then(
      module => ({ default: module?.default ?? onLoadError }),
      () => ({ default: onLoadError })
    )
  );
}

/**
 * Preloads components once the browser is idle (Safari has no
 * requestIdleCallback, so it gets a short timeout). The rejection is not
 * surfaced here, but in a build a failed import still fires
 * `vite:preloadError`, and main.tsx's handler reloads the app once per boot.
 * Returns a cancel function for an effect cleanup.
 */
export function preloadWhenIdle(
  components: readonly { preload: () => Promise<void> }[]
): () => void {
  const run = (): void => {
    for (const component of components) {
      component.preload().catch(() => {});
    }
  };
  if (typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(run, { timeout: 2000 });
    return () => window.cancelIdleCallback(handle);
  }
  const timer = window.setTimeout(run, 300);
  return () => window.clearTimeout(timer);
}
