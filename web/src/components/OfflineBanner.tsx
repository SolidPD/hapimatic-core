// SPDX-License-Identifier: AGPL-3.0-only
import { useOnlineStatus } from "@/hooks/useOnlineStatus";

export function OfflineBanner() {
  const isOnline = useOnlineStatus();

  if (isOnline) {
    return null;
  }

  // R4 (#2779): pad past the iOS notch / Dynamic Island — see SyncingBanner.
  return (
    <div
      className="fixed top-0 left-0 right-0 bg-amber-500 text-white text-center py-2 text-sm font-medium z-50"
      style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top, 0.5rem))" }}
    >
      You're offline. Some features may be unavailable.
    </div>
  );
}
