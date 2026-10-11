// SPDX-License-Identifier: MIT
/**
 * Orphan-MCP reaper (issue #849), scoped to this instance and anchored to the
 * MCP server's own identity (issue #4065).
 *
 * Every instance daemon on a host (prod, dev, each worktree instance) runs this
 * reaper on its maintenance tick. The pre-#4065 reaper matched `pgrep -f`
 * substrings host-wide and killed every match that was not under THIS daemon's
 * tracked sessions — so each daemon killed every OTHER instance's live MCP
 * servers, and any process whose argv merely mentioned an MCP name (a
 * `.playwright-mcp/` output path, a `bash -c` tool shell, a `grep` argument).
 *
 * A process is signaled only when ALL of these hold:
 *   - Identity: its executable/script token matches an end-anchored MCP server
 *     identity — never a free argv substring.
 *   - Ownership: `HAPI_HOME` in its `/proc/<pid>/environ` is this instance's
 *     (fixed at exec, inherited from the session's spawn env; not in the
 *     OmniBox SECRET_ENV_VARS strip list). Survives reparenting.
 *   - Orphanhood, read from /proc (not from daemon memory): no ancestor is one
 *     of the daemon's live PIDs, AND its parent chain climbs through wrapper
 *     processes only (shells, npm/npx, uv/uvx, other MCP processes) to init or
 *     the `systemd --user` subreaper. A live MCP always has a real host above it
 *     — claude, a tmux server (the tmux launcher's claude runs on its own tmux
 *     server, outside the tracked wrapper), the hapi wrapper — so a session the
 *     daemon does not track (tmux launcher, a detached direct spawn after a
 *     daemon restart, a missed recovery) is never mistaken for dead.
 *   - Stability: observed as an orphan on consecutive ticks at the same
 *     (pid, starttime), re-verified immediately before the signal.
 * Any unreadable or truncated evidence resolves to "do not signal".
 *
 * Pure decision helpers are exported for unit tests (pattern:
 * orphanCheckDecision.ts); `reapOrphanMcpProcesses` is the thin `/proc` I/O
 * wrapper, with `procRoot` / `readFile` / `kill` / `platform` injectable so
 * tests can run it against a fixture tree.
 */
import { readdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { basename, isAbsolute, join, resolve } from "path";

export type McpServerIdentity = {
  /** Stable name used in reaper logs. */
  name: string;
  /** Matched against the whole identity token (see `mcpIdentityToken`). */
  token: RegExp;
  /** When set, at least one argv element must fully match it. */
  argvGuard?: RegExp;
};

/**
 * The #849 logical server set. Each `token` is anchored at a path boundary and
 * at the end, so `/x/.bin/context7-mcp` matches but `/x/.playwright-mcp/a.mjs`
 * (a path component) and `context7-mcp-notes.md` do not.
 */
export const MCP_SERVER_IDENTITIES: readonly McpServerIdentity[] = [
  { name: "context7", token: /(^|\/)context7-mcp(@[^/]*)?$/ },
  {
    name: "sequential-thinking",
    token:
      /(^|\/)(mcp-server-sequential-thinking|server-sequential-thinking(@[^/]*)?)$/,
  },
  { name: "serena", token: /(^|\/)serena(-mcp-server)?$/ },
  {
    // The installed server is `node …/@playwright/mcp/cli.js`; the legacy
    // `playwright-mcp` pattern never matched it (#4065 pattern drift).
    name: "playwright",
    token:
      /(^|\/)(@playwright\/mcp\/cli\.js|@playwright\/mcp(@[^/]*)?|mcp-server-playwright|playwright-mcp(-server)?(@[^/]*)?)$/,
  },
  { name: "tavily", token: /(^|\/)tavily-mcp(@[^/]*)?$/ },
  { name: "tailscale", token: /(^|\/)tailscale-mcp(-server)?(@[^/]*)?$/ },
  { name: "zen", token: /(^|\/)zen-mcp(-server)?$/ },
  {
    // #849 matched the bare word; the server is an `mcp-remote` bridge pointed
    // at a Wrike URL, so require both.
    name: "wrike",
    token: /(^|\/)mcp-remote(@[^/]*)?$/,
    argvGuard: /^https?:\/\/([a-z0-9-]+\.)*wrike\.com(\/|$)/i,
  },
];

/** Interpreters / package runners whose first positional argument is the program. */
const RUNTIME_LAUNCHERS = new Set([
  "node",
  "nodejs",
  "bun",
  "deno",
  "tsx",
  "npx",
  "npm",
  "pnpm",
  "bunx",
  "uv",
  "uvx",
]);
const PYTHON_LAUNCHER = /^python[0-9.]*$/;
/** Launchers that take a leading subcommand (`npm exec`, `uv tool run`, `deno run`). */
const SUBCOMMAND_LAUNCHERS = new Set([
  "npm",
  "pnpm",
  "uv",
  "uvx",
  "bun",
  "deno",
]);
const LAUNCHER_SUBCOMMANDS = new Set(["exec", "x", "dlx", "run", "tool"]);
/** Flags whose NEXT argv element is their value, not the program. */
const VALUE_FLAGS = new Set([
  "--from",
  "--with",
  "-p",
  "--package",
  "-r",
  "--require",
  "--import",
  "--loader",
]);
/** JS runtimes where `-p` / `--print` means inline code, not `--package`. */
const JS_RUNTIMES = new Set(["node", "nodejs", "bun", "deno", "tsx"]);

/**
 * Programs that sit BETWEEN an MCP host and its server without being a host
 * themselves: shells and exec helpers, and package runners. Seen in an
 * ancestor chain, they neither prove the session alive nor dead.
 */
const WRAPPER_PROGRAMS = new Set([
  "sh",
  "bash",
  "dash",
  "zsh",
  "env",
  "nohup",
  "setsid",
  "timeout",
  "stdbuf",
  "npm",
  "npx",
  "pnpm",
  "bunx",
  "uv",
  "uvx",
]);
/** A node process running the npm/npx CLI script (before any title rewrite). */
const NODE_PACKAGE_RUNNER_SCRIPT = /(^|\/)(npm|npx)(-cli\.js)?$/;
/** Where an orphan is reparented: init, or the `systemd --user` subreaper. */
const INIT_PROGRAMS = new Set(["systemd", "init"]);

/**
 * Normalize a raw `/proc/<pid>/cmdline` split. A Node process that sets
 * `process.title` (npm does: `npm exec @playwright/mcp`) collapses its whole
 * command line into argv[0] followed by empty padding, so a single non-empty
 * element containing whitespace is split back into words. Empty elements are
 * dropped.
 */
export function normalizeArgv(raw: readonly string[]): string[] {
  const argv = raw.filter(arg => arg !== "");
  if (argv.length === 1 && /\s/.test(argv[0])) {
    return argv[0].split(/\s+/).filter(Boolean);
  }
  return argv;
}

/**
 * The token that names the program a process is running: `argv[0]`, or — when
 * `argv[0]` is a runtime launcher — the first positional argument after the
 * launcher's options and leading subcommands. Shells are deliberately NOT
 * launchers, so `bash -c '<script>'` yields `bash` and its script text is never
 * inspected. Returns `null` for inline code (`node -e`, `python -c`).
 */
export function mcpIdentityToken(argv: readonly string[]): string | null {
  const program = argv[0];
  if (!program) return null;
  const launcher = basename(program);
  const isPython = PYTHON_LAUNCHER.test(launcher);
  if (!RUNTIME_LAUNCHERS.has(launcher) && !isPython) return program;

  const skipsSubcommands = SUBCOMMAND_LAUNCHERS.has(launcher);
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-e" || arg === "--eval" || (isPython && arg === "-c")) {
      return null;
    }
    if (JS_RUNTIMES.has(launcher) && (arg === "-p" || arg === "--print")) {
      return null;
    }
    if (isPython && arg === "-m") return argv[i + 1] ?? null;
    if (VALUE_FLAGS.has(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    if (skipsSubcommands && LAUNCHER_SUBCOMMANDS.has(arg)) continue;
    return arg;
  }
  return null;
}

/** The MCP server name this argv runs, or `null` when it is not one. */
export function matchMcpIdentity(argv: readonly string[]): string | null {
  const token = mcpIdentityToken(argv);
  if (token === null) return null;
  for (const identity of MCP_SERVER_IDENTITIES) {
    if (!identity.token.test(token)) continue;
    const guard = identity.argvGuard;
    if (guard && !argv.some(arg => guard.test(arg))) continue;
    return identity.name;
  }
  return null;
}

/**
 * Whether a process can sit between an MCP host and its server (see
 * `WRAPPER_PROGRAMS`). A multi-process MCP server's own processes count too.
 * An empty argv (kernel thread, zombie) is NOT a wrapper.
 */
export function isWrapperProcess(argv: readonly string[]): boolean {
  const program = argv[0];
  if (!program) return false;
  const name = basename(program);
  if (WRAPPER_PROGRAMS.has(name)) return true;
  if (
    (name === "node" || name === "nodejs") &&
    argv[1] !== undefined &&
    NODE_PACKAGE_RUNNER_SCRIPT.test(argv[1])
  ) {
    return true;
  }
  return matchMcpIdentity(argv) !== null;
}

/**
 * Normalize a `HAPI_HOME` value the way `configuration.ts` resolves it (`~`
 * expansion), plus `path.resolve` so trailing slashes / `..` compare equal.
 * Absent, empty or relative (ambiguous: it resolves against each process's own
 * cwd) → `null`, i.e. no ownership claim.
 */
export function normalizeHapiHome(
  raw: string | null | undefined
): string | null {
  if (!raw) return null;
  const expanded = raw.replace(/^~/, homedir());
  if (!isAbsolute(expanded)) return null;
  return resolve(expanded);
}

export type ProcStat = { ppid: number; startTime: string };

/**
 * Parse `/proc/<pid>/stat`. The comm field (2) is parenthesized and may itself
 * contain spaces and `)`, so fields are read after the LAST `)`: that slice
 * starts at field 3, putting ppid (field 4) at index 1 and starttime (field 22,
 * clock ticks since boot) at index 19.
 */
export function parseProcStat(stat: string): ProcStat | null {
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const fields = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const ppid = Number(fields[1]);
  const startTime = fields[19];
  if (!Number.isInteger(ppid) || ppid < 0) return null;
  if (!startTime || !/^\d+$/.test(startTime)) return null;
  return { ppid, startTime };
}

/** One ancestor, nearest first; `argv` is `null` when its cmdline was unreadable. */
export type AncestorInfo = { pid: number; argv: readonly string[] | null };

export type McpCandidate = {
  /** Raw `HAPI_HOME` from the process's environ (`null` if absent/unreadable). */
  hapiHome: string | null;
  /** Parent chain, nearest first, stopping before pid 1. */
  ancestors: readonly AncestorInfo[];
  /** `false` when the walk stopped early (unreadable stat, hop cap). */
  complete: boolean;
};

export type OrphanMcpVerdict = "foreign" | "live" | "orphan" | "unknown";

/**
 * Classify an MCP-identity process for THIS instance:
 *   - `foreign` — its `HAPI_HOME` is absent/unreadable/relative or names
 *     another instance: never ours to signal (#4065 R1).
 *   - `live` — an ancestor is one of the daemon's live PIDs, or the chain
 *     reaches a real host process (claude, tmux, the hapi wrapper, …).
 *   - `orphan` — ours, and its chain climbs through wrappers only to init.
 *   - `unknown` — the evidence is incomplete (unreadable ancestor, truncated
 *     walk): never signaled.
 */
export function classifyMcpCandidate(
  candidate: McpCandidate,
  context: { ownHome: string; livePids: ReadonlySet<number> }
): OrphanMcpVerdict {
  const home = normalizeHapiHome(candidate.hapiHome);
  const ownHome = normalizeHapiHome(context.ownHome);
  if (home === null || ownHome === null || home !== ownHome) return "foreign";

  for (const ancestor of candidate.ancestors) {
    if (context.livePids.has(ancestor.pid)) return "live";
    if (ancestor.argv === null) return "unknown";
    const program = ancestor.argv[0];
    if (program !== undefined && INIT_PROGRAMS.has(basename(program))) {
      return "orphan";
    }
    if (!isWrapperProcess(ancestor.argv)) return "live";
  }
  // Chain exhausted through wrappers only: the next parent is pid 1 (init).
  return candidate.complete ? "orphan" : "unknown";
}

/** Consecutive ticks an orphan must be observed (same pid + starttime) before it is signaled. */
export const ORPHAN_MCP_REAP_AFTER_TICKS = 2;
/** Bound on the parent-chain walk (guards a malformed or cyclic /proc read). */
const MAX_ANCESTOR_HOPS = 64;

/** Per-pid observation state carried across ticks (keyed by pid, pinned by starttime). */
export type OrphanMcpDebounce = Map<
  number,
  { startTime: string; ticks: number }
>;

export type ReapOrphanMcpOptions = {
  /** This daemon's `configuration.happyHomeDir`. */
  ownHome: string;
  /** PIDs whose descendants are live: tracked sessions, in-flight spawns, the daemon. */
  livePids: ReadonlySet<number>;
  debounce: OrphanMcpDebounce;
  procRoot?: string;
  platform?: NodeJS.Platform;
  selfPid?: number;
  /** Reads a /proc file as UTF-8; throws when unreadable (tests inject this). */
  readFile?: (path: string) => string;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
};

export type ReapOrphanMcpResult = {
  reaped: Array<{ pid: number; identity: string }>;
  pending: number;
  liveSkipped: number;
  foreignSkipped: number;
  unknownSkipped: number;
};

/** Where /proc lives and how to read one of its files (both injectable). */
type ProcFs = { root: string; readFile: (path: string) => string };

function readProcFile(fs: ProcFs, pid: number, name: string): string | null {
  try {
    return fs.readFile(join(fs.root, String(pid), name));
  } catch {
    // The process exited mid-scan, or the file is unreadable (another user).
    return null;
  }
}

function readArgv(fs: ProcFs, pid: number): string[] | null {
  const raw = readProcFile(fs, pid, "cmdline");
  if (!raw) return null;
  const argv = normalizeArgv(raw.split("\0"));
  return argv.length > 0 ? argv : null;
}

function readEnvValue(fs: ProcFs, pid: number, key: string): string | null {
  const raw = readProcFile(fs, pid, "environ");
  if (!raw) return null;
  const prefix = `${key}=`;
  const entry = raw.split("\0").find(line => line.startsWith(prefix));
  return entry === undefined ? null : entry.slice(prefix.length);
}

function readStat(fs: ProcFs, pid: number): ProcStat | null {
  const raw = readProcFile(fs, pid, "stat");
  return raw === null ? null : parseProcStat(raw);
}

function readAncestry(
  fs: ProcFs,
  firstPpid: number
): { ancestors: AncestorInfo[]; complete: boolean } {
  const ancestors: AncestorInfo[] = [];
  let pid = firstPpid;
  while (pid > 1) {
    if (ancestors.length >= MAX_ANCESTOR_HOPS) {
      return { ancestors, complete: false };
    }
    ancestors.push({ pid, argv: readArgv(fs, pid) });
    const stat = readStat(fs, pid);
    if (!stat) return { ancestors, complete: false };
    pid = stat.ppid;
  }
  return { ancestors, complete: true };
}

/**
 * One reaper tick: scan `procRoot`, classify every MCP-identity process, and
 * SIGTERM this instance's orphans once they have been observed on
 * `ORPHAN_MCP_REAP_AFTER_TICKS` consecutive ticks with an unchanged starttime
 * (absorbs one-tick transients and PID reuse). The starttime is re-read
 * immediately before the signal. A no-op off Linux, where there is no `/proc`
 * to read ownership from.
 */
export function reapOrphanMcpProcesses(
  options: ReapOrphanMcpOptions
): ReapOrphanMcpResult {
  const result: ReapOrphanMcpResult = {
    reaped: [],
    pending: 0,
    liveSkipped: 0,
    foreignSkipped: 0,
    unknownSkipped: 0,
  };
  if ((options.platform ?? process.platform) !== "linux") return result;

  const fs: ProcFs = {
    root: options.procRoot ?? "/proc",
    readFile:
      options.readFile ??
      ((path: string): string => readFileSync(path, "utf8")),
  };
  const selfPid = options.selfPid ?? process.pid;
  const kill =
    options.kill ??
    ((pid: number, signal: NodeJS.Signals): void => {
      process.kill(pid, signal);
    });
  const orphansThisTick = new Set<number>();

  for (const entry of readdirSync(fs.root)) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === selfPid) continue;

    const argv = readArgv(fs, pid);
    if (!argv) continue;
    const identity = matchMcpIdentity(argv);
    if (!identity) continue;
    const stat = readStat(fs, pid);
    if (!stat) continue;

    const verdict = classifyMcpCandidate(
      {
        hapiHome: readEnvValue(fs, pid, "HAPI_HOME"),
        ...readAncestry(fs, stat.ppid),
      },
      { ownHome: options.ownHome, livePids: options.livePids }
    );
    if (verdict === "foreign") {
      result.foreignSkipped++;
      continue;
    }
    if (verdict === "live") {
      result.liveSkipped++;
      continue;
    }
    if (verdict === "unknown") {
      result.unknownSkipped++;
      continue;
    }

    orphansThisTick.add(pid);
    const previous = options.debounce.get(pid);
    const ticks =
      previous?.startTime === stat.startTime ? previous.ticks + 1 : 1;
    if (ticks < ORPHAN_MCP_REAP_AFTER_TICKS) {
      options.debounce.set(pid, { startTime: stat.startTime, ticks });
      result.pending++;
      continue;
    }

    options.debounce.delete(pid);
    // PID-reuse guard: signal only the very process that was observed.
    if (readStat(fs, pid)?.startTime !== stat.startTime) continue;
    try {
      kill(pid, "SIGTERM");
      result.reaped.push({ pid, identity });
    } catch {
      // Already gone (ESRCH) or not ours to signal (EPERM).
    }
  }

  // An entry not seen as an orphan this tick restarts its count next time.
  for (const pid of Array.from(options.debounce.keys())) {
    if (!orphansThisTick.has(pid)) options.debounce.delete(pid);
  }
  return result;
}
