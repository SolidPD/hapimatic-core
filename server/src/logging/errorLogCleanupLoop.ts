// SPDX-License-Identifier: AGPL-3.0-only
import { type JobRegistry, SupervisedLoop } from "@hapi/protocol";

import type { ErrorLogger } from "./errorLogger";

/** How often the error-log cleanup runs. */
export const ERROR_LOG_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Error-log entries older than this many days are deleted. */
export const ERROR_LOG_RETENTION_DAYS = 30;

export interface ErrorLogCleanupDeps {
  store: { errorLogs: { deleteEntriesOlderThan(days: number): number } };
  errorLogger: Pick<ErrorLogger, "info">;
}

/**
 * One cleanup pass: delete entries older than {@link ERROR_LOG_RETENTION_DAYS}
 * and log the count when non-zero. A store error is logged and rethrown so the
 * supervised loop records the failure.
 */
export function runErrorLogCleanup(deps: ErrorLogCleanupDeps): void {
  try {
    const deleted = deps.store.errorLogs.deleteEntriesOlderThan(
      ERROR_LOG_RETENTION_DAYS
    );
    if (deleted > 0) {
      deps.errorLogger.info(
        `Cleaned up ${deleted} error log entries older than 30 days`,
        {
          category: "error-log-cleanup",
        }
      );
    }
  } catch (err) {
    console.error("[ErrorLog] Cleanup failed:", err);
    throw err;
  }
}

/**
 * The daily error-log cleanup loop, moved out of `index.ts` unchanged (issue
 * #2911): same job name, 24-hour cadence, first tick one interval after start.
 * The caller starts and stops it.
 */
export function createErrorLogCleanupLoop(
  opts: ErrorLogCleanupDeps & { node: string; registry: JobRegistry }
): SupervisedLoop {
  return new SupervisedLoop({
    name: "error-log-cleanup",
    node: opts.node,
    intervalMs: ERROR_LOG_CLEANUP_INTERVAL_MS,
    immediate: false,
    registry: opts.registry,
    tick: () => runErrorLogCleanup(opts),
  });
}
