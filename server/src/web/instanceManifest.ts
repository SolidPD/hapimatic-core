// SPDX-License-Identifier: AGPL-3.0-only
/**
 * #4797 — per-instance web-app manifest identity.
 *
 * The web client is built once and embedded in the single binary, so the
 * build-time manifest (`web/vite.config.ts`) always carries the production
 * identity ("Hapimatic", `icons-production/…`). The rest of the client decides
 * dev vs production at runtime from the page URL; the manifest cannot, so the
 * server rewrites it per request instead: a dev request gets "Hapimatic DEV" and
 * the DEV-badged `icons/…` set, every other request gets the built bytes
 * untouched.
 *
 * Dev = this server listens on the dev port (`webappPort` 3009), OR the request
 * URL passes the same test the client applies — kept identical to
 * `web/index.html` (inline icon script), `web/src/sw.ts` (notification icons),
 * and `web/src/hooks/useIsDevInstance.ts`. Worktree instances (3010–3019) are
 * therefore production-identity, matching `useIsDevInstance`.
 */

export const MANIFEST_PATH = "/manifest.webmanifest";
export const DEV_WEBAPP_PORT = 3009;
export const DEV_APP_NAME = "Hapimatic DEV";

const PRODUCTION_ICONS_PREFIX = /^(\/?)icons-production\//;

/** The client's dev test, applied to a request URL. */
export function isDevHost(url: URL): boolean {
  return (
    url.hostname.includes("hapi-dev") ||
    url.port === "3009" ||
    url.port === "8443"
  );
}

/** True when a request to this server should see the dev identity. */
export function isDevInstanceRequest(
  requestUrl: string,
  webappPort: number
): boolean {
  if (webappPort === DEV_WEBAPP_PORT) {
    return true;
  }
  try {
    return isDevHost(new URL(requestUrl));
  } catch {
    return false;
  }
}

/**
 * Rewrite a built manifest to the dev identity. Returns null when the text is
 * not a JSON object, so the caller serves the original asset instead.
 */
export function rewriteManifestForDev(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const manifest = parsed as Record<string, unknown>;
  const rewritten: Record<string, unknown> = {
    ...manifest,
    name: DEV_APP_NAME,
    short_name: DEV_APP_NAME,
  };
  if (Array.isArray(manifest.icons)) {
    rewritten.icons = manifest.icons.map((icon: unknown) => {
      if (
        icon === null ||
        typeof icon !== "object" ||
        typeof (icon as { src?: unknown }).src !== "string"
      ) {
        return icon;
      }
      const entry = icon as Record<string, unknown> & { src: string };
      return {
        ...entry,
        src: entry.src.replace(PRODUCTION_ICONS_PREFIX, "$1icons/"),
      };
    });
  }
  return JSON.stringify(rewritten);
}

/**
 * The dev-identity manifest response for this request, or null when the
 * request is not for the manifest, is not a dev request, or the built manifest
 * is missing or unreadable — in every null case the caller falls through to its
 * existing asset serving, so production bytes never change.
 */
export async function devManifestResponse(
  requestPath: string,
  requestUrl: string,
  webappPort: number,
  readManifest: () => Promise<string | null>
): Promise<Response | null> {
  if (requestPath !== MANIFEST_PATH) {
    return null;
  }
  if (!isDevInstanceRequest(requestUrl, webappPort)) {
    return null;
  }
  let text: string | null;
  try {
    text = await readManifest();
  } catch {
    return null;
  }
  const rewritten = text === null ? null : rewriteManifestForDev(text);
  if (rewritten === null) {
    return null;
  }
  return new Response(rewritten, {
    headers: { "Content-Type": "application/manifest+json; charset=utf-8" },
  });
}
