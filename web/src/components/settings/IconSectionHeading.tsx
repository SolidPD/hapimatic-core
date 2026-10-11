// SPDX-License-Identifier: AGPL-3.0-only
import { type ReactNode } from "react";
import { type LucideIcon } from "lucide-react";
import { TitleChip } from "@/components/settings/SettingsSectionHeader";

/**
 * IconSectionHeading — the shared in-page section heading used across the Settings
 * area: a bold `<h2>` preceded by the accent-tinted icon chip. Extracted (issue
 * #2961) from three call sites (Notifications + Session Handoff in
 * `routes/settings/preferences.tsx`, Onboarding in
 * `sections/OnboardingSection.tsx`) that inline-duplicated the same markup.
 *
 * The chip is delegated to `TitleChip` (which itself delegates to `AccentChip`),
 * so this renders byte-identically to the pre-extraction inline
 * `<h2><AccentChip accent={a}><Icon className="h-4 w-4" style={{ color: a }} /></AccentChip>{title}</h2>`.
 *
 * Named `IconSectionHeading` — NOT `SectionHeading` — deliberately: `SectionHeading`
 * is already taken by a DIFFERENT (text-only, 11px-uppercase) heading in
 * `routes/settings/preferences.tsx` and `sections/SessionHandoffSection.tsx`.
 */
export function IconSectionHeading({
  icon,
  accent,
  title,
}: {
  icon: LucideIcon;
  accent: string;
  title: ReactNode;
}) {
  return (
    <h2 className="flex items-center gap-2.5 text-lg font-bold text-[var(--app-fg)]">
      <TitleChip icon={icon} accent={accent} />
      {title}
    </h2>
  );
}
