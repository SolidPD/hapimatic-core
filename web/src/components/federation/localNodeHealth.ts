// SPDX-License-Identifier: AGPL-3.0-only
import type { SystemHealthMetrics } from "@/lib/systemHealth";
import {
  DEFAULT_FEDERATION_HEALTH_THRESHOLDS,
  type FederationHealthDimension,
  type FederationHealthSeverity,
  type FederationHealthThresholds,
} from "@hapi/protocol";
import type { NodeCardReading } from "./FederationNodeCard";

/**
 * Client-side mirror of the server's `classifyDimension`
 * (`server/src/federation/healthAggregator.ts`) — used when the server runs no
 * `HealthAggregator` (a standalone VM on a server built before #6217; from
 * #6217 every node runs one, local-only on a standalone node or a spoke), so
 * the server never classifies the local node's dimensions. The
 * threshold VALUES are imported from `@hapi/protocol`
 * (`DEFAULT_FEDERATION_HEALTH_THRESHOLDS`), so only the small lower-edge band
 * comparison is duplicated — the numbers themselves can never drift.
 *
 * Null handling is dimension-aware and byte-identical to the server: a null
 * `latency` (the local node has no network hop) stays "healthy", and so does a
 * null `cpu`, which means no 1-60 s sample window exists yet (#6156). A
 * null/non-finite `ram`/`disk`, or a non-finite `cpu`, means its collector
 * FAILED and is surfaced as "critical" — a failed sample must never hide behind
 * a "healthy" reading. (The card still renders "—" for a null VALUE regardless of
 * severity, because `DimensionBar` gates the bar on `value !== null`.)
 */
export function classifyDimension(
  dimension: FederationHealthDimension,
  value: number | null,
  thresholds: FederationHealthThresholds = DEFAULT_FEDERATION_HEALTH_THRESHOLDS
): FederationHealthSeverity {
  // #6156: a null CPU means no 1-60 s sample window exists yet (the first
  // seconds after a server start), not a failed collector, so it is neutral.
  if (value == null && dimension === "cpu") return "healthy";
  if (value == null || !Number.isFinite(value)) {
    return dimension === "latency" ? "healthy" : "critical";
  }
  const t = thresholds[dimension];
  if (value >= t.critical) return "critical";
  if (value >= t.warning) return "warning";
  if (value >= t.degraded) return "degraded";
  return "healthy";
}

export type LocalNodeReadings = {
  cpu: NodeCardReading;
  ram: NodeCardReading;
  disk: NodeCardReading;
  latency: NodeCardReading;
};

/**
 * Map the local `/api/system-health` collector's `SystemHealthMetrics` into the
 * federation card's per-dimension `readings` shape (issue #2513).
 *
 * Used ONLY for the local-node fallback card, shown when the health reads fail
 * (a server built before #6217 runs no health aggregator and answers 503; any
 * other failed read lands here too). `latency` has no meaning for the local
 * node (no network hop) → `value: null` renders "—". A null resource `usagePercent`
 * (collector sub-failure, #1519) likewise keeps `value: null` → "—", matching
 * the server's semantics. Returns `undefined` when no metrics are available yet
 * (poll pending or health disabled), so the card falls back to the readings-free
 * identity floor (Fallback Preservation Rule) rather than rendering wrong data.
 */
export function localReadingsFromMetrics(
  metrics: SystemHealthMetrics | null
): LocalNodeReadings | undefined {
  if (!metrics) return undefined;
  return {
    cpu: {
      value: metrics.cpu.usagePercent,
      severity: classifyDimension("cpu", metrics.cpu.usagePercent),
    },
    ram: {
      value: metrics.memory.usagePercent,
      severity: classifyDimension("ram", metrics.memory.usagePercent),
    },
    disk: {
      value: metrics.disk.usagePercent,
      severity: classifyDimension("disk", metrics.disk.usagePercent),
    },
    latency: { value: null, severity: "healthy" },
  };
}
