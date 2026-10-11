// SPDX-License-Identifier: AGPL-3.0-only
/**
 * C3 (#1988) theme persistence — the localStorage layer that makes a theme choice
 * survive reloads and applies it pre-paint. C1 (#1986) holds the active theme in
 * memory; this module reads the stored id synchronously at bootstrap (fed into C1's
 * `ThemeProvider` `initialThemeId` prop) and writes it back on change (via
 * `ThemePersistenceBridge`).
 *
 * Deliberately C1-registry-independent: it stores/reads the RAW id string and lets
 * C1's `getThemeById` fall back for an unknown/stale id (R4), so this module
 * typechecks and unit-tests in isolation regardless of C1's exports.
 *
 * DECISION — localStorage-only for the MVP (NOT server-side): the pre-paint AC needs
 * a SYNCHRONOUS bootstrap read, which localStorage provides; a server-persisted
 * theme needs an async authenticated round-trip and would paint the default first
 * (the flash the AC forbids). The existing server preference infra
 * (`server/src/web/routes/preferences.ts`) is instance-global + auth-gated, so a
 * true cross-device "follows me" theme is deferred as a sync-on-auth stretch. See
 * `web/CLAUDE.md`.
 *
 * Pattern: `web/src/lib/route-persistence.ts` (getStorageKey-scoped key + synchronous
 * bootstrap read + safe write) and `useAdminPreferences`' "ignore storage errors"
 * try/catch convention (R3).
 */

import { getStorageKey } from "@/lib/storage-keys";

/**
 * Port-scoped, versioned storage key. `:v1` is the migration boundary; the port
 * suffix (added by `getStorageKey`) isolates instances sharing a hostname.
 */
const THEME_KEY = "hapi:theme:v1";

/**
 * Read the persisted theme id synchronously (for the bootstrap pre-paint read).
 * Returns `undefined` when nothing is stored OR storage is unavailable/throws
 * (private mode, disabled) — never throws, so the caller falls back to the default
 * theme (R3). Does NOT validate against C1's registry: returns the raw stored value
 * and lets C1's `getThemeById` degrade an unknown/stale id to the default (R4).
 */
export function getStoredThemeId(): string | undefined {
  try {
    return localStorage.getItem(getStorageKey(THEME_KEY)) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Persist the selected theme id. Swallows any storage error (quota / private mode) —
 * a non-persisted choice is cosmetic and must never throw into the render path (R3).
 */
export function persistThemeId(id: string): void {
  try {
    localStorage.setItem(getStorageKey(THEME_KEY), id);
  } catch {
    /* ignore storage errors (quota / private mode) — R3 */
  }
}

/**
 * Remove the persisted theme id (used by tests + a defensive reset path).
 */
export function clearStoredThemeId(): void {
  try {
    localStorage.removeItem(getStorageKey(THEME_KEY));
  } catch {
    /* ignore storage errors — R3 */
  }
}
