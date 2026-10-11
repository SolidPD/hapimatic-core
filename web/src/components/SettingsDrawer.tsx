// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { X, Settings as SettingsIcon } from "lucide-react";
import { useSwipeBack } from "@/hooks/useSwipeBack";
import { useSplitViewContext } from "@/lib/split-view-context";
import SettingsLandingPage from "@/routes/settings/index";
import { TitleChip } from "@/components/settings/SettingsSectionHeader";
import { Button } from "@/components/ui/button";
import { CONTENT_MAX_WIDTH } from "@/lib/layout-thresholds";

/**
 * SettingsDrawer — a right-anchored, URL-driven slide-in MENU for the settings area.
 *
 * Open state is derived entirely from the URL **search param** `?drawer=settings` (via
 * `useLocation`) — there is no React `isOpen` boolean and NO `/settings` path route. Because
 * the drawer is a search-param overlay (not a route), the underlying page the user was on
 * stays the matched/mounted route while the drawer overlays it — closing the drawer returns
 * to that page without re-mounting it.
 *
 * #1935: the drawer is now a PURE MENU. It renders only `SettingsLandingPage` (the section
 * list). Every informational section was promoted to its own `/settings/*` route, so tapping
 * a menu row navigates to a full page and dismisses the drawer (the menu's `navigate({ to })`
 * drops `?drawer=settings`). Nothing renders *inside* the drawer except the menu.
 *
 * #1035 invariant (load-bearing): the admin content renders in EXACTLY ONE place. An earlier
 * path-route design hosted section content in an `<Outlet />`, which double-rendered it in
 * both the App's main outlet and the drawer's. #1935 keeps that invariant by NOT importing
 * or rendering any section component here — promoted pages mount only via the router outlet.
 * (The in-drawer `?section=` switch `AdminSectionView` and the `clearSection`/`clearNodeId`
 * machinery that #1036/#1444/#1777 added were removed in #1935.)
 *
 * Dismissal strips the `drawer` search param while staying on the current pathname. We
 * deliberately do NOT use `useAppGoBack` here — it is pathname-aware and would navigate away
 * from the underlying page instead of just closing the drawer. Three dismissal affordances:
 * the ✕ in the pinned title bar (explicit), tapping the backdrop (secondary), and the PWA
 * swipe-back gesture.
 *
 * Panel shape (#1935): right-anchored and flush to the right edge, sized to its menu content
 * in BOTH dimensions — a fixed `w-[300px]` width (capped at `max-w-[90vw]` so it can't overflow
 * a very narrow screen) so there is no empty purple fill to the right of the rows, and a
 * content-height cap (no full-height fill). Offset from the top so a strip of the dimmed
 * backdrop shows above it. A pinned "Settings" title bar (with the ✕) stays fixed at the top
 * of the panel while the menu below scrolls. Respects iOS safe areas. (#4088 removed an
 * unverified 75px iPad-multitasking right padding: it only shifted the menu content left
 * inside a panel already flush to the window edge.)
 *
 * The earlier #1935 width was `w-[70vw] max-w-content` (≈720px cap). That happened to look
 * fine on a phone (70vw of a ~393px screen ≈ the content width) but on desktop blew out to the
 * 720px cap, leaving ~60% of the panel as dead purple space — the rows' `flex-1` labels and the
 * title bar's `justify-between` flung the chevrons and the ✕ to the far right edge. The fixed
 * content width pulls those affordances back next to their labels.
 */
export function SettingsDrawer() {
  const isOpen = useLocation({
    select: l => {
      // #2765 R3 back-compat shim: `?drawer=settings` is the primary param; the
      // legacy `?drawer=admin` value still opens the drawer so #2453's badge-dropdown
      // deep link and PWA shortcuts do not 404.
      const d = (l.search as { drawer?: string }).drawer;
      return d === "settings" || d === "admin";
    },
  });
  const { isSplit } = useSplitViewContext();
  // #3280 Task 5: split is a two-pane layout ONLY on the pane host (`/sessions`).
  // On any other route (a full `/settings/*` page) the content is single-column
  // even when `isSplit` is still true in context (collapse is visual — R4), so
  // anchor to the letterbox content edge there, not the window edge.
  const onSessionsRoute = useLocation({
    select: l => l.pathname === "/sessions",
  });
  const navigate = useNavigate();

  const closeDrawer = useCallback(() => {
    navigate({
      to: ".",
      search: prev => {
        const next = { ...(prev as Record<string, unknown>) };
        delete next.drawer;
        return next;
      },
      replace: true,
    });
  }, [navigate]);

  // The drawer is a pure menu now, so swipe-back simply closes it.
  const { handlers: swipeBackHandlers } = useSwipeBack({
    onSwipeBack: closeDrawer,
    enabled: isOpen,
  });

  if (!isOpen) return null;

  return (
    <>
      <div
        data-testid="settings-drawer-backdrop"
        className="fixed inset-0 z-40 bg-black/50"
        onClick={closeDrawer}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className={
          /* design-tokens-allow: drawer layout width, no exact spacing token */ "settings-drawer-emerge fixed z-50 flex w-[300px] max-w-[90vw] flex-col overflow-hidden rounded-l-2xl bg-[var(--brand-primary)] shadow-2xl"
        }
        style={{
          // #N4: anchor the drawer's right edge to the app's content column
          // (max-w-content = CONTENT_MAX_WIDTH, tailwind.config.ts:8) rather than the window edge,
          // so on a wide desktop the menu appears at the right edge of the centered
          // workspace (matching the BrandedFrame content-area clamp). On the pane host
          // in split view the content-area is full-width, so the letterbox is 0 and the
          // drawer sits at the window edge. #3280: gate on `onSessionsRoute` too — on a
          // full `/settings/*` route the content is single-column even with `isSplit`
          // still true (R4), so anchor to the content edge, not the window edge.
          right:
            isSplit && onSessionsRoute
              ? 0
              : `max(0px, calc((100vw - ${CONTENT_MAX_WIDTH}px) / 2))`,
          // Offset from the top so the dimmed backdrop is visible above the panel,
          // accounting for the iOS safe-area inset (notch / Dynamic Island).
          top: "calc(env(safe-area-inset-top) + 3.5rem)",
          // Content-height up to the available space — no excess blank fill. The inner
          // SettingsLandingPage scrolls if the menu is taller than this cap.
          maxHeight:
            "calc(100dvh - env(safe-area-inset-top) - 4.5rem - env(safe-area-inset-bottom))",
          paddingBottom: "env(safe-area-inset-bottom)",
        }}
        {...swipeBackHandlers}
      >
        {/* Pinned title bar — stays fixed at the top of the panel while the menu
            below scrolls (flex-shrink-0 header + flex-1 scroll area). */}
        <div className="flex flex-shrink-0 items-center justify-between border-b border-black/10 px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <TitleChip
              icon={SettingsIcon}
              accent={
                /* design-tokens-allow: TitleChip slate accent — no exact --accent token for #94a3b8; a page-accent token is Sub B/token work */ "#94a3b8"
              }
            />
            <h1 className="text-base font-semibold text-[var(--app-fg)]">
              Settings
            </h1>
          </div>
          <Button
            variant="ghost"
            size="icon"
            type="button"
            onClick={closeDrawer}
            aria-label="Close"
            data-testid="settings-drawer-close"
            className="text-[var(--app-fg)] opacity-80 hover:bg-black/15 hover:opacity-100 active:bg-black/25"
          >
            <X className="h-5 w-5" />
          </Button>
        </div>
        {/* Scrollable menu. */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <SettingsLandingPage />
        </div>
      </aside>
    </>
  );
}
