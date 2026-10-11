// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Extension preferences configuration helpers (Sub-Issue E of Epic #1264).
 *
 * Pure, side-effect-free wrappers over an `ExtensionPrefsStore` reference passed
 * in by the caller. Configuration is created BEFORE Store at startup, so holding a
 * Store reference on the Configuration class would invert the load order — instead
 * the store is passed at call time. These helpers are the stable contract surface
 * that Sub-Issue F's extension loader will import from; the manifest-default
 * coupling (once Sub-Issue A's `HapiExtensionManifest` lands) can be added here
 * without churning callers.
 */

import type {
  ExtensionPrefsStore,
  StoredExtensionPref,
} from "../store/extensionPrefsStore";

export type { StoredExtensionPref };

/** Read prefs for an extension, falling back to `defaultEnabled` when no row exists. */
export function readExtensionPref(
  store: ExtensionPrefsStore,
  id: string,
  defaultEnabled: boolean
): StoredExtensionPref {
  return store.get(id, defaultEnabled);
}

/** Write prefs for an extension (partial writes preserve unspecified fields). */
export function writeExtensionPref(
  store: ExtensionPrefsStore,
  id: string,
  pref: { enabled?: boolean; config?: Record<string, unknown> | null }
): StoredExtensionPref {
  return store.set(id, pref);
}

/** Enumerate all persisted prefs (for the future preferences UI). */
export function listExtensionPrefs(
  store: ExtensionPrefsStore
): StoredExtensionPref[] {
  return store.list();
}

/**
 * Remove prefs for an extension — reverts it to the manifest default
 * (`defaultEnabled`). NOT a data purge. Returns `true` if a row was deleted.
 */
export function removeExtensionPref(
  store: ExtensionPrefsStore,
  id: string
): boolean {
  return store.remove(id);
}
