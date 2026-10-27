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
// The legacy happy-coder CLI ran under node only.
const NODE_RUNTIMES = new Set(["node", "node.exe"]);
const LEGACY_HAPPY_EXECUTABLES = new Set(["happy", "happy.mjs"]);
const LEGACY_HAPPY_PACKAGES = new Set(["happy-coder", "happy-cli"]);

function pathSegments(token: string): string[] {
  return token.split(/[\\/]/);
}

function executableName(token: string): string {
  const parts = pathSegments(token);
  return parts[parts.length - 1] ?? "";
}

/**
 * Arguments of a process whose comm name is one of `names` but whose
 * executable token is not: its path contains a space ("/home/John Doe/
 * .local/bin/hapi"), so splitting on whitespace broke the path in two. Start
 * after the token that ends in the binary, or after argv[0] when the process
 * rewrote its own argv[0].
 */
function argsAfterBinary(
  tokens: string[],
  names: ReadonlySet<string>
): string[] {
  const binary = tokens.findIndex(token => names.has(executableName(token)));
  return tokens.slice(binary >= 0 ? binary + 1 : 1);
}

/**
 * The hapi CLI's own dev entry: a path ending in `cli/src/index.ts`, which is
 * what every dev-mode spawn passes (spawnHappyCLI). Another project's
 * `src/index.ts` is not hapi (#5763).
 */
function isHapiDevEntry(token: string): boolean {
  return pathSegments(token).slice(-3).join("/") === "cli/src/index.ts";
}

/**
 * A script path inside the legacy happy-coder / happy-cli package, or that
 * package's `happy` bin. A bare word is not a path, so
 * `ssh h happy-coder daemon start` never matches (#5763).
 */
function isLegacyHappyScript(token: string): boolean {
  const segments = pathSegments(token);
  if (segments.length < 2) {
    return false;
  }
  return (
    segments.some(segment => LEGACY_HAPPY_PACKAGES.has(segment)) ||
    LEGACY_HAPPY_EXECUTABLES.has(segments[segments.length - 1] ?? "")
  );
}

/**
 * The executable names whose processes `hapi daemon status` and `hapi doctor`
 * list: `hapi` / `hapi.exe`, plus the running binary's own name when it is a
 * compiled binary (#5526). A fleet instance's binary is named per instance
 * (`hapimatic-private`, `hapimatic-dev`, `hapimatic-wt-3012`), so this lists
 * that instance's own processes and any `hapi` / `hapi.exe` process, but no
 * other `hapimatic-*` instance's.
 *
 * Only the listing uses this set. `doctor clean`'s kill list keeps the default
 * names (see findRunawayHappyProcesses).
 */
export function instanceExecutableNames(
  execPath: string,
  compiled: boolean
): ReadonlySet<string> {
  const own = executableName(execPath);
  if (
    !compiled ||
    !own ||
    HAPI_EXECUTABLES.has(own) ||
    SHELL_EXECUTABLES.has(own) ||
    DEV_RUNTIMES.has(own)
  ) {
    return HAPI_EXECUTABLES;
  }
  return new Set([...HAPI_EXECUTABLES, own]);
}

const SECRET_FLAG = /^--(?:[a-z0-9]+-)*token$/i;
const SECRET_FLAG_WITH_VALUE = /^(--(?:[a-z0-9]+-)*token=).+$/i;

/**
 * Hide the value of any `--token` / `--*-token` argument in a command line
 * before it is printed (#5526). The hook forwarder runs as
 * `<binary> hook-forwarder --port N --token <secret>`, and `hapi doctor`
 * output is often pasted into issues.
 */
export function redactCommandSecrets(cmd: string): string {
  const tokens = cmd.split(/(\s+)/);
  let redactNext = false;
  return tokens
    .map(token => {
      if (/^\s+$/.test(token) || token === "") {
        return token;
      }
      if (redactNext) {
        redactNext = false;
        return "<redacted>";
      }
      if (SECRET_FLAG.test(token)) {
        redactNext = true;
        return token;
      }
      return token.replace(SECRET_FLAG_WITH_VALUE, "$1<redacted>");
    })
    .join("");
}

/**
 * Locate a process's hapi arguments, or null when it is not a hapi process.
 *
 * #5180 F11: the arguments are read from the executable token onwards, never
 * from a substring of the whole command line. A shell wrapper such as
 * `bash -c "cd /x && hapi daemon start"` merely contains those words; it is
 * not the daemon, and `hapi doctor clean` must never kill it. The same rule
 * applies to an instance's own binary name (#5526), to dev mode (a `bun` /
 * `node` running the hapi CLI's own `cli/src/index.ts`) and to the legacy
 * happy-coder CLI (its `happy` binary, or `node` running a script inside the
 * happy-coder / happy-cli package) (#5763).
 */
function locateHapiArgs(
  tokens: string[],
  name: string,
  executables: ReadonlySet<string>
): { args: string[]; isDevMode: boolean } | null {
  const exe = executableName(tokens[0] ?? "");
  if (executables.has(exe)) {
    return { args: tokens.slice(1), isDevMode: false };
  }
  if (executables.has(name)) {
    return { args: argsAfterBinary(tokens, executables), isDevMode: false };
  }
  if (DEV_RUNTIMES.has(exe)) {
    // Dev mode: bun/node running the CLI's src/index.ts (production is the
    // binary).
    const entry = tokens.findIndex(
      (token, index) => index > 0 && isHapiDevEntry(token)
    );
    if (entry > 0) {
      return { args: tokens.slice(entry + 1), isDevMode: true };
    }
  }
  if (SHELL_EXECUTABLES.has(exe)) {
    return null;
  }
  if (LEGACY_HAPPY_EXECUTABLES.has(exe)) {
    return { args: tokens.slice(1), isDevMode: false };
  }
  if (LEGACY_HAPPY_EXECUTABLES.has(name)) {
    return {
      args: argsAfterBinary(tokens, LEGACY_HAPPY_EXECUTABLES),
      isDevMode: false,
    };
  }
  if (NODE_RUNTIMES.has(exe)) {
    const script = tokens.findIndex(
      (token, index) => index > 0 && isLegacyHappyScript(token)
    );
    if (script > 0) {
      return { args: tokens.slice(script + 1), isDevMode: false };
    }
  }
  return null;
}

/**
 * Classify one process for `hapi doctor` / `hapi daemon status`. Returns null
 * when the process is not a hapi process. `executables` is the set of binary
 * names that count as hapi (default `hapi` / `hapi.exe`).
 */
export function classifyHappyProcess(
  proc: { pid: number; cmd: string; name: string },
  selfPid: number,
  executables: ReadonlySet<string> = HAPI_EXECUTABLES
): string | null {
  const cmd = proc.cmd || "";
  const name = proc.name || "";
  const tokens = cmd.trim().split(/\s+/).filter(Boolean);
  const located = locateHapiArgs(tokens, name, executables);
  if (!located) {
    return null;
  }
  const { args, isDevMode } = located;
  const startedBy = args.indexOf("--started-by");

  if (proc.pid === selfPid) {
    return "current";
  }
  // `ps` joins argv with spaces, so a `--version` word inside a prompt reads
  // as an argument; a version check is `<binary> --version` alone (#5763).
  if (args.length === 1 && args[0] === "--version") {
    return isDevMode ? "dev-daemon-version-check" : "daemon-version-check";
  }
  if (
    args[0] === "daemon" &&
    (args[1] === "start-sync" || args[1] === "start")
  ) {
    return isDevMode ? "dev-daemon" : "daemon";
  }
  if (args[0] === "server") {
    return isDevMode ? "dev-related" : "server";
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
 * Find all HAPI CLI processes (including current process). `executables` is
 * the set of binary names that count as hapi; the listing passes
 * instanceExecutableNames() so a fleet instance sees its own processes.
 *
 * Rejects when the process list cannot be read, so a caller reports the
 * failure instead of reading it as "no hapi processes" (#5763).
 */
export async function findAllHappyProcesses(
  executables: ReadonlySet<string> = HAPI_EXECUTABLES
): Promise<Array<{ pid: number; command: string; type: string }>> {
  const processes = await psList();
  const allProcesses: Array<{ pid: number; command: string; type: string }> =
    [];

  for (const proc of processes) {
    const cmd = proc.cmd || "";
    const name = proc.name || "";
    const type = classifyHappyProcess(
      { pid: proc.pid, cmd, name },
      process.pid,
      executables
    );
    if (type === null) continue;
    allProcesses.push({
      pid: proc.pid,
      command: redactCommandSecrets(cmd || name),
      type,
    });
  }

  return allProcesses;
}

/**
 * Find all runaway HAPI CLI processes that should be killed. Rejects when the
 * process list cannot be read.
 */
export async function findRunawayHappyProcesses(): Promise<
  Array<{ pid: number; command: string }>
> {
  // #5526: the kill list deliberately stays on the default `hapi` / `hapi.exe`
  // names. The listing adds the instance's own binary name, but a fleet
  // instance's daemon and sessions must never become killable through it:
  // `hapimatic-private doctor clean` would otherwise kill the prod daemon and
  // every session it spawned.
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
 * Whether a process is still in the process list. `ps-list` is used rather
 * than `isProcessAlive`, which reads another user's live process (EPERM) as
 * dead.
 */
async function isListed(pid: number): Promise<boolean> {
  const processes = await psList();
  return processes.some(p => p.pid === pid);
}

/**
 * Kill all runaway HAPI CLI processes. A process counts as killed only when a
 * signal reached it: `killProcess` returns false for both an exited process
 * and one this user may not signal, so a false return is re-checked against
 * the process list (#5763). `graceMs` is the wait between SIGTERM and the
 * SIGKILL fallback.
 */
export async function killRunawayHappyProcesses(
  options: { graceMs?: number } = {}
): Promise<{
  killed: number;
  errors: Array<{ pid: number; error: string }>;
}> {
  const graceMs = options.graceMs ?? 1000;
  const runawayProcesses = await findRunawayHappyProcesses();
  const errors: Array<{ pid: number; error: string }> = [];
  let killed = 0;

  const fail = (pid: number, error: string): void => {
    errors.push({ pid, error });
    console.log(`Failed to kill process PID ${pid}: ${error}`);
  };

  for (const { pid, command } of runawayProcesses) {
    try {
      console.log(`Killing runaway process PID ${pid}: ${command}`);

      if (!(await killProcess(pid, false))) {
        if (await isListed(pid)) {
          fail(pid, "could not send SIGTERM (permission denied?)");
        } else {
          console.log(`Process PID ${pid} had already exited`);
        }
        continue;
      }

      await new Promise(resolve => setTimeout(resolve, graceMs));

      if (await isListed(pid)) {
        console.log(
          `Process PID ${pid} ignored termination request, using force kill`
        );
        if (!(await killProcess(pid, true)) && (await isListed(pid))) {
          fail(pid, "could not send SIGKILL (permission denied?)");
          continue;
        }
      }

      console.log(`Successfully killed runaway process PID ${pid}`);
      killed++;
    } catch (error) {
      fail(pid, (error as Error).message);
    }
  }

  return { killed, errors };
}
