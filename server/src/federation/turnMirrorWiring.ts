// SPDX-License-Identifier: AGPL-3.0-only
import type { FederationConfig, JobRegistry } from "@hapi/protocol";
import type { NodeRegistry } from "./nodeRegistry";
import type { TurnMirrorStore } from "../store/turns/turnMirrorStore";
import { loadTurnMirrorConfig } from "../config/turnMirrorConfig";
import * as turnMirrorPullService from "../services/turnMirrorPullService";

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
 */
export function startTurnMirrorPull(opts: {
  federationConfig: FederationConfig | null;
  jobNodeId: string;
  jobRegistry: JobRegistry;
  getNodeRegistry: () => NodeRegistry | null;
  turnMirror: TurnMirrorStore;
}): void {
  const { federationConfig } = opts;
  if (!federationConfig || federationConfig.role === "node") return;
  turnMirrorPullService.start({
    jobNodeId: opts.jobNodeId,
    jobRegistry: opts.jobRegistry,
    getNodeRegistry: opts.getNodeRegistry,
    turnMirror: opts.turnMirror,
    turnMirrorConfig: loadTurnMirrorConfig(federationConfig),
  });
}

/** Stop the turn-mirror pull loop (reverse-order shutdown). */
export function stopTurnMirrorPull(): void {
  turnMirrorPullService.stop();
}
