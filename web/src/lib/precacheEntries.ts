// SPDX-License-Identifier: AGPL-3.0-only
/**
 * #4797 — the web manifest must never come from the service worker's precache.
 *
 * The server picks the manifest's identity per instance (the dev instance gets
 * "Hapimatic DEV" and the DEV-badged icons; `server/src/web/instanceManifest.ts`),
 * but vite-plugin-pwa adds `manifest.webmanifest` to the precache list with a
 * revision taken from the built bytes. A client whose service worker cached the
 * production copy would keep being answered from that cache, so the manifest is
 * dropped from the list and always goes to the network.
 */

export type PrecacheEntry = string | { url: string; revision?: string | null };

const MANIFEST_FILE = "manifest.webmanifest";

function entryPath(entry: PrecacheEntry): string {
  const url = typeof entry === "string" ? entry : entry.url;
  const withoutQuery = url.split(/[?#]/, 1)[0] ?? "";
  return withoutQuery.replace(/^\/+/, "");
}

/** The precache list without the web manifest. */
export function withoutWebManifest<T extends PrecacheEntry>(
  entries: readonly T[]
): T[] {
  return entries.filter(entry => entryPath(entry) !== MANIFEST_FILE);
}
