// SPDX-License-Identifier: AGPL-3.0-only
import type { TurnLifecycle } from "./turnLifecycle";
import type { RpcGateway } from "./rpcGateway";
import type { ErrorLogger } from "../logging/errorLogger";

/** Dependencies for {@link gracefulTurnInterruptBeforeKill}. */
export interface GracefulTurnInterruptDeps {
  /** Lazy read — TurnLifecycle is injected into SyncEngine post-construction. */
  getTurnLifecycle: () => TurnLifecycle | null;
  rpcGateway: Pick<RpcGateway, "abortSession">;
  /**
   * `Pick`, not the class: ErrorLogger has private members (errorLogger.ts:41-46),
   * so a hand-rolled `{ warn }` test fake is not assignable to it without an
   * `as unknown as ErrorLogger` cast. Passing `this.errorLogger` still type-checks.
   */
  errorLogger?: Pick<ErrorLogger, "warn"> | null;
}

/**
 * Issue #3087 (deferred OOS-1 from #2149): the SHARED "bounded graceful turn
 * interrupt before a hard-kill restart", extracted from the byte-identical
 * private copies in AccountRestart and SessionRelaunch.
 *
 * #2002 (R1a-opt): the killSession restart path emits NO turn:finalize, so a
 * turn open at kill time would linger status='open'. BEFORE the caller's
 * archiveSession: if the session has a tracked open turn, send the "abort" RPC
 * (interrupt the turn + fire the CLI's turnReporter.finalize → clean tail + a
 * clean `interrupted` telemetry finalize), hard-bounded by a short deadline. The
 * open-turn gate is keyed off turn-lifecycle state — NOT session.thinking, which
 * setRateLimited stales to false the instant a 429 lands, BEFORE finalize.
 *
 * Runs BEFORE archiveSession; the caller runs the backstop
 * orphanTrackedTurnsForSession AFTER archiveSession. Fallback Preservation Rule:
 * any failure here is swallowed and the caller proceeds to the hard kill.
 *
 * @param logLabel caller tag for the warn message ("restart" | "relaunch").
 */
export async function gracefulTurnInterruptBeforeKill(
  sessionId: string,
  deps: GracefulTurnInterruptDeps,
  logLabel: "restart" | "relaunch"
): Promise<void> {
  const HARD_DEADLINE_MS = 1500;
  try {
    const turnLifecycle = deps.getTurnLifecycle();
    if (!turnLifecycle?.hasOpenTurnForSession(sessionId)) return;
    // Race the abort RPC against a short deadline. abortSession → the launcher's
    // "abort" handler interrupts the turn AND calls turnReporter.finalize.
    await Promise.race([
      deps.rpcGateway.abortSession(sessionId).catch(() => undefined),
      new Promise<void>(resolve => setTimeout(resolve, HARD_DEADLINE_MS)),
    ]);
  } catch (error) {
    deps.errorLogger?.warn(
      `${logLabel} ${sessionId}: graceful pre-kill turn interrupt failed (proceeding to hard kill): ${
        error instanceof Error ? error.message : String(error)
      }`,
      { category: "sync", sessionId }
    );
  }
}
