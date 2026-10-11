// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ceilingGuardStep (issue #1905) — the FinalizeStep that fires the
 * runaway-session ceiling guard. Registered in `turnLifecycle`'s finalize chain
 * beside `successorHandoffStep`; running on the finalize seam is what makes the
 * check happen "at each turn boundary" (a FinalizeStep runs strictly BETWEEN
 * turns, never inside one — the AC granularity) and keeps the guard
 * launcher-agnostic (SDK / pty / tmux all forward their turns through the same
 * `turn:finalize` seam). This is the ruled architecture (1905-3): the guard is a
 * synchronous FinalizeStep, NOT wiring in `socket/handlers/cli/sessionHandlers.ts`.
 *
 * 🔴 THE STEP IS SYNCHRONOUS — it only INVOKES the engine's guard, which itself
 * does the cheap metering + dedupe check and `void`-detaches the archive /
 * escalation. `FinalizeStep` is a sync type and `runFinalizeSteps` destructures
 * each step's result unawaited, so the step returns `{}` immediately (no column
 * enrichment).
 *
 * 🔴 FAIL-OPEN (R9): the guard is already fully fail-open internally, but this
 * step ALSO wraps the call (belt-and-braces, matching the runner's per-step
 * try/catch) — a guard fault must never disturb finalize.
 */

import type { ErrorLogger } from "../logging/errorLogger";
import type { FinalizeStep, FinalizeStepContext } from "./turnLifecycle";

export interface CeilingGuardStepDeps {
  /** Invoke the engine's ceiling guard for the just-finalized session
   *  (`SyncEngine.checkSessionCeilings`). */
  check: (sessionId: string) => void;
  errorLogger?: ErrorLogger | null;
}

/**
 * Build the issue #1905 ceiling-guard finalize step. Mirrors the
 * `createSuccessorHandoffStep` factory shape; the returned step is a pure
 * side-effecting `FinalizeStep` (returns `{}`).
 */
export function createCeilingGuardStep(
  deps: CeilingGuardStepDeps
): FinalizeStep {
  return (ctx: FinalizeStepContext) => {
    try {
      deps.check(ctx.hapiSessionId);
    } catch (error) {
      // Fail-open: the synchronous evaluation must never disturb finalize.
      deps.errorLogger?.error(
        "[CeilingGuard] synchronous finalize step failed (degraded)",
        {
          category: "ceiling-breach",
          sessionId: ctx.hapiSessionId,
          context: {
            error: error instanceof Error ? error.message : String(error),
          },
        }
      );
    }
    return {};
  };
}
