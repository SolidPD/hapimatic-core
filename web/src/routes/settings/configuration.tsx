// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { FolderCog } from "lucide-react";
import {
  SettingsSectionHeader,
  TitleChip,
} from "@/components/settings/SettingsSectionHeader";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { useEmojiFavicon } from "@/hooks/useEmojiFavicon";
import { InstalledConfigTabs } from "@/components/porter/InstalledConfigTabs";
import { SettingsPage } from "@/components/layouts/SettingsPage";
import { Button } from "@/components/ui/button";
import { useAppContext } from "@/lib/app-context";
import {
  porterExposure,
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
 * #4533 / #5165: gated FAIL-CLOSED on the Porter exposure probe (the `vms.tsx`
 * shape). No Porter component mounts, and no Porter endpoint besides the probe
 * is called, until the server answers 200 `{ exposed: true }`. Porter is
 * exposed by default, so while the first probe is in flight the page shows
 * only its header; a node withheld by `HAPI_PORTER_EXPOSED=0` (the probe's 404)
 * — reached by a direct visit or the legacy `/admin/configuration` redirect —
 * then shows the not-available notice.
 *
 * #4655: the probe's verdict has four states. Loading renders the header only
 * (plus a screen-reader status line), so an exposed instance never flashes a
 * notice; a 404 `porter_withheld` renders the not-available notice; any other
 * probe failure renders "couldn't check" with Retry — it is not proof that the
 * instance withholds Porter; and only `exposed` renders the full page. The
 * verdict reads the query status before its data, so a tab that cached
 * `exposed` falls back to the notice when a refetch answers `porter_withheld`.
 * #5212: any other failed refetch keeps a cached `exposed`, so a 502 during a
 * deploy does not unmount an import review in progress.
 */
export default function ConfigurationAdminPage() {
  useDocumentTitle("Configuration - Hapimatic");
  useEmojiFavicon(null);
  const { api } = useAppContext();
  const status = usePorterStatus(api);
  const exposure = porterExposure(status);
  // A Retry after a failed first probe sends the query back to `pending` (no
  // data is cached), which would swap the couldn't-check block — and the
  // focused Retry button — for the loading line. Keep the block mounted while
  // a Retry the user clicked is in flight. #5212: this is a local flag, not
  // TanStack's `errorUpdateCount`, which never resets for the cached query, so
  // a remount, a second probe observer (the Settings drawer) or a reconnect
  // refetch read as a Retry and flashed "Couldn't check…".
  const [retryClicked, setRetryClicked] = useState(false);
  const retrying = retryClicked && exposure === "loading";

  const header = (
    <SettingsSectionHeader
      icon={<TitleChip icon={FolderCog} accent="var(--accent-teal-200)" />}
      title="Configuration"
    />
  );

  if (exposure !== "exposed") {
    return (
      <SettingsPage data-testid="settings-configuration-root" header={header}>
        {/* One polite live region that persists across the states, so the
            notice or the couldn't-check text is announced when it replaces
            the loading line. */}
        <div
          className="mx-auto w-full max-w-content px-4 pb-6"
          aria-live="polite"
        >
          {exposure === "unknown" || retrying ? (
            <div
              className="flex flex-col items-start gap-3 py-6"
              data-testid="configuration-check-failed"
            >
              <p className="text-[length:var(--text-body)] text-[var(--app-hint)]">
                Couldn&apos;t check whether configuration import is available.
              </p>
              {/* aria-disabled, not disabled: a disabled button drops focus,
                  and this one keeps it through the retry. */}
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-disabled={status.isFetching}
                onClick={() => {
                  if (status.isFetching) return;
                  setRetryClicked(true);
                  void status.refetch().finally(() => setRetryClicked(false));
                }}
                data-testid="configuration-check-retry"
              >
                {status.isFetching ? "Checking…" : "Retry"}
              </Button>
            </div>
          ) : exposure === "loading" ? (
            <p className="sr-only" data-testid="configuration-checking">
              Checking availability…
            </p>
          ) : (
            <p
              className="py-6 text-[length:var(--text-body)] text-[var(--app-hint)]"
              data-testid="configuration-withheld"
            >
              Configuration import is not available on this instance.
            </p>
          )}
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
