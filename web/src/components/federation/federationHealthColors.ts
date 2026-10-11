// SPDX-License-Identifier: AGPL-3.0-only
import { getStatusColor, type HealthStatus } from "@/lib/systemHealth";
import type { FederationNodeHealthStatus } from "@hapi/protocol";

/**
 * Latency has no 0–100 scale, so its meter/mini-bar fill is scaled to this
 * critical-threshold value (ms) as "full width" — a purely relative visual cue.
 * Shared by `FederationNodeCard`'s compact `DimensionBar` and the per-node
 * detail page's full-size `NodeResourceMeter` so the two latency bars stay in
 * sync (single source of truth).
 */
export const LATENCY_FULL_SCALE_MS = 4000;

/**
 * Locked severity → existing-`HealthStatus` mapping (issue #1037, R10).
 *
 * #1445's severity vocabulary (`healthy`/`degraded`/`warning`/`critical`, plus
 * the per-node `offline` status) differs from the existing local `HealthStatus`
 * palette (`green`/`yellow`/`orange`/`red`/`unknown`). This module is the single
 * lock-point that bridges them — reusing `getStatusColor` so a federation health
 * dot is the EXACT same color as the top-bar `HealthIcon` for the same condition
 * (the icon #1043 reroutes via #1040's preference).
 *
 * `FederationHealthSeverity` (the aggregate `worstCaseSeverity`, which has no
 * `offline`) is a subtype of `FederationNodeHealthStatus`, so this signature
 * accepts both the aggregate severity and a per-node status.
 */
const SEVERITY_TO_HEALTH_STATUS: Record<
  FederationNodeHealthStatus,
  HealthStatus
> = {
  healthy: "green",
  degraded: "yellow",
  warning: "orange",
  critical: "red",
  offline: "unknown",
};

/** Map a federation severity / per-node status onto the existing HealthStatus. */
export function severityToHealthStatus(
  severity: FederationNodeHealthStatus
): HealthStatus {
  return SEVERITY_TO_HEALTH_STATUS[severity] ?? "unknown";
}

/**
 * Resolve the UI hex color for a federation severity / per-node status, using
 * the existing `getStatusColor` palette (R10 — visual parity with HealthIcon).
 */
export function severityToColor(severity: FederationNodeHealthStatus): string {
  return getStatusColor(severityToHealthStatus(severity));
}

const SEVERITY_TO_LABEL: Record<FederationNodeHealthStatus, string> = {
  healthy: "Healthy",
  degraded: "Degraded",
  warning: "Warning",
  critical: "Critical",
  offline: "Offline",
};

/**
 * Human-readable label for a federation severity / per-node status — used by
 * the per-node detail page's critical banner and alert badges (issue #1444).
 */
export function severityToLabel(severity: FederationNodeHealthStatus): string {
  return SEVERITY_TO_LABEL[severity] ?? "Unknown";
}

/**
 * Whether a per-node `status` warrants the per-node detail page's critical
 * banner (issue #1444, R4). The worst-case aggregation is server-computed
 * (#1445) — this is purely the read-side "is this the alarm condition?" test
 * (`critical` OR `offline`), NOT a client-side re-aggregation.
 */
export function isCriticalStatus(status: FederationNodeHealthStatus): boolean {
  return status === "critical" || status === "offline";
}
