// SPDX-License-Identifier: AGPL-3.0-only
// Notification-preference storage + service-worker cache-sync layer.
//
// Extracted from NotificationSettings.tsx (issue #87) so the pieces that write
// the `notification-preferences` cache can be shared without a component ↔ hook
// import cycle: `useMutedSessions` (hook) and `pruneOrphanedSessions`
// (localStorageCleanup, a lib) both need `syncPreferencesToCache`, and
// `NotificationSettings` needs the muted-set key — routing all of it through this
// neutral lib module keeps every consumer on the same single source of truth for
// the storage keys and the cache payload shape.
//
// localStorage (per-type booleans + the muted set + the global opt-out) is the
// UI-side source of truth; `syncPreferencesToCache()` mirrors the combined
// snapshot into a Cache Storage entry the service worker reads
// (`sw.ts:getNotificationPreferences`), because a service worker has no
// localStorage access.
//
// Issue #4836: `GLOBAL_OPT_OUT_KEY` records that the user pressed Disable. The
// browser permission stays `granted` after Disable, so without a persisted
// opt-out the app re-subscribed on its next load and notifications resumed.
import { getStorageKey, getCacheName } from "@/lib/storage-keys";
import {
  NEW_KIND_PREFERENCE_KEYS,
  type NewKindPreferenceKey,
} from "@/lib/notificationKindPrefs";

// Local storage keys for the per-type notification toggles (instance-specific).
export const STORAGE_KEYS = {
  permissions: getStorageKey("hapi:notify:permissions"),
  questions: getStorageKey("hapi:notify:questions"),
  ready: getStorageKey("hapi:notify:ready"),
  errors: getStorageKey("hapi:notify:errors"),
  stalls: getStorageKey("hapi:notify:stalls"),
  usage: getStorageKey("hapi:notify:usage"),
  // Issue #4915: the global "Show pop-ups" switch (Lane 2 toasts only) and one
  // toggle per non-push notification kind. A kind toggle gates that kind's
  // pop-up (the inbox row is always stored); `showPopups` never affects push.
  showPopups: getStorageKey("hapi:notify:showPopups"),
  toolErrors: getStorageKey("hapi:notify:toolErrors"),
  promptBlocked: getStorageKey("hapi:notify:promptBlocked"),
  apiErrors: getStorageKey("hapi:notify:apiErrors"),
  accountUnrefreshable: getStorageKey("hapi:notify:accountUnrefreshable"),
  sessionRestartFailed: getStorageKey("hapi:notify:sessionRestartFailed"),
  spawnFailed: getStorageKey("hapi:notify:spawnFailed"),
  waitingForSlot: getStorageKey("hapi:notify:waitingForSlot"),
  loopsResuming: getStorageKey("hapi:notify:loopsResuming"),
  modelReverted: getStorageKey("hapi:notify:modelReverted"),
} as const satisfies Record<
  | "permissions"
  | "questions"
  | "ready"
  | "errors"
  | "stalls"
  | "usage"
  | "showPopups"
  | NewKindPreferenceKey,
  string
>;

// Issue #87: per-session mute set. Port-scoped to match the `hapi:notify:*`
// family — the raw key is NOT used anywhere else, so this constant is the single
// definition every consumer (hook, prune, cache sync) reads.
export const MUTED_SESSIONS_KEY = getStorageKey("hapi:notify:mutedSessions");

// Issue #4836: per-origin "notifications disabled" flag, set by the Settings
// Disable button and cleared by Enable. Kept OUT of `STORAGE_KEYS` because those
// per-type toggles default to on and drive the Settings toggle list; this flag
// defaults to off and has its own guarded helpers below.
export const GLOBAL_OPT_OUT_KEY = getStorageKey("hapi:notify:globalOptOut");

// Cache storage for service worker access (instance-specific).
export const PREFERENCES_CACHE_NAME = getCacheName("notification-preferences");
// Issue #4836: ROOT-relative on purpose. The Cache API resolves a string key
// against the calling global's base URL — a page's document path, but the
// service worker's script URL — so the old relative "preferences.json" was
// written to e.g. /settings/preferences.json while sw.ts read /preferences.json,
// and the service worker never saw any preference (toggles, mute, opt-out).
// Must stay identical to PREFERENCES_KEY in sw.ts.
export const PREFERENCES_KEY = "/preferences.json";

export type NotificationPreferences = {
  permissions: boolean;
  questions: boolean;
  ready: boolean;
  errors: boolean;
  stalls: boolean;
  usage: boolean;
  // Issue #4915: the global "Show pop-ups" switch (Lane 2 toasts only).
  showPopups: boolean;
  // Issue #87: session IDs the user has muted. A muted id suppresses that
  // session's push in the service worker even when its type toggle is on.
  mutedSessions: string[];
  // Issue #4836: true after the user pressed Disable. The service worker shows
  // nothing and unsubscribes while this is set.
  globalOptOut: boolean;
} & Record<NewKindPreferenceKey, boolean>; // Issue #4915: one toggle per non-push kind

export function getStoredPreference(key: string): boolean {
  if (typeof window === "undefined") return true;
  const stored = localStorage.getItem(key);
  return stored === null ? true : stored === "true";
}

export function setStoredPreference(key: string, value: boolean): void {
  localStorage.setItem(key, String(value));
}

/**
 * Read the muted-session id set from localStorage. Every access is
 * try/catch-guarded so a disabled or malformed store degrades to "nothing muted"
 * instead of throwing into a caller.
 */
export function readMutedSessions(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(MUTED_SESSIONS_KEY);
    if (!raw) return new Set();
    const ids = JSON.parse(raw) as string[];
    return new Set(Array.isArray(ids) ? ids : []);
  } catch {
    return new Set();
  }
}

/** Persist the muted-session id set to localStorage (try/catch-guarded). */
export function writeMutedSessions(ids: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(MUTED_SESSIONS_KEY, JSON.stringify([...ids]));
  } catch {
    // Ignore localStorage errors (quota / disabled store).
  }
}

/**
 * True when the user has disabled notifications on this origin (issue #4836).
 * Defaults to false, and any storage error also reads as false.
 */
export function readGlobalOptOut(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(GLOBAL_OPT_OUT_KEY) === "true";
  } catch {
    return false;
  }
}

/** A localStorage write that reports whether it landed. */
export type StorageWriter = (key: string, value: string) => boolean;

function plainSetItem(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (error) {
    console.error("[notificationPreferences] Failed to save a setting:", error);
    return false;
  }
}

/**
 * Persist the global opt-out flag (issue #4836). Returns false when the write
 * failed, because a lost opt-out is not harmless: the next app load sees no
 * opt-out and subscribes again. Settings passes `safeSetItem`, which frees
 * space and retries when storage is full; it lives in `localStorageCleanup`,
 * which imports this module, so it is passed in rather than imported here.
 */
export function writeGlobalOptOut(
  value: boolean,
  setItem: StorageWriter = plainSetItem
): boolean {
  if (typeof window === "undefined") return false;
  return setItem(GLOBAL_OPT_OUT_KEY, String(value));
}

/**
 * Drop any muted id no longer present in the live session set (issue #87, R6).
 * Returns true when the stored set changed, so the caller can re-sync the cache.
 */
export function pruneMutedSessions(validIds: Set<string>): boolean {
  const current = readMutedSessions();
  if (current.size === 0) return false;
  const filtered = new Set([...current].filter(id => validIds.has(id)));
  if (filtered.size === current.size) return false;
  writeMutedSessions(filtered);
  return true;
}

/**
 * The current preference snapshot from localStorage: every toggle (default on),
 * the muted set and the global opt-out. The service-worker cache mirrors this
 * object, and `NotificationListener` reads it at decision time (issue #4915), so
 * a toggle applies to the next notification without a re-render. A storage
 * error propagates to the caller.
 */
export function readNotificationPreferences(): NotificationPreferences {
  const kinds = Object.fromEntries(
    NEW_KIND_PREFERENCE_KEYS.map(key => [
      key,
      getStoredPreference(STORAGE_KEYS[key]),
    ])
  ) as Record<NewKindPreferenceKey, boolean>;
  return {
    permissions: getStoredPreference(STORAGE_KEYS.permissions),
    questions: getStoredPreference(STORAGE_KEYS.questions),
    ready: getStoredPreference(STORAGE_KEYS.ready),
    errors: getStoredPreference(STORAGE_KEYS.errors),
    stalls: getStoredPreference(STORAGE_KEYS.stalls),
    usage: getStoredPreference(STORAGE_KEYS.usage),
    showPopups: getStoredPreference(STORAGE_KEYS.showPopups),
    ...kinds,
    mutedSessions: [...readMutedSessions()],
    globalOptOut: readGlobalOptOut(),
  };
}

/** Resolves false only when a write was attempted and failed. */
async function writePreferencesToCache(): Promise<boolean> {
  if (typeof window === "undefined" || !("caches" in window)) return true;

  // Issue #4836: building the snapshot is inside the try too. A throw here
  // (e.g. localStorage disabled) used to reject the shared sync chain, after
  // which every later sync — including the one Disable awaits before it
  // unsubscribes — rejected without running.
  try {
    const prefs = readNotificationPreferences();

    const cache = await caches.open(PREFERENCES_CACHE_NAME);
    const response = new Response(JSON.stringify(prefs), {
      headers: { "Content-Type": "application/json" },
    });
    await cache.put(PREFERENCES_KEY, response);
    return true;
  } catch (error) {
    console.error(
      "[notificationPreferences] Failed to sync preferences to cache:",
      error
    );
    return false;
  }
}

// Serialize every cache write through a single in-flight chain. Each write reads
// localStorage fresh at execution time, so chaining guarantees the LAST write
// observes the latest localStorage state and lands last — two rapid mute toggles
// can no longer race an older snapshot over a newer one (issue #87). Applies to
// every caller (mute toggles, prune, per-type toggles), which is strictly safer
// than the previous unsequenced writes.
let syncChain: Promise<boolean> = Promise.resolve(true);

/**
 * Mirror the current localStorage notification preferences (per-type booleans +
 * muted session set + global opt-out) into the Cache Storage entry the service
 * worker reads.
 * Serialized against concurrent callers; never rejects. Resolves false when the
 * write failed, so the service worker still holds the previous preferences.
 */
export function syncPreferencesToCache(): Promise<boolean> {
  syncChain = syncChain.then(() => writePreferencesToCache());
  return syncChain;
}
