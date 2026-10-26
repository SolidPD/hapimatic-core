// SPDX-License-Identifier: AGPL-3.0-only
import { useState, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import type { ApiClient } from "@/api/client";
import { usePushNotifications } from "@/hooks/usePushNotifications";
import { safeSetItem } from "@/lib/localStorageCleanup";
import {
  STORAGE_KEYS,
  setStoredPreference,
  readNotificationPreferences,
  syncPreferencesToCache,
  writeGlobalOptOut,
  writeMutedSessions,
} from "@/lib/notificationPreferences";
import { NEW_KIND_PREFERENCE_KEYS } from "@/lib/notificationKindPrefs";

// Storage keys, the per-type helpers, and the SW cache-sync (which now also
// carries the per-session mute set, issue #87) live in @/lib/notificationPreferences
// so the useMutedSessions hook and localStorageCleanup can share them without a
// component ↔ hook import cycle.

function BellIcon(props: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.className}
    >
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

function Toggle(props: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label: string;
  description?: string;
}) {
  const { checked, onChange, disabled, label, description } = props;

  return (
    <Button
      variant="ghost"
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`h-auto w-full items-start justify-start gap-3 whitespace-normal rounded-lg p-3 text-left ${
        disabled
          ? "cursor-not-allowed opacity-50"
          : "hover:bg-[var(--app-bg-hover)]"
      }`}
    >
      <div
        className={`relative flex-shrink-0 h-6 w-11 rounded-full transition-colors ${
          checked ? "bg-[var(--app-button)]" : "bg-[var(--app-border)]"
        }`}
      >
        <div
          className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
            checked ? "translate-x-5" : "translate-x-0"
          }`}
        />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-[var(--app-fg)]">{label}</div>
        {description && (
          <div className="text-xs text-[var(--app-hint)] mt-0.5">
            {description}
          </div>
        )}
      </div>
    </Button>
  );
}

type PreferenceKey = keyof typeof STORAGE_KEYS;

// The push-and-pop-up rows that existed before #4915, unchanged.
const PUSH_KIND_ROWS: Array<{
  key: PreferenceKey;
  label: string;
  description: string;
}> = [
  {
    key: "permissions",
    label: "Permission Requests",
    description: "When Claude needs approval for an action",
  },
  {
    key: "questions",
    label: "Questions",
    description: "When Claude asks you a question",
  },
  {
    key: "ready",
    label: "Ready for Input",
    description: "When Claude finishes and is waiting",
  },
  {
    key: "errors",
    label: "Errors",
    description: "When something goes wrong",
  },
  {
    key: "stalls",
    label: "Stall Detection",
    description: "When a session appears stuck with no progress",
  },
  {
    key: "usage",
    label: "Usage Alerts",
    description: "When an account crosses a usage threshold",
  },
];

// Issue #4915: one row per non-push notification kind. Each gates that kind's
// pop-up; the inbox entry is always stored (epic decision D3).
const EVENT_KIND_ROWS: Record<
  (typeof NEW_KIND_PREFERENCE_KEYS)[number],
  { label: string; description: string }
> = {
  toolErrors: {
    label: "Tool Errors",
    description: "When a tool call in a session fails",
  },
  promptBlocked: {
    label: "Blocked Prompts",
    description: "When a hook blocks a prompt you sent",
  },
  apiErrors: {
    label: "API Errors",
    description: "When the API retries, overloads or recovers",
  },
  accountUnrefreshable: {
    label: "Account Needs Re-login",
    description: "When an account's login expires and cannot refresh",
  },
  sessionRestartFailed: {
    label: "Session Restart Failed",
    description: "When a session cannot restart after a token refresh",
  },
  spawnFailed: {
    label: "Session Creation Failed",
    description: "When a new session fails to start",
  },
  waitingForSlot: {
    label: "Waiting for a Session Slot",
    description: "When a reconnect waits for a free slot",
  },
  loopsResuming: {
    label: "Scheduled Jobs Resuming",
    description: "When paused jobs resume after a reconnect",
  },
  modelReverted: {
    label: "Model Reverted",
    description: "When a session falls back to a different model",
  },
};

export type NotificationSettingsBodyProps = {
  api: ApiClient | null;
};

export function NotificationSettingsBody(props: NotificationSettingsBodyProps) {
  const { api } = props;
  const {
    isSupported,
    permission,
    isSubscribed,
    requestPermission,
    subscribe,
    unsubscribe,
  } = usePushNotifications(api);

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Per-kind notification preferences + the "Show pop-ups" switch (#4915).
  // One reader for every toggle (the same snapshot the service worker gets).
  const [prefs, setPrefs] = useState<Record<PreferenceKey, boolean>>(
    readNotificationPreferences
  );

  // Sync preferences to cache on mount
  useEffect(() => {
    void syncPreferencesToCache();
  }, []);

  const handleEnableNotifications = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      // Issue #4836: the click is the explicit intent to receive notifications,
      // so clear the opt-out first. If permission is then denied the browser
      // stays unsubscribed anyway (the app only auto-subscribes when granted).
      // The cache sync is started here but awaited only before subscribe():
      // Safari shows the permission prompt only within a recent user gesture,
      // so nothing may be awaited ahead of requestPermission().
      // If the opt-out cannot be cleared, subscribing would be undone (the
      // service worker unsubscribes on the first push, the next load
      // unsubscribes again), so say so instead of reporting success.
      if (!writeGlobalOptOut(false, safeSetItem)) {
        setError(
          "Notifications could not be turned on because this site's browser storage is full."
        );
        return;
      }
      const optOutCleared = syncPreferencesToCache();

      const permissionGranted = await requestPermission();
      if (!permissionGranted) {
        setError(
          "Notification permission was denied. Please enable notifications in your browser settings."
        );
        return;
      }

      // The service worker must see the cleared opt-out before a push can
      // reach the new subscription, or it would unsubscribe it again.
      if (!(await optOutCleared)) {
        setError(
          "Notifications could not be turned on because the setting could not be saved. Please try again."
        );
        return;
      }
      const subscribed = await subscribe();
      if (!subscribed) {
        setError(
          "Failed to subscribe to push notifications. Please try again."
        );
      } else {
        // #87 feedback (#2745 round): the global toggle BROADCASTS — flipping
        // it clears every per-session mute so all sessions immediately follow
        // the new global state (individual bells can diverge again afterwards).
        writeMutedSessions(new Set());
        void syncPreferencesToCache();
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "An unexpected error occurred."
      );
    } finally {
      setIsLoading(false);
    }
  }, [requestPermission, subscribe]);

  const handleDisableNotifications = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      // Issue #4836: persist the opt-out BEFORE unsubscribing, and keep it even
      // if the unsubscribe fails. `unsubscribe()` removes the browser
      // subscription before the server DELETE, so a failed DELETE returns false
      // after the browser side already succeeded; without the flag the next app
      // load re-subscribed (permission stays `granted`) and pushes resumed.
      // If the opt-out cannot be saved (storage full even after cleanup), still
      // unsubscribe, but tell the user: the next load would subscribe again.
      const saved = writeGlobalOptOut(true, safeSetItem);
      await syncPreferencesToCache();

      const success = await unsubscribe();
      if (!saved) {
        setError(
          "Notifications are off, but this setting could not be saved because this site's browser storage is full. They may turn back on the next time the app opens."
        );
      } else if (!success) {
        setError("Failed to unsubscribe from push notifications.");
      } else {
        // #87 feedback (#2745 round): broadcast in the disable direction too —
        // per-session overrides are wiped so re-enabling later starts every
        // session fresh on the (new) global state.
        writeMutedSessions(new Set());
        void syncPreferencesToCache();
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "An unexpected error occurred."
      );
    } finally {
      setIsLoading(false);
    }
  }, [unsubscribe]);

  const handleTogglePreference = useCallback(
    (key: PreferenceKey, value: boolean) => {
      setStoredPreference(STORAGE_KEYS[key], value);
      setPrefs(current => ({ ...current, [key]: value }));
      // Sync to cache for service worker access
      void syncPreferencesToCache();
    },
    []
  );

  const renderContent = () => {
    if (!isSupported) {
      // Debug info for iOS troubleshooting
      const hasServiceWorker =
        typeof navigator !== "undefined" && "serviceWorker" in navigator;
      const hasPushManager =
        typeof window !== "undefined" && "PushManager" in window;
      const hasNotification =
        typeof window !== "undefined" && "Notification" in window;
      const isStandalone =
        typeof window !== "undefined" &&
        (window.matchMedia("(display-mode: standalone)").matches ||
          (window.navigator as Navigator & { standalone?: boolean })
            .standalone === true);
      const isSecureContext =
        typeof window !== "undefined" && window.isSecureContext;
      const protocol =
        typeof window !== "undefined" ? window.location.protocol : "unknown";

      // Parse iOS version from userAgent
      let iosVersion = "N/A";
      if (typeof navigator !== "undefined") {
        const match = navigator.userAgent.match(/OS (\d+)[_.](\d+)/);
        if (match) {
          iosVersion = `${match[1]}.${match[2]}`;
        }
      }

      return (
        <div className="py-6 text-center">
          <div className="text-[var(--app-hint)] text-sm mb-3">
            Push notifications are not supported on this device or browser.
          </div>
          <div className="text-xs text-[var(--app-hint)] opacity-70 space-y-1">
            <div>ServiceWorker: {hasServiceWorker ? "✓" : "✗"}</div>
            <div>PushManager: {hasPushManager ? "✓" : "✗"}</div>
            <div>Notification: {hasNotification ? "✓" : "✗"}</div>
            <div>Standalone PWA: {isStandalone ? "✓" : "✗"}</div>
            <div>Secure Context: {isSecureContext ? "✓" : "✗"}</div>
            <div>Protocol: {protocol}</div>
            <div>iOS Version: {iosVersion}</div>
            {!isSecureContext && (
              <div className="mt-2 text-[var(--app-badge-warning-text)]">
                ServiceWorker requires HTTPS. Current: {protocol}
              </div>
            )}
            {isSecureContext && !hasPushManager && (
              <div className="mt-2 text-[var(--app-badge-warning-text)]">
                iOS requires 16.4+ for push notifications.
              </div>
            )}
          </div>
        </div>
      );
    }

    if (permission === "denied") {
      return (
        <div className="py-6 text-center">
          <div className="text-[var(--app-badge-error-text)] text-sm mb-2">
            Notifications are blocked
          </div>
          <div className="text-[var(--app-hint)] text-xs">
            To enable notifications, update your browser or device settings.
          </div>
        </div>
      );
    }

    if (!isSubscribed) {
      return (
        <div className="py-6 flex flex-col items-center gap-4">
          <BellIcon className="h-12 w-12 text-[var(--app-hint)]" />
          <div className="text-center">
            <div className="text-sm font-medium text-[var(--app-fg)] mb-1">
              Enable Push Notifications
            </div>
            <div
              className={
                /* design-tokens-allow: layout max-width, no exact spacing token */ "text-xs text-[var(--app-hint)] max-w-[250px]"
              }
            >
              Get notified when Claude needs your attention or finishes a task.
            </div>
          </div>
          <Button onClick={handleEnableNotifications} disabled={isLoading}>
            {isLoading ? "Enabling..." : "Enable Notifications"}
          </Button>
        </div>
      );
    }

    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between px-3 py-2 bg-[var(--app-bg-hover)] rounded-lg">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-[var(--app-badge-success-text)]" />
            <span className="text-sm text-[var(--app-fg)]">
              Notifications enabled
            </span>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleDisableNotifications}
            disabled={isLoading}
          >
            {isLoading ? "Disabling..." : "Disable"}
          </Button>
        </div>
      </div>
    );
  };

  // Issue #4915: the pop-up switch and the per-kind list render whether or not
  // push is supported or subscribed — a pop-up needs no push subscription.
  const renderPreferences = () => (
    <div className="mt-4 border-t border-[var(--app-border)] pt-4">
      <Toggle
        checked={prefs.showPopups}
        onChange={v => handleTogglePreference("showPopups", v)}
        label="Show Pop-ups"
        description="Show a pop-up when a notification arrives. Notifications still appear in the inbox and the badge."
      />
      <div className="mt-2 text-xs font-medium text-[var(--app-hint)] uppercase tracking-wide px-3 mb-2">
        Notification Types
      </div>
      <div className="flex flex-col">
        {PUSH_KIND_ROWS.map(row => (
          <Toggle
            key={row.key}
            checked={prefs[row.key]}
            onChange={v => handleTogglePreference(row.key, v)}
            label={row.label}
            description={row.description}
          />
        ))}
        {NEW_KIND_PREFERENCE_KEYS.map(key => (
          <Toggle
            key={key}
            checked={prefs[key]}
            onChange={v => handleTogglePreference(key, v)}
            label={EVENT_KIND_ROWS[key].label}
            description={EVENT_KIND_ROWS[key].description}
          />
        ))}
      </div>
    </div>
  );

  return (
    <div className="mt-4">
      {renderContent()}
      {renderPreferences()}
      {error && (
        <div className="mt-4 rounded-md bg-red-900/20 p-3 text-sm text-red-400">
          {error}
        </div>
      )}
    </div>
  );
}
