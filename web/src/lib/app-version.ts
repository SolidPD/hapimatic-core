// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The client bundle's own version, and how it compares with the server's (#3491).
 *
 * Before #3491 the footer showed only `/api/version` — the SERVER's version. A
 * returning PWA whose already-registered service worker still served the
 * previous deploy's precached bundle therefore ran old code while showing the
 * new server's version. The bundle now carries the version it was built from,
 * so the footer and the update flow can tell the two apart.
 */

/** A version string both sides use: `1.0.1994`, or a test build `1.0.1994-AA`. */
const REAL_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

/**
 * The version this bundle was built from (the `__APP_VERSION__` define), or null
 * when the define is missing or is not a real version. Callers treat null as
 * "unknown", and an unknown client version is never a mismatch, so a build or a
 * test runner without the define can never start an automatic reload.
 */
export function getClientVersion(): string | null {
  const version =
    typeof __APP_VERSION__ === "undefined" ? undefined : __APP_VERSION__;
  return typeof version === "string" && REAL_VERSION.test(version)
    ? version
    : null;
}

/** The two versions when the bundle is not the build the server runs. */
export interface VersionMismatch {
  client: string;
  server: string;
}

/**
 * The mismatch between this bundle and the server, or null when there is none.
 * Both versions must be real and different: a server that has not answered
 * (`undefined`), its error fallback (`?.?.?`), or an unknown client version all
 * read as "no mismatch".
 */
export function getVersionMismatch(
  client: string | null,
  server: string | null | undefined
): VersionMismatch | null {
  if (!client || !server || !REAL_VERSION.test(server)) return null;
  return client === server ? null : { client, server };
}

/**
 * The key for one client/server pair, shared by the mismatch telemetry latch
 * and the automatic-activation guard in `@/lib/sw-update`. Versions never
 * contain `|`.
 */
export function versionPairKey(client: string, server: string): string {
  return `${client}|${server}`;
}
