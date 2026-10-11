// SPDX-License-Identifier: AGPL-3.0-only
/**
 * successorHandoffStep (issue #2158) — the FinalizeStep that FIRES the
 * context-watermark successor handoff. Registered in `turnLifecycle`'s finalize
 * chain beside `pmReconcileStep`; running on the finalize seam is what makes the
 * FIRE decision structural (a `FinalizeStep` runs strictly BETWEEN turns, never
 * inside one — precisely R2).
 *
 * 🔴 THE STEP IS SYNCHRONOUS — it only EVALUATES; the pipeline runs DETACHED.
 * `FinalizeStep` is a sync type and `runFinalizeSteps` destructures each step's
 * result unawaited, so the registered step may ONLY (1) do the cheap armed check,
 * (2) call `evaluateBoundary`, and (3) on fire `void`-detach the pipeline and
 * return `{}` immediately. The pipeline is its own async state machine
 * (`armed → handing_off → complete | failed`) that OWNS `handoffTimeoutMs` and
 * MUST catch its own rejections — an unhandled rejection would escape the runner's
 * per-step try/catch (which covers only the synchronous evaluation). Awaiting the
 * pipeline would block every finalize on the box behind an up-to-120s handoff.
 *
 * 🔴 FAIL-SAFE (R7): any failure/timeout leaves the predecessor ALIVE, the packet
 * on disk, reaps any spawned-but-unconfirmed successor (never strands one),
 * releases the input hold, and logs. Never kill a healthy predecessor on a partial
 * handoff.
 */

import type {
  HandoffPacket,
  HandoffPendingGate,
  Session,
  WatermarkState,
  WatermarkDeferReason,
} from "@hapi/protocol";

import type { ErrorLogger } from "../logging/errorLogger";
import type { ContextWatermarkConfig } from "../config/contextWatermarkConfig";
import { evaluateBoundary } from "../watermark/boundaryGate";
import type { FinalizeStep, FinalizeStepContext } from "./turnLifecycle";

/** The subset of ContextWatermarkService the step drives (fakeable in tests). */
export interface WatermarkStateController {
  getState(sessionId: string): WatermarkState | undefined;
  getConfig(): ContextWatermarkConfig;
  beginHandoff(sessionId: string): void;
  completeHandoff(sessionId: string): void;
  failHandoff(sessionId: string): void;
  setDeferredReason(
    sessionId: string,
    reason: WatermarkDeferReason | null
  ): void;
  recordSuccessorGeneration(successorId: string, generation: number): void;
}

/** Initiative roster ops — guarded (null when the initiative store is absent). */
export interface HandoffRosterOps {
  /** Resolve the predecessor's active initiative (id + phase), or null. */
  resolveInitiative: (
    sessionId: string
  ) => { id: string; phase: string | null } | null;
  detachSession: (initiativeId: string, sessionId: string) => void;
  attachSession: (initiativeId: string, sessionId: string) => void;
  appendEvent: (
    initiativeId: string,
    kind: string,
    payload: Record<string, unknown>
  ) => void;
}

export interface SuccessorHandoffDeps {
  service: WatermarkStateController;
  getSession: (sessionId: string) => Session | undefined;
  /** Explicit open-transaction marker (a `🔒 locked:` label / non-complete roster row). */
  hasOpenTransaction: (sessionId: string) => boolean;
  getActiveSessionCount: () => number;
  getMaxConcurrent: () => number;
  /** Spawn a successor from the predecessor session; resolve its session id. */
  spawnSuccessor: (predecessor: Session) => Promise<string>;
  /** Deliver the packet as the successor's FIRST message. */
  deliverPacket: (successorId: string, packet: HandoffPacket) => Promise<void>;
  /** Confirm the successor is alive AND has consumed the packet. */
  confirmSuccessor: (successorId: string) => Promise<boolean>;
  /** Guarded roster ops (null → no-op roster handover; the feature does not hard-depend on #2156). */
  roster: HandoffRosterOps | null;
  /** Wind the predecessor down (archiveSession). */
  reapPredecessor: (sessionId: string) => Promise<void>;
  /** Reap a spawned-but-unconfirmed successor on abort (deleteSession). */
  reapSuccessor: (sessionId: string) => Promise<void>;
  /** Reap-time quiescence/boundary re-check (predecessor idle, no new turn since fire). */
  reapBoundaryClear: (sessionId: string) => boolean;
  /** Persist the packet to disk under the predecessor's dir; return the path. */
  persistPacket: (predecessor: Session, packet: HandoffPacket) => string;
  /** Optional: derive pending-gate refs (e.g. from the linked issue). Default: []. */
  derivePendingGates?: (predecessor: Session) => HandoffPendingGate[];
  now: () => number;
  errorLogger?: ErrorLogger | null;
}

/**
 * Build the issue #2158 successor-handoff finalize step. Mirrors the
 * `createPmReconcileStep` factory shape; the returned step is a pure side-effecting
 * `FinalizeStep` (returns no column enrichment, `{}`).
 */
export function createSuccessorHandoffStep(
  deps: SuccessorHandoffDeps
): FinalizeStep {
  return (ctx: FinalizeStepContext) => {
    try {
      const predecessorId = ctx.hapiSessionId;
      const state = deps.service.getState(predecessorId);

      // Cheap path: not armed (the 99.9% case) → nothing to do. Also skip a
      // session whose pipeline is already in flight (a re-entrant finalize).
      if (!state || !state.armed || state.handoffState === "handing_off") {
        return {};
      }

      const config = deps.service.getConfig();
      const session = deps.getSession(predecessorId);

      const gate = evaluateBoundary({
        armed: state.armed,
        enabled: config.enabled,
        atTurnFinalize: true, // we ARE inside the finalize seam for this session
        sessionThinking: session?.thinking ?? false,
        hasOpenTransaction: deps.hasOpenTransaction(predecessorId),
        activeSessionCount: deps.getActiveSessionCount(),
        maxConcurrent: deps.getMaxConcurrent(),
      });

      if (!gate.fire) {
        // Record why we deferred; the gate re-runs at the next finalize — this IS
        // the "defers until the next clean boundary" acceptance criterion.
        deps.service.setDeferredReason(predecessorId, gate.defer);
        return {};
      }

      if (!session) return {}; // defensive: cannot hand off without the session

      // Enter the persisted `handing_off` HOLD (pauses queue drain for this
      // session) BEFORE detaching, so the reap race is closed the instant we fire.
      deps.service.beginHandoff(predecessorId);

      // Detach the async pipeline: fire-and-forget. It owns its own timeout and
      // rejection handling; the runner must never await it.
      void runSuccessorHandoffPipeline(
        deps,
        predecessorId,
        session,
        state,
        config
      );
      return {};
    } catch (error) {
      // Fail-open: the synchronous evaluation must never disturb finalize.
      deps.errorLogger?.error(
        "[SuccessorHandoff] synchronous evaluation failed (degraded)",
        {
          category: "context-watermark",
          sessionId: ctx.hapiSessionId,
          context: {
            error: error instanceof Error ? error.message : String(error),
          },
        }
      );
      return {};
    }
  };
}

/**
 * The detached handoff pipeline. Runs R3's steps IN ORDER under the
 * `handoffTimeoutMs` bound, catches its own rejections, and on ANY failure leaves
 * the predecessor alive (R7). Exported for deterministic unit testing (the step
 * `void`-detaches it, so it cannot be awaited via the step's return).
 */
export async function runSuccessorHandoffPipeline(
  deps: SuccessorHandoffDeps,
  predecessorId: string,
  predecessor: Session,
  state: WatermarkState,
  config: ContextWatermarkConfig
): Promise<void> {
  let successorId: string | null = null;
  let rosterHandedOver = false;

  // Resolve the initiative ONCE, up front, so the delivered packet carries the
  // initiative ref + phase (R4) and step (d) reuses the same id.
  const initiative = deps.roster
    ? deps.roster.resolveInitiative(predecessorId)
    : null;

  const packet: HandoffPacket = {
    version: 1,
    predecessorSessionId: predecessorId,
    successorSessionId: null,
    initiativeId: initiative?.id ?? null,
    phase: initiative?.phase ?? null,
    pendingGates: deps.derivePendingGates
      ? deps.derivePendingGates(predecessor)
      : [],
    // The server never authors a checkpoint narrative — nullable by design.
    checkpointPath: null,
    contextPercentageAtHandoff: state.contextPercentage,
    createdAtMs: deps.now(),
    // Successor's generation = predecessor's + 1 (anti-chain counter).
    generation: state.generation + 1,
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("handoff timeout")),
      config.handoffTimeoutMs
    );
  });

  try {
    await Promise.race([
      timeout,
      (async () => {
        // (a) Persist the packet FIRST — durable before anything else can fail.
        const path = deps.persistPacket(predecessor, packet);
        deps.errorLogger?.info(
          `[SuccessorHandoff] packet persisted for ${predecessorId.slice(0, 8)} at ${path}`,
          { category: "context-watermark", sessionId: predecessorId }
        );

        // (b) Spawn the successor.
        successorId = await deps.spawnSuccessor(predecessor);
        packet.successorSessionId = successorId;
        deps.service.recordSuccessorGeneration(successorId, packet.generation);

        // (c) Deliver the packet + confirm — BEFORE the roster moves.
        await deps.deliverPacket(successorId, packet);
        const confirmed = await deps.confirmSuccessor(successorId);
        if (!confirmed) throw new Error("successor did not confirm handoff");

        // (d) Roster handover — guarded (no-op when no initiative).
        rosterHandedOver = handoverRoster(
          deps,
          predecessorId,
          successorId,
          initiative?.id ?? null,
          packet
        );

        // (e) Reap-time RE-CHECK, then wind the predecessor down — last.
        if (config.reapPredecessor) {
          if (!deps.reapBoundaryClear(predecessorId)) {
            throw new Error("reap-time boundary re-check failed");
          }
          await deps.reapPredecessor(predecessorId);
        }
      })(),
    ]);

    deps.service.completeHandoff(predecessorId);
    deps.errorLogger?.info(
      `[SuccessorHandoff] complete: ${predecessorId.slice(0, 8)} → ${(
        successorId ?? "?"
      ).slice(0, 8)} (generation ${packet.generation})`,
      { category: "context-watermark", sessionId: predecessorId }
    );
  } catch (error) {
    // R7 fail-safe: the predecessor is the only thing holding the work — it stays
    // ALIVE. Compensate the roster if it moved; reap any unconfirmed successor.
    try {
      if (rosterHandedOver && successorId) {
        compensateRoster(
          deps,
          predecessorId,
          successorId,
          initiative?.id ?? null
        );
      }
      if (successorId) {
        await deps.reapSuccessor(successorId); // never strand a spawned successor
      }
    } catch (cleanupError) {
      deps.errorLogger?.error(
        "[SuccessorHandoff] cleanup after failed handoff also failed",
        {
          category: "context-watermark",
          sessionId: predecessorId,
          context: {
            error:
              cleanupError instanceof Error
                ? cleanupError.message
                : String(cleanupError),
          },
        }
      );
    }
    // failHandoff releases the persisted hold; the next poll re-arms if still over
    // the watermark (R6/R7).
    deps.service.failHandoff(predecessorId);
    deps.errorLogger?.error(
      `[SuccessorHandoff] handoff FAILED for ${predecessorId.slice(0, 8)} — ` +
        `predecessor left alive, packet on disk`,
      {
        category: "context-watermark",
        sessionId: predecessorId,
        context: {
          error: error instanceof Error ? error.message : String(error),
        },
      }
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** (d) Move the roster from predecessor to successor + append a `session_handoff` event. */
function handoverRoster(
  deps: SuccessorHandoffDeps,
  predecessorId: string,
  successorId: string,
  initiativeId: string | null,
  packet: HandoffPacket
): boolean {
  if (!deps.roster || !initiativeId) return false;
  deps.roster.detachSession(initiativeId, predecessorId);
  deps.roster.attachSession(initiativeId, successorId);
  deps.roster.appendEvent(initiativeId, "session_handoff", {
    predecessorSessionId: predecessorId,
    successorSessionId: successorId,
    generation: packet.generation,
    contextPercentageAtHandoff: packet.contextPercentageAtHandoff,
  });
  return true;
}

/** Reverse a roster handover on abort: re-attach predecessor, detach successor. */
function compensateRoster(
  deps: SuccessorHandoffDeps,
  predecessorId: string,
  successorId: string,
  initiativeId: string | null
): void {
  if (!deps.roster || !initiativeId) return;
  deps.roster.detachSession(initiativeId, successorId);
  deps.roster.attachSession(initiativeId, predecessorId);
  deps.roster.appendEvent(initiativeId, "session_handoff", {
    compensated: true,
    predecessorSessionId: predecessorId,
    successorSessionId: successorId,
  });
}
