// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, redirect, type AnyRoute } from "@tanstack/react-router";

/**
 * Legacy `/admin/*` → `/settings/*` permanent redirects (issue #2765, R2/R3/R7).
 *
 * The Settings-menu surface was renamed from "admin" to "settings" (drawer, routes,
 * URLs, titles, test-ids). Every legacy `/admin/*` deep link, bookmark, and PWA
 * shortcut must keep resolving, so each old path registers a redirect route whose
 * `beforeLoad` throws `redirect({ to: "/settings/…" })`. The navigation is replaced
 * before the (now non-existent) admin page would load, landing the user on the
 * corresponding `/settings/*` route.
 *
 * This file is deliberately the ONLY place `/admin/*` path literals survive in
 * `web/src` — the #2765 V1 verification grep (`grep -rn "/admin" src | grep -Ev
 * "legacyAdminRedirects|adminVms|admin-vms"`) whitelists it by filename for exactly
 * this reason. The `?drawer=admin` search-param shim is handled separately in
 * `SettingsDrawer.tsx` (it still accepts the legacy value), so no redirect route is
 * needed for the drawer overlay.
 *
 * The redirect count MUST stay in lockstep with the `/settings/*` route set in
 * `router.tsx` (1:1, asserted by `router.test.tsx`). A missing redirect is an ABSENCE — invisible to grep, `tsc`,
 * lint, and the moved test suite alike — that would 404 a legacy deep link in silence,
 * so `router.test.tsx` asserts every legacy path redirects.
 *
 * #2745 feedback round: Analytics + Account Usage moved under `/settings/*` too.
 * Their REAL legacy paths were top-level (`/analytics`, `/account-usage`), so those
 * redirect here alongside `/admin/*`; the never-shipped `/admin/analytics` +
 * `/admin/account-usage` redirects also register purely to keep the 1:1
 * settings↔admin invariant test uniform.
 *
 * Exposed as a factory because the redirect routes need the app's `rootRoute` as their
 * parent, which is a module-local const in `router.tsx`. The caller passes it in and
 * spreads the returned array into `rootRoute.addChildren([...])`. `TRoot` is generic so
 * the concrete `rootRoute` type flows through without a circular import from `router.tsx`.
 */
export function makeLegacyAdminRedirects<TRoot extends AnyRoute>(
  rootRoute: TRoot
) {
  return [
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/admin/federation",
      beforeLoad: () => {
        throw redirect({ to: "/settings/federation" });
      },
    }),
    // Param-preserving redirect: carry the `$nodeId` through to the new nested route.
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/admin/federation/$nodeId",
      beforeLoad: ({ params }) => {
        throw redirect({
          to: "/settings/federation/$nodeId",
          params: params as { nodeId: string },
        });
      },
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/admin/system-jobs",
      beforeLoad: () => {
        throw redirect({ to: "/settings/system-jobs" });
      },
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/admin/file-conflicts",
      beforeLoad: () => {
        throw redirect({ to: "/settings/file-conflicts" });
      },
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/admin/time-log",
      beforeLoad: () => {
        throw redirect({ to: "/settings/time-log" });
      },
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/admin/session-metadata",
      beforeLoad: () => {
        throw redirect({ to: "/settings/session-metadata" });
      },
    }),
    // #3839: the transcript browser keeps the #2765 R2 1:1 /admin/* ↔ /settings/* pairing.
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/admin/transcripts",
      beforeLoad: () => {
        throw redirect({ to: "/settings/transcripts" });
      },
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/admin/feedback",
      beforeLoad: () => {
        throw redirect({ to: "/settings/feedback" });
      },
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/admin/preferences",
      beforeLoad: () => {
        throw redirect({ to: "/settings/preferences" });
      },
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/admin/about",
      beforeLoad: () => {
        throw redirect({ to: "/settings/about" });
      },
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/admin/keys",
      beforeLoad: () => {
        throw redirect({ to: "/settings/keys" });
      },
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/admin/extensions",
      beforeLoad: () => {
        throw redirect({ to: "/settings/extensions" });
      },
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/admin/configuration",
      beforeLoad: () => {
        throw redirect({ to: "/settings/configuration" });
      },
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/admin/vms",
      beforeLoad: () => {
        throw redirect({ to: "/settings/vms" });
      },
    }),
    // #3128 (epic #3117 Sub N): the Harness Scorecard page.
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/admin/harness-scorecard",
      beforeLoad: () => {
        throw redirect({ to: "/settings/harness-scorecard" });
      },
    }),
    // #1773 (epic #1769 Sub-Issue D): the Harness Updates page.
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/admin/harness-updates",
      beforeLoad: () => {
        throw redirect({ to: "/settings/harness-updates" });
      },
    }),
    // #3752 (epic #3740 Sub-Issue L): the Capabilities panel. Never-shipped
    // /admin/* alias, registered only to keep the 1:1 settings↔admin invariant.
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/admin/capabilities",
      beforeLoad: () => {
        throw redirect({ to: "/settings/capabilities" });
      },
    }),
    // #2745 feedback round: real legacy top-level paths for the two pages that
    // moved under /settings/* after the #2765 rename.
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/analytics",
      beforeLoad: () => {
        throw redirect({ to: "/settings/analytics" });
      },
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/account-usage",
      beforeLoad: () => {
        throw redirect({ to: "/settings/account-usage" });
      },
    }),
    // Never-shipped /admin/* aliases — registered only so the 1:1
    // settings↔admin invariant in router.test.tsx stays uniform.
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/admin/analytics",
      beforeLoad: () => {
        throw redirect({ to: "/settings/analytics" });
      },
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/admin/account-usage",
      beforeLoad: () => {
        throw redirect({ to: "/settings/account-usage" });
      },
    }),
  ];
}
