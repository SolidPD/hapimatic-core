// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Web-side extension loader (Sub-Issue F of epic #1264).
 *
 * Iterates the generated web registry (manifests only — locked contract §5c) and
 * for every ENABLED extension awaits `manifest.entryPoints.web()` and invokes the
 * resolved module's `register(host)`. Because each `entryPoints.web` is a dynamic
 * `import()` thunk, Vite code-splits every web entry into its own chunk — a
 * DISABLED extension's chunk is never fetched.
 *
 * The caller (`web/src/main.tsx`) must run this BEFORE `bootstrap()`'s first
 * statement (locked §5h) so the host is fully populated before the route tree
 * and Telegram-environment checks run.
 *
 * Fail-soft: a `register` (or its dynamic import) that throws is logged and
 * skipped; the remaining extensions still load.
 */
import type {
  HapiExtensionManifest,
  WebExtensionHost,
} from "@hapi/protocol/ext";

import { extensions } from "../extensions.generated";

/** The generated web-registry entry shape (manifests-only). */
export interface WebExtensionEntry {
  manifest: HapiExtensionManifest;
}

export interface LoadWebExtensionsDeps {
  /**
   * Enable state from RAW `extension_prefs` rows (id → enabled), fetched from
   * `GET /api/extension-prefs` BEFORE this call. NEVER a Set of enabled ids — an
   * explicit `false` must survive and not be masked by the manifest default
   * (locked §5d). An absent entry falls back to `manifest.defaultEnabled`; a
   * failed fetch should pass an EMPTY Map (→ every extension uses its default).
   */
  enableState: ReadonlyMap<string, boolean>;
}

/**
 * Load every enabled web extension into `host`. `entries` defaults to the
 * committed generated registry and is injectable for testing.
 */
export async function loadWebExtensions(
  host: WebExtensionHost,
  deps: LoadWebExtensionsDeps,
  entries: readonly WebExtensionEntry[] = extensions
): Promise<void> {
  for (const { manifest } of entries) {
    // Enable check (R5). `requiredAtBuild` bypasses; otherwise the raw map value
    // wins and an absent id falls back to the manifest default (locked §5d).
    if (!manifest.requiredAtBuild) {
      const enabled =
        deps.enableState.get(manifest.id) ?? manifest.defaultEnabled;
      if (!enabled) continue;
    }

    // The generated web file only carries extensions with a `web` entry point
    // (R8); guard defensively regardless.
    const webEntry = manifest.entryPoints.web;
    if (!webEntry) continue;

    try {
      // Lazy resolution (locked §5c): Vite code-splits this dynamic import.
      const mod = await webEntry();
      await mod.register(host);
    } catch (err) {
      console.error(
        `[ext:loader] Failed to register web extension '${manifest.id}':`,
        err
      );
    }
  }
}
