// SPDX-License-Identifier: AGPL-3.0-only
import type { HarnessRegistry, InstallFlavor } from "@hapi/protocol";
import type { SyncEngine } from "../sync/syncEngine";
import type { Store } from "../store";
import {
  UpdateOrchestrator,
  type ExecFileFn,
  type UpdateResult,
} from "./updateOrchestrator";

/**
 * Self-update service facade (issue #1774, Sub E of epic #1769, Task 6). The
 * single object the `harnessUpdate` route talks to; wires the
 * `UpdateOrchestrator` to the SyncEngine + Store + the code-defined registry.
 * The request NEVER carries a command — it is resolved server-side from the
 * registry (R11). Bootstrapped once in `server/src/index.ts`.
 *
 * Mirrors the sibling `impactService` facade shape.
 */
export interface UpdateServiceDeps {
  engine: SyncEngine;
  store: Store;
  /** The code-defined registry — the command source of truth (R11). */
  registry: HarnessRegistry;
  /** `federationConfig?.nodeId ?? "standalone"` — the SAME value #1770's poll
   *  stamps. */
  nodeId: string;
  /** Re-run detection after a successful apply (R4) — injected from
   *  `HarnessPollService.detectNow`. */
  detectNow: (harnessId: string) => Promise<void>;
  /** Optional spawn-quiesce during the symlink flip (Task 10 / R9). Default
   *  no-ops — the flow is correct without them. */
  pauseSpawning?: () => Promise<void>;
  resumeSpawning?: () => Promise<void>;
  // ── test injectables (all optional; production uses the real defaults) ──
  execFileFn?: ExecFileFn;
  resolveBinary?: (name: string) => string | null;
  detectFlavor?: (resolvedPath: string) => InstallFlavor;
  buildEnv?: () => NodeJS.ProcessEnv;
  now?: () => number;
  timeoutMs?: number;
}

export class UpdateService {
  readonly nodeId: string;
  private readonly orchestrator: UpdateOrchestrator;

  constructor(deps: UpdateServiceDeps) {
    this.nodeId = deps.nodeId;
    this.orchestrator = new UpdateOrchestrator({
      engine: deps.engine,
      store: deps.store,
      registry: deps.registry,
      nodeId: deps.nodeId,
      detectNow: deps.detectNow,
      pauseSpawning: deps.pauseSpawning,
      resumeSpawning: deps.resumeSpawning,
      execFileFn: deps.execFileFn,
      resolveBinary: deps.resolveBinary,
      detectFlavor: deps.detectFlavor,
      buildEnv: deps.buildEnv,
      now: deps.now,
      timeoutMs: deps.timeoutMs,
    });
  }

  /** Apply an update to `version` (which MUST equal the detected latest). */
  runUpdate(
    nodeId: string,
    harnessId: string,
    version: string,
    actor: string | null
  ): Promise<UpdateResult> {
    return this.orchestrator.runUpdate({
      nodeId,
      harnessId,
      targetVersion: version,
      actor,
    });
  }

  /** Roll back to the captured prior version (never a client-supplied version). */
  runRollback(
    nodeId: string,
    harnessId: string,
    actor: string | null
  ): Promise<UpdateResult> {
    return this.orchestrator.runRollback({ nodeId, harnessId, actor });
  }
}
