// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Server-side extension loader (Sub-Issue F of epic #1264).
 *
 * Iterates the generated extension registry (`../extensions.generated`), and for
 * every ENABLED extension constructs ONE {@link ServerExtensionHostImpl} (locked
 * contract §5e — B's host takes per-extension `extensionId` + `manifest`),
 * resolves the runtime `register` via A's `manifest.entryPoints.server()`
 * (the manifest is the sole register-locator), invokes it once, and aggregates
 * the contributions collected across all per-extension hosts.
 *
 * The caller (`server/src/index.ts`) never constructs a host — it supplies the
 * shared late-bound core accessors once, and this loader stamps each host with
 * that extension's identity. The returned aggregate feeds the NotificationHub
 * (channels), route mounting (route factories, locked §5f), and the lifecycle
 * invocation points (onStartup/onShutdown, locked §3b).
 *
 * Fail-soft (locked risk mitigation): a `register` that throws is logged and
 * skipped — its partial contributions are dropped and the remaining extensions
 * still load. A broken extension never blocks server boot.
 */
import { CapabilityGate } from "@hapi/protocol/ext";
import type {
  HapiExtensionManifest,
  HonoRouteFactory,
  NotificationChannel,
} from "@hapi/protocol/ext";
import type { CatalogEntry } from "@hapi/protocol";

import { extensions } from "../extensions.generated";
import { ServerExtensionHostImpl, type ServerExtensionHostDeps } from "./host";

/** The generated-registry entry shape the loader iterates (manifests-only). */
export interface ServerExtensionEntry {
  manifest: HapiExtensionManifest;
  /**
   * PROVENANCE for capability gating (issue #1291, ADR-0003). `false` ⇒ the
   * extension was loaded from the runtime filesystem (`fsLoader`, the untrusted
   * surface `HAPI_FS_EXTENSIONS` enables) and is capability-gated (default-deny).
   * Absent / `true` ⇒ the extension is BUILD-COMPOSED (compiled into the binary)
   * and is trusted — it bypasses the gate. Only the filesystem loader sets
   * `false`; a compiled-in registry entry cannot be forged at runtime, so
   * "absent ⇒ trusted" is sound by construction.
   */
  trusted?: boolean;
}

/**
 * Shared dependencies for {@link loadServerExtensions} — B's per-host deps minus
 * the two per-extension fields (`extensionId`, `manifest`) that the loader
 * supplies itself. Every core service is a late-bound getter resolved at call
 * time, so the loader can run before core services (NotificationHub, …) exist.
 */
export type LoadServerExtensionsDeps = Omit<
  ServerExtensionHostDeps,
  "extensionId" | "manifest" | "capabilityGate"
>;

/** Aggregate of contributions collected across all per-extension hosts. */
export interface LoadedServerExtensions {
  /** Notification channels — merged into `notificationChannels` before the hub. */
  channels: readonly NotificationChannel[];
  /** Hono route factories — mounted under `/api` after auth (locked §5f). */
  routeFactories: readonly HonoRouteFactory[];
  /**
   * Capability-catalog entries contributed via `host.capabilities.add` (#3752).
   * Each is owner-stamped (facade) AND `trusted`-stamped from PROVENANCE at this
   * drain (R3b): a build-composed extension keeps the entry's own `trusted` value;
   * a runtime filesystem extension is forced `trusted: false` (fail-closed). Merged
   * into the live Tier-1 catalog served by `GET /api/capabilities/catalog`.
   */
  catalogEntries: readonly CatalogEntry[];
  /** Startup callbacks — invoked after core services are constructed (locked §3b). */
  onStartup: readonly (() => void | Promise<void>)[];
  /** Shutdown callbacks — invoked during graceful shutdown (locked §3b). */
  onShutdown: readonly (() => void | Promise<void>)[];
  /**
   * Resolve a cross-extension service handle by id (locked §3d), searching
   * every successfully-registered host.
   *
   * Resolution is LAZY on purpose. Extensions publish their handles from inside
   * `onStartup`, which the caller drains long after `loadServerExtensions()`
   * has returned — a snapshot taken at load time would always be empty. Core
   * uses this to reach services it no longer constructs itself (#1274: the
   * heartbeat routes still consult the scheduler, which now lives in
   * `builtin.scheduler`).
   */
  getService: <T = unknown>(id: string) => T | null;
}

/**
 * Load every enabled server extension and return the aggregate of their
 * contributions. Runs AFTER `Store` is constructed (the enable check reads
 * `extension_prefs`) and BEFORE `new NotificationHub(...)` (so extension channels
 * are in the aggregate).
 *
 * `entries` defaults to the committed generated registry; it is injectable so
 * `loader.test.ts` can exercise the enable/aggregate/fail-soft logic with fake
 * entries without the committed (empty) registry (the `index.ts` call site uses
 * the default and is unaffected).
 */
export async function loadServerExtensions(
  deps: LoadServerExtensionsDeps,
  entries: readonly ServerExtensionEntry[] = extensions
): Promise<LoadedServerExtensions> {
  const store = deps.getStore();
  const channels: NotificationChannel[] = [];
  const routeFactories: HonoRouteFactory[] = [];
  const catalogEntries: CatalogEntry[] = [];
  const onStartup: (() => void | Promise<void>)[] = [];
  const onShutdown: (() => void | Promise<void>)[] = [];
  // Hosts that registered without throwing — the search space for getService.
  const readyHosts: ServerExtensionHostImpl[] = [];

  for (const entry of entries) {
    const { manifest } = entry;
    // Enable check (R5). `requiredAtBuild` bypasses prefs; otherwise E's
    // `get(id, defaultEnabled)` — never null; an explicit `false` row survives
    // and is not masked by the manifest default (locked §5d).
    if (!manifest.requiredAtBuild) {
      const enabled = store.extensionPrefs.get(
        manifest.id,
        manifest.defaultEnabled
      ).enabled;
      if (!enabled) continue;
    }

    // The generated server file only carries extensions with a `server` entry
    // point (R8), but guard defensively so a hand-edited registry cannot crash.
    const serverEntry = manifest.entryPoints.server;
    if (!serverEntry) continue;

    // Capability gate (issue #1291, ADR-0003) — built per-extension from the
    // declared `manifest.capabilities` and its PROVENANCE. Build-composed
    // entries (`entry.trusted !== false`) are trusted and bypass the gate;
    // runtime filesystem entries (`trusted: false`, stamped by fsLoader) are
    // default-deny gated against their declared set.
    const capabilityGate = new CapabilityGate(
      manifest.id,
      manifest.capabilities ?? [],
      { trusted: entry.trusted !== false }
    );

    // One host per extension (locked §5e) — per-extension identity for B's log
    // prefixes, table-name sanitization, and services registry.
    const host = new ServerExtensionHostImpl({
      ...deps,
      extensionId: manifest.id,
      manifest,
      capabilityGate,
    });

    try {
      const mod = await serverEntry();
      await mod.register(host);
    } catch (err) {
      // Fail-soft: drop this host's partial contributions, keep loading.
      console.error(
        `[ext:loader] Failed to register server extension '${manifest.id}':`,
        err
      );
      continue;
    }

    // Aggregate only on success — a thrower's partial contributions never appear.
    channels.push(...host.getRegisteredChannels());
    routeFactories.push(...host.getRegisteredRouteFactories());
    // Catalog entries (#3752): stamp `trusted` from PROVENANCE at the drain (R3b)
    // — the facade has no provenance, this loop does. A build-composed extension
    // (`entry.trusted !== false`) keeps the entry's own `trusted`; a runtime
    // filesystem extension is forced `false` (fail-closed — it cannot self-declare
    // `trusted: true`). `owner` was already stamped by the facade.
    const provenanceTrusted = entry.trusted !== false;
    for (const catalogEntry of host.getRegisteredCatalogEntries()) {
      catalogEntries.push({
        ...catalogEntry,
        trusted: provenanceTrusted && (catalogEntry.trusted ?? true),
      });
    }
    // Manifest-DECLARED catalog entries (#3752, R3): a filesystem extension
    // declares these under manifest.json `catalog[]` (already validated by
    // `parseFsManifest`'s #3741 allowlist). Owner is stamped HERE (facade entries
    // are owner-stamped by the facade); `trusted` is stamped from provenance —
    // forced `false` for the untrusted filesystem surface, covering BOTH paths (R3b).
    for (const catalogEntry of manifest.catalog ?? []) {
      catalogEntries.push({
        ...catalogEntry,
        owner: manifest.id,
        trusted: provenanceTrusted && (catalogEntry.trusted ?? true),
      });
    }
    onStartup.push(...host.getStartupCallbacks());
    onShutdown.push(...host.getShutdownCallbacks());
    readyHosts.push(host);
  }

  // Apply any extension-contributed table migrations (B's host.store.addTable /
  // addMigration queue onto the core Store). No-op for the empty registry.
  store.runExtensionMigrations();

  const getService = <T = unknown>(id: string): T | null => {
    for (const host of readyHosts) {
      const handle = host.getRegisteredServices().get(id);
      if (handle !== undefined) return handle as T;
    }
    return null;
  };

  return {
    channels,
    routeFactories,
    catalogEntries,
    onStartup,
    onShutdown,
    getService,
  };
}
