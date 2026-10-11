// SPDX-License-Identifier: AGPL-3.0-only
import { Button } from "@/components/ui/button";

export function AuthErrorBanner({
  visible,
  onLogin,
}: {
  visible: boolean;
  onLogin?: () => void;
}) {
  if (!visible) {
    return null;
  }

  // R4 (#2779): pad past the iOS notch / Dynamic Island — see SyncingBanner.
  return (
    <div
      className="fixed top-0 left-0 right-0 bg-red-600 text-white text-center py-2 text-sm font-medium z-50 flex items-center justify-center gap-2"
      style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top, 0.5rem))" }}
    >
      <span>Session expired. Please log in again.</span>
      {onLogin && (
        <Button
          type="button"
          variant="ghost"
          onClick={onLogin}
          className="ml-2 h-auto rounded bg-white px-3 py-0.5 text-xs font-semibold text-red-600 transition-colors hover:bg-red-50 hover:text-red-600"
        >
          Log In
        </Button>
      )}
    </div>
  );
}
