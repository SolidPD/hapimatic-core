// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Serializable filesystem-extension manifest (`manifest.json`) — the P2 runtime
 * loading contract (Sub-Issue Y of epic #1264, issue #1289).
 *
 * The build-time {@link HapiExtensionManifest} (`./types.ts`) declares
 * `entryPoints.*` as `import()` THUNKS and `configSchema` as a live Zod object —
 * neither is JSON-serializable. A runtime filesystem extension ships a
 * `manifest.json`, so this schema mirrors `HapiExtensionManifest` with entry
 * points expressed as RELATIVE PATH STRINGS and NO `configSchema`. The
 * server/CLI filesystem loaders (`<pkg>/src/ext/fsLoader.ts`) parse this, then
 * wrap each path in an `import()` thunk to produce a `HapiExtensionManifest`
 * -shaped entry the EXISTING loaders consume unchanged.
 *
 * Kept zod-only (NO `node:fs`/`node:path`) because `@hapi/protocol/ext` is
 * imported by the web browser bundle — the filesystem SCAN lives in the
 * server/CLI packages (Bun runtimes), never here.
 */
import { z } from "zod";

import { CapabilitySchema } from "./capabilities";
import { catalogEntrySchema } from "../capabilityCatalog/schema";
import { PLUGIN_API_VERSION } from "./version";

/**
 * JSON-serializable manifest for a runtime filesystem extension. Mirrors the
 * subset of `HapiExtensionManifest` that survives serialization:
 * `entryPoints.<runtime>` are relative path strings (e.g. `"./server.js"`), and
 * `configSchema` is intentionally absent (a Zod schema cannot be expressed in
 * JSON — per-extension config validation for filesystem extensions is a
 * documented follow-up). `requiredAtBuild` is also absent: a filesystem
 * extension is never build-composed, so it always has a real runtime disable
 * path.
 *
 * Uses `z.object` (strip mode) rather than `z.strictObject` so a
 * forward-compatible manifest carrying unknown keys still parses against the
 * pre-stable v0.1 API.
 */
export const FsExtensionManifestSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  apiVersion: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string(),
  defaultEnabled: z.boolean(),
  dependsOn: z.array(z.string()).optional(),
  conflictsWith: z.array(z.string()).optional(),
  // Privileged host-facade capabilities the extension requires (issue #1291,
  // ADR-0003). Validated against the canonical taxonomy so a filesystem
  // extension cannot request an unknown capability; the per-runtime host gates
  // every privileged API against this set (default-deny). Optional — an
  // extension that needs no privileged capability omits it.
  capabilities: z.array(CapabilitySchema).optional(),
  // Capability-catalog entries contributed DECLARATIVELY (issue #3752). A DISTINCT
  // top-level key from `capabilities` (privilege strings) above — nesting catalog
  // entries under `capabilities` would collide with that privilege array (an object
  // there yields an empty Set and silently denies every privilege). Each entry is
  // validated against the #3741 `catalogEntrySchema`, whose plain-text allowlist
  // rejects `<`/`>`/markdown-link, a bad id prefix, or a missing `availability.scope`
  // — so a malformed catalog entry fails the WHOLE extension's load (fail-soft skip).
  catalog: z.array(catalogEntrySchema).optional(),
  entryPoints: z.object({
    server: z.string().min(1).optional(),
    web: z.string().min(1).optional(),
    cli: z.string().min(1).optional(),
  }),
  // Optional per-extension stylesheet paths (relative to the extension's
  // `dist/`, e.g. `["./style.css"]`), served over `/ext-assets/<id>/dist/<css>`
  // and injected as `<link>` by the web runtime loader (#1294). A runtime ESM
  // `import()` does NOT auto-inject imported CSS (unlike the Vite dev pipeline),
  // so a filesystem web extension declares its stylesheets explicitly here.
  styles: z.array(z.string().min(1)).optional(),
});

/** Parsed shape of a filesystem `manifest.json`. */
export type FsExtensionManifest = z.infer<typeof FsExtensionManifestSchema>;

/** Discriminated result of {@link parseFsManifest}. */
export type ParseFsManifestResult =
  | { ok: true; manifest: FsExtensionManifest }
  | { ok: false; error: string };

/** Parse `"MAJOR.MINOR[.PATCH…]"` → `{ major, minor }`, or `null` if unparseable. */
function parseMajorMinor(v: string): { major: number; minor: number } | null {
  const m = v.match(/^(\d+)\.(\d+)(?:[.\-+]|$)/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]) };
}

/**
 * apiVersion compatibility rule (#1289 expert-review MED-3). A bare
 * "major-equality" check is VACUOUS while the host is pre-stable at major 0
 * (every `0.x` shares major 0), so a `0.9.0` manifest would falsely pass against
 * a `0.1.0` host even though it targets contribution points the host lacks.
 *
 * Rule: accept iff the manifest's major equals the host's major AND its minor is
 * `<=` the host's minor (an extension may target the same or an OLDER API than
 * the host, never a NEWER one). For the current host `0.1.0` this evaluates to
 * `major === 0 && minor <= 1` and naturally rejects `major >= 1`; it also
 * self-corrects when the host later crosses a major boundary.
 */
function checkApiVersionCompat(
  apiVersion: string
): { ok: true } | { ok: false; error: string } {
  const host = parseMajorMinor(PLUGIN_API_VERSION);
  const ext = parseMajorMinor(apiVersion);
  if (!ext) {
    return {
      ok: false,
      error: `apiVersion "${apiVersion}" is not a valid MAJOR.MINOR version`,
    };
  }
  // The host constant is one we control; this branch is purely defensive.
  if (!host) {
    return {
      ok: false,
      error: `host PLUGIN_API_VERSION "${PLUGIN_API_VERSION}" is unparseable`,
    };
  }
  if (ext.major !== host.major) {
    return {
      ok: false,
      error: `apiVersion "${apiVersion}" targets major ${ext.major}, but this host provides major ${host.major} (PLUGIN_API_VERSION ${PLUGIN_API_VERSION})`,
    };
  }
  if (ext.minor > host.minor) {
    return {
      ok: false,
      error: `apiVersion "${apiVersion}" targets minor ${ext.minor}, newer than this host's ${PLUGIN_API_VERSION} — upgrade the host or lower the extension's apiVersion`,
    };
  }
  return { ok: true };
}

/**
 * Safe-parse a raw (JSON-decoded) value into an {@link FsExtensionManifest} AND
 * enforce {@link checkApiVersionCompat}. NEVER throws — returns a discriminated
 * result so the filesystem loader can fail-soft (log + skip a single extension)
 * without crashing the host (R2).
 */
export function parseFsManifest(raw: unknown): ParseFsManifestResult {
  const parsed = FsExtensionManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const at = issue && issue.path.length ? issue.path.join(".") : "(root)";
    return {
      ok: false,
      error: `invalid manifest.json at ${at}: ${issue?.message ?? "schema validation failed"}`,
    };
  }
  const compat = checkApiVersionCompat(parsed.data.apiVersion);
  if (!compat.ok) {
    return { ok: false, error: compat.error };
  }
  return { ok: true, manifest: parsed.data };
}
