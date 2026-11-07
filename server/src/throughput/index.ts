// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  FederationConfig,
  JobRegistry,
  SupervisedLoop,
} from "@hapi/protocol";
import type { UsageService } from "../accounts/usageService";
import type { Settings } from "../config/settings";
import { loadTurnMirrorConfig } from "../config/turnMirrorConfig";
import type { NodeRegistry } from "../federation/nodeRegistry";
import type { ErrorLogger } from "../logging/errorLogger";
import {
  NotifyPmNotifier,
  resolveNotifyPmPath,
} from "../notifications/notifier";
import { getKnownSecretLiterals } from "../services/knownSecretLiterals";
import type { Store } from "../store";
import { parseAccessToken } from "../utils/accessToken";
import { loadThroughputConfig, type ThroughputConfig } from "./config";
import { ThroughputDigest, createDigestLoop } from "./digest";
import { ThroughputFactsCollector, createFactsLoop } from "./factsCollector";
import { resolveCollectorToken } from "./github/client";
import {
  ThroughputGithubCollector,
  createGithubLoop,
} from "./github/collector";
import { compileLanePattern, type IssueVocabulary } from "./github/issueFacts";
import { ThroughputQuota, createQuotaLoop } from "./quota";
import { ThroughputRollup, createRollupLoop } from "./rollup";
import { setThroughputRuntime } from "./runtime";
import { ThroughputSummaryService } from "./summary";

/**
 * Throughput telemetry boot module (issue #6164, A1 — R13).
 *
 * `start()` (once, from `index.ts`, after listen) builds every loop and starts
 * them in order — facts, rollup, then the fleet jobs (GitHub, quota, digest) —
 * and hands the REST routes their summary service. `stop()` stops them in
 * reverse, before the store closes. Every loop is constructed and registered
 * even when disabled, so System Jobs shows it as stopped. Fail-soft: a failure
 * here is logged and never blocks boot.
 */

let loops: SupervisedLoop[] = [];
let facts: ThroughputFactsCollector | null = null;
let current: ThroughputConfig | null = null;

/** The active configuration (null before start). */
export function getThroughputConfig(): ThroughputConfig | null {
  return current;
}

export function start(opts: {
  config: { dataDir: string; cliApiToken: string; webappPort?: number };
  settings: Settings | null;
  federationConfig: FederationConfig | null;
  jobNodeId: string;
  jobRegistry: JobRegistry;
  store: Store;
  usageService: UsageService;
  getNodeRegistry: () => NodeRegistry | null;
  errorLogger: ErrorLogger;
}): void {
  try {
    const cfg = loadThroughputConfig({
      settings: opts.settings,
      listenPort: opts.config.webappPort,
      federationRole: opts.federationConfig?.role ?? null,
    });
    current = cfg;
    if (cfg.rejected.length > 0) {
      console.warn(
        `[throughput] ignored invalid settings: ${cfg.rejected.join("; ")}`
      );
    }
    const { store, jobNodeId: node, jobRegistry: registry } = opts;
    const on = !cfg.disabled;
    const fleet = on && cfg.fleetJobs;
    const vocab: IssueVocabulary = {
      checkpoints: cfg.labels.checkpoints,
      lanePattern: compileLanePattern(cfg.labels.lanePattern)!,
      dangerPaths: cfg.github.dangerPaths,
      points: cfg.labels.points,
    };
    const ownerNamespace =
      parseAccessToken(opts.config.cliApiToken)?.namespace ?? null;

    facts = new ThroughputFactsCollector({
      facts: store.throughputFacts,
      literals: () =>
        getKnownSecretLiterals({ ownToken: opts.config.cliApiToken }),
    });
    const rollup = new ThroughputRollup({
      rollups: store.throughputRollups,
      localOrigin: node,
      defaultModel: cfg.pricing.defaultModel,
    });
    const github = new ThroughputGithubCollector({
      store: store.throughputGithub,
      repos: cfg.github.repos,
      vocab,
      resolveToken: () => resolveCollectorToken({}),
      backfillDays: cfg.github.backfillDays,
      idleIntervalMs: cfg.github.intervalMs,
    });
    const quota = new ThroughputQuota({
      rollups: store.throughputRollups,
      usageHistory: store.usageHistory,
    });
    const service = new ThroughputSummaryService({
      rollups: store.throughputRollups,
      github: store.throughputGithub,
      digests: store.throughputDigests,
      localOrigin: () => node,
      mirror: () => {
        const fed = opts.federationConfig;
        return {
          enabled:
            !fed || fed.role === "node"
              ? null
              : loadTurnMirrorConfig(fed).enabled,
          // Read whenever cursors exist: mirrored rows keep their last sync.
          origins: store.turnMirror.getStatus(),
        };
      },
      registryNodes: () => opts.getNodeRegistry()?.getNodeSummaries() ?? null,
      usage: () => opts.usageService.getLatest(),
      usageSeries: (account, sinceMs) =>
        store.usageHistory.getSeries(account, sinceMs),
      quotaWeights: () => quota.storedWeights(),
      vocab: () => vocab,
      githubRepos: () => cfg.github.repos,
      fleetJobs: () => cfg.fleetJobs,
    });
    const digest = new ThroughputDigest({
      service,
      digests: store.throughputDigests,
      rollups: store.throughputRollups,
      reportsDir: join(opts.config.dataDir, "reports", "throughput"),
      collector: node,
      ownerNamespace: ownerNamespace ?? "default",
      notifier: new NotifyPmNotifier({ errorLogger: opts.errorLogger }),
      canNotify: () => existsSync(resolveNotifyPmPath()),
      cron: cfg.digest.cron,
      timezone: cfg.digest.timezone,
    });

    loops = [
      createFactsLoop({
        collector: facts,
        node,
        enabled: on && cfg.facts.enabled,
        registry,
      }),
      createRollupLoop({ rollup, node, enabled: on, registry }),
      createGithubLoop({
        collector: github,
        node,
        enabled: fleet && cfg.github.repos.length > 0,
        registry,
      }),
      createQuotaLoop({ quota, node, enabled: fleet, registry }),
      createDigestLoop({ digest, node, enabled: fleet, registry }),
    ];
    for (const loop of loops) loop.start();
    if (on) setThroughputRuntime({ service, ownerNamespace });
  } catch (error) {
    console.error("[throughput] start failed (telemetry off):", error);
    stop();
  }
}

/** Stop every loop (reverse order) and clear the route handles. */
export function stop(): void {
  setThroughputRuntime(null);
  for (const loop of [...loops].reverse()) {
    try {
      loop.stop();
    } catch {
      // keep stopping the rest
    }
  }
  loops = [];
  const collector = facts;
  facts = null;
  void collector?.close().catch(() => undefined);
}
