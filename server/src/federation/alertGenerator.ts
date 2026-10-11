// SPDX-License-Identifier: AGPL-3.0-only
// Federation alert generator (issue #1445, Task 6).
//
// Translates per-node health transitions into alerts and pushes them to a
// bounded AlertRingBuffer. Fires on a RISE only — recovery (critical→healthy)
// is silent for the MVP (#1037 derives current state from the aggregate, not by
// replaying the alert feed).
//
// Two rules, one alert per logical event (no double-firing):
//   R4 — online→offline transition ⇒ ONE "reachability"/critical alert.
//   R5 — a resource dimension RISING into warning/critical ⇒ ONE alert tagged
//        with that dimension. General non-offline severity worsening is fully
//        represented by its causing dimension(s), so there is no separate
//        "overall" alert for non-offline cases.
import type {
  FederationAlert,
  FederationAlertDimension,
  FederationAlertsResponse,
  FederationHealthDimension,
  FederationHealthSeverity,
  FederationNodeHealth,
} from "@hapi/protocol";
import type { AlertRingBuffer, AlertQuery } from "./alertRingBuffer";
import type { AlertEvaluator, AlertSource } from "./healthAggregator";

const SEVERITY_RANK: Record<FederationHealthSeverity, number> = {
  healthy: 0,
  degraded: 1,
  warning: 2,
  critical: 3,
};

const RESOURCE_DIMENSIONS: FederationHealthDimension[] = [
  "cpu",
  "ram",
  "disk",
  "latency",
];

function newAlertId(): string {
  try {
    if (
      typeof crypto !== "undefined" &&
      typeof crypto.randomUUID === "function"
    ) {
      return crypto.randomUUID();
    }
  } catch {
    // fall through
  }
  return `alert-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
}

function dimensionMessage(
  dim: FederationHealthDimension,
  node: FederationNodeHealth
): string {
  const sev = node[dim].severity;
  const value = node[dim].value;
  if (dim === "latency") {
    const v = value == null ? "?" : `${Math.round(value)}ms`;
    return `latency ${v} on ${node.nodeLabel} (${sev})`;
  }
  const v = value == null ? "?" : `${Math.round(value)}%`;
  return `${dim} usage ${v} on ${node.nodeLabel} (${sev})`;
}

export class AlertGenerator implements AlertEvaluator, AlertSource {
  private readonly buffer: AlertRingBuffer;
  private readonly getNow: () => number;

  constructor(
    buffer: AlertRingBuffer,
    getNow: () => number = () => Date.now()
  ) {
    this.buffer = buffer;
    this.getNow = getNow;
  }

  /**
   * Inspect a node's prev→next health and push alerts for any rises.
   * `prev === null` (first sighting) is treated as a healthy/online baseline.
   */
  evaluate(
    prev: FederationNodeHealth | null,
    next: FederationNodeHealth
  ): void {
    const ts = next.lastSampleAt ?? this.getNow();

    // R4 — reachability: fire once when a node transitions INTO offline.
    const prevOffline = prev?.status === "offline";
    if (next.status === "offline" && !prevOffline) {
      this.emit({
        severity: "critical",
        nodeId: next.nodeId,
        nodeLabel: next.nodeLabel,
        timestamp: ts,
        message: `${next.nodeLabel} went offline (no recent metrics)`,
        dimension: "reachability",
      });
      // While offline, the resource dimensions are not meaningful (no sample),
      // so do not also evaluate R5 for this cycle.
      return;
    }

    // R5 — per-dimension rise into warning/critical.
    for (const dim of RESOURCE_DIMENSIONS) {
      const nextSev = next[dim].severity;
      const prevSev = prev ? prev[dim].severity : "healthy";
      const rose = SEVERITY_RANK[nextSev] > SEVERITY_RANK[prevSev];
      const intoActionable = SEVERITY_RANK[nextSev] >= SEVERITY_RANK.warning;
      if (rose && intoActionable) {
        this.emit({
          severity: nextSev,
          nodeId: next.nodeId,
          nodeLabel: next.nodeLabel,
          timestamp: ts,
          message: dimensionMessage(dim, next),
          dimension: dim as FederationAlertDimension,
        });
      }
    }
  }

  private emit(alert: Omit<FederationAlert, "seq" | "id">): FederationAlert {
    return this.buffer.push({ ...alert, id: newAlertId() });
  }

  /** Cursor-paginated alert read (AlertSource — used by HealthAggregator). */
  getAlerts(query: AlertQuery = {}): FederationAlertsResponse {
    return this.buffer.query(query);
  }
}
