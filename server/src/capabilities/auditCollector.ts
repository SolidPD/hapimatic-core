// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Server-side collector for the runtime self-audit (issue #3744, Sub-Issue D /
 * Task 4). The impure glue that feeds the PURE `audit()` engine: it walks
 * `app.routes` ONCE for the REST binding topology (static after boot) and reads the
 * per-session `RpcRegistry` FRESH on every call, then reconciles them against the
 * committed Tier-0 index. Mirrors `catalogCollector.buildCatalogProvider`.
 *
 * The server can observe ONLY `rest` + `rpc` (R1: `server/` cannot import `cli/` or
 * `web/`), so it reports `surfacesObserved: ["rest","rpc"]`. It also returns the
 * RAW observation (`ServerAuditObservation`) so the CLI verb (Task 7) can MERGE its
 * `mcp`+`cli` half and re-run the SAME engine for a four-surface report — one engine,
 * two collectors (KD-1).
 *
 * FAIL-SOFT: a thrown collection error is a served all-`n/a` report, never a 500.
 */
import type { Hono } from "hono";
import { CAPABILITY_TAG } from "./cataloged";
import { capabilityCatalogIndex } from "@hapi/protocol";
import type { WebAppEnv } from "../web/middleware/auth";
import type { RpcRegistry } from "../socket/rpcRegistry";
import type { CapabilityMeta } from "../socket/handlers/cli/rpcHandlers";
import type { ErrorLogger } from "../logging/errorLogger";
import type { LiveCatalog } from "./catalogCollector";
import {
  audit,
  type AuditReport,
  type ObservedRestRoute,
  type ObservedRpc,
} from "./audit";

/**
 * Hono stores the original handler on a COMPOSED one under this well-known key
 * (`hono/utils/constants` `COMPOSED_HANDLER`, verified for hono 4.11.2). Read the
 * literal to avoid a deep import; `cataloged()` sets its tag by reference and no
 * sub-app mounted via `app.route()` sets a custom `errorHandler` (the only
 * `app.onError` is the root's, `buildWebApp.ts`), so this is a DEFENSIVE second
 * hop only (mirrors `catalogCollector`).
 */
const COMPOSED_HANDLER_KEY = "__COMPOSED_HANDLER";
const AUDIT_LOG_CATEGORY = "capability-audit";

/** The raw server-side observation the CLI verb (Task 7) merges its half into. */
export interface ServerAuditObservation {
  surfacesObserved: ["rest", "rpc"];
  /** Every `METHOD PATH` route group + its `cataloged()` tag ids (topology). */
  restRoutes: ObservedRestRoute[];
  /** The announced RPC methods + socket-count provenance. */
  rpc: ObservedRpc;
  /** The meta-bearing (cataloged) RPC methods — `liveCatalog.rpc`. */
  rpcCovered: { method: string; meta: CapabilityMeta }[];
}

/** The provider's per-call result: the computed report + the raw observation. */
export interface ServerAuditResult {
  report: AuditReport;
  observed: ServerAuditObservation;
}

function emptyLiveCatalog(): LiveCatalog {
  return { rest: [], uncatalogedRest: [], rpc: [], mcp: [], cli: [], ui: [] };
}

/** Recover a `cataloged()` middleware's `CatalogEntry.id`, or null (defensive hop). */
function readCapabilityId(handler: unknown): string | null {
  if (typeof handler !== "function") return null;
  const rec = handler as unknown as Record<PropertyKey, unknown>;
  const direct = rec[CAPABILITY_TAG] as { id?: unknown } | undefined;
  if (direct && typeof direct.id === "string") return direct.id;
  const composed = rec[COMPOSED_HANDLER_KEY];
  if (typeof composed === "function") {
    const nested = (composed as unknown as Record<PropertyKey, unknown>)[
      CAPABILITY_TAG
    ] as { id?: unknown } | undefined;
    if (nested && typeof nested.id === "string") return nested.id;
  }
  return null;
}

/**
 * Walk `app.routes` ONCE and group by `METHOD PATH`, collecting every `cataloged()`
 * tag id per group. A cataloged route registers >= 2 `app.routes` entries (tagged
 * middleware + untagged handler) for one METHOD+PATH, so tags are folded per group;
 * ids are de-duplicated (the same tag appears on multiple entries). Two DISTINCT
 * tags on one group is a duplicate binding — left in place for the engine (R4). The
 * `ALL /*`-vs-`ALL /explicit` middleware filter lives in the engine (R2), so ALL
 * route groups are passed through raw here.
 */
function collectRestTopology(app: Hono<WebAppEnv>): ObservedRestRoute[] {
  const groups = new Map<string, ObservedRestRoute>();
  for (const route of app.routes) {
    const key = `${route.method} ${route.path}`;
    const id = readCapabilityId(route.handler);
    const existing = groups.get(key);
    if (existing) {
      if (id && !existing.catalogedIds.includes(id))
        existing.catalogedIds.push(id);
    } else {
      groups.set(key, {
        method: route.method,
        path: route.path,
        catalogedIds: id ? [id] : [],
      });
    }
  }
  return [...groups.values()];
}

/**
 * Build the boot-time audit provider (R5): walks the REST topology ONCE here, then
 * reads RPC + reconciles FRESH on every call. Both halves are fail-soft.
 */
export function buildAuditProvider(
  app: Hono<WebAppEnv>,
  options?: {
    getRpcRegistry?: () => RpcRegistry | null;
    errorLogger?: ErrorLogger | null;
  }
): () => ServerAuditResult {
  const restRoutes = collectRestTopology(app);
  return () => {
    try {
      const reg = options?.getRpcRegistry?.() ?? null;
      const rpcCovered = reg
        ? reg.listMeta().map(([method, meta]) => ({ method, meta }))
        : [];
      const rpc: ObservedRpc = {
        sockets: reg ? reg.connectedSocketCount() : 0,
        announced: reg ? reg.listAll() : [],
      };
      const observed: ServerAuditObservation = {
        surfacesObserved: ["rest", "rpc"],
        restRoutes,
        rpc,
        rpcCovered,
      };
      const report = audit({
        index: capabilityCatalogIndex,
        liveCatalog: { ...emptyLiveCatalog(), rpc: rpcCovered },
        runtimeSurface: { rest: restRoutes, rpc },
        surfacesObserved: ["rest", "rpc"],
      });
      return { report, observed };
    } catch (err) {
      options?.errorLogger?.error(
        "capability-audit: report generation failed; serving empty (all-n/a) report",
        {
          category: AUDIT_LOG_CATEGORY,
          context: { error: err instanceof Error ? err.message : String(err) },
        }
      );
      const report = audit({
        index: [],
        liveCatalog: emptyLiveCatalog(),
        runtimeSurface: {},
        surfacesObserved: [],
      });
      return {
        report,
        observed: {
          surfacesObserved: ["rest", "rpc"],
          restRoutes: [],
          rpc: { sockets: 0, announced: [] },
          rpcCovered: [],
        },
      };
    }
  };
}
