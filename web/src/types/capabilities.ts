// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Web-local response types for the capability panel (issue #3752, Sub-Issue L / R5).
 *
 * The web package cannot import server types (the `server/` package is not a web
 * dependency), so these MIRROR the JSON shapes the read routes emit. Source of truth:
 * - catalog: `AnnotatedLiveCatalog` in `server/src/capabilities/availabilityContext.ts`
 *   (returned by `GET /api/capabilities/catalog`, #3743/#3749).
 * - audit: `AuditReport` / `AuditFullBody` in `server/src/capabilities/audit.ts` +
 *   `server/src/web/routes/capabilityAudit.ts` (returned by `GET /api/capabilities/audit?format=full`, #3744).
 *
 * The panel is READ-ONLY and SERVER-COMPUTED (KD2/KD3): it renders these values,
 * it never recomputes availability, coverage, or drift from manifests.
 */
import type { CatalogEntry, Surface, DomainSlug } from "@hapi/protocol";

/** A catalog entry annotated with its per-session availability (#3749). */
export interface AnnotatedCatalogEntry extends CatalogEntry {
  /** Whether this in-scope entry is usable for the caller right now. */
  available: boolean;
  /** Human "why not" — present only when `available` is false. */
  reason?: string;
  /** Staleness marker: when the node-capability set was detected. */
  detectedAt?: string;
}

/** A REST route group carrying no `cataloged()` tag — the reverse-drift surface. */
export interface UncatalogedRoute {
  method: string;
  path: string;
}

/** One live RPC capability (a pointer to the per-session registration meta). */
export interface LiveRpcCapability {
  method: string;
  meta: { description?: string; riskTier?: string; since?: string };
}

/**
 * `GET /api/capabilities/catalog` response. Out-of-scope entries are OMITTED by the
 * server's hard scope filter (never `available:false`), so a `user` caller never
 * learns an operator entry exists. `nodeId`/`fallback`/`peerVersion` appear only on
 * a federated (`?nodeId=`) read.
 */
export interface CapabilityCatalogResponse {
  rest: AnnotatedCatalogEntry[];
  uncatalogedRest: UncatalogedRoute[];
  rpc: LiveRpcCapability[];
  mcp: AnnotatedCatalogEntry[];
  cli: AnnotatedCatalogEntry[];
  ui: AnnotatedCatalogEntry[];
  nodeId?: string;
  fallback?: boolean;
  peerVersion?: string | null;
}

/** Per-surface coverage headline. */
export type SurfaceCoverage =
  | { status: "n/a" }
  | { status: "unknown" }
  | { status: "measured"; observed: number; cataloged: number };

/** Per (domain, surface): committed-index entry count + how many resolve live. */
export interface DomainSurfaceCount {
  entries: number;
  resolved: number;
}

/** A live runtime item with no catalog entry (reverse decay). */
export interface ReverseDriftEntry {
  surface: Surface;
  item: string;
  harness?: string;
}

/** A committed index entry that does not resolve to a live item (forward decay). */
export interface ForwardDriftEntry {
  id: string;
  surface: Surface;
  reason: "unresolved" | "binding-mismatch";
  declared: string;
  foundAt?: string;
}

/** A structural inconsistency in the catalog itself. */
export interface SchemaError {
  kind: "duplicate-id" | "duplicate-binding";
  id?: string;
  binding?: string;
  ids: string[];
}

/** A committed entry excluded from forward drift because it carries `mountedWhen`. */
export interface NotMountedEntry {
  id: string;
  surface: Surface;
  mountedWhen: string;
}

/** The audit report — `?format=full`'s `report` field. */
export interface AuditReport {
  surfacesObserved: Surface[];
  coverage: {
    bySurface: Record<Surface, SurfaceCoverage>;
    byDomain: Record<DomainSlug, Record<Surface, DomainSurfaceCount>>;
    mcpByHarness: Record<string, SurfaceCoverage>;
  };
  forwardDrift: ForwardDriftEntry[];
  reverseDrift: ReverseDriftEntry[];
  schemaErrors: SchemaError[];
  notMountedHere: NotMountedEntry[];
  rpcObserved: { sockets: number } | null;
  provenance: { surfacesObserved: Surface[]; stabilityCaveats: string[] };
}

/**
 * `GET /api/capabilities/audit?format=full` response. `observed` (the raw server
 * observation for the CLI merge) is present but the panel ignores it. `nodeId`
 * appears only on a federated read.
 */
export interface CapabilityAuditResponse {
  report: AuditReport;
  observed?: unknown;
  nodeId?: string;
}
