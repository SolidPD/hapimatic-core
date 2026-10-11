// SPDX-License-Identifier: MIT
/**
 * HTTP client helpers for daemon communication
 * Used by CLI commands to interact with running daemon
 */

import { logger } from "@/ui/logger";
import { clearDaemonState, readDaemonState } from "@/persistence";
import { Metadata } from "@/api/types";
import packageJson from "../../package.json";
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
 * The version check is still quite naive.
 * For instance we are not handling the case where we upgraded hapi,
 * the daemon is still running, and it recieves a new message to spawn a new session.
 * This is a tough case - we need to somehow figure out to restart ourselves,
 * yet still handle the original request.
 *
 * Options:
 * 1. Periodically check during the health checks whether our version is the same as CLIs version. If not - restart.
 * 2. Wait for a command from the machine session, or any other signal to
 * check for version & restart.
 *   a. Handle the request first
 *   b. Let the request fail, restart and rely on the client retrying the request
 *
 * I like option 1 a little better.
 * Maybe we can ... wait for it ... have another daemon to make sure
 * our daemon is always alive and running the latest version.
 *
 * That seems like an overkill and yet another process to manage - lets not do this :D
 *
 * TODO: This function should return a state object with
 * clear state - if it is running / or errored out or something else.
 * Not just a boolean.
 *
 * We can destructure the response on the caller for richer output.
 * For instance when running `hapi daemon status` we can show more information.
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
 * Check if the running daemon version matches the current CLI version.
 * This should work from both the daemon itself & a new CLI process.
 * Works via the daemon.state.json file.
 *
 * @returns true if versions match, false if versions differ or no daemon running
 */
export async function isDaemonRunningCurrentlyInstalledHappyVersion(): Promise<boolean> {
  logger.debug("[DAEMON CONTROL] Checking if daemon is running same version");
  const runningDaemon = await checkIfDaemonRunningAndCleanupStaleState();
  if (!runningDaemon) {
    logger.debug("[DAEMON CONTROL] No daemon running, returning false");
    return false;
  }

  const state = await readDaemonState();
  if (!state) {
    logger.debug("[DAEMON CONTROL] No daemon state found, returning false");
    return false;
  }

  try {
    // Primary check: version string comparison (stable across rebuilds/copies)
    const currentCliVersion = packageJson.version;
    if (currentCliVersion && state.startedWithCliVersion) {
      logger.debug(
        `[DAEMON CONTROL] Current CLI version: ${currentCliVersion}, Daemon started with version: ${state.startedWithCliVersion}`
      );
      return currentCliVersion === state.startedWithCliVersion;
    }

    // Fallback: mtime comparison (when version string is unavailable)
    const currentCliMtimeMs = getInstalledCliMtimeMs();
    if (
      typeof currentCliMtimeMs === "number" &&
      typeof state.startedWithCliMtimeMs === "number"
    ) {
      logger.debug(
        `[DAEMON CONTROL] Falling back to mtime check: current=${currentCliMtimeMs}, daemon=${state.startedWithCliMtimeMs}`
      );
      return currentCliMtimeMs === state.startedWithCliMtimeMs;
    }

    // Neither version string nor mtime available — can't determine, assume mismatch
    logger.debug(
      "[DAEMON CONTROL] No version or mtime data available for comparison"
    );
    return false;

    // PREVIOUS IMPLEMENTATION - Keeping this commented in case we need it
    // Kirill does not understand how the upgrade of npm packages happen and whether
    // we will get a new path or not when hapi is upgraded globally.
    // If reading package.json doesn't work correctly after npm upgrades,
    // we can revert to spawning a process (but should add timeout and cleanup!)
    /*
    const { spawnHappyCLI } = await import('@/utils/spawnHappyCLI');
    const happyProcess = spawnHappyCLI(['--version'], { stdio: 'pipe' });
    let version: string | null = null;
    happyProcess.stdout?.on('data', (data) => {
      version = data.toString().trim();
    });
    await new Promise(resolve => happyProcess.stdout?.on('close', resolve));
    logger.debug(`[DAEMON CONTROL] Current CLI version: ${version}, Daemon started with version: ${state.startedWithCliVersion}`);
    return version === state.startedWithCliVersion;
    */
  } catch (error) {
    logger.debug("[DAEMON CONTROL] Error checking daemon version", error);
    return false;
  }
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
