// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Server extension capability-catalog facade (issue #3752, Sub-Issue L / R1, Task 2).
 *
 * The validate-and-owner-stamp helper behind `ServerExtensionHost.capabilities.add`
 * (`server/src/ext/host.ts`). Extensions contribute capability-catalog entries
 * through the host facade; this module is the single place that turns a raw,
 * possibly-untrusted authored entry into a validated, owner-stamped
 * {@link CatalogEntry} the loader can drain into the live Tier-1 catalog.
 *
 * SERVER-ONLY (ER 2026-09-16 3752-6): the CLI host is documented stateless and the
 * web host is a singleton — neither carries a per-extension identity nor a
 * live-catalog assembler to reach — so the facade lives on the server host only,
 * where `buildCatalogProvider` assembles the catalog at the end of `buildWebApp`.
 */
import { catalogEntrySchema, type CatalogEntry } from "@hapi/protocol";

/**
 * Validate an extension-contributed catalog entry and stamp its owner.
 *
 * UNTRUSTED input path (#3752): this uses `catalogEntrySchema.parse(entry)`'s
 * RESULT — NOT the `defineCapability` passthrough — so the strict-mode schema
 * REJECTS unknown keys and the R6 plain-text allowlist rejects control characters,
 * `<`, `>`, and markdown-link syntax at LOAD. A `<script>`-bearing field therefore
 * throws HERE, before the entry ever reaches the catalog or the browser (AC: a
 * `<script>` description is rejected at load by the schema).
 *
 * `owner` is FORCED to `manifestId` — an extension cannot spoof another owner even
 * if it authored an `owner` field. `trusted` is deliberately NOT stamped here:
 * the facade has no provenance, so `trusted` is stamped from the load path at the
 * loader drain site (R3b) — build-composed ⇒ the entry's own value (schema-default
 * `true`), runtime filesystem ⇒ forced `false` (fail-closed).
 *
 * @throws ZodError when the entry fails schema validation. The loader's fail-soft
 *   `register()` path (`server/src/ext/loader.ts`) logs and skips the offending
 *   extension; a `bun:test` asserts the throw carries the schema error.
 */
export function buildExtensionCatalogEntry(
  entry: CatalogEntry,
  manifestId: string
): CatalogEntry {
  const validated = catalogEntrySchema.parse(entry);
  return { ...validated, owner: manifestId };
}
