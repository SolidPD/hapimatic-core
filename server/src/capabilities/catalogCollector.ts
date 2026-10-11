// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Boot-time live-catalog collector (issue #3743, Task 5 / R5, R6). Assembles the
 * live Tier-1 capability catalog from the running binary — the artifact #3744
 * reconciles against the committed Tier-0 index (`index.generated.ts`).
 *
 * TWO TIMESCALES (KD-4 / R6):
 *   - The STATIC part (REST routes from `app.routes`, and the mcp/cli/ui sections
 *     from the committed index) is collected ONCE by `buildCatalogProvider`, at
 *     the single pinned line in `buildWebApp` immediately after the last
 *     `app.route()` mount and BEFORE the first `return app` exit — so every build
 *     mode (compiled single-exe, dev checkout) collects the IDENTICAL route set
 *     (V5a). Hooking a later `return app` would ship an EMPTY catalog in the
 *     production single-exe (NEW-3746-17).
 *   - The RPC section is PER-SESSION dynamic, so the returned provider re-reads
 *     `RpcRegistry.listMeta()` FRESH on every call. With zero connected sessions
 *     the read legitimately yields nothing and the catalog serves `rpc: []` — the
 *     state of every fresh boot and of CI — never a 503 (R6).
 *
 * FAIL-SOFT (KD-4): a thrown collection error at boot is a service outage, not a
 * catalog gap. Both the boot collection and the per-request RPC merge are wrapped
 * in try/catch → logged via `ErrorLogger` → serve an EMPTY (or rpc-less) catalog.
 *
 * MIDDLEWARE FILTER (R5 / 3743-5): every `app.routes` entry whose `method` is
 * `ALL` is ignored — not merely `ALL /*`. Hono registers `app.use("/exact", mw)`
 * (an exact-path middleware, e.g. `routes/health.ts` `/system-health`,
 * `routes/update.ts` `/update-stage`) under method `ALL` with NO trailing `*`, so
 * a `*`-suffix rule would leak them as permanent phantom uncataloged entries into
 * #3744's coverage meter and #3747's baseline. There are no genuine `.all()`
 * ROUTE registrations in `server/src/web`, so filtering on the method costs
 * nothing.
 *
 * The catalog REFERENCES the RPC namespace (N1) by pointer, never a copy (R8 /
 * non-duplication): the `rpc` section carries each method's `CapabilityMeta`
 * (whose `inputSchema`/`outputSchema` are already JSON Schema, produced CLI-side
 * via `z.toJSONSchema()`), NOT a re-authored `CatalogEntry`. See
 * `docs/internal/architecture/capability-catalog.md`.
 */
import type { Hono } from "hono";
import { CAPABILITY_TAG } from "./cataloged";
import { capabilityCatalogIndex } from "@hapi/protocol";
import type { CatalogEntry, Surface } from "@hapi/protocol";
import type { WebAppEnv } from "../web/middleware/auth";
import type { RpcRegistry } from "../socket/rpcRegistry";
import type { CapabilityMeta } from "../socket/handlers/cli/rpcHandlers";
import type { ErrorLogger } from "../logging/errorLogger";

/**
 * Hono stores the original handler on a COMPOSED one under this well-known key
 * (`hono/utils/constants` `COMPOSED_HANDLER = "__COMPOSED_HANDLER"`, verified for
 * hono 4.11.2). We read the literal to avoid a deep-import outside hono's exports
 * map. `cataloged()` sets its tag by reference and there is no `app.onError` in
 * `server/src`, so the tag survives prefixing directly — this is a DEFENSIVE
 * second hop only (3743-18).
 */
const COMPOSED_HANDLER_KEY = "__COMPOSED_HANDLER";

const CATALOG_LOG_CATEGORY = "capability-catalog";

/** One live RPC capability — a pointer to N1's per-session registration meta. */
export interface LiveRpcCapability {
  method: string;
  meta: CapabilityMeta;
}

/** A REST route group carrying no `cataloged()` tag — the #3744 coverage gap. */
export interface UncatalogedRoute {
  method: string;
  path: string;
}

/** The assembled live Tier-1 catalog served by `GET /api/capabilities/catalog`. */
export interface LiveCatalog {
  /** Cataloged REST routes (their `cataloged()` `CatalogEntry`), sorted by id. */
  rest: CatalogEntry[];
  /** REST route groups with no `cataloged()` tag — the not-yet-cataloged surface. */
  uncatalogedRest: UncatalogedRoute[];
  /** Live RPC capabilities from connected sessions (empty with zero sessions). */
  rpc: LiveRpcCapability[];
  /** MCP capabilities from the committed index (cli-side, unobservable at runtime). */
  mcp: CatalogEntry[];
  /** CLI capabilities from the committed index. */
  cli: CatalogEntry[];
  /** Web-UI capabilities from the committed index (#3752 populates). */
  ui: CatalogEntry[];
}

export interface CatalogProviderOptions {
  /** Per-session RPC registry accessor (N1). Absent/null → `rpc: []`. */
  getRpcRegistry?: () => RpcRegistry | null;
  /** Fail-soft sink; a collection error logs here and serves an empty catalog. */
  errorLogger?: ErrorLogger | null;
  /**
   * Extension-contributed catalog entries (#3752), collected ONCE at boot with the
   * static half. Each is already owner-stamped (facade) and `trusted`-stamped from
   * provenance (loader drain). They are merged into the matching surface bucket
   * (`rest`/`mcp`/`cli`/`ui`) so the panel renders them, and are `runtime-only` by
   * construction — absent from the committed Tier-0 index, and not a route group in
   * the audit's `runtimeSurface`, so the audit reports them as neither forward nor
   * reverse drift.
   */
  extensionEntries?: readonly CatalogEntry[];
}

/** The static (non-`rpc`) half of the catalog, collected once at boot. */
type StaticCatalog = Omit<LiveCatalog, "rpc">;

function emptyStatic(): StaticCatalog {
  return { rest: [], uncatalogedRest: [], mcp: [], cli: [], ui: [] };
}

/**
 * Read the `CatalogEntry` off a (possibly composed) Hono handler, or null when
 * the handler carries no `cataloged()` tag. Defensive against the COMPOSED
 * wrapper (3743-18).
 */
function readCapabilityTag(handler: unknown): CatalogEntry | null {
  if (typeof handler !== "function") return null;
  const asRecord = handler as unknown as Record<PropertyKey, unknown>;
  const direct = asRecord[CAPABILITY_TAG];
  if (direct) return direct as CatalogEntry;
  const composed = asRecord[COMPOSED_HANDLER_KEY];
  if (typeof composed === "function") {
    const nested = (composed as unknown as Record<PropertyKey, unknown>)[
      CAPABILITY_TAG
    ];
    if (nested) return nested as CatalogEntry;
  }
  return null;
}

/**
 * Collect the STATIC catalog ONCE from the fully-mounted app. Fail-soft: any
 * error logs and yields the empty static shape (never throws).
 */
function collectStaticCatalog(
  app: Hono<WebAppEnv>,
  extensionEntries: readonly CatalogEntry[] = [],
  errorLogger?: ErrorLogger | null
): StaticCatalog {
  try {
    // Group by "METHOD PATH". A cataloged route registers >= 2 `app.routes`
    // entries for one METHOD+PATH (one tagged middleware + one untagged handler),
    // so we fold the group and keep the tag if ANY member carries it.
    const groups = new Map<
      string,
      { method: string; path: string; entry: CatalogEntry | null }
    >();
    for (const route of app.routes) {
      if (route.method === "ALL") continue; // middleware, never a capability (R5)
      const key = `${route.method} ${route.path}`;
      const tag = readCapabilityTag(route.handler);
      const existing = groups.get(key);
      if (existing) {
        if (tag && !existing.entry) existing.entry = tag;
      } else {
        groups.set(key, { method: route.method, path: route.path, entry: tag });
      }
    }

    const rest: CatalogEntry[] = [];
    const uncatalogedRest: UncatalogedRoute[] = [];
    for (const group of groups.values()) {
      if (group.entry) rest.push(group.entry);
      else uncatalogedRest.push({ method: group.method, path: group.path });
    }
    // Deterministic order (stable reconciliation against the committed index).
    rest.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    uncatalogedRest.sort((a, b) => {
      const ka = `${a.method} ${a.path}`;
      const kb = `${b.method} ${b.path}`;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });

    const bySurface = (surface: Surface): CatalogEntry[] =>
      capabilityCatalogIndex.filter(entry => entry.surface === surface);

    // #3752: merge extension-contributed (runtime-only) entries into their surface
    // bucket. Zero-change when there are none (the default) — a build without any
    // enabled extension contributing entries returns the byte-identical shape.
    const withExt = (
      base: CatalogEntry[],
      surface: Surface
    ): CatalogEntry[] => {
      const ext = extensionEntries.filter(entry => entry.surface === surface);
      if (ext.length === 0) return base;
      return [...base, ...ext].sort((a, b) =>
        a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      );
    };

    return {
      rest: withExt(rest, "rest"),
      uncatalogedRest,
      mcp: withExt(bySurface("mcp"), "mcp"),
      cli: withExt(bySurface("cli"), "cli"),
      ui: withExt(bySurface("ui"), "ui"),
    };
  } catch (err) {
    errorLogger?.error(
      "capability-catalog: static collection failed; serving empty catalog",
      {
        category: CATALOG_LOG_CATEGORY,
        context: { error: err instanceof Error ? err.message : String(err) },
      }
    );
    return emptyStatic();
  }
}

/**
 * Emit ONE boot warning per untagged EXTENSION route (issue #3752, ruling D12).
 *
 * Called at extension-route MOUNT time on each extension's sub-app, BEFORE it is
 * merged into the main app. Under D12 an uncataloged extension route is NEVER
 * refused and NEVER un-mounted: a throw inside `register()`/mount would be
 * swallowed at `loader.ts` AND `buildWebApp`'s mount loop, silently dropping the
 * whole extension's channels, services and lifecycle callbacks. So each untagged
 * `METHOD PATH` group gets exactly one `ErrorLogger` warning (never
 * `console.error`), naming the route; the route still mounts. The SAME uncataloged
 * route is ALSO recorded as reverse drift by the static collector's
 * `uncatalogedRest` path + #3744's audit — the warning is the boot-time signal,
 * the audit record is the durable one.
 *
 * Fail-soft: a malformed sub-app logs and is skipped — scanning for cataloging
 * must never abort mounting.
 */
export function warnUncatalogedExtensionRoutes(
  sub: Hono<WebAppEnv>,
  errorLogger?: ErrorLogger | null
): void {
  try {
    // Group by "METHOD PATH" and keep the group tagged if ANY member carries a
    // `cataloged()` tag (a cataloged route registers a tagged middleware + an
    // untagged handler for the same METHOD+PATH — mirrors collectStaticCatalog).
    const tagged = new Map<string, boolean>();
    for (const route of sub.routes) {
      if (route.method === "ALL") continue; // middleware, never a capability
      const key = `${route.method} ${route.path}`;
      const isTagged = readCapabilityTag(route.handler) !== null;
      tagged.set(key, (tagged.get(key) ?? false) || isTagged);
    }
    for (const [key, isTagged] of tagged) {
      if (!isTagged) {
        errorLogger?.warn(
          `capability-catalog: extension route "${key}" is not cataloged — tag its ` +
            `handler chain with cataloged(defineCapability({...})) (#3752, ruling D12: ` +
            `warn-only, the route still mounts and is reported as reverse drift by the audit)`,
          { category: CATALOG_LOG_CATEGORY }
        );
      }
    }
  } catch (err) {
    errorLogger?.error(
      "capability-catalog: failed to scan an extension's routes for cataloging (warn path skipped)",
      {
        category: CATALOG_LOG_CATEGORY,
        context: { error: err instanceof Error ? err.message : String(err) },
      }
    );
  }
}

/** Read the RPC section fresh (per-session). `[]` when no registry/sessions. */
function readRpcSection(
  getRpcRegistry?: () => RpcRegistry | null
): LiveRpcCapability[] {
  const registry = getRpcRegistry?.();
  if (!registry) return [];
  return registry.listMeta().map(([method, meta]) => ({ method, meta }));
}

/**
 * Build the boot-time catalog provider (R5: runs the STATIC collection ONCE,
 * here). The returned getter merges a FRESH RPC section on every call (R6). Both
 * halves are fail-soft — a collection error is a served empty/rpc-less catalog,
 * never a boot outage or a 500.
 */
export function buildCatalogProvider(
  app: Hono<WebAppEnv>,
  options?: CatalogProviderOptions
): () => LiveCatalog {
  const staticPart = collectStaticCatalog(
    app,
    options?.extensionEntries,
    options?.errorLogger
  );
  return () => {
    try {
      return { ...staticPart, rpc: readRpcSection(options?.getRpcRegistry) };
    } catch (err) {
      options?.errorLogger?.error(
        "capability-catalog: rpc merge failed; serving without rpc section",
        {
          category: CATALOG_LOG_CATEGORY,
          context: { error: err instanceof Error ? err.message : String(err) },
        }
      );
      return { ...staticPart, rpc: [] };
    }
  };
}
