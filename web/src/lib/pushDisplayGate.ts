// SPDX-License-Identifier: AGPL-3.0-only
// Push display gate (issue #4836): decides whether the service worker shows a
// received push, from the preferences snapshot the app mirrors into Cache
// Storage (`syncPreferencesToCache`).
//
// Bundled into the service worker, so it must stay free of window-dependent
// value imports: `@/lib/notificationPreferences` computes its storage keys and
// cache name from `window.location` at load time, which is wrong (or undefined)
// in a service worker — the reason `getCacheNameForServiceWorker` exists in
// `@/lib/storage-keys`. Only a type-only import from it is allowed here; the one
// value import, `@/lib/notificationKindPrefs`, is window-free by construction.
import type { NotificationPreferences } from "@/lib/notificationPreferences";
import { preferenceKeyForKind } from "@/lib/notificationKindPrefs";

/** Per-type toggle keys in the preferences snapshot. */
export type PushTypePreferenceKey = Exclude<
  keyof NotificationPreferences,
  "mutedSessions" | "globalOptOut" | "showPopups"
>;

/**
 * The preferences the gate reads. Fields are optional because a cached
 * snapshot written by an older app build may lack newer ones; a missing
 * `globalOptOut` reads as false and a missing type toggle as on (fail-open, so
 * an old cache entry never silences a wanted notification).
 */
export type PushDisplayPreferences = Partial<NotificationPreferences>;

/** Map a push payload `data.type` to its per-type toggle, or null if unmapped. */
export function getPreferenceKeyForType(
  type: string | undefined
): PushTypePreferenceKey | null {
  switch (type) {
    case "permission-request":
      return "permissions";
    case "question":
      return "questions";
    case "ready":
      return "ready";
    case "error":
      return "errors";
    case "stall-detected":
      return "stalls";
    case "usage-threshold":
      return "usage";
    default:
      // Issue #4915: a push whose type is a notification kind name reads that
      // kind's toggle, so one preference governs pop-up and push. No such push
      // is sent today (`NOTIFICATION_KIND_DEFAULTS[k].pushType` is null for
      // every non-push kind); this keeps the gate correct if one is added.
      return type ? preferenceKeyForKind(type) : null;
  }
}

/**
 * True when the service worker should display this push:
 * - never while the user has disabled notifications (`globalOptOut`);
 * - never when the push's type toggle is off;
 * - never for a muted session (issue #87) — account-global pushes (usage,
 *   job alerts) carry no sessionId and are never muted per-session.
 */
export function shouldDisplayPush(
  prefs: PushDisplayPreferences,
  payloadType: string | undefined,
  sessionId: string | undefined
): boolean {
  if (prefs.globalOptOut === true) return false;

  const preferenceKey = getPreferenceKeyForType(payloadType);
  if (preferenceKey && prefs[preferenceKey] === false) return false;

  if (sessionId && prefs.mutedSessions?.includes(sessionId)) return false;

  return true;
}

/** What the service worker should do with a received push. */
export type PushAction = "display" | "drop" | "unsubscribe";

/**
 * The service worker's full decision for a received push (issue #4836):
 * - `unsubscribe` while the user has disabled notifications — remove the push
 *   subscription and show nothing. Dropping alone is not enough: iOS counts a
 *   push that shows nothing as "silent" (and revokes after 3), while
 *   Chrome/Edge show a generic "updated in the background" notice instead.
 * - `drop` when the push's type toggle is off or its session is muted.
 * - `display` otherwise.
 */
export function decidePushAction(
  prefs: PushDisplayPreferences,
  payloadType: string | undefined,
  sessionId: string | undefined
): PushAction {
  if (prefs.globalOptOut === true) return "unsubscribe";
  return shouldDisplayPush(prefs, payloadType, sessionId) ? "display" : "drop";
}
