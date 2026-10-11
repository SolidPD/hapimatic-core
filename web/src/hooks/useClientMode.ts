// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useState } from "react";
import { getStorageKey } from "@/lib/storage-keys";

/**
 * Opt-in kiosk client mode (issue #2848).
 *
 * A per-origin+profile UI-mode flag, activatable two ways:
 *   1. Query param `?ui=<mode>` — takes precedence and is PERSISTED to
 *      localStorage so it survives reload and in-app navigation (R5), and so a
 *      headless provisioner can activate it with a single CDP localStorage write
 *      (no UI interaction needed — R1).
 *   2. localStorage `getStorageKey("hapi_ui_mode")` — the persisted fallback.
 *
 * `kioskMode` is true only for the `r1-kiosk` value (the rabbit r1 panel target).
 * Storage access mirrors useServerUrl.ts (try/catch helpers + a `typeof window`
 * guard for SSR/test), so a disabled or full store degrades to "no flag" rather
 * than throwing into render.
 */
const UI_MODE_KEY = getStorageKey("hapi_ui_mode");
const KIOSK_MODE_VALUE = "r1-kiosk";

function readStoredUiMode(): string | null {
  try {
    return localStorage.getItem(UI_MODE_KEY);
  } catch {
    return null;
  }
}

function writeStoredUiMode(value: string): void {
  try {
    localStorage.setItem(UI_MODE_KEY, value);
  } catch {
    // Ignore storage errors
  }
}

function clearStoredUiMode(): void {
  try {
    localStorage.removeItem(UI_MODE_KEY);
  } catch {
    // Ignore storage errors
  }
}

function resolveInitialUiMode(): string | null {
  // Guard window access for SSR/test (mirrors useServerUrl.ts).
  if (typeof window === "undefined") {
    return null;
  }
  // Query param wins and is persisted so it survives reload/navigation (R5).
  try {
    const fromQuery = new URLSearchParams(window.location.search).get("ui");
    if (fromQuery) {
      writeStoredUiMode(fromQuery);
      return fromQuery;
    }
  } catch {
    // Malformed URL / access error — fall through to the persisted value.
  }
  return readStoredUiMode();
}

export function useClientMode(): {
  kioskMode: boolean;
  uiMode: string | null;
  clearUiMode: () => void;
} {
  // Synchronous initializer (like useServerUrl) so kioskMode is correct on the
  // first render — an effect-based read would flash the non-kiosk composer.
  const [uiMode, setUiMode] = useState<string | null>(() =>
    resolveInitialUiMode()
  );

  const clearUiMode = useCallback(() => {
    clearStoredUiMode();
    setUiMode(null);
  }, []);

  return {
    kioskMode: uiMode === KIOSK_MODE_VALUE,
    uiMode,
    clearUiMode,
  };
}
