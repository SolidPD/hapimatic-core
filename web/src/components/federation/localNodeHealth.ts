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
 * (`server/src/federation/healthAggregator.ts`) — used on a **standalone** VM
 * where the federation `HealthAggregator` is never constructed (federation is
 * disabled), so the server never classifies the local node's dimensions. The
 * threshold VALUES are imported from `@hapi/protocol`
 * (`DEFAULT_FEDERATION_HEALTH_THRESHOLDS`), so only the small lower-edge band
 * comparison is duplicated — the numbers themselves can never drift.
 *
 * Null handling is dimension-aware and byte-identical to the server: a null
 * `latency` (the local node has no network hop) stays "healthy", but a
 * null/non-finite resource dimension (cpu/ram/disk) means its collector FAILED
 * and is surfaced as "critical" — a failed sample must never hide behind a
 * "healthy" reading. (The card still renders "—" for a null VALUE regardless of
 * severity, because `DimensionBar` gates the bar on `value !== null`.)
 */
export function classifyDimension(
  dimension: FederationHealthDimension,
  value: number | null,
  thresholds: FederationHealthThresholds = DEFAULT_FEDERATION_HEALTH_THRESHOLDS
): FederationHealthSeverity {
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
 * Used ONLY for the standalone local-node fallback card, where the federation
 * aggregator is unavailable. `latency` has no meaning for the local node (no
 * network hop) → `value: null` renders "—". A null resource `usagePercent`
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
