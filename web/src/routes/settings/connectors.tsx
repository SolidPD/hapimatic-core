// SPDX-License-Identifier: AGPL-3.0-only
import { Plug } from "lucide-react";
import {
  SettingsSectionHeader,
  TitleChip,
} from "@/components/settings/SettingsSectionHeader";
import { AccentChip } from "@/components/ui/AccentChip";
import { GitHubIcon } from "@/components/icons";
import {
  GitHubConnectionsSection,
  useGitHubConnectionsVisible,
} from "@/components/settings/sections/GitHubConnectionsSection";
import { SettingsPage } from "@/components/layouts/SettingsPage";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { useEmojiFavicon } from "@/hooks/useEmojiFavicon";
import { useScrollToLocationHash } from "@/hooks/useScrollToLocationHash";

const ACCENT = "var(--accent-violet-400)";

/**
 * ConnectorsPage — the `/settings/connectors` route (#4793 Task 6, PM ruling
 * D-4793-6).
 *
 * The services this instance reaches on the user's behalf. It holds one section
 * today, GitHub (`#github`): the accounts linked on hapimatic.com, which a cloud VM
 * lists through the gateway's read broker. #2724 later adds its server-used keys
 * to this same page. The page and its Settings row show only on a broker-backed
 * host; anywhere else a direct visit says there is nothing to connect.
 *
 * Registered in BOTH `router.tsx` (route) and `settings/index.tsx` (menu row) — an
 * unregistered route is an invisible page (#2344).
 */
export default function ConnectorsPage() {
  useDocumentTitle("Connectors - Hapimatic");
  useEmojiFavicon(null);
  const { visible, isLoading, accounts, loadFailed } =
    useGitHubConnectionsVisible();
  useScrollToLocationHash(!isLoading);

  return (
    // The SettingsPage template owns the single scroll container (#2830).
    <SettingsPage
      data-testid="settings-connectors-root"
      header={
        <SettingsSectionHeader
          icon={<TitleChip icon={Plug} accent={ACCENT} />}
          title="Connectors"
        />
      }
    >
      <div className="mx-auto flex w-full max-w-content flex-col gap-5 p-4">
        {/* What the page is for, in one line (D-4793-8); absent where nothing can connect. */}
        {visible && (
          <p className="text-sm text-[var(--app-hint)]">
            Services this instance can reach on your behalf. GitHub accounts let
            Hapimatic list your repositories and issues when you create a
            session.
          </p>
        )}
        {visible ? (
          <section
            id="github"
            aria-label="GitHub"
            className="flex scroll-mt-2 flex-col gap-3"
          >
            {/* IconSectionHeading takes a Lucide icon, and Lucide has no GitHub
                mark, so the same chip is composed here around the app's own. */}
            <h2 className="flex items-center gap-2.5 text-lg font-bold text-[var(--app-fg)]">
              <AccentChip accent={ACCENT}>
                <span style={{ color: ACCENT }}>
                  <GitHubIcon className="h-4 w-4" />
                </span>
              </AccentChip>
              GitHub
              {accounts.length > 0 && (
                <span className="ml-auto text-[length:var(--text-caption)] font-normal text-[var(--app-hint)]">
                  {accounts.length === 1
                    ? "1 account"
                    : `${accounts.length} accounts`}
                </span>
              )}
            </h2>
            <GitHubConnectionsSection />
          </section>
        ) : isLoading ? (
          <p className="text-sm text-[var(--app-hint)]">Loading…</p>
        ) : loadFailed ? (
          // The request failed, so whether this host has connectors is unknown: say that,
          // never "no connectors" (#4793 review).
          <p className="text-sm text-[var(--status-warn)]" role="status">
            Connectors could not be loaded. Check your connection, then reload
            the page.
          </p>
        ) : (
          <p className="text-sm text-[var(--app-hint)]">
            No connectors are available on this instance.
          </p>
        )}
      </div>
    </SettingsPage>
  );
}
