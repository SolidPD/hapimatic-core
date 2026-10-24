// SPDX-License-Identifier: MIT AND AGPL-3.0-only
/**
 * Daemon doctor utilities
 *
 * Process discovery and cleanup functions for the daemon
 * Helps diagnose and fix issues with hung or orphaned processes
 */

import psList from "ps-list";
import { killProcess } from "@/utils/process";

const SHELL_EXECUTABLES = new Set(["bash", "sh", "zsh", "dash"]);
const HAPI_EXECUTABLES = new Set(["hapi", "hapi.exe"]);
const DEV_RUNTIMES = new Set(["bun", "bun.exe", "node", "node.exe"]);

function executableName(token: string): string {
  const parts = token.split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}

/**
 * Locate a process's hapi arguments, or null when it is not a hapi process.
 *
 * #5180 F11: the arguments are read from the executable token onwards, never
 * from a substring of the whole command line. A shell wrapper such as
 * `bash -c "cd /x && hapi daemon start"` merely contains those words; it is
 * not the daemon, and `hapi doctor clean` must never kill it.
 */
function locateHapiArgs(
  tokens: string[],
  name: string,
  cmd: string
): { args: string[]; isDevMode: boolean } | null {
  const exe = executableName(tokens[0] ?? "");
  if (HAPI_EXECUTABLES.has(exe)) {
    return { args: tokens.slice(1), isDevMode: false };
  }
  if (HAPI_EXECUTABLES.has(name)) {
    // The process IS hapi, but its path contains a space ("/home/John Doe/
    // .local/bin/hapi"), so splitting on whitespace broke the path in two.
    // Start the arguments after the token that ends in the hapi binary, or
    // after argv[0] when the process rewrote its own argv[0].
    const binary = tokens.findIndex(token =>
      HAPI_EXECUTABLES.has(executableName(token))
    );
    return {
      args: tokens.slice(binary >= 0 ? binary + 1 : 1),
      isDevMode: false,
    };
  }
  if (DEV_RUNTIMES.has(exe)) {
    // Dev mode: bun/node running src/index.ts (production is the binary).
    const entry = tokens.findIndex(
      (token, index) => index > 0 && token.endsWith("src/index.ts")
    );
    if (entry > 0) {
      return { args: tokens.slice(entry + 1), isDevMode: true };
    }
  }
  if (SHELL_EXECUTABLES.has(exe)) {
    return null;
  }
  const isLegacyHappy =
    name.includes("happy") ||
    (name === "node" && cmd.includes("happy-cli")) ||
    cmd.includes("happy-coder");
  if (!isLegacyHappy) {
    return null;
  }
  const entry = tokens.findIndex(token => token.includes("happy"));
  return { args: tokens.slice(entry >= 0 ? entry + 1 : 1), isDevMode: false };
}

/**
 * Classify one process for `hapi doctor` / `hapi daemon status`. Returns null
 * when the process is not a hapi process.
 */
export function classifyHappyProcess(
  proc: { pid: number; cmd: string; name: string },
  selfPid: number
): string | null {
  const cmd = proc.cmd || "";
  const name = proc.name || "";
  const tokens = cmd.trim().split(/\s+/).filter(Boolean);
  const located = locateHapiArgs(tokens, name, cmd);
  if (!located) {
    return null;
  }
  const { args, isDevMode } = located;
  const startedBy = args.indexOf("--started-by");

  if (proc.pid === selfPid) {
    return "current";
  }
  if (args.includes("--version")) {
    return isDevMode ? "dev-daemon-version-check" : "daemon-version-check";
  }
  if (
    args[0] === "daemon" &&
    (args[1] === "start-sync" || args[1] === "start")
  ) {
    return isDevMode ? "dev-daemon" : "daemon";
  }
  if (
    (startedBy >= 0 && args[startedBy + 1] === "daemon") ||
    args.includes("--started-by=daemon")
  ) {
    return isDevMode ? "dev-daemon-spawned" : "daemon-spawned-session";
  }
  if (args.includes("doctor")) {
    return isDevMode ? "dev-doctor" : "doctor";
  }
  if (args.includes("--yolo")) {
    return "dev-session";
  }
  return isDevMode ? "dev-related" : "user-session";
}

/**
 * Find all HAPI CLI processes (including current process)
 */
export async function findAllHappyProcesses(): Promise<
  Array<{ pid: number; command: string; type: string }>
> {
  try {
    const processes = await psList();
    const allProcesses: Array<{ pid: number; command: string; type: string }> =
      [];

    for (const proc of processes) {
      const cmd = proc.cmd || "";
      const name = proc.name || "";
      const type = classifyHappyProcess(
        { pid: proc.pid, cmd, name },
        process.pid
      );
      if (type === null) continue;
      allProcesses.push({ pid: proc.pid, command: cmd || name, type });
    }

    return allProcesses;
  } catch (error) {
    return [];
  }
}

/**
 * Find all runaway HAPI CLI processes that should be killed
 */
export async function findRunawayHappyProcesses(): Promise<
  Array<{ pid: number; command: string }>
> {
  const allProcesses = await findAllHappyProcesses();

  // Filter to just runaway processes (excluding current process)
  return allProcesses
    .filter(
      p =>
        p.pid !== process.pid &&
        (p.type === "daemon" ||
          p.type === "dev-daemon" ||
          p.type === "daemon-spawned-session" ||
          p.type === "dev-daemon-spawned" ||
          p.type === "daemon-version-check" ||
          p.type === "dev-daemon-version-check")
    )
    .map(p => ({ pid: p.pid, command: p.command }));
}

/**
 * Kill all runaway HAPI CLI processes
 */
export async function killRunawayHappyProcesses(): Promise<{
  killed: number;
  errors: Array<{ pid: number; error: string }>;
}> {
  const runawayProcesses = await findRunawayHappyProcesses();
  const errors: Array<{ pid: number; error: string }> = [];
  let killed = 0;

  for (const { pid, command } of runawayProcesses) {
    try {
      console.log(`Killing runaway process PID ${pid}: ${command}`);

      await killProcess(pid, false);

      // Wait a moment
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Check if still alive
      const processes = await psList();
      const stillAlive = processes.find(p => p.pid === pid);
      if (stillAlive) {
        console.log(
          `Process PID ${pid} ignored termination request, using force kill`
        );
        await killProcess(pid, true);
      }

      console.log(`Successfully killed runaway process PID ${pid}`);
      killed++;
    } catch (error) {
      const errorMessage = (error as Error).message;
      errors.push({ pid, error: errorMessage });
      console.log(`Failed to kill process PID ${pid}: ${errorMessage}`);
    }
  }

  return { killed, errors };
}
