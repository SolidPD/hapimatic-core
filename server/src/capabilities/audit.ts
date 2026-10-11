// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Runtime self-audit engine (issue #3744, Sub-Issue D / R1–R4, R8).
 *
 * The PURE reconciler that turns capability-catalog population from all-or-nothing
 * into a per-domain, per-surface coverage meter. It compares the committed Tier-0
 * `index` against the raw runtime surface (`runtimeSurface`) — plus the Tier-1
 * live catalog (`liveCatalog`) for the one surface whose catalog entry is inline
 * and NOT committed (RPC meta) — and reports every mismatch. It mirrors rp1-home's
 * `hook_registration_validator.py`: one validator, three consumers (this route/CLI,
 * #3747's pre-commit + CI, #3747's scheduled sweep), so the drift definition never
 * diverges (KD-1).
 *
 * PURE by construction — no I/O, no boot, no import of `cli/` or `web/` (R1: `server/`
 * depends on `@hapi/protocol` alone). Every drift class is fixture-testable in-memory.
 *
 * TWO COLLECTORS, ONE ENGINE (KD-1 / KD-5): no single process can observe all five
 * surfaces, so `runtimeSurface` is PARTIAL and `surfacesObserved` names what was
 * sampled. The server route observes `rest`+`rpc`; the CLI verb merges `mcp`+`cli`;
 * `ui` stays `unobserved` until #3752. An unobserved surface renders **`n/a`, never
 * `0 %`** (R1) — a `0 %` reading for a surface nobody sampled is indistinguishable
 * from total decay, the exact failure this engine exists to prevent. A zero-socket
 * `rpc` sample renders **`unknown`, never `clean`** (R2).
 *
 * WHERE A CATALOG ENTRY LIVES differs by surface, which drives reverse drift:
 *   - `rest`: the entry is the inline `cataloged()` tag on the route (recovered from
 *     `app.routes[i].handler[CAPABILITY_TAG]`). Reverse drift = a live route with no tag.
 *   - `rpc`: the entry is the inline `CapabilityMeta` a session announces
 *     (`liveCatalog.rpc`). Reverse drift = an announced method with no meta.
 *   - `mcp`/`cli`/`ui`: those surfaces cannot self-tag at runtime, so their entries
 *     live in the committed `index`. Reverse drift = a live item with no `index` entry.
 */
import type {
  CatalogEntry,
  Surface,
  Availability,
  DomainSlug,
} from "@hapi/protocol";
import { DOMAIN_SLUGS, INFRA_EXCLUDED_ROUTE_PATHS } from "@hapi/protocol";
import type { LiveCatalog } from "./catalogCollector";

/**
 * The five surfaces in a FIXED order (R8: stable + diffable output). Coverage
 * records and drift arrays are emitted in this order so `?format=summary` is
 * byte-identical on repeat (V3).
 */
export const AUDIT_SURFACE_ORDER: readonly Surface[] = [
  "rest",
  "rpc",
  "mcp",
  "cli",
  "ui",
];

// ── Runtime-surface observation shapes (the raw denominators) ────────────────

/** One observed REST route group (from `app.routes`, ALL-method-filtered). */
export interface ObservedRestRoute {
  method: string;
  path: string;
  /**
   * The `id` of every `cataloged()` tag on this METHOD+PATH group. Length 0 =
   * uncataloged (reverse drift); length > 1 = duplicate binding (schema error).
   */
  catalogedIds: string[];
  /** Source file the route was mounted from, where determinable. */
  mountFile?: string;
}

/**
 * RPC observation: the raw announced roster + socket-count provenance. `RpcRegistry`
 * is per-socket with no all-methods enumerator, so the denominator is the union of
 * methods across all currently-connected sockets, and `sockets` is load-bearing
 * provenance (R2): a zero-socket sample is `unknown`, never `clean`.
 */
export interface ObservedRpc {
  /** Number of currently-connected sockets sampled (0 → unknown). */
  sockets: number;
  /** Distinct bare method names announced across all connected sockets. */
  announced: string[];
}

/** One MCP harness's registered tool names — MCP coverage is per-harness (R2). */
export interface ObservedMcpHarness {
  /** e.g. `"claude"` (startHappyServer) or `"codex-bridge"` (happyMcpStdioBridge). */
  harness: string;
  tools: string[];
}

/** CLI observation: command groups + `hapi api <resource> <action>` pairs. */
export interface ObservedCli {
  /** `hapi` command-group names (`listCommands()` + the `claude` special case). */
  commands: string[];
  /** `hapi api <resource> <action>` pairs; an actionless resource has `action: ""`. */
  apiPairs: { resource: string; action: string }[];
}

/** UI observation: the flat router route paths (populated by #3752). */
export interface ObservedUi {
  routes: string[];
}

/** The raw runtime surface — PARTIAL by design. A field present iff observed. */
export interface RuntimeSurface {
  rest?: ObservedRestRoute[];
  rpc?: ObservedRpc;
  mcp?: ObservedMcpHarness[];
  cli?: ObservedCli;
  ui?: ObservedUi;
}

/**
 * Availability evaluator SEAM for #3749 (I). At D-time `mountedWhen` is an OPAQUE
 * presence marker (R3) and this is unused; #3749 injects a real evaluator later so
 * its edit is an injection, not a rewrite of this file. Default: unknown → not
 * user-visible.
 */
export type AvailabilityEvaluator = (
  availability: Availability,
  ctx?: unknown
) => boolean;

/** The four data inputs the audit reconciles (KD-1). */
export interface AuditInput {
  /** Tier-0 committed index (`capabilityCatalogIndex`). Forward drift + numerator. */
  index: readonly CatalogEntry[];
  /** Tier-1 live catalog (#3743). The engine reads `.rpc` — the meta-bearing methods. */
  liveCatalog: LiveCatalog;
  /** The raw runtime roster, partial by design. */
  runtimeSurface: RuntimeSurface;
  /** The surfaces this caller could observe. An absent surface renders `n/a`. */
  surfacesObserved: readonly Surface[];
  /** #3749 seam (unused at D-time — `mountedWhen` is presence-only now). */
  evaluateAvailability?: AvailabilityEvaluator;
}

// ── Report shapes ────────────────────────────────────────────────────────────

/**
 * Per-surface coverage headline. `n/a` = surface not observed; `unknown` = observed
 * but inconclusive (zero-socket rpc); `measured` = a real sample.
 */
export type SurfaceCoverage =
  | { status: "n/a" }
  | { status: "unknown" }
  | { status: "measured"; observed: number; cataloged: number };

/** Per (domain, surface): committed-index entry count + how many resolve live. */
export interface DomainSurfaceCount {
  /** Committed index entries in this (domain, surface), excluding `notMountedHere`. */
  entries: number;
  /** How many of those resolve to a live runtime item without drift. */
  resolved: number;
}

/** A live runtime item with no catalog entry (reverse decay). */
export interface ReverseDriftEntry {
  surface: Surface;
  /** `"GET /foo"` (rest) | method (rpc) | tool (mcp) | command (cli) | path (ui). */
  item: string;
  /** Set for `mcp` — coverage is reported per harness (R2). */
  harness?: string;
}

/** A committed index entry that does not resolve to a live item (forward decay). */
export interface ForwardDriftEntry {
  id: string;
  surface: Surface;
  /** `unresolved` = no live item; `binding-mismatch` = tag found at the wrong route. */
  reason: "unresolved" | "binding-mismatch";
  /** The entry's declared coordinate, e.g. `"GET /foo"`. */
  declared: string;
  /** For `binding-mismatch`: where the tag was actually found, e.g. `"POST /bar"`. */
  foundAt?: string;
}

/** A structural inconsistency in the catalog itself. */
export interface SchemaError {
  kind: "duplicate-id" | "duplicate-binding";
  /** For `duplicate-id`. */
  id?: string;
  /** For `duplicate-binding`: `"GET /foo"`. */
  binding?: string;
  /** The colliding entry ids. */
  ids: string[];
}

/** A committed entry excluded from forward drift because it carries `mountedWhen`. */
export interface NotMountedEntry {
  id: string;
  surface: Surface;
  /** The raw `mountedWhen` string, echoed verbatim (R3 — presence, not evaluation). */
  mountedWhen: string;
}

/** The assembled audit report — the shape both consumers and #3747's gate quote. */
export interface AuditReport {
  surfacesObserved: Surface[];
  coverage: {
    /** Headline meter per surface. */
    bySurface: Record<Surface, SurfaceCoverage>;
    /** Per-domain × per-surface committed-entry counts, `DOMAINS`-ordered (R8). */
    byDomain: Record<DomainSlug, Record<Surface, DomainSurfaceCount>>;
    /** MCP coverage per harness (R2 — never one global bucket). */
    mcpByHarness: Record<string, SurfaceCoverage>;
  };
  forwardDrift: ForwardDriftEntry[];
  reverseDrift: ReverseDriftEntry[];
  schemaErrors: SchemaError[];
  notMountedHere: NotMountedEntry[];
  /** RPC provenance (R2): the socket count sampled, or null when rpc is unobserved. */
  rpcObserved: { sockets: number } | null;
  /** Stability caveats (V3/R8): byte-identical only for a fixed socket + command set. */
  provenance: {
    surfacesObserved: Surface[];
    stabilityCaveats: string[];
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const bindingKey = (method: string, path: string): string =>
  `${method} ${path}`;

/**
 * A wildcard-suffixed path — `app.use("/api/*", mw)` / `app.use("*", mw)` — vs an
 * exact path — `app.use("/system-health", mw)`. Load-bearing for the middleware
 * filter below (R2).
 */
const isWildcardPath = (path: string): boolean =>
  path === "*" || path === "/*" || path.endsWith("/*");

/**
 * True when a route group is pure middleware to be IGNORED (R2): a `method === "ALL"`
 * registration with a WILDCARD path (`app.use("/api/*", …)`). An `ALL` registration
 * with an EXACT path (`app.use("/system-health", …)`) is a real capability surface
 * and IS audited — this is stricter than #3743's collector, which drops every `ALL`.
 */
const isMiddlewareRoute = (group: ObservedRestRoute): boolean =>
  group.method === "ALL" && isWildcardPath(group.path);

/**
 * Normalise a route path for infra-exclusion comparison. Hono 4.11's `mergePath`
 * may record `app.get("*", …)` as `/*`, so collapse that to `*` (consistent with
 * the SPA catch-all form and `audit.test.ts`); all other paths pass through.
 */
const normalizeInfraPath = (path: string): string =>
  path === "/*" ? "*" : path;

/** The named infra-exclusion class as a lookup set (#3837 F.16 / D18-A). */
const INFRA_EXCLUDED_SET: ReadonlySet<string> = new Set(
  INFRA_EXCLUDED_ROUTE_PATHS
);

const naCoverage = (): SurfaceCoverage => ({ status: "n/a" });

/** Compare two strings for a stable ascending sort. */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Sort by surface fixed-order first, then by a per-entry key. */
const surfaceRank = (s: Surface): number => AUDIT_SURFACE_ORDER.indexOf(s);

// ── The engine ────────────────────────────────────────────────────────────────

/**
 * Reconcile the committed index against the observed runtime surface. PURE — the
 * same inputs always yield a byte-identical report (for a fixed socket + command
 * set). See the module doc for the reverse/forward/binding/schema drift model.
 */
export function audit(input: AuditInput): AuditReport {
  const { index, liveCatalog, runtimeSurface, surfacesObserved } = input;
  const observed = new Set<Surface>(surfacesObserved);
  const isObserved = (s: Surface): boolean => observed.has(s);

  const forwardDrift: ForwardDriftEntry[] = [];
  const reverseDrift: ReverseDriftEntry[] = [];
  const schemaErrors: SchemaError[] = [];
  const notMountedHere: NotMountedEntry[] = [];

  // ── Schema error: duplicate id ─────────────────────────────────────────────
  const idCounts = new Map<string, string[]>();
  for (const entry of index) {
    const arr = idCounts.get(entry.id);
    if (arr) arr.push(entry.id);
    else idCounts.set(entry.id, [entry.id]);
  }
  for (const [id, occurrences] of idCounts) {
    if (occurrences.length > 1) {
      schemaErrors.push({ kind: "duplicate-id", id, ids: occurrences });
    }
  }

  // ── notMountedHere: any entry carrying `availability.mountedWhen` (R3) ──────
  // Presence, NOT evaluation. Excluded from forward drift AND both coverage buckets.
  const mountedElsewhere = new Set<string>();
  for (const entry of index) {
    const mountedWhen = entry.availability?.mountedWhen;
    if (mountedWhen !== undefined) {
      mountedElsewhere.add(entry.id);
      notMountedHere.push({
        id: entry.id,
        surface: entry.surface,
        mountedWhen,
      });
    }
  }

  // Track which committed entries resolved cleanly (for byDomain).
  const resolvedIds = new Set<string>();

  // ── REST ───────────────────────────────────────────────────────────────────
  // Build a tag-location map for binding-mismatch + duplicate-binding detection.
  const restTagLocations = new Map<string, string[]>(); // id → ["GET /foo", ...]
  const restCoverage: SurfaceCoverage = (() => {
    if (!isObserved("rest") || !runtimeSurface.rest) return naCoverage();
    // Companion detection (#3837 F.16 / D18-A): the exact paths that carry a
    // cataloged NON-`ALL` route group. An exact-path `ALL` group at such a path is
    // an auth-middleware COMPANION of its route (e.g. `app.use("/system-health", …)`
    // beside a cataloged `app.get("/system-health", …)`), not a surface of its own,
    // so it is excluded below; an exact-path `ALL` group with NO cataloged sibling
    // stays reverse drift (R2's stricter-than-#3743 intent survives).
    const catalogedNonAllPaths = new Set<string>();
    for (const g of runtimeSurface.rest) {
      if (g.method !== "ALL" && g.catalogedIds.length > 0) {
        catalogedNonAllPaths.add(normalizeInfraPath(g.path));
      }
    }
    // Infra-exclusion (#3837 F.16 / D18-A): a group is infrastructure — dropped
    // from BOTH the observed denominator AND reverse drift — when its normalised
    // path is in the named class (`INFRA_EXCLUDED_ROUTE_PATHS`), OR it is an
    // exact-path `ALL` companion of a cataloged route. Before F.16 the engine had
    // no consumer of the class, so `GET /health`, `GET /api/health` and the four
    // `ALL` auth companions were permanent reverse drift and REST never reached
    // 100%; this is the audit-side denominator the doc + F.1 R10 always promised.
    const isInfraExcluded = (g: ObservedRestRoute): boolean => {
      const norm = normalizeInfraPath(g.path);
      if (INFRA_EXCLUDED_SET.has(norm)) return true;
      return (
        g.method === "ALL" &&
        !isWildcardPath(g.path) &&
        catalogedNonAllPaths.has(norm)
      );
    };
    // Middleware filter (R2): drop `ALL /*` (pure middleware), keep `ALL /explicit`
    // (an exact-path capability surface) and every non-`ALL` route group; then drop
    // the infra-exclusion class (#3837 F.16).
    const groups = runtimeSurface.rest.filter(
      g => !isMiddlewareRoute(g) && !isInfraExcluded(g)
    );
    let cataloged = 0;
    for (const group of groups) {
      const key = bindingKey(group.method, group.path);
      if (group.catalogedIds.length === 0) {
        reverseDrift.push({ surface: "rest", item: key });
      } else {
        cataloged += 1;
        for (const id of group.catalogedIds) {
          const locs = restTagLocations.get(id);
          if (locs) locs.push(key);
          else restTagLocations.set(id, [key]);
        }
      }
      // Duplicate binding: >1 cataloged() tag on one METHOD PATH group (R4).
      if (group.catalogedIds.length > 1) {
        schemaErrors.push({
          kind: "duplicate-binding",
          binding: key,
          ids: [...group.catalogedIds].sort(cmp),
        });
      }
    }
    return { status: "measured", observed: groups.length, cataloged };
  })();

  // ── RPC ──────────────────────────────────────────────────────────────────
  const rpcObs = runtimeSurface.rpc;
  const rpcCovered = new Set(liveCatalog.rpc.map(r => r.method));
  const rpcAnnounced = new Set(rpcObs?.announced ?? []);
  const rpcCoverage: SurfaceCoverage = (() => {
    if (!isObserved("rpc") || !rpcObs) return naCoverage();
    // A zero-socket sample is `unknown`, never `clean` (R2): with no connected
    // session we cannot conclude any method is absent, so we emit no drift.
    if (rpcObs.sockets === 0) return { status: "unknown" };
    let cataloged = 0;
    for (const method of rpcAnnounced) {
      if (rpcCovered.has(method)) cataloged += 1;
      // Reverse drift: an announced method with no meta. The sentinel rule falls
      // out for free — a name-only teardown stub is drift only if NO registration
      // of that bare method carries meta (`liveCatalog.rpc` = meta-bearing).
      else reverseDrift.push({ surface: "rpc", item: method });
    }
    return { status: "measured", observed: rpcAnnounced.size, cataloged };
  })();

  // ── MCP (per-harness) ────────────────────────────────────────────────────
  const mcpIndexTools = new Set(
    index
      .filter(e => e.invocation.kind === "mcp")
      .map(e => (e.invocation.kind === "mcp" ? e.invocation.tool : ""))
  );
  const mcpByHarness: Record<string, SurfaceCoverage> = {};
  const mcpAllTools = new Set<string>();
  let mcpAggObserved = 0;
  let mcpAggCataloged = 0;
  if (isObserved("mcp") && runtimeSurface.mcp) {
    // Sort harnesses for stable output.
    const harnesses = [...runtimeSurface.mcp].sort((a, b) =>
      cmp(a.harness, b.harness)
    );
    for (const h of harnesses) {
      let cataloged = 0;
      for (const tool of h.tools) {
        mcpAllTools.add(tool);
        if (mcpIndexTools.has(tool)) cataloged += 1;
        else
          reverseDrift.push({ surface: "mcp", harness: h.harness, item: tool });
      }
      mcpByHarness[h.harness] = {
        status: "measured",
        observed: h.tools.length,
        cataloged,
      };
      mcpAggObserved += h.tools.length;
      mcpAggCataloged += cataloged;
    }
  }
  const mcpCoverage: SurfaceCoverage =
    isObserved("mcp") && runtimeSurface.mcp
      ? {
          status: "measured",
          observed: mcpAggObserved,
          cataloged: mcpAggCataloged,
        }
      : naCoverage();

  // ── CLI (command groups + api pairs, flattened to command strings) ──────────
  const cliRoster = new Set<string>();
  if (isObserved("cli") && runtimeSurface.cli) {
    for (const command of runtimeSurface.cli.commands) cliRoster.add(command);
    for (const pair of runtimeSurface.cli.apiPairs) {
      cliRoster.add(
        pair.action
          ? `api ${pair.resource} ${pair.action}`
          : `api ${pair.resource}`
      );
    }
  }
  const cliIndexCommands = new Set(
    index
      .filter(e => e.invocation.kind === "cli")
      .map(e => (e.invocation.kind === "cli" ? e.invocation.command : ""))
  );
  const cliCoverage: SurfaceCoverage = (() => {
    if (!isObserved("cli") || !runtimeSurface.cli) return naCoverage();
    let cataloged = 0;
    for (const item of [...cliRoster].sort(cmp)) {
      if (cliIndexCommands.has(item)) cataloged += 1;
      else reverseDrift.push({ surface: "cli", item });
    }
    return { status: "measured", observed: cliRoster.size, cataloged };
  })();

  // ── UI (unobserved at D-time → n/a; generic reverse-drift logic when observed) ─
  const uiRoster = new Set(
    isObserved("ui") ? (runtimeSurface.ui?.routes ?? []) : []
  );
  const uiIndexLocations = new Set(
    index
      .filter(e => e.invocation.kind === "ui")
      .map(e => (e.invocation.kind === "ui" ? e.invocation.location : ""))
  );
  const uiCoverage: SurfaceCoverage = (() => {
    if (!isObserved("ui") || !runtimeSurface.ui) return naCoverage();
    let cataloged = 0;
    for (const route of [...uiRoster].sort(cmp)) {
      if (uiIndexLocations.has(route)) cataloged += 1;
      else reverseDrift.push({ surface: "ui", item: route });
    }
    return { status: "measured", observed: uiRoster.size, cataloged };
  })();

  // ── Forward drift + binding mismatch (index → live) ────────────────────────
  for (const entry of index) {
    if (mountedElsewhere.has(entry.id)) continue; // R3 exclusion
    const inv = entry.invocation;
    if (!isObserved(inv.kind)) continue; // an unobserved surface yields no drift
    switch (inv.kind) {
      case "rest": {
        const declared = bindingKey(inv.method, inv.path);
        const locs = restTagLocations.get(entry.id);
        if (!locs || locs.length === 0) {
          forwardDrift.push({
            id: entry.id,
            surface: "rest",
            reason: "unresolved",
            declared,
          });
        } else if (locs.includes(declared)) {
          resolvedIds.add(entry.id);
        } else {
          // Tag exists but at a different route — the binding-mismatch self-check
          // that makes a duplicated path string safe (R3).
          forwardDrift.push({
            id: entry.id,
            surface: "rest",
            reason: "binding-mismatch",
            declared,
            foundAt: [...locs].sort(cmp)[0],
          });
        }
        break;
      }
      case "rpc": {
        // Skip resolution when the sample is inconclusive (zero sockets).
        if (!rpcObs || rpcObs.sockets === 0) break;
        if (rpcAnnounced.has(inv.method)) resolvedIds.add(entry.id);
        else {
          forwardDrift.push({
            id: entry.id,
            surface: "rpc",
            reason: "unresolved",
            declared: inv.method,
          });
        }
        break;
      }
      case "mcp": {
        if (mcpAllTools.has(inv.tool)) resolvedIds.add(entry.id);
        else {
          forwardDrift.push({
            id: entry.id,
            surface: "mcp",
            reason: "unresolved",
            declared: inv.tool,
          });
        }
        break;
      }
      case "cli": {
        if (cliRoster.has(inv.command)) resolvedIds.add(entry.id);
        else {
          forwardDrift.push({
            id: entry.id,
            surface: "cli",
            reason: "unresolved",
            declared: inv.command,
          });
        }
        break;
      }
      case "ui": {
        if (uiRoster.has(inv.location)) resolvedIds.add(entry.id);
        else {
          forwardDrift.push({
            id: entry.id,
            surface: "ui",
            reason: "unresolved",
            declared: inv.location,
          });
        }
        break;
      }
    }
  }

  // ── coverage.byDomain (per-domain × per-surface committed counts) ──────────
  const byDomain = {} as Record<
    DomainSlug,
    Record<Surface, DomainSurfaceCount>
  >;
  for (const slug of DOMAIN_SLUGS) {
    const perSurface = {} as Record<Surface, DomainSurfaceCount>;
    for (const surface of AUDIT_SURFACE_ORDER) {
      perSurface[surface] = { entries: 0, resolved: 0 };
    }
    byDomain[slug] = perSurface;
  }
  for (const entry of index) {
    if (mountedElsewhere.has(entry.id)) continue;
    const bucket = byDomain[entry.domain]?.[entry.surface];
    if (!bucket) continue; // unknown domain slug — defensive; index is DOMAIN-validated
    bucket.entries += 1;
    if (resolvedIds.has(entry.id)) bucket.resolved += 1;
  }

  // ── coverage.bySurface (fixed order) ───────────────────────────────────────
  const bySurface = {
    rest: restCoverage,
    rpc: rpcCoverage,
    mcp: mcpCoverage,
    cli: cliCoverage,
    ui: uiCoverage,
  } as Record<Surface, SurfaceCoverage>;

  // ── Stable sorting (R8 / V3) ───────────────────────────────────────────────
  reverseDrift.sort(
    (a, b) =>
      surfaceRank(a.surface) - surfaceRank(b.surface) ||
      cmp(a.harness ?? "", b.harness ?? "") ||
      cmp(a.item, b.item)
  );
  forwardDrift.sort(
    (a, b) =>
      surfaceRank(a.surface) - surfaceRank(b.surface) ||
      cmp(a.id, b.id) ||
      cmp(a.reason, b.reason)
  );
  schemaErrors.sort(
    (a, b) =>
      cmp(a.kind, b.kind) ||
      cmp(a.id ?? a.binding ?? "", b.id ?? b.binding ?? "")
  );
  notMountedHere.sort(
    (a, b) => surfaceRank(a.surface) - surfaceRank(b.surface) || cmp(a.id, b.id)
  );

  const stabilityCaveats: string[] = [];
  if (isObserved("rpc")) {
    stabilityCaveats.push(
      "rpc coverage reflects the sockets connected at read time (rpcObserved.sockets); byte-identical only for a fixed socket set"
    );
  }
  if (isObserved("cli")) {
    stabilityCaveats.push(
      "cli coverage reflects the extension-registered command set at read time; byte-identical only for a fixed extension-command set"
    );
  }

  return {
    surfacesObserved: [...AUDIT_SURFACE_ORDER].filter(isObserved),
    coverage: { bySurface, byDomain, mcpByHarness },
    forwardDrift,
    reverseDrift,
    schemaErrors,
    notMountedHere,
    rpcObserved: isObserved("rpc") ? { sockets: rpcObs?.sockets ?? 0 } : null,
    provenance: {
      surfacesObserved: [...AUDIT_SURFACE_ORDER].filter(isObserved),
      stabilityCaveats,
    },
  };
}

/**
 * True when the report carries any blocking drift — the CLI verb's exit-code `1`
 * predicate (R6). Schema errors and both drift classes are blocking; `notMountedHere`
 * and `unknown`/`n/a` coverage are not.
 */
export function hasDrift(report: AuditReport): boolean {
  return (
    report.forwardDrift.length > 0 ||
    report.reverseDrift.length > 0 ||
    report.schemaErrors.length > 0
  );
}

// ── Advertised-vs-actual comparator (issue #3749, Sub-Issue I / R6) ───────────

/**
 * One capability as ADVERTISED by the session-aware catalog (#3749 annotation):
 * the entry `id` plus the availability verdict served to the caller.
 */
export interface AdvertisedCapability {
  id: string;
  available: boolean;
  reason?: string;
}

/**
 * The OUTCOME of a readonly probe of one capability. `ok` = the endpoint answered
 * as expected (a 2xx / a successful readonly call). `rejection` = the documented
 * rejection code when the probe was refused (e.g. `local_mode_not_supported`).
 * The probe EXECUTION lives in `cli/src/commands/capabilities.ts`; this module
 * only compares outcomes (D's R1 purity contract — no network, no fs, no boot).
 */
export interface ProbeOutcome {
  id: string;
  ok: boolean;
  rejection?: string;
}

export type AdvertisedVsActualKind =
  | "advertised-but-dead"
  | "unavailable-but-answering";

/** One reconciliation mismatch between what was advertised and what answered. */
export interface AdvertisedVsActualMismatch {
  id: string;
  kind: AdvertisedVsActualKind;
  detail: string;
}

/**
 * PURE advertised-vs-actual fold (R6). Reconciles each ADVERTISED capability
 * against its readonly PROBE outcome:
 *   - `available:true` with NO successful probe → `advertised-but-dead` (a
 *     missing outcome counts as dead: we advertised it usable but never confirmed).
 *   - `available:false` that ANSWERS successfully (probe ok, no rejection) →
 *     `unavailable-but-answering` (we hid a usable capability, or the reason is stale).
 *   - `available:false` matched by the documented rejection → MATCH.
 *   - `available:true` matched by a successful probe → MATCH.
 * Fixture-tested only; the caller passes exactly the probed (`probe:"safe"`) set.
 */
export function advertisedVsActual(
  advertised: readonly AdvertisedCapability[],
  probeOutcomes: readonly ProbeOutcome[]
): AdvertisedVsActualMismatch[] {
  const byId = new Map<string, ProbeOutcome>();
  for (const o of probeOutcomes) byId.set(o.id, o);

  const mismatches: AdvertisedVsActualMismatch[] = [];
  for (const cap of advertised) {
    const outcome = byId.get(cap.id);
    if (cap.available) {
      if (!outcome || !outcome.ok) {
        mismatches.push({
          id: cap.id,
          kind: "advertised-but-dead",
          detail: outcome
            ? `advertised available but the probe failed${outcome.rejection ? ` (${outcome.rejection})` : ""}`
            : "advertised available but no readonly probe confirmed it",
        });
      }
    } else if (outcome && outcome.ok && !outcome.rejection) {
      mismatches.push({
        id: cap.id,
        kind: "unavailable-but-answering",
        detail: `advertised unavailable (${cap.reason ?? "no reason"}) but the endpoint answered successfully`,
      });
    }
  }
  return mismatches;
}
