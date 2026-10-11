// SPDX-License-Identifier: AGPL-3.0-only
import { useAdminPreferences } from "@/hooks/useAdminPreferences";
import { type ComposerSubmitBehavior } from "@/lib/composerSubmitBehavior";

/**
 * Resolves the active composer submit behavior for every composer surface.
 *
 * Reads the user's persisted choice from the /settings/preferences store (#1525,
 * epic #1034 / #1040). The default lives in the store
 * (`DEFAULT_COMPOSER_SUBMIT_BEHAVIOR` via `DEFAULT_ADMIN_PREFERENCES`), so the
 * fallback is preserved. Because `useAdminPreferences` is a module-level
 * `useSyncExternalStore`, every composer surface that calls this hook re-renders
 * in the same update when the toggle flips — no surface reads the behavior
 * constant directly, keeping the #1524 single source of truth consistent.
 */
export function useComposerSubmitBehavior(): ComposerSubmitBehavior {
  return useAdminPreferences().prefs.composerSubmitBehavior;
}
