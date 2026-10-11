// SPDX-License-Identifier: AGPL-3.0-only
import type { ApiSessionClient } from "@/api/apiSession";
// Imported from the leaf `@/ext/lifecycle`, NOT `@/ext/host` — see the note at
// the matching import in `@/agent/sessionBase`.
import { fireSessionEnd } from "@/ext/lifecycle";
import { reportScorecardRun } from "@/agent/scorecardRunReporter";
import { logger } from "@/ui/logger";
import { restoreTerminalState } from "@/ui/terminalState";
import { killProcessTree } from "@/utils/processTree";

type RunnerLifecycleOptions = {
  session: ApiSessionClient;
  logTag: string;
  stopKeepAlive?: () => void;
  onBeforeClose?: () => Promise<void> | void;
  onAfterClose?: () => Promise<void> | void;
};

export type RunnerLifecycle = {
  setExitCode: (code: number) => void;
  setArchiveReason: (reason: string) => void;
  markCrash: (error: unknown) => void;
  cleanup: () => Promise<void>;
  cleanupAndExit: (codeOverride?: number) => Promise<void>;
  registerProcessHandlers: () => void;
};

export function createRunnerLifecycle(
  options: RunnerLifecycleOptions
): RunnerLifecycle {
  let exitCode = 0;
  let archiveReason = "User terminated";
  let cleanupStarted = false;
  let cleanupPromise: Promise<void> | null = null;
  // Issue #1268: at-most-once guard for the extension session-end event. The
  // `cleanupPromise` memoization above already makes `cleanup` idempotent, so
  // this is defence-in-depth against a future re-entrant close path — the
  // emitter itself does not de-duplicate.
  let lifecycleEndFired = false;

  const logPrefix = `[${options.logTag}]`;

  const archiveAndClose = async () => {
    options.session.updateMetadata(currentMetadata => ({
      ...currentMetadata,
      lifecycleState: "archived",
      lifecycleStateSince: Date.now(),
      archivedBy: "cli",
      archiveReason,
    }));

    options.session.sendSessionDeath();
    await options.session.flush();
    await options.session.close();
  };

  const cleanup = async () => {
    if (cleanupPromise) {
      return cleanupPromise;
    }

    cleanupStarted = true;
    cleanupPromise = (async () => {
      logger.debug(`${logPrefix} Cleanup start`);
      restoreTerminalState();

      try {
        options.stopKeepAlive?.();
        await options.onBeforeClose?.();
        await archiveAndClose();
        logger.debug(`${logPrefix} Cleanup complete`);
      } finally {
        try {
          await options.onAfterClose?.();
        } catch (error) {
          logger.debug(`${logPrefix} Error during post-cleanup:`, error);
        }

        // Issue #1268: extension lifecycle — session end. Fired here, after
        // `archiveAndClose` and the caller's post-close hook, so handlers see
        // genuinely-torn-down state. Deliberately NOT fired from
        // `stopKeepAlive()`, which merely clears intervals and runs *before*
        // archival. In the `finally` so a crash during archival still notifies
        // extensions that the session is over — and separately guarded, because
        // a throw from this optional path would escape the `finally` and mask
        // the very cleanup error we are unwinding from.
        if (!lifecycleEndFired) {
          lifecycleEndFired = true;
          try {
            fireSessionEnd(options.session.getSessionSnapshot());
          } catch (error) {
            logger.warn(
              `${logPrefix} [ext.lifecycle] failed to emit session end:`,
              error
            );
          }
          // #3128 (Task 5): fire-and-forget scorecard run report. Guarded
          // internally + not awaited — teardown latency is unchanged.
          void reportScorecardRun(options.session.getSessionSnapshot());
        }
      }
    })();

    return cleanupPromise;
  };

  const cleanupAndExit = async (codeOverride?: number) => {
    if (codeOverride !== undefined) {
      exitCode = codeOverride;
    }

    try {
      await cleanup();

      // Kill all descendant processes (MCP servers, etc.) before exiting.
      // Without this, process.exit() reparents children to PID 1 as
      // orphans that accumulate over system uptime. (Issue #849)
      try {
        const result = await killProcessTree(process.pid);
        if (result.killed.length > 0) {
          logger.debug(
            `${logPrefix} Killed ${result.killed.length} child processes before exit`
          );
        }
      } catch (killError) {
        logger.debug(`${logPrefix} Error killing process tree:`, killError);
      }

      process.exit(exitCode);
    } catch (error) {
      logger.debug(`${logPrefix} Error during cleanup:`, error);
      process.exit(1);
    }
  };

  const setExitCode = (code: number) => {
    exitCode = code;
  };

  const setArchiveReason = (reason: string) => {
    archiveReason = reason;
  };

  const markCrash = (error: unknown) => {
    logger.warn(`${logPrefix} Unhandled error:`, error);
    exitCode = 1;
    archiveReason = "Session crashed";
  };

  const registerProcessHandlers = () => {
    process.on("SIGTERM", () => {
      void cleanupAndExit();
    });

    process.on("SIGINT", () => {
      void cleanupAndExit();
    });

    process.on("uncaughtException", error => {
      logger.reportError({
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? (error.stack ?? null) : null,
        category: "uncaught-exception",
        severity: "fatal",
        context: logPrefix,
      });
      markCrash(error);
      void cleanupAndExit(1);
    });

    process.on("unhandledRejection", reason => {
      logger.reportError({
        message:
          reason instanceof Error
            ? reason.message
            : String(reason ?? "Unhandled rejection"),
        stack: reason instanceof Error ? (reason.stack ?? null) : null,
        category: "unhandled-rejection",
        severity: "error",
        context: logPrefix,
      });
      markCrash(reason);
      void cleanupAndExit(1);
    });
  };

  return {
    setExitCode,
    setArchiveReason,
    markCrash,
    cleanup,
    cleanupAndExit,
    registerProcessHandlers,
  };
}

export function setControlledByUser(
  session: ApiSessionClient,
  mode: "local" | "remote"
): void {
  session.updateAgentState(currentState => ({
    ...currentState,
    controlledByUser: mode === "local",
  }));
}

export function createModeChangeHandler(
  session: ApiSessionClient
): (mode: "local" | "remote") => void {
  return mode => {
    session.sendSessionEvent({ type: "switch", mode });
    setControlledByUser(session, mode);
  };
}
