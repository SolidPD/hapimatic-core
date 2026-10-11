// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Extension marketplace registry resolver (issue #1292, epic #1264 Phase 5).
 *
 * The remote-discovery layer atop the runtime filesystem loader (#1289) and the
 * lifecycle CLI (#1290). DECISION-1 (Matt, 2026-07-20): a GitHub-based / Obsidian-style
 * STAGED registry — a metadata-only catalog (`community-extensions.json`) in a dedicated
 * `hapimatic-extensions` repo points at each extension's OWN GitHub repo; `hapi ext
 * install <publisher>.<name>` resolves the id → the author repo's git URL, which the
 * EXISTING install pipeline (`cli/src/ext/manage.ts` → `materializeSource`) shallow-clones
 * and installs. No extension code lives in the catalog — only metadata.
 *
 * Browser-safe (`fetch` + `zod` only, NO `node:fs`, NO `process.env`) so it lives in
 * `@hapi/protocol/ext` and is importable by cli (manage.ts wiring), server (the future
 * `/api/ext/*` route), and web (the browse UI). The env-driven catalog-URL default is
 * read by the CLI/server CALLER and passed in via `opts.catalogUrl` — this module never
 * touches `process.env`, preserving the browser-safe contract (mirrors `fsManifest.ts`).
 *
 * Uses `z.object` (strip mode) rather than `z.strictObject` so a forward-compatible
 * catalog carrying unknown keys (e.g. a future ratings field) still parses against the
 * pre-stable v0 shape — the same choice `fsManifest.ts` makes.
 */
import { z } from "zod";

/**
 * One metadata-only catalog entry (the Obsidian `community-plugins.json` model).
 * `id` is the canonical `<publisher>.<name>`; `repo` is the author's `owner/name`
 * GitHub repo whose default branch carries the extension's `manifest.json`.
 */
export const CommunityExtensionEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  publisher: z.string().min(1),
  description: z.string(),
  repo: z
    .string()
    .min(1)
    .regex(/^[^/\s]+\/[^/\s]+$/, "repo must be in 'owner/name' form"),
  branch: z.string().min(1).optional(),
});

/** Parsed shape of a single catalog entry. */
export type CommunityExtensionEntry = z.infer<
  typeof CommunityExtensionEntrySchema
>;

/** The catalog is a JSON array of entries. */
export const CommunityExtensionsCatalogSchema = z.array(
  CommunityExtensionEntrySchema
);

/** Parsed shape of a `community-extensions.json` catalog. */
export type CommunityExtensionsCatalog = z.infer<
  typeof CommunityExtensionsCatalogSchema
>;

/**
 * Default catalog location — the dedicated `hapimatic-extensions` repo (DECISION-1
 * sub-decision, Matt 2026-07-20). The CLI/server caller overrides this via the
 * `HAPI_EXTENSION_CATALOG_URL` env var, read caller-side and passed as `opts.catalogUrl`
 * (kept out of this module to preserve the browser-safe / no-`process.env` contract).
 */
export const DEFAULT_CATALOG_URL =
  "https://raw.githubusercontent.com/MattStarfield/hapimatic-extensions/main/community-extensions.json";

/** Typed failure reasons so callers (CLI / UI) can message precisely. */
export type RegistryErrorReason =
  | "fetch_failed"
  | "invalid_catalog"
  | "not_found";

/** Thrown by {@link resolveRegistryId} / {@link fetchCatalog} on any resolution failure. */
export class RegistryError extends Error {
  constructor(
    readonly reason: RegistryErrorReason,
    message: string
  ) {
    super(message);
    this.name = "RegistryError";
  }
}

/**
 * Resolved install target for a registry id. `id` is the integrity anchor: the install
 * pipeline MUST verify the staged `manifest.json`'s `id` equals this value before placing
 * the extension (guards a catalog entry pointing at a repo whose manifest declares a
 * different id).
 */
export interface ResolvedRegistrySource {
  id: string;
  /** The install SOURCE handed to the existing pipeline — the author repo's `.git` URL. */
  source: string;
  publisher: string;
  entry: CommunityExtensionEntry;
}

/**
 * Parse a raw (JSON-decoded) value into a catalog. NEVER throws — returns a discriminated
 * result so callers can message a bad catalog without a try/catch (mirrors
 * `parseFsManifest`).
 */
export function parseCommunityCatalog(
  raw: unknown
):
  | { ok: true; catalog: CommunityExtensionsCatalog }
  | { ok: false; error: string } {
  const parsed = CommunityExtensionsCatalogSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const at = issue && issue.path.length ? issue.path.join(".") : "(root)";
    return {
      ok: false,
      error: `invalid catalog at ${at}: ${issue?.message ?? "schema validation failed"}`,
    };
  }
  return { ok: true, catalog: parsed.data };
}

/** Find a catalog entry by exact id (case-sensitive — ids are canonical). */
export function findCatalogEntry(
  catalog: CommunityExtensionsCatalog,
  id: string
): CommunityExtensionEntry | null {
  return catalog.find(e => e.id === id) ?? null;
}

/**
 * Build the install SOURCE for an entry — the author repo's `.git` HTTPS URL, which
 * `materializeSource` (#1290) recognizes as a git source and shallow-clones. v0 installs
 * from the repo's DEFAULT branch; the optional `branch` field is surfaced on the entry
 * for a future release-tag refinement (the current install pipeline clones HEAD and does
 * not honor a per-source branch).
 */
export function entryToSource(entry: CommunityExtensionEntry): string {
  return `https://github.com/${entry.repo}.git`;
}

/**
 * Fetch + parse the catalog from `catalogUrl`. `fetchImpl` is injectable for tests
 * (defaults to the global `fetch`, present in Bun and the browser). Throws
 * {@link RegistryError} with `reason` `fetch_failed` (network / non-2xx) or
 * `invalid_catalog` (non-JSON / schema mismatch).
 */
export async function fetchCatalog(
  catalogUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<CommunityExtensionsCatalog> {
  let res: Response;
  try {
    res = await fetchImpl(catalogUrl);
  } catch (err) {
    throw new RegistryError(
      "fetch_failed",
      `catalog fetch failed for ${catalogUrl}: ${(err as Error).message}`
    );
  }
  if (!res.ok) {
    throw new RegistryError(
      "fetch_failed",
      `catalog fetch failed for ${catalogUrl}: HTTP ${res.status}`
    );
  }
  let raw: unknown;
  try {
    raw = await res.json();
  } catch (err) {
    throw new RegistryError(
      "invalid_catalog",
      `catalog at ${catalogUrl} is not valid JSON: ${(err as Error).message}`
    );
  }
  const parsed = parseCommunityCatalog(raw);
  if (!parsed.ok) {
    throw new RegistryError("invalid_catalog", parsed.error);
  }
  return parsed.catalog;
}

/**
 * Resolve a bare registry id (`<publisher>.<name>`) into an install source by looking it
 * up in the catalog. Throws {@link RegistryError} on fetch/parse failure (`fetch_failed`
 * / `invalid_catalog`) or when the id is absent from the catalog (`not_found`).
 */
export async function resolveRegistryId(
  id: string,
  opts: { catalogUrl?: string; fetchImpl?: typeof fetch } = {}
): Promise<ResolvedRegistrySource> {
  const catalogUrl = opts.catalogUrl ?? DEFAULT_CATALOG_URL;
  const catalog = await fetchCatalog(catalogUrl, opts.fetchImpl ?? fetch);
  const entry = findCatalogEntry(catalog, id);
  if (!entry) {
    throw new RegistryError(
      "not_found",
      `extension '${id}' is not in the catalog at ${catalogUrl}`
    );
  }
  return {
    id: entry.id,
    source: entryToSource(entry),
    publisher: entry.publisher,
    entry,
  };
}
