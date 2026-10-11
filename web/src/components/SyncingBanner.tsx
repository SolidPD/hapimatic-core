// SPDX-License-Identifier: AGPL-3.0-only
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { Spinner } from "@/components/Spinner";

export function SyncingBanner({ isSyncing }: { isSyncing: boolean }) {
  const isOnline = useOnlineStatus();

  // Don't show syncing banner when offline (OfflineBanner takes precedence)
  if (!isSyncing || !isOnline) {
    return null;
  }

  // R4 (#2779): retain the fixed-top overlay but pad past the iOS notch /
  // Dynamic Island via env(safe-area-inset-top). On desktop (inset 0) this
  // resolves to the base 0.5rem = the former py-2 top, so no regression.
  return (
    <div
      className="fixed top-0 left-0 right-0 bg-[var(--app-banner-bg)] text-[var(--app-banner-text)] text-center py-2 text-sm font-medium z-50 flex items-center justify-center gap-2 border-b border-[var(--app-divider)]"
      style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top, 0.5rem))" }}
    >
      <Spinner
        size="sm"
        label={null}
        className="text-[var(--app-banner-text)]"
      />
      Syncing…
    </div>
  );
}
