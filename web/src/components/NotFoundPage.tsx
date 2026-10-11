// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect } from "react";
import { Link } from "@tanstack/react-router";
import { clearLastRoute } from "@/lib/route-persistence";
import { StatePanel } from "@/components/ui/StatePanel";

/**
 * Root not-found view (issue #1257). Rendered by the root route's
 * `notFoundComponent` when no route in the tree resolves — i.e. the
 * structurally malformed deep-link case that would otherwise fall through to
 * TanStack Router's bare default 404 (plain text, no navigation) and trap an
 * iOS PWA user with no in-app escape hatch.
 *
 * Renders inside `App`'s `BrandedFrame` chrome (the root route's `component`
 * is `App`, which renders `<Outlet />` inside `BrandedFrame`), so the header,
 * version footer, and wordmark home button remain visible from this view.
 *
 * Self-healing: clears the persisted lastRoute key on mount so the next cold
 * start does not re-restore the bad deep link.
 */
export function NotFoundPage() {
  useEffect(() => {
    // Self-heal: purge the persisted deep link that resolved to no route so
    // the next cold start can't re-trap the user. Idempotent
    // (localStorage.removeItem on an absent key is a no-op), so React 19
    // StrictMode's dev double-mount is harmless.
    clearLastRoute();
  }, []);

  // #3032 Sub D — migrated to the shared `StatePanel` composite (empty variant;
  // normalizes the ad-hoc `--app-fg/60` muted title to the canonical `--app-hint`
  // token, behavior-preserving otherwise).
  return (
    <StatePanel
      variant="empty"
      className="flex-1 p-4"
      title="Not Found"
      action={
        <Link
          to="/sessions"
          className="text-sm text-[var(--app-link)] hover:underline"
        >
          Back to sessions
        </Link>
      }
    />
  );
}

export default NotFoundPage;
