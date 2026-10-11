// SPDX-License-Identifier: AGPL-3.0-only
import { KeyRound, ShieldCheck } from "lucide-react";
import {
  SettingsSectionHeader,
  TitleChip,
} from "@/components/settings/SettingsSectionHeader";
import { useAppContext } from "@/lib/app-context";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { useEmojiFavicon } from "@/hooks/useEmojiFavicon";
import { useScrollToLocationHash } from "@/hooks/useScrollToLocationHash";
import {
  useBackupIdentityStatus,
  isBackupProvisioned,
} from "@/hooks/queries/useBackupIdentityStatus";
import { ApiKeysSection } from "@/components/settings/sections/ApiKeysSection";
import { BackupKeySection } from "@/components/settings/sections/BackupKeySection";
import { SettingsPage } from "@/components/layouts/SettingsPage";

/**
 * AdminKeysPage — the `/settings/keys` route (Settings sidebar reorganization).
 *
 * One page for everything key-shaped: the provider API-key vault (#1955) and the
 * per-VM backup age identity (#2507), previously the separate `/settings/api-keys`
 * and `/settings/backup-key` pages. Each folded section keeps its own component
 * (`components/settings/sections/`) and test file; this page just composes them
 * under anchored headings so the sidebar's nested rows can deep-link via URL
 * hash (`#api-keys`, `#backup-key`).
 *
 * Registered in BOTH `router.tsx` (route) and `admin/index.tsx` (nav row) — an
 * unregistered route is an invisible page (#2344).
 */
export default function AdminKeysPage() {
  useDocumentTitle("Keys - Hapimatic");
  useEmojiFavicon(null);
  useScrollToLocationHash();

  // #3059 round-3 feedback: the whole Backup Key section is hidden on nodes
  // that were never backup-provisioned (every physical node) rather than
  // explained. Derivation shared with the settings sidebar's sub-row gate —
  // see isBackupProvisioned.
  const { api } = useAppContext();
  const { data: backupStatus } = useBackupIdentityStatus(api);
  const backupEligible = isBackupProvisioned(backupStatus);

  return (
    // Adopts the SettingsPage layout template (#3033): the template owns the
    // single scroll container (h-full overflow-y-auto) per the #2830 invariant.
    <SettingsPage
      data-testid="settings-keys-root"
      header={
        <SettingsSectionHeader
          icon={<TitleChip icon={KeyRound} accent="var(--accent-amber-300)" />}
          title="Keys"
        />
      }
    >
      <div className="mx-auto flex max-w-content flex-col gap-8 p-4">
        <section
          id="api-keys"
          aria-label="API Keys"
          className="flex scroll-mt-2 flex-col gap-3"
        >
          <h2 className="flex items-center gap-2.5 text-lg font-bold text-[var(--app-fg)]">
            <TitleChip icon={KeyRound} accent="var(--accent-amber-300)" />
            API Keys
          </h2>
          <ApiKeysSection />
        </section>

        {backupEligible ? (
          <section
            id="backup-key"
            aria-label="Backup Key"
            className="flex scroll-mt-2 flex-col gap-3 border-t border-[var(--app-border)] pt-6"
          >
            <h2 className="flex items-center gap-2.5 text-lg font-bold text-[var(--app-fg)]">
              <TitleChip icon={ShieldCheck} accent="var(--accent-green-400)" />
              Backup Key
            </h2>
            <BackupKeySection />
          </section>
        ) : null}
      </div>
    </SettingsPage>
  );
}
