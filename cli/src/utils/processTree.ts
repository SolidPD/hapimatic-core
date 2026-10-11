// SPDX-License-Identifier: MIT
import { execSync } from "child_process";
import { logger } from "@/ui/logger";
import { isProcessAlive } from "@/utils/process";

/**
 * Get all descendant PIDs of a parent PID (recursive).
 * Walks the parent-child tree via `pgrep -P`, which follows the tree
 * regardless of process group boundaries — critical for MCP servers
 * that call setpgid() via npm exec / Python venv launchers.
 *
 * Note: Uses execSync with a numeric PID (not user input) — safe from injection.
 */
export function getAllDescendantPids(parentPid: number): number[] {
  const descendants: number[] = [];
  try {
    const output = execSync(`pgrep -P ${parentPid}`, {
      encoding: "utf8",
    }).trim();
    if (!output) return descendants;

    const childPids = output
      .split("\n")
      .map((p: string) => parseInt(p, 10))
      .filter((p: number) => !isNaN(p));

    for (const childPid of childPids) {
      descendants.push(childPid);
      descendants.push(...getAllDescendantPids(childPid));
    }
  } catch {
    // pgrep returns non-zero if no children found
  }
  return descendants;
}

/**
 * Check if a PID is a descendant of another PID.
 */
export function isPidDescendantOf(pid: number, ancestorPid: number): boolean {
  const descendants = getAllDescendantPids(ancestorPid);
  return descendants.includes(pid);
}

export type KillProcessTreeResult = {
  killed: number[];
  survived: number[];
};

/**
 * Kill all descendants of a process.
 *
 * Sends SIGTERM to all descendants in leaf-first order (prevents
 * reparenting to PID 1 mid-sweep), waits for them to exit, then
 * sends SIGKILL to any survivors.
 *
 * Does NOT kill the root PID itself — only its descendants.
 */
export async function killProcessTree(
  rootPid: number,
  options?: { signal?: NodeJS.Signals; timeoutMs?: number }
): Promise<KillProcessTreeResult> {
  const signal = options?.signal ?? "SIGTERM";
  const timeoutMs = options?.timeoutMs ?? 3000;

  const descendants = getAllDescendantPids(rootPid);
  if (descendants.length === 0) {
    return { killed: [], survived: [] };
  }

  // Kill leaf-first: reverse the list (getAllDescendantPids returns
  // parent-first via depth-first traversal)
  const reversed = [...descendants].reverse();

  logger.debug(
    `[processTree] Killing ${reversed.length} descendants of PID ${rootPid} with ${signal}`
  );

  // Phase 1: Send graceful signal
  for (const pid of reversed) {
    try {
      process.kill(pid, signal);
    } catch {
      // Process may have already exited
    }
  }

  // Phase 2: Wait for processes to exit
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const stillAlive = reversed.filter(pid => isProcessAlive(pid));
    if (stillAlive.length === 0) {
      logger.debug(
        `[processTree] All ${reversed.length} descendants exited gracefully`
      );
      return { killed: reversed, survived: [] };
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  // Phase 3: SIGKILL survivors
  const survivors = reversed.filter(pid => isProcessAlive(pid));
  if (survivors.length > 0) {
    logger.debug(
      `[processTree] ${survivors.length} processes survived ${signal}, sending SIGKILL`
    );
    for (const pid of survivors) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone
      }
    }
  }

  // Final check
  const finalSurvivors = survivors.filter(pid => isProcessAlive(pid));
  const killed = reversed.filter(pid => !finalSurvivors.includes(pid));

  return { killed, survived: finalSurvivors };
}
