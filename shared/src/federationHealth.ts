// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

// Federation-aware per-node health metrics contract (issue #1445, epic #1034).
//
// These schemas are the client contract that the Federation Health Dashboard
// (#1037) and the per-node detail page (#1444) render against. The server-side
// HealthAggregator produces values conforming to these shapes; the UI consumes
// them. Keep the response schemas stable — downstream UI work depends on them.
//
// Headline invariant: the aggregate severity is the WORST (highest) severity
// across every dimension of every node — NEVER an average. A single critical
// dimension on a single node makes the whole federation critical.

// ─── Severity scale ──────────────────────────────────────────

// Ordered severity scale. Index = rank (higher = worse). Used for max-reduction.
export const FederationHealthSeveritySchema = z.enum([
  "healthy", // 0
  "degraded", // 1
  "warning", // 2
  "critical", // 3
]);
export type FederationHealthSeverity = z.infer<
  typeof FederationHealthSeveritySchema
>;

// Per-node overall status adds "offline" (a node with no fresh sample). For
// AGGREGATION, "offline" collapses to "critical"; it is retained distinctly here
// so the UI can render offline nodes differently from merely-critical ones.
export const FederationNodeHealthStatusSchema = z.enum([
  "healthy",
  "degraded",
  "warning",
  "critical",
  "offline",
]);
export type FederationNodeHealthStatus = z.infer<
  typeof FederationNodeHealthStatusSchema
>;

// Resource dimensions tracked per node.
export const FederationHealthDimensionSchema = z.enum([
  "cpu",
  "ram",
  "disk",
  "latency",
]);
export type FederationHealthDimension = z.infer<
  typeof FederationHealthDimensionSchema
>;

const DimensionReadingSchema = z.object({
  value: z.number().nullable(), // usagePercent for cpu/ram/disk; roundTripMs for latency; null if unknown
  severity: FederationHealthSeveritySchema,
});

// ─── Per-node health ─────────────────────────────────────────

// Per-node metrics (response for GET /federation/health/:nodeId, and array element of aggregate inputs)
export const FederationNodeHealthSchema = z.object({
  nodeId: z.string(),
  nodeLabel: z.string(),
  status: FederationNodeHealthStatusSchema, // overall (worst-of-dimensions) OR "offline"
  online: z.boolean(),
  cpu: DimensionReadingSchema.extend({ temperatureF: z.number().nullable() }),
  ram: DimensionReadingSchema.extend({
    totalBytes: z.number(),
    usedBytes: z.number(),
  }),
  disk: DimensionReadingSchema.extend({
    totalBytes: z.number(),
    usedBytes: z.number(),
    mountPoint: z.string(),
  }),
  latency: DimensionReadingSchema, // value = roundTripMs (null for the local node — no network hop)
  lastSampleAt: z.number().nullable(), // epoch ms; null if never sampled
});
export type FederationNodeHealth = z.infer<typeof FederationNodeHealthSchema>;

// GET /federation/health/:nodeId response (node + time-series window)
export const FederationNodeHealthDetailSchema =
  FederationNodeHealthSchema.extend({
    timeSeries: z.array(
      z.object({
        timestamp: z.number(),
        cpu: z.number().nullable(),
        ram: z.number().nullable(),
        disk: z.number().nullable(),
        latency: z.number().nullable(),
      })
    ),
  });
export type FederationNodeHealthDetail = z.infer<
  typeof FederationNodeHealthDetailSchema
>;

// ─── Aggregate ───────────────────────────────────────────────

// GET /federation/health/aggregate response
export const FederationHealthAggregateSchema = z.object({
  worstCaseSeverity: FederationHealthSeveritySchema, // offline collapses to "critical" here
  perDimensionWorstCase: z.object({
    cpu: FederationHealthSeveritySchema,
    ram: FederationHealthSeveritySchema,
    disk: FederationHealthSeveritySchema,
    latency: FederationHealthSeveritySchema,
  }),
  nodesContributingToWorstCase: z.array(z.string()), // nodeIds whose worst dimension == worstCaseSeverity (incl. offline when worst==critical)
  nodeCount: z.number().int(),
  onlineNodeCount: z.number().int(),
  lastSampleAt: z.number().nullable(), // most recent sample across all nodes
});
export type FederationHealthAggregate = z.infer<
  typeof FederationHealthAggregateSchema
>;

// GET /federation/health/nodes response (issue #1632) — batch per-node view
// for #1037's Tier-2 cards. NO aggregation: offline nodes keep status
// "offline" (collapse-to-critical is computeAggregate-only semantics).
export const FederationHealthNodesResponseSchema = z.object({
  nodes: z.array(FederationNodeHealthSchema),
  lastSampleAt: z.number().nullable(), // most recent sample across all nodes; null if never sampled
});
export type FederationHealthNodesResponse = z.infer<
  typeof FederationHealthNodesResponseSchema
>;

// ─── Alerts ──────────────────────────────────────────────────

// Alert. dimension is a SUPERSET of the resource dimensions (adds "reachability"
// for offline transitions).
export const FederationAlertDimensionSchema = z.enum([
  "cpu",
  "ram",
  "disk",
  "latency",
  "reachability",
]);
export type FederationAlertDimension = z.infer<
  typeof FederationAlertDimensionSchema
>;

export const FederationAlertSchema = z.object({
  id: z.string(), // crypto.randomUUID()
  seq: z.number().int(), // monotonic; cursor ordering key
  severity: FederationHealthSeveritySchema,
  nodeId: z.string(),
  nodeLabel: z.string(),
  timestamp: z.number(), // epoch ms
  message: z.string(),
  dimension: FederationAlertDimensionSchema,
});
export type FederationAlert = z.infer<typeof FederationAlertSchema>;

// GET /federation/alerts response (newest-first)
export const FederationAlertsResponseSchema = z.object({
  alerts: z.array(FederationAlertSchema),
  nextCursor: z.string().nullable(), // seq (as string) to pass as ?cursor= for the next (older) page; null if no more
});
export type FederationAlertsResponse = z.infer<
  typeof FederationAlertsResponseSchema
>;

// ─── Thresholds ──────────────────────────────────────────────

// Per-dimension severity thresholds. A value at or above `degraded` is at
// least `degraded`; at or above `warning` is at least `warning`; at or above
// `critical` is `critical`. Below `degraded` is `healthy`. These bounds are
// the lower edge of each band. Configurable via HAPI_FED_HEALTH_THRESHOLDS
// (JSON override) — see the issue directive §5.
const DimensionThresholdsSchema = z.object({
  degraded: z.number(),
  warning: z.number(),
  critical: z.number(),
});
export type DimensionThresholds = z.infer<typeof DimensionThresholdsSchema>;

export const FederationHealthThresholdsSchema = z.object({
  cpu: DimensionThresholdsSchema, // usagePercent
  ram: DimensionThresholdsSchema, // usagePercent
  disk: DimensionThresholdsSchema, // usagePercent
  latency: DimensionThresholdsSchema, // roundTripMs
});
export type FederationHealthThresholds = z.infer<
  typeof FederationHealthThresholdsSchema
>;

// Locked default thresholds (issue directive §3). All bounds are the lower edge
// of the band: e.g. CPU is `degraded` at 70, `warning` at 85, `critical` at 95.
export const DEFAULT_FEDERATION_HEALTH_THRESHOLDS: FederationHealthThresholds =
  {
    cpu: { degraded: 70, warning: 85, critical: 95 },
    ram: { degraded: 75, warning: 88, critical: 95 },
    disk: { degraded: 80, warning: 90, critical: 95 },
    latency: { degraded: 500, warning: 1500, critical: 4000 },
  };

// ─── Health disabled ─────────────────────────────────────────

// Machine code on the 503 every health read route answers when this instance
// runs no HealthAggregator (federation health monitoring is off). The `error`
// string stays the human message; this code lets a client tell a deliberately
// disabled feature from a broken route — `hapi capabilities audit --probe`
// reports it as disabled, not as drift (issue #5212).
export const FEDERATION_HEALTH_DISABLED_CODE = "federation_health_disabled";
