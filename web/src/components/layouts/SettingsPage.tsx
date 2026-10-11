// SPDX-License-Identifier: AGPL-3.0-only
import { type ReactNode } from "react";

export interface SettingsPageProps {
  /**
   * Section header (e.g. `<SettingsSectionHeader />`), rendered above the body
   * INSIDE the single scroll container so it scrolls with the content.
   */
  header?: ReactNode;
  /** Page body. Provides its own `max-w-content` column + padding. */
  children: ReactNode;
  /** Extra classes merged onto the scroll-owning root (e.g. `[scrollbar-gutter:stable]`). */
  className?: string;
  /** Passthrough test id for the scroll-owning root. */
  "data-testid"?: string;
}

/**
 * SettingsPage — the settings-surface layout template (Interface Design System
 * Sub-Issue E, epic #3028).
 *
 * A `/settings/*` route pane renders inside the app shell's fixed-height,
 * `overflow-hidden` content area, so its ROOT must own the single scroll container
 * (`h-full overflow-y-auto`) or the bottom of the page is silently unreachable
 * (#2830). This template owns that scroll container so every settings page gets the
 * invariant for free, and adds NO wrapper DOM around the header/body — the rendered
 * output is identical to the hand-rolled `<div className="h-full overflow-y-auto">`
 * shape it replaces.
 *
 * Regions: header (scrolls with the body) · body. Exactly ONE scroll owner (this
 * root). `scripts/check-settings-scroll.ts` guards this invariant; pages that adopt
 * this template register a `SCROLL_OWNER_OVERRIDES` entry pointing here (the same
 * delegation the Time Log shape uses), so the token check resolves through the
 * template.
 *
 * See the layout catalog at `docs/design/design-system/layouts.md`.
 */
export function SettingsPage({
  header,
  children,
  className,
  "data-testid": testId,
}: SettingsPageProps) {
  return (
    <div
      data-testid={testId}
      className={`h-full overflow-y-auto${className ? ` ${className}` : ""}`}
    >
      {header}
      {children}
    </div>
  );
}
