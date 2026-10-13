// SPDX-License-Identifier: MIT
/**
 * HTTP client helpers for daemon communication
 * Used by CLI commands to interact with running daemon
 */

import { logger } from "@/ui/logger";
import { clearDaemonState, readDaemonState } from "@/persistence";
import { Metadata } from "@/api/types";
import { CLI_VERSION, describeDaemonBuildSkew } from "@/version";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { isBunCompiled, projectPath } from "@/projectPath";
import { isProcessAlive, killProcess } from "@/utils/process";

export function getInstalledCliMtimeMs(): number | undefined {
  if (isBunCompiled()) {
    try {
      return statSync(process.execPath).mtimeMs;
    } catch {
      return undefined;
    }
  }

  const packageJsonPath = join(projectPath(), "package.json");
  if (!existsSync(packageJsonPath)) {
    return undefined;
  }

  try {
    return statSync(packageJsonPath).mtimeMs;
  } catch {
    return undefined;
  }
}

async function daemonPost(
  path: string,
  body?: unknown
): Promise<Record<string, unknown>> {
  const state = await readDaemonState();
  if (!state?.httpPort) {
    const errorMessage = "No daemon running, no state file found";
    logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
    return {
      error: errorMessage,
    };
  }

  if (!isProcessAlive(state.pid)) {
    const errorMessage = "Daemon is not running, file is stale";
    logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
    return {
      error: errorMessage,
    };
  }

  try {
    const timeout = process.env.HAPI_DAEMON_HTTP_TIMEOUT
      ? parseInt(process.env.HAPI_DAEMON_HTTP_TIMEOUT)
      : 10_000;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    // Defense-in-depth bearer token (issue #1738). The guard avoids sending
    // "Bearer undefined" against a pre-#1738 daemon state file; same-binary
    // coherence guarantees the token is present in steady state.
    if (state.controlToken) {
      headers["Authorization"] = `Bearer ${state.controlToken}`;
    }
    const response = await fetch(`http://127.0.0.1:${state.httpPort}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body || {}),
      // Mostly increased for stress test
      signal: AbortSignal.timeout(timeout),
    });

    if (!response.ok) {
      const errorMessage = `Request failed: ${path}, HTTP ${response.status}`;
      logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
      return {
        error: errorMessage,
      };
    }

    return (await response.json()) as Record<string, unknown>;
  } catch (error) {
    const errorMessage = `Request failed: ${path}, ${error instanceof Error ? error.message : "Unknown error"}`;
    logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
    return {
      error: errorMessage,
    };
  }
}

export async function notifyDaemonSessionStarted(
  sessionId: string,
  metadata: Metadata
): Promise<Record<string, unknown>> {
  return await daemonPost("/session-started", {
    sessionId,
    metadata,
  });
}

export async function listDaemonSessions(): Promise<Record<string, unknown>[]> {
  const result = await daemonPost("/list");
  return (result.children as Record<string, unknown>[]) || [];
}

export async function stopDaemonSession(sessionId: string): Promise<boolean> {
  const result = await daemonPost("/stop-session", { sessionId });
  return (result.success as boolean) || false;
}

export async function spawnDaemonSession(
  directory: string,
  sessionId?: string
): Promise<Record<string, unknown>> {
  const result = await daemonPost("/spawn-session", { directory, sessionId });
  return result;
}

export async function stopDaemonHttp(): Promise<void> {
  await daemonPost("/stop");
}

/**
 * Force an immediate token refresh for one account through the running daemon
 * (issue #1547). Returns the daemon's ForceRefreshReport (shaped as a plain
 * record here), or `{ error }` when no daemon is running / reachable — the CLI
 * command surfaces that as the "start the daemon" message (R7).
 */
export async function forceRefreshDaemonAccount(
  accountUuid: string
): Promise<Record<string, unknown>> {
  return await daemonPost("/force-refresh-account", { accountUuid });
}

/**
 * Query the daemon's authoritative effective active-session count (issue #1477) —
 * the SAME number the spawn gate uses: max(tracked PIDs, active tmux windows),
 * excluding dead panes / idle shells (#603/#633). Returns `{ error }` (from
 * daemonPost) when no daemon is running / reachable, so callers must guard on the
 * numeric `effectiveCount` shape.
 */
export async function getDaemonEffectiveCount(): Promise<
  Record<string, unknown>
> {
  return await daemonPost("/effective-count");
}

/**
 * Whether a daemon process for this HAPI_HOME is alive. A state file whose pid is
 * dead is deleted on the way; the daemon-start paths rely on that cleanup, and
 * `hapi doctor` deliberately does not call this (#4155 R12: a read-only probe).
 *
 * Upgrades never go through here. Since #4594 (D-4594-1 A) a running daemon of
 * any build is left in place, and the deploy flows restart the daemon's unit.
 */
export async function checkIfDaemonRunningAndCleanupStaleState(): Promise<boolean> {
  const state = await readDaemonState();
  if (!state) {
    return false;
  }

  // Check if the daemon is running
  if (isProcessAlive(state.pid)) {
    return true;
  }

  logger.debug("[DAEMON RUN] Daemon PID not running, cleaning up state");
  await cleanupDaemonState();
  return false;
}

/**
 * What `daemon start`, `daemon start-sync` and `hapi claude` learn about this
 * HAPI_HOME's daemon.
 */
export interface DaemonBuildSkew {
  /** A daemon process for this HAPI_HOME is alive. */
  running: boolean;
  /** The live daemon's pid. */
  pid?: number;
  /** The build the live daemon recorded at boot (`startedWithCliVersion`). */
  daemonVersion?: string;
  /** This CLI's build. */
  cliVersion: string;
  /** describeDaemonBuildSkew() for a live daemon whose build differs, else null. */
  skew: string | null;
}

/**
 * Issue #4594 (D-4594-1 A): whether a daemon is live for this HAPI_HOME and which
 * build it recorded. Callers never stop or replace a live daemon because its
 * build differs; they report the skew. A state file with a dead pid is cleaned
 * up, as every daemon-start path did before.
 */
export async function readDaemonBuildSkew(): Promise<DaemonBuildSkew> {
  const cliVersion = CLI_VERSION;
  if (!(await checkIfDaemonRunningAndCleanupStaleState())) {
    return { running: false, cliVersion, skew: null };
  }
  const state = await readDaemonState();
  if (!state) {
    // The daemon removed its record between the two reads (it is shutting down).
    // A start path then contends for the daemon lock, which still decides.
    return { running: false, cliVersion, skew: null };
  }
  return {
    running: true,
    pid: state.pid,
    daemonVersion: state.startedWithCliVersion,
    cliVersion,
    skew: describeDaemonBuildSkew(state.startedWithCliVersion, cliVersion),
  };
}

export async function cleanupDaemonState(): Promise<void> {
  try {
    await clearDaemonState();
    logger.debug("[DAEMON RUN] Daemon state file removed");
  } catch (error) {
    logger.debug("[DAEMON RUN] Error cleaning up daemon metadata", error);
  }
}

export async function stopDaemon() {
  try {
    const state = await readDaemonState();
    if (!state) {
      logger.debug("No daemon state found");
      return;
    }

    logger.debug(`Stopping daemon with PID ${state.pid}`);

    // Try HTTP graceful stop
    try {
      await stopDaemonHttp();

      // Wait for daemon to die
      await waitForProcessDeath(state.pid, 2000);
      logger.debug("Daemon stopped gracefully via HTTP");
      return;
    } catch (error) {
      logger.debug("HTTP stop failed, will force kill", error);
    }

    // Force kill
    const killed = await killProcess(state.pid, true);
    if (killed) {
      logger.debug("Force killed daemon");
    } else {
      logger.debug("Daemon already dead or could not be killed");
    }
  } catch (error) {
    logger.debug("Error stopping daemon", error);
  }
}

async function waitForProcessDeath(
  pid: number,
  timeout: number
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (isProcessAlive(pid)) {
      await new Promise(resolve => setTimeout(resolve, 100));
      continue;
    }
    return; // Process is dead
  }
  throw new Error("Process did not die within timeout");
}
