// SPDX-License-Identifier: AGPL-3.0-only
import type { FederationConfig, JobRegistry } from "@hapi/protocol";
import type { NodeRegistry } from "./nodeRegistry";
import type { TurnMirrorStore } from "../store/turns/turnMirrorStore";
import type { IntervalMirrorStore } from "../store/billable/intervalMirrorStore";
import { loadTurnMirrorConfig } from "../config/turnMirrorConfig";
import * as turnMirrorPullService from "../services/turnMirrorPullService";
import * as intervalMirrorPullService from "../services/intervalMirrorPullService";

/**
 * Turn-ledger mirror pull-loop wiring (issue #4614), extracted from index.ts so
 * the entrypoint stays under the max-lines ceiling (one-module-per-concern).
 *
 * Starts the per-origin pull loop ONLY on a node that has a NodeRegistry (hub +
 * peer; the headless "node" role has none). The per-node opt-out is the loop's
 * `enabled` flag (registers "stopped" but stays visible in the System Jobs
 * portal). It pulls each peer's finalized-turn feed into THIS node's SEPARATE
 * mirror store (never `turns`, so existing readers can't double-count). Pure
 * extraction: same gate, same opts, same start/stop order as before.
 *
 * Issue #6586: the billable interval pull starts here too, after the turn pull,
 * with the same role gate and the same `loadTurnMirrorConfig` result (cadence
 * and opt-out: a node that opted out of holding other nodes' history opted out
 * of both kinds). Its own SupervisedLoop, so a failure in one loop cannot stop
 * the other. It runs in every billable mode: a node in `off` still holds its
 * peers' history for reports.
 */
export function startTurnMirrorPull(opts: {
  federationConfig: FederationConfig | null;
  jobNodeId: string;
  jobRegistry: JobRegistry;
  getNodeRegistry: () => NodeRegistry | null;
  turnMirror: TurnMirrorStore;
  intervalMirror: IntervalMirrorStore;
}): void {
  const { federationConfig } = opts;
  if (!federationConfig || federationConfig.role === "node") return;
  const turnMirrorConfig = loadTurnMirrorConfig(federationConfig);
  turnMirrorPullService.start({
    jobNodeId: opts.jobNodeId,
    jobRegistry: opts.jobRegistry,
    getNodeRegistry: opts.getNodeRegistry,
    turnMirror: opts.turnMirror,
    turnMirrorConfig,
  });
  intervalMirrorPullService.start({
    jobNodeId: opts.jobNodeId,
    jobRegistry: opts.jobRegistry,
    getNodeRegistry: opts.getNodeRegistry,
    intervalMirror: opts.intervalMirror,
    turnMirrorConfig,
  });
}

/** Stop the turn-mirror and interval-mirror pull loops (reverse-order shutdown). */
export function stopTurnMirrorPull(): void {
  intervalMirrorPullService.stop();
  turnMirrorPullService.stop();
}
