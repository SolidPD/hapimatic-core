// SPDX-License-Identifier: AGPL-3.0-only
import { Bell } from "lucide-react";
import {
  SettingsSectionHeader,
  TitleChip,
} from "@/components/settings/SettingsSectionHeader";
import { IconSectionHeading } from "@/components/settings/IconSectionHeading";
import { NotificationsSection } from "@/components/settings/sections/NotificationsSection";
import { SettingsPage } from "@/components/layouts/SettingsPage";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { useEmojiFavicon } from "@/hooks/useEmojiFavicon";
import { useScrollToLocationHash } from "@/hooks/useScrollToLocationHash";

/**
 * NotificationsPage — the `/settings/notifications` route (#4906).
 *
 * The Settings menu's top-level Notifications row lands here. Today the page holds
 * one section, the notification settings that used to sit on Preferences under
 * `#notifications` (that old link redirects here, see `router.tsx`). Epic #4912's
 * Sub D (#4916) adds the Inbox beside it: the 48-hour notification list and its
 * detail view.
 *
 * Registered in BOTH `router.tsx` (route) and `settings/index.tsx` (menu row) — an
 * unregistered route is an invisible page (#2344).
 */
export default function NotificationsPage() {
  useDocumentTitle("Notifications - Hapimatic");
  useEmojiFavicon(null);
  useScrollToLocationHash();

  return (
    // The SettingsPage template owns the single scroll container (#2830); the
    // scroll lint resolves through its SCROLL_OWNER_OVERRIDES entry.
    <SettingsPage
      data-testid="settings-notifications-root"
      header={
        <SettingsSectionHeader
          icon={<TitleChip icon={Bell} accent="var(--accent-amber-400)" />}
          title="Notifications"
        />
      }
    >
      <div className="mx-auto flex w-full max-w-content flex-col gap-8 p-4">
        <section
          id="preferences"
          aria-label="Notification preferences"
          className="flex scroll-mt-2 flex-col gap-3"
        >
          <IconSectionHeading
            icon={Bell}
            accent="var(--accent-amber-400)"
            title="Preferences"
          />
          <NotificationsSection />
        </section>

        {/* #4916 (epic #4912 Sub D) adds the Inbox section here: the list of the
            last 48 hours' notifications and the detail view a row opens. */}
      </div>
    </SettingsPage>
  );
}
