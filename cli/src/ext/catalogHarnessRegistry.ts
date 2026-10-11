// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Process-wide catalog-harness registry (HAL catalog, epic #3117 Sub-D / issue #3120).
 *
 * The SECOND tier of the two-tier harness-identity contract (expert ruling D8b / KD5):
 * #3118 keeps `AgentFlavor` CLOSED over the stock 4 with a total
 * `Record<AgentFlavor, HarnessManifest>` registry (`resolveHarnessManifest`); catalog
 * CLIs are the OPEN tier, keyed by a plain string id (`"crush"`, `"cursor"`, …) and
 * resolved HERE via {@link resolveCatalogManifest}. This registry NEVER consults the
 * stock-4 record, and `resolveHarnessManifest` NEVER consults this one — two resolution
 * paths, deliberately separate.
 *
 * A leaf module (mirroring `@/agent/AgentRegistry`) so `CliExtensionHostImpl` stays the
 * documented STATELESS facade — `host.harness.register` forwards here, and every
 * registration is process-wide so constructing more than one host is harmless.
 *
 * Registrations arrive at CLI load time from each ENABLED `harness-<name>` extension's
 * `cli()` entry point (`cli/src/extensions/harness-<name>/cli.ts` → `host.harness.register`).
 * Catalog extensions ship `defaultEnabled: true` so their metadata contributions register
 * at load (the catalog must be browsable / installable before any BINARY is present — the
 * binary is what installs lazily via the recipe, ruling D2).
 */
import type { HarnessContribution } from "@hapi/protocol/ext";
import type { CatalogHarnessManifest } from "@hapi/protocol";

/** id (OPEN catalog harness id) → its full contribution. */
const catalog = new Map<string, HarnessContribution>();

/**
 * Register a catalog harness contribution under its OPEN id. Throws on an empty id
 * (mirroring `AgentRegistry.register`'s validation). A later registration for the same id
 * replaces the earlier one (last-writer-wins — a re-load is idempotent).
 */
export function registerCatalogHarness(
  id: string,
  contribution: HarnessContribution
): void {
  if (typeof id !== "string" || id.trim() === "") {
    throw new Error("catalog harness id must be a non-empty string");
  }
  catalog.set(id, contribution);
}

/**
 * Resolve a catalog harness's capability manifest by its OPEN id (KD5 — the id-open
 * `CatalogHarnessManifest`, never a stock-4 `AgentFlavor` manifest). Returns `undefined`
 * on a miss (non-throwing — catalog probing is fallback-preserving). This is the resolver
 * #3118's registry doc comment forward-references; it never consults the stock-4 record.
 */
export function resolveCatalogManifest(
  id: string
): CatalogHarnessManifest | undefined {
  return catalog.get(id)?.capabilityManifest;
}

/** Resolve a catalog harness's full contribution (recipe + manifest + driver binding). */
export function resolveCatalogContribution(
  id: string
): HarnessContribution | undefined {
  return catalog.get(id);
}

/** Every registered catalog harness contribution (for the Extensions-page catalog list). */
export function listCatalogHarnesses(): HarnessContribution[] {
  return [...catalog.values()];
}

/** Test-only: clear the registry so cases don't leak registrations into each other. */
export function _resetCatalogHarnessRegistry(): void {
  catalog.clear();
}
