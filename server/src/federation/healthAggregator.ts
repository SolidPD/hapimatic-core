// SPDX-License-Identifier: AGPL-3.0-only
// Federation health aggregator (issue #1445, Task 5).
//
// Owns a SEPARATE poll loop from NodeRegistry — it only READS
// `getNodeStates()` and never touches `pollNode()` (the session-sync hot path,
// the #1 federation feature). Per the Fallback Preservation Rule and the
// no-regression AC, this loop is additive.
//
// Three pure exports (`classifyDimension`, `computeNodeStatus`,
// `computeAggregate`) carry the worst-case-NOT-averaged invariant and are
// unit-tested without any timers/mocks. The `HealthAggregator` class wires the
// poll loop, the per-node cache + time-series ring, the independent offline
// clock, and the alert-transition feed around those pure functions.
import type {
  FederationAlert,
  FederationHealthAggregate,
  FederationHealthDimension,
  FederationHealthNodesResponse,
  FederationHealthSeverity,
  FederationHealthThresholds,
  FederationNodeHealth,
  FederationNodeHealthDetail,
  FederationNodeHealthStatus,
  FederationNodeState,
} from "@hapi/protocol";
import {
  DEFAULT_FEDERATION_HEALTH_THRESHOLDS,
  SupervisedLoop,
  type JobRegistry,
} from "@hapi/protocol";
import type { SystemHealthMetrics } from "../metrics/systemHealth";

// ─── Severity algebra ────────────────────────────────────────

const SEVERITY_RANK: Record<FederationHealthSeverity, number> = {
  healthy: 0,
  degraded: 1,
  warning: 2,
  critical: 3,
};
const RANK_TO_SEVERITY: FederationHealthSeverity[] = [
  "healthy",
  "degraded",
  "warning",
  "critical",
];

/** Max-reduction over a severity list. Empty → "healthy". NEVER averages. */
export function maxSeverity(
  severities: FederationHealthSeverity[]
): FederationHealthSeverity {
  let rank = 0;
  for (const s of severities) rank = Math.max(rank, SEVERITY_RANK[s]);
  return RANK_TO_SEVERITY[rank];
}

/**
 * Rank for an overall node status, where "offline" sits at/above "critical".
 * Used by the alert generator to detect worsening transitions.
 */
export function nodeStatusRank(status: FederationNodeHealthStatus): number {
  return status === "offline" ? 4 : SEVERITY_RANK[status];
}

// ─── Pure classification ─────────────────────────────────────

/**
 * Classify a single dimension value into a severity using the lower-edge
 * threshold bands. Null handling is dimension-aware (#1519): a null `latency`
 * (the local node has no network hop) stays "healthy", but a null/non-finite
 * resource dimension (cpu/ram/disk) means its collector FAILED and is surfaced
 * as "critical" — a failed sample must never hide behind a "healthy" reading.
 */
export function classifyDimension(
  dimension: FederationHealthDimension,
  value: number | null,
  thresholds: FederationHealthThresholds
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

/**
 * Overall per-node status: "offline" when not online, else the worst of the
 * four dimension severities.
 */
export function computeNodeStatus(
  node: Pick<
    FederationNodeHealth,
    "online" | "cpu" | "ram" | "disk" | "latency"
  >
): FederationNodeHealthStatus {
  if (!node.online) return "offline";
  return maxSeverity([
    node.cpu.severity,
    node.ram.severity,
    node.disk.severity,
    node.latency.severity,
  ]);
}

const DIMENSIONS: FederationHealthDimension[] = [
  "cpu",
  "ram",
  "disk",
  "latency",
];

/**
 * Effective severity of a node on one dimension for AGGREGATION purposes.
 * An offline node contributes "critical" on EVERY dimension — the worst-case
 * safety property: a missing sample can never hide behind healthy peers.
 */
function effectiveSeverity(
  node: FederationNodeHealth,
  dim: FederationHealthDimension
): FederationHealthSeverity {
  if (!node.online || node.status === "offline") return "critical";
  return node[dim].severity;
}

/**
 * Federation-wide aggregate. WORST-CASE, NEVER AVERAGED: each dimension's
 * aggregate severity is the max across all nodes (offline ⇒ critical), and the
 * overall worst-case severity is the max across all dimensions. A single
 * critical dimension on a single node makes the whole federation critical,
 * regardless of how many healthy metrics exist elsewhere. (AC#1, AC#2, R2)
 */
export function computeAggregate(
  nodes: FederationNodeHealth[]
): FederationHealthAggregate {
  const perDimensionWorstCase = {
    cpu: maxSeverity(nodes.map(n => effectiveSeverity(n, "cpu"))),
    ram: maxSeverity(nodes.map(n => effectiveSeverity(n, "ram"))),
    disk: maxSeverity(nodes.map(n => effectiveSeverity(n, "disk"))),
    latency: maxSeverity(nodes.map(n => effectiveSeverity(n, "latency"))),
  };

  const worstCaseSeverity = maxSeverity([
    perDimensionWorstCase.cpu,
    perDimensionWorstCase.ram,
    perDimensionWorstCase.disk,
    perDimensionWorstCase.latency,
  ]);

  // Nodes whose own worst effective dimension equals the federation worst-case.
  const nodesContributingToWorstCase = nodes
    .filter(n => {
      const nodeWorst = maxSeverity(
        DIMENSIONS.map(d => effectiveSeverity(n, d))
      );
      return nodeWorst === worstCaseSeverity;
    })
    .map(n => n.nodeId);

  let onlineNodeCount = 0;
  let lastSampleAt: number | null = null;
  for (const n of nodes) {
    if (n.online) onlineNodeCount++;
    if (n.lastSampleAt != null) {
      lastSampleAt =
        lastSampleAt == null
          ? n.lastSampleAt
          : Math.max(lastSampleAt, n.lastSampleAt);
    }
  }

  return {
    worstCaseSeverity,
    perDimensionWorstCase,
    nodesContributingToWorstCase,
    nodeCount: nodes.length,
    onlineNodeCount,
    lastSampleAt,
  };
}

// ─── Node-health construction ────────────────────────────────

/** Build a FederationNodeHealth from a raw metrics sample. */
export function buildNodeHealth(
  nodeId: string,
  nodeLabel: string,
  metrics: SystemHealthMetrics,
  latencyMs: number | null,
  sampledAt: number,
  thresholds: FederationHealthThresholds
): FederationNodeHealth {
  const node: FederationNodeHealth = {
    nodeId,
    nodeLabel,
    online: true,
    status: "healthy", // placeholder; recomputed below
    cpu: {
      value: metrics.cpu.usagePercent,
      severity: classifyDimension("cpu", metrics.cpu.usagePercent, thresholds),
      temperatureF: metrics.cpu.temperatureF,
    },
    ram: {
      value: metrics.memory.usagePercent,
      severity: classifyDimension(
        "ram",
        metrics.memory.usagePercent,
        thresholds
      ),
      totalBytes: metrics.memory.total,
      usedBytes: metrics.memory.used,
    },
    disk: {
      value: metrics.disk.usagePercent,
      severity: classifyDimension(
        "disk",
        metrics.disk.usagePercent,
        thresholds
      ),
      totalBytes: metrics.disk.total,
      usedBytes: metrics.disk.used,
      mountPoint: metrics.disk.mountPoint,
    },
    latency: {
      value: latencyMs,
      severity: classifyDimension("latency", latencyMs, thresholds),
    },
    lastSampleAt: sampledAt,
  };
  node.status = computeNodeStatus(node);
  return node;
}

/** A node we've never sampled (or that has aged out): offline on every front. */
function blankOfflineNode(
  nodeId: string,
  nodeLabel: string
): FederationNodeHealth {
  return {
    nodeId,
    nodeLabel,
    online: false,
    status: "offline",
    cpu: { value: null, severity: "healthy", temperatureF: null },
    ram: { value: null, severity: "healthy", totalBytes: 0, usedBytes: 0 },
    disk: {
      value: null,
      severity: "healthy",
      totalBytes: 0,
      usedBytes: 0,
      mountPoint: "",
    },
    latency: { value: null, severity: "healthy" },
    lastSampleAt: null,
  };
}

// ─── The class ───────────────────────────────────────────────

export interface AlertEvaluator {
  /** Inspect a node's prev→next health and push any alerts. */
  evaluate(prev: FederationNodeHealth | null, next: FederationNodeHealth): void;
}

export interface AlertSource {
  /** Cursor-paginated alert read (delegates to the ring buffer). */
  getAlerts(query: { limit?: number; cursor?: string; nodeId?: string }): {
    alerts: FederationAlert[];
    nextCursor: string | null;
  };
}

export interface HealthAggregatorConfig {
  /** Health poll interval (ms). Default 30000. */
  healthPollIntervalMs: number;
  /** Offline grace: a node with no fresh sample within this window → offline. */
  offlineGraceMs: number;
  /** Time-series ring retention (minutes). */
  tsRetentionMinutes: number;
  /** Severity thresholds. */
  thresholds: FederationHealthThresholds;
  /** Injectable clock for deterministic tests. Default Date.now. */
  getNow?: () => number;
}

interface SamplePoint {
  timestamp: number;
  cpu: number | null;
  ram: number | null;
  disk: number | null;
  latency: number | null;
}

interface NodeCacheEntry {
  /** Last SUCCESSFUL sample (dims populated). */
  last: FederationNodeHealth;
  /** Epoch ms of the last successful sample; null if never sampled. */
  lastSampleAt: number | null;
  /** View presented on the previous cycle (for alert transition detection). */
  prevView: FederationNodeHealth | null;
  /** Bounded time-series ring. */
  ring: SamplePoint[];
  /** Display label. */
  nodeLabel: string;
}

export interface HealthAggregatorOptions {
  getNodeStates: () => FederationNodeState[];
  gatherLocalMetrics: () => Promise<SystemHealthMetrics>;
  /** GET the peer's /api/federation/node-metrics with the fed token + timeout. */
  fetchPeerMetrics: (url: string) => Promise<SystemHealthMetrics>;
  localNodeId: string;
  localNodeLabel: string;
  alertGenerator: AlertEvaluator;
  /** Read accessor for the alert feed (the AlertGenerator's ring buffer). */
  alertSource: AlertSource;
  config: HealthAggregatorConfig;
  /** Runtime job registry to register the supervised loop into (#1963). */
  jobRegistry?: JobRegistry | null;
}

export class HealthAggregator {
  private readonly opts: HealthAggregatorOptions;
  private readonly thresholds: FederationHealthThresholds;
  private readonly getNow: () => number;
  private readonly ringCapacity: number;
  private readonly cache = new Map<string, NodeCacheEntry>();
  private readonly loop: SupervisedLoop;

  constructor(opts: HealthAggregatorOptions) {
    this.opts = opts;
    this.thresholds =
      opts.config.thresholds ?? DEFAULT_FEDERATION_HEALTH_THRESHOLDS;
    this.getNow = opts.config.getNow ?? (() => Date.now());
    const pollMs = Math.max(1000, opts.config.healthPollIntervalMs);
    this.ringCapacity = Math.max(
      1,
      Math.floor((opts.config.tsRetentionMinutes * 60_000) / pollMs)
    );
    // #1963: supervised-loop wrapper. HealthAggregator already rescheduled in
    // `.finally()` (the correct shape this primitive canonicalizes); adoption
    // adds the stall watchdog + job-registry registration without changing the
    // sample() unit of work.
    this.loop = new SupervisedLoop({
      name: "health-aggregator",
      node: opts.localNodeId,
      intervalMs: opts.config.healthPollIntervalMs,
      immediate: true, // sample immediately on start (preserves prior behavior)
      now: this.getNow,
      registry: opts.jobRegistry ?? undefined,
      tick: () => this.sample(),
    });
  }

  /** Begin the drift-free poll loop (sample immediately, then reschedule). */
  start(): void {
    console.log(
      `[Federation] HealthAggregator polling every ${Math.round(
        this.opts.config.healthPollIntervalMs / 1000
      )}s (offline grace ${Math.round(this.opts.config.offlineGraceMs / 1000)}s)`
    );
    this.loop.start();
  }

  /** Stop the loop and clear any pending timer (graceful shutdown). */
  stop(): void {
    this.loop.stop();
  }

  /**
   * Run exactly one poll cycle: sample the local node in-process, fetch each
   * pollable remote peer (skipping offline/backoff per R12), update the cache +
   * time-series, re-evaluate the offline clock, and feed prev→next transitions
   * to the alert generator. Public so tests can drive cycles without timers.
   */
  async sample(): Promise<void> {
    const now = this.getNow();
    const states = this.opts.getNodeStates();

    // Reconcile known nodes: drop cache entries no longer in the federation.
    const knownIds = new Set<string>([this.opts.localNodeId]);
    for (const s of states) knownIds.add(s.config.id);
    for (const id of [...this.cache.keys()]) {
      if (!knownIds.has(id)) this.cache.delete(id);
    }

    // 1. Local node (in-process; latency = null — no network hop).
    let localHealth: FederationNodeHealth | null = null;
    try {
      const metrics = await this.opts.gatherLocalMetrics();
      localHealth = buildNodeHealth(
        this.opts.localNodeId,
        this.opts.localNodeLabel,
        metrics,
        null,
        this.getNow(),
        this.thresholds
      );
    } catch (err) {
      console.error("[Federation] HealthAggregator local sample failed:", err);
    }
    if (localHealth) {
      this.commitFresh(
        this.opts.localNodeId,
        this.opts.localNodeLabel,
        localHealth
      );
    } else {
      this.commitStale(this.opts.localNodeId, this.opts.localNodeLabel, now);
    }

    // 2. Remote peers — fetch pollable ones concurrently, bound load (R12).
    const pollable = states.filter(s => !this.isSkippable(s));
    const skipped = states.filter(s => this.isSkippable(s));

    const fetches = pollable.map(async state => {
      const t0 = this.getNow();
      try {
        const url = this.metricsUrl(state.config.url);
        const metrics = await this.opts.fetchPeerMetrics(url);
        const rtt = Math.max(0, this.getNow() - t0);
        const health = buildNodeHealth(
          state.config.id,
          state.config.label,
          metrics,
          rtt,
          this.getNow(),
          this.thresholds
        );
        return { state, health };
      } catch {
        return { state, health: null as FederationNodeHealth | null };
      }
    });

    const results = await Promise.allSettled(fetches);
    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      const { state, health } = r.value;
      if (health) {
        this.commitFresh(state.config.id, state.config.label, health);
      } else {
        this.commitStale(state.config.id, state.config.label, now);
      }
    }

    // Skipped (offline/backoff) peers get no fresh sample — re-evaluate clock.
    for (const state of skipped) {
      this.commitStale(state.config.id, state.config.label, now);
    }
  }

  /** Should NodeRegistry's view of this node cause us to skip polling it? (R12) */
  private isSkippable(state: FederationNodeState): boolean {
    // Skip nodes NodeRegistry already considers offline or in poll-backoff
    // (consecutiveFailures past the offline threshold). Bounds request load.
    return state.status === "offline" || state.consecutiveFailures >= 3;
  }

  private metricsUrl(base: string): string {
    return `${base.replace(/\/+$/, "")}/api/federation/node-metrics`;
  }

  private getEntry(nodeId: string, nodeLabel: string): NodeCacheEntry {
    let entry = this.cache.get(nodeId);
    if (!entry) {
      entry = {
        last: blankOfflineNode(nodeId, nodeLabel),
        lastSampleAt: null,
        prevView: null,
        ring: [],
        nodeLabel,
      };
      this.cache.set(nodeId, entry);
    }
    entry.nodeLabel = nodeLabel;
    return entry;
  }

  /** A successful sample landed this cycle. */
  private commitFresh(
    nodeId: string,
    nodeLabel: string,
    health: FederationNodeHealth
  ): void {
    const entry = this.getEntry(nodeId, nodeLabel);
    entry.last = health;
    entry.lastSampleAt = health.lastSampleAt;
    this.pushRing(entry, {
      timestamp: health.lastSampleAt ?? this.getNow(),
      cpu: health.cpu.value,
      ram: health.ram.value,
      disk: health.disk.value,
      latency: health.latency.value,
    });
    this.fireAndStore(entry, health);
  }

  /** No fresh sample this cycle — present the offline-clock-evaluated view. */
  private commitStale(nodeId: string, nodeLabel: string, now: number): void {
    const entry = this.getEntry(nodeId, nodeLabel);
    const view = this.viewOf(entry, now);
    // Stale cycle records a gap (null values) in the time series.
    this.pushRing(entry, {
      timestamp: now,
      cpu: null,
      ram: null,
      disk: null,
      latency: null,
    });
    this.fireAndStore(entry, view);
  }

  private pushRing(entry: NodeCacheEntry, point: SamplePoint): void {
    entry.ring.push(point);
    if (entry.ring.length > this.ringCapacity) entry.ring.shift();
  }

  private fireAndStore(
    entry: NodeCacheEntry,
    view: FederationNodeHealth
  ): void {
    this.opts.alertGenerator.evaluate(entry.prevView, view);
    entry.prevView = view;
  }

  /** Compute the presented view for a cache entry, applying the offline clock. */
  private viewOf(entry: NodeCacheEntry, now: number): FederationNodeHealth {
    const online =
      entry.lastSampleAt != null &&
      now - entry.lastSampleAt <= this.opts.config.offlineGraceMs;
    if (online) return entry.last;
    // Offline: keep last-known dimension readings for the UI, override status.
    if (entry.lastSampleAt == null) {
      return blankOfflineNode(entry.last.nodeId, entry.nodeLabel);
    }
    return {
      ...entry.last,
      nodeLabel: entry.nodeLabel,
      online: false,
      status: "offline",
    };
  }

  // ─── Read accessors (for the routes) ───────────────────────

  /** Current federation aggregate (worst-case across all nodes). */
  getAggregate(): FederationHealthAggregate {
    const now = this.getNow();
    const nodes = [...this.cache.values()].map(e => this.viewOf(e, now));
    return computeAggregate(nodes);
  }

  /**
   * Current per-node health for every cached node (local + remotes), offline
   * clock applied per node. NO aggregation (issue #1632): offline nodes keep
   * status "offline"; severities pass through as cached. Batch source for
   * #1037's Tier-2 cards.
   */
  getNodes(): FederationHealthNodesResponse {
    const now = this.getNow();
    const nodes = [...this.cache.values()].map(e => this.viewOf(e, now));
    let lastSampleAt: number | null = null;
    for (const n of nodes) {
      if (n.lastSampleAt != null) {
        lastSampleAt =
          lastSampleAt == null
            ? n.lastSampleAt
            : Math.max(lastSampleAt, n.lastSampleAt);
      }
    }
    return { nodes, lastSampleAt };
  }

  /** One node's current health + a time-series window, or null if unknown. */
  getNode(
    nodeId: string,
    windowMinutes = 30
  ): FederationNodeHealthDetail | null {
    const entry = this.cache.get(nodeId);
    if (!entry) return null;
    const now = this.getNow();
    const view = this.viewOf(entry, now);
    const cutoff =
      now - clampWindowMinutes(windowMinutes, this.opts.config) * 60_000;
    const timeSeries = entry.ring
      .filter(p => p.timestamp >= cutoff)
      .map(p => ({
        timestamp: p.timestamp,
        cpu: p.cpu,
        ram: p.ram,
        disk: p.disk,
        latency: p.latency,
      }));
    return { ...view, timeSeries };
  }

  /** Delegate alert reads to the AlertGenerator's ring buffer. */
  getAlerts(query: { limit?: number; cursor?: string; nodeId?: string }): {
    alerts: FederationAlert[];
    nextCursor: string | null;
  } {
    return this.opts.alertSource.getAlerts(query);
  }
}

function clampWindowMinutes(
  requested: number,
  config: HealthAggregatorConfig
): number {
  if (!Number.isFinite(requested) || requested <= 0) return 30;
  return Math.min(requested, config.tsRetentionMinutes);
}
