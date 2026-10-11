// SPDX-License-Identifier: AGPL-3.0-only
import { type ReactNode } from "react";
import { type LucideIcon } from "lucide-react";
import { useAppGoBack } from "@/hooks/useAppGoBack";
import { BackIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { AccentChip } from "@/components/ui/AccentChip";

/**
 * TitleChip — the graphical icon chip that accompanies EVERY page title in the
 * Settings area: an 8×8 rounded square tinted with the page's accent at 15%
 * alpha (hex suffix 0x26) holding the page's lucide icon at full accent color.
 * The same chip the Settings sidebar rows and the in-page section headings
 * (keys.tsx) render, extracted here so every surface shares one implementation.
 * Pass each page's own `icon`/`accent` pair from the sidebar registry
 * (routes/settings/index.tsx ADMIN_SECTIONS) so the title chip always matches the
 * menu row that navigated there.
 */
export function TitleChip({
  icon: Icon,
  accent,
}: {
  icon: LucideIcon;
  accent: string;
}) {
  return (
    <AccentChip accent={accent}>
      <Icon className="h-4 w-4" style={{ color: accent }} />
    </AccentChip>
  );
}

/**
 * SettingsSectionHeader — the shared sticky header for every admin page (issue #1777,
 * reworked in #1935). Renders a visible upper-left back affordance + title on the
 * `--app-bg` palette, matching the `analytics.tsx` / `ErrorLogViewer.tsx` aesthetic so
 * every admin landing page is visually consistent.
 *
 * Back is plain history-back via `useAppGoBack()` — the SAME behavior Analytics and
 * Error Log use. An optional `onBack` prop overrides it (mirrors `AccountUsagePage`'s
 * `props?.onBack ?? defaultGoBack` pattern), e.g. for tests or a bespoke back target.
 *
 * History (#1935): the admin sections used to render as in-drawer `?section=`/`?nodeId=`
 * search-param overlays, and this header stripped those params to navigate back inside
 * the drawer. #1935 promoted every section to its own route, so the drawer is now a pure
 * menu and back is ordinary pathname history-back.
 *
 * The title renders as an `<h1>` (one per page) for accessibility and to preserve existing
 * `getByRole("heading", { level: 1 })` test selectors. The Settings sidebar reorganization
 * bumped it from `text-sm font-medium` to `text-lg font-bold` so the page title clearly
 * outweighs the in-page section headings and controls. An optional `icon` slot sits between
 * the back button and the title (e.g. the federation node-detail short-id chip).
 */
export function SettingsSectionHeader({
  title,
  icon,
  onBack,
}: {
  title: ReactNode;
  icon?: ReactNode;
  onBack?: () => void;
}) {
  const defaultGoBack = useAppGoBack();
  const handleBack = onBack ?? defaultGoBack;

  return (
    <div className="sticky top-0 z-10 bg-[var(--app-bg)]">
      <div className="mx-auto flex w-full max-w-content items-center gap-2 px-3 py-2">
        <Button
          variant="ghost"
          size="icon"
          type="button"
          onClick={handleBack}
          aria-label="Back"
          data-testid="settings-section-back"
          className="shrink-0 hover:bg-[var(--app-secondary-bg)]"
        >
          <BackIcon className="h-5 w-5" />
        </Button>
        {icon}
        <h1 className="min-w-0 truncate text-lg font-bold text-[var(--app-fg)]">
          {title}
        </h1>
      </div>
    </div>
  );
}
