// SPDX-License-Identifier: AGPL-3.0-only
import { FolderCog } from "lucide-react";
import {
  SettingsSectionHeader,
  TitleChip,
} from "@/components/settings/SettingsSectionHeader";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { useEmojiFavicon } from "@/hooks/useEmojiFavicon";
import { InstalledConfigTabs } from "@/components/porter/InstalledConfigTabs";
import { SettingsPage } from "@/components/layouts/SettingsPage";
import { useAppContext } from "@/lib/app-context";
import {
  isPorterExposed,
  usePorterStatus,
} from "@/hooks/queries/usePorterStatus";

/**
 * ConfigurationAdminPage — the `/settings/configuration` route (issue #2344,
 * epic #2339 Sub E). The Configuration Porter's single, always-available import
 * surface.
 *
 * This is the ONE import-UI implementation in the codebase (directive R5): the
 * onboarding wizard's optional import stage deep-links here rather than carrying
 * its own form, and this page is also the persistent re-entry point — a user who
 * skipped import during onboarding (or wants to re-run it later) reaches the full
 * flow from here with no CLI intervention.
 *
 * One tabbed surface (#2745 feedback round): InstalledConfigTabs hosts the four
 * installed-config list tabs (R1) PLUS the mint "Import" tab, which contains
 * PorterExtractionPrompt (R3) and PorterImportPanel (R4) — previously stacked
 * below every tab as page-level siblings.
 *
 * Follows the `/settings/extensions` section pattern; registered in `router.tsx`
 * and linked from `ADMIN_SECTIONS` (`admin/index.tsx`) — an admin page nothing
 * links to is invisible in practice (the `/extensions` cautionary tale).
 *
 * Full-width inside the drawer; does NOT attach its own `useSwipeBack`
 * (SettingsDrawer owns the single swipe-back handler).
 *
 * #4533: gated FAIL-CLOSED on the Porter exposure probe (the `vms.tsx` shape).
 * Porter is withheld by default, so a direct visit — or the legacy
 * `/admin/configuration` redirect — renders a not-available notice and mounts
 * no Porter component (no Porter endpoint is called besides the probe) until
 * the server answers 200 `{ exposed: true }`.
 */
export default function ConfigurationAdminPage() {
  useDocumentTitle("Configuration - Hapimatic");
  useEmojiFavicon(null);
  const { api } = useAppContext();
  const exposed = isPorterExposed(usePorterStatus(api).data);

  const header = (
    <SettingsSectionHeader
      icon={<TitleChip icon={FolderCog} accent="var(--accent-teal-200)" />}
      title="Configuration"
    />
  );

  if (!exposed) {
    return (
      <SettingsPage data-testid="settings-configuration-root" header={header}>
        <div className="mx-auto w-full max-w-content px-4 pb-6">
          <p
            className="py-6 text-[length:var(--text-body)] text-[var(--app-hint)]"
            data-testid="configuration-withheld"
          >
            Configuration import is not available on this instance.
          </p>
        </div>
      </SettingsPage>
    );
  }

  return (
    // Adopts the SettingsPage layout template (#3033): the template owns the
    // single scroll container (h-full overflow-y-auto) per the #2830 invariant.
    <SettingsPage
      data-testid="settings-configuration-root"
      // #2745 round-2 feedback: `scrollbar-gutter: stable` reserves the
      // scrollbar track permanently, so expanding/collapsing the Import tab's
      // sections never shifts the page contents left-right when the scrollbar
      // appears or disappears.
      className="[scrollbar-gutter:stable]"
      header={header}
    >
      <div className="mx-auto flex w-full max-w-content flex-col gap-8 px-4 pb-6">
        <p className="text-[length:var(--text-body)] text-[var(--app-hint)]">
          Bring your Claude Code configuration — skills, hooks, MCP servers, and
          agents — over from another machine. Generate the extraction prompt,
          run it on the source machine, then upload and review the archive here
          before anything is written.
        </p>

        <InstalledConfigTabs />
      </div>
    </SettingsPage>
  );
}
