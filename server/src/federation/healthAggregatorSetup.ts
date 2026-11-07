// SPDX-License-Identifier: AGPL-3.0-only
// Health aggregator setup shared by every node (issue #6217).
//
// `resolveHealthAggregatorSettings` reads the HAPI_FED_HEALTH_* environment
// once, so a federated hub and a standalone node cannot drift on poll interval
// or thresholds. `createLocalOnlyHealthAggregator` builds the aggregator a node
// runs when it has no federation peers to poll (federation off, or the spoke
// role "node"): `HealthAggregator.sample()` already samples the local node
// in-process and polls only the peers `getNodeStates()` returns, so an empty
// list is the local-only mode.
import {
  DEFAULT_FEDERATION_HEALTH_THRESHOLDS,
  FederationHealthThresholdsSchema,
  type FederationHealthThresholds,
  type JobRegistry,
} from "@hapi/protocol";
import type { SystemHealthMetrics } from "../metrics/systemHealth";
import { parseEnvInt } from "../utils/rateLimitCounter";
import { AlertGenerator } from "./alertGenerator";
import { AlertRingBuffer } from "./alertRingBuffer";
import {
  HealthAggregator,
  type HealthAggregatorConfig,
} from "./healthAggregator";

export interface HealthAggregatorSettings {
  config: HealthAggregatorConfig;
  /** Timeout for one peer `/api/federation/node-metrics` fetch (ms). */
  fetchTimeoutMs: number;
  /** Alert ring-buffer capacity. */
  alertCapacity: number;
}

function resolveThresholds(
  raw: string | undefined,
  warn: (msg: string) => void
): FederationHealthThresholds {
  if (!raw) return DEFAULT_FEDERATION_HEALTH_THRESHOLDS;
  try {
    const parsed = FederationHealthThresholdsSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
    warn(
      "[Federation] HAPI_FED_HEALTH_THRESHOLDS invalid shape — using defaults"
    );
  } catch {
    warn(
      "[Federation] HAPI_FED_HEALTH_THRESHOLDS not valid JSON — using defaults"
    );
  }
  return DEFAULT_FEDERATION_HEALTH_THRESHOLDS;
}

/** Read the health aggregator settings from the environment (#1445 names). */
export function resolveHealthAggregatorSettings(
  env: NodeJS.ProcessEnv = process.env,
  warn: (msg: string) => void = console.warn
): HealthAggregatorSettings {
  const healthPollIntervalMs = parseEnvInt(env.HAPI_FED_HEALTH_POLL_MS, 30_000);
  const offlineGraceMult = parseEnvInt(
    env.HAPI_FED_HEALTH_OFFLINE_GRACE_MULT,
    2
  );
  return {
    config: {
      healthPollIntervalMs,
      offlineGraceMs: offlineGraceMult * healthPollIntervalMs,
      tsRetentionMinutes: parseEnvInt(env.HAPI_FED_HEALTH_TS_RETENTION_MIN, 60),
      thresholds: resolveThresholds(env.HAPI_FED_HEALTH_THRESHOLDS, warn),
    },
    fetchTimeoutMs: parseEnvInt(env.HAPI_FED_HEALTH_FETCH_TIMEOUT_MS, 8_000),
    alertCapacity: parseEnvInt(env.HAPI_FED_ALERT_BUFFER_CAPACITY, 1_000),
  };
}

export interface LocalOnlyHealthAggregatorOptions {
  gatherLocalMetrics: () => Promise<SystemHealthMetrics>;
  /** This node's id as the web knows it (`resolveLocalNodeIdentity`). */
  localNodeId: string;
  localNodeLabel: string;
  /** The process's job node id (`"standalone"` when federation is off). */
  jobNode: string;
  settings: HealthAggregatorSettings;
  jobRegistry?: JobRegistry | null;
}

/**
 * An aggregator for a node with no federation peers. It samples this node,
 * keeps its time series and alerts, and never fetches a peer. The caller
 * starts it, as the federated branch of `server/src/index.ts` does.
 */
export function createLocalOnlyHealthAggregator(
  opts: LocalOnlyHealthAggregatorOptions
): HealthAggregator {
  const alertGenerator = new AlertGenerator(
    new AlertRingBuffer(opts.settings.alertCapacity)
  );
  return new HealthAggregator({
    getNodeStates: () => [],
    gatherLocalMetrics: opts.gatherLocalMetrics,
    fetchPeerMetrics: () =>
      Promise.reject(new Error("local-only health aggregator has no peers")),
    localNodeId: opts.localNodeId,
    localNodeLabel: opts.localNodeLabel,
    jobNode: opts.jobNode,
    alertGenerator,
    alertSource: alertGenerator,
    config: opts.settings.config,
    jobRegistry: opts.jobRegistry,
  });
}
