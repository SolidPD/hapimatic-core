// SPDX-License-Identifier: AGPL-3.0-only
import type { FederationConfig, JobRegistry } from "@hapi/protocol";
import type { NodeRegistry } from "./nodeRegistry";
import type { TurnMirrorStore } from "../store/turns/turnMirrorStore";
import type { IntervalMirrorStore } from "../store/billable/intervalMirrorStore";
import { loadTurnMirrorConfig } from "../config/turnMirrorConfig";
import * as turnMirrorPullService from "../services/turnMirrorPullService";
import * as intervalMirrorPullService from "../services/intervalMirrorPullService";
import * as billableSwitchMirrorPullService from "../services/billableSwitchMirrorPullService";
import type { BillableSwitchStore } from "../store/billableSwitchStore";

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
  /**
   * Issue #6646 (Task 7b): the billable switch record's copy, pulled by its own
   * loop with the turn mirror's role gate, cadence and opt-out. Optional so a
   * caller without it starts the turn mirror alone.
   */
  billableSwitch?: BillableSwitchStore;
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
  if (opts.billableSwitch) {
    billableSwitchMirrorPullService.start({
      jobNodeId: opts.jobNodeId,
      jobRegistry: opts.jobRegistry,
      getNodeRegistry: opts.getNodeRegistry,
      store: opts.billableSwitch,
      turnMirrorConfig,
    });
  }
}

/** Stop the turn-mirror, interval-mirror and billable-switch-mirror pull loops (reverse-order shutdown). */
export function stopTurnMirrorPull(): void {
  billableSwitchMirrorPullService.stop();
  intervalMirrorPullService.stop();
  turnMirrorPullService.stop();
}
