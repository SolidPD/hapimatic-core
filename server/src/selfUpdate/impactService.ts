// SPDX-License-Identifier: AGPL-3.0-only
import type { UpdateSpan, ImpactArtifact } from "@hapi/protocol";
import type { SyncEngine } from "../sync/syncEngine";
import type { Store } from "../store";
import type {
  ImpactAnalysisCoordinator,
  ActiveImpactAnalysis,
} from "../web/routes/impactArtifact";
import { getDaemonCapacity } from "../utils/daemonControlClient";
import { ImpactOrchestrator, type TriggerOutcome } from "./impactOrchestrator";

/**
 * Impact-analysis service facade (issue #1772, Task 5). The single object the
 * routes talk to and the submit endpoint uses as its `ImpactAnalysisCoordinator`.
 * Wires the `ImpactOrchestrator` (spawn/watchdog state machine) to the
 * SyncEngine + Store and adds the store-read surfaces the consumer API serves.
 * Bootstrapped once in `server/src/index.ts`.
 */

/** The discriminated envelope the consumer GET serves (Task 7). snake_case +
 *  epoch-ms `analyzed_at` — reaches #1773's panel raw, no camelizing mapper. */
export type AnalysisStatusEnvelope =
  | { status: "none" }
  | { status: "analyzing" }
  | {
      status: "ready";
      artifact: ImpactArtifact;
      companion_session_id: string | null;
      analyzed_at: number;
    }
  | { status: "failed" }
  | { status: "at_capacity" };

/** Default watchdog window — an LLM changelog analysis + `gh issue` searches
 *  take a few minutes. Overridable via env for tuning without a redeploy. */
const DEFAULT_ANALYSIS_TIMEOUT_MS = process.env.HAPI_IMPACT_ANALYSIS_TIMEOUT_MS
  ? parseInt(process.env.HAPI_IMPACT_ANALYSIS_TIMEOUT_MS, 10)
  : 300_000;

const DEFAULT_SUBMIT_URL = "$HAPI_SERVER_URL/cli/impact-artifact";

export interface ImpactServiceDeps {
  engine: SyncEngine;
  store: Store;
  /** `federationConfig?.nodeId ?? "standalone"` (R4). */
  nodeId: string;
  /** Working directory the peer spawns into (a Hapimatic checkout). */
  repoRoot: string;
  submitUrl?: string;
  timeoutMs?: number;
  now?: () => number;
  buildSeed?: (span: UpdateSpan, opts: { submitUrl: string }) => string;
  /** Override the advisory capacity probe (tests). Default reads the local
   *  daemon's `/effective-count`; null when unreachable → rely on the
   *  authoritative spawn `code:"at_capacity"`. */
  probeCapacity?: () => Promise<boolean | null>;
}

export class ImpactService implements ImpactAnalysisCoordinator {
  readonly nodeId: string;
  private readonly orchestrator: ImpactOrchestrator;
  private readonly store: Store;
  private readonly engine: Pick<SyncEngine, "getSession">;

  constructor(deps: ImpactServiceDeps) {
    this.nodeId = deps.nodeId;
    this.store = deps.store;
    this.engine = deps.engine;
    this.orchestrator = new ImpactOrchestrator({
      engine: deps.engine,
      store: deps.store,
      nodeId: deps.nodeId,
      repoRoot: deps.repoRoot,
      submitUrl: deps.submitUrl ?? DEFAULT_SUBMIT_URL,
      timeoutMs: deps.timeoutMs ?? DEFAULT_ANALYSIS_TIMEOUT_MS,
      now: deps.now,
      buildSeed: deps.buildSeed,
      probeCapacity:
        deps.probeCapacity ??
        (async () => {
          const cap = await getDaemonCapacity();
          if ("error" in cap) return null; // unreachable → authoritative code decides
          return cap.effectiveCount >= cap.maxConcurrent;
        }),
    });
  }

  /** Trigger an analysis (delegates to the orchestrator; returns after seed). */
  startAnalysis(span: UpdateSpan): Promise<TriggerOutcome> {
    return this.orchestrator.startAnalysis(span);
  }

  /** The discriminated status for a range — `analyzing` from the orchestrator's
   *  in-flight state (so a mid-analysis reload sees it), `ready` from the store,
   *  else the last terminal outcome or `none`. */
  getAnalysisStatus(
    harnessId: string,
    from: string,
    to: string
  ): AnalysisStatusEnvelope {
    if (this.orchestrator.isAnalyzing(harnessId, from, to)) {
      return { status: "analyzing" };
    }
    const row = this.store.impactAnalysis.getByRange(
      this.nodeId,
      harnessId,
      from,
      to
    );
    if (row?.artifact) {
      return {
        status: "ready",
        artifact: row.artifact,
        companion_session_id: row.peer_session_id,
        analyzed_at: row.analyzed_at,
      };
    }
    const last = this.orchestrator.lastTerminalOutcome(harnessId, from, to);
    if (last) return { status: last };
    return { status: "none" };
  }

  getArtifact(
    harnessId: string,
    from: string,
    to: string
  ): ImpactArtifact | null {
    return (
      this.store.impactAnalysis.getByRange(this.nodeId, harnessId, from, to)
        ?.artifact ?? null
    );
  }

  /** R5: probe a companion session's liveness before routing Q&A to it. */
  probeCompanionLiveness(sessionId: string): boolean {
    return this.engine.getSession(sessionId)?.active ?? false;
  }

  // ── ImpactAnalysisCoordinator (delegated to the orchestrator) ──

  getActiveAnalysisForSession(sessionId: string): ActiveImpactAnalysis | null {
    return this.orchestrator.getActiveAnalysisForSession(sessionId);
  }

  notifyArtifactSubmitted(sessionId: string): void {
    this.orchestrator.notifyArtifactSubmitted(sessionId);
  }
}
