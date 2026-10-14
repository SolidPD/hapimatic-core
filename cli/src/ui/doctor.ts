// SPDX-License-Identifier: MIT AND AGPL-3.0-only
/**
 * Doctor command implementation
 *
 * Provides comprehensive diagnostics and troubleshooting information
 * for hapi CLI including configuration, daemon status, logs, and links
 */

import chalk from "chalk";
import { configuration } from "@/configuration";
import { readSettings } from "@/persistence";
import { getDaemonEffectiveCount } from "@/daemon/controlClient";
import {
  findRunawayHappyProcesses,
  findAllHappyProcesses,
} from "@/daemon/doctor";
import {
  readDaemonState,
  DAEMON_STATE_DISPLAY,
  SETTINGS_DISPLAY,
  type AmbientOnboardingTokenState,
} from "@/persistence";
import { isProcessAlive } from "@/utils/process";
import { parseAmbientOnboardingTokenState } from "@/daemon/envSeedTokenDisposition";
import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isBunCompiled, projectPath, runtimePath } from "@/projectPath";
import { logger } from "@/ui/logger";
import { TmuxManager } from "@/tmux";
import { describeTmuxFailure, type GlobalEnvRead } from "@/tmux/TmuxManager";
import { UUID_REGEX } from "@/accounts/accountStore";
import packageJson from "../../package.json";
import {
  CLI_VERSION,
  CLI_VERSION_TIMESTAMP,
  describeDaemonBuildSkew,
} from "@/version";

/**
 * Get relevant environment information for debugging
 */
export function getEnvironmentInfo(): Record<string, any> {
  return {
    PWD: process.env.PWD,
    HAPI_HOME: process.env.HAPI_HOME,
    HAPI_SERVER_URL: process.env.HAPI_SERVER_URL,
    HAPI_PROJECT_ROOT: process.env.HAPI_PROJECT_ROOT,
    CLI_API_TOKEN_SET: Boolean(process.env.CLI_API_TOKEN),
    NODE_ENV: process.env.NODE_ENV,
    DEBUG: process.env.DEBUG,
    workingDirectory: process.cwd(),
    processArgv: process.argv,
    happyDir: configuration?.happyHomeDir,
    serverUrl: configuration?.serverUrl,
    logsDir: configuration?.logsDir,
    processPid: process.pid,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    user: process.env.USER,
    home: process.env.HOME,
    shell: process.env.SHELL,
    terminal: process.env.TERM,
  };
}

function getLogFiles(
  logDir: string
): { file: string; path: string; modified: Date }[] {
  if (!existsSync(logDir)) {
    return [];
  }

  try {
    return readdirSync(logDir)
      .filter(file => file.endsWith(".log"))
      .map(file => {
        const path = join(logDir, file);
        const stats = statSync(path);
        return { file, path, modified: stats.mtime };
      })
      .sort((a, b) => b.modified.getTime() - a.modified.getTime());
  } catch (error) {
    logger.reportCaught(error, {
      category: "doctor-list-logs",
      severity: "warn",
    });
    return [];
  }
}

/**
 * Issue #3731 (R6): the variable NAMES in a NUL-separated `/proc/<pid>/environ`
 * blob. Values are discarded — never returned or printed (the daemon env can hold
 * a credential). Pure + exported for a unit test.
 */
export function parseEnvironNames(environ: string): Set<string> {
  const names = new Set<string>();
  for (const entry of environ.split("\0")) {
    const eq = entry.indexOf("=");
    if (eq > 0) names.add(entry.slice(0, eq));
  }
  return names;
}

/**
 * Issue #3731 (F2): the daemon's tmux socket name from its LAUNCH env, used only
 * when the daemon's state record predates the `tmuxSessionName` field. Reads
 * nothing but `HAPI_TMUX_SESSION_NAME` (a socket name, not a secret) and accepts
 * only a plain socket-name value. `null` when absent or malformed.
 */
export function readTmuxSessionNameFromEnviron(environ: string): string | null {
  for (const entry of environ.split("\0")) {
    if (entry.startsWith("HAPI_TMUX_SESSION_NAME=")) {
      const value = entry.slice("HAPI_TMUX_SESSION_NAME=".length);
      return isPlainSocketName(value) ? value : null;
    }
  }
  return null;
}

function isPlainSocketName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value);
}

/** Outcome of the #3731 ambient onboarding-token check. */
export interface AmbientTokenCheck {
  level: "ok" | "info" | "warn" | "unknown";
  message: string;
}

/** Inputs to {@link classifyAmbientOnboardingToken}; `null` always means UNKNOWN. */
export interface AmbientTokenInputs {
  /** What the daemon recorded doing with the onboarding token (daemon.state.json);
   *  `null` = no valid record (a pre-#3731 daemon, one still starting, or an
   *  unreadable/garbage value). */
  daemonTokenState: AmbientOnboardingTokenState | null;
  /** HINT ONLY: whether the daemon was LAUNCHED with the token in its service env
   *  (`/proc/<pid>/environ` — a launch snapshot that never shows a later release). */
  startedWithToken: boolean | null;
  /** Presence in the daemon socket's tmux global table; `null` = read failed,
   *  timed out, or the socket could not be resolved or confirmed. */
  tmuxTableHasToken: boolean | null;
  /** #4153 (A4): why the table is unknown — named in the verdict. */
  tmuxTableUnknownReason?: string | null;
  /** #4153 (A1): replaces "the tmux global table is clean" in an `ok` verdict
   *  when the table read was a confirmed "no server". */
  tmuxTableCleanNote?: string | null;
  /** Isolated per-account config dirs; `null` = not countable. */
  isolatedAccountCount: number | null;
  /** #4153 (A2): why the isolated-account count is unknown. */
  isolatedAccountsUnknownReason?: string | null;
  /** #4153 (A5): how long the record has said `pending`, in ms; `null` when the
   *  daemon recorded no `pendingSince`. */
  pendingForMs?: number | null;
}

/**
 * Issue #4153 (A5): a `pending` record older than this is a stuck seed, not one
 * in progress. The seed's profile fetch times out after 10 s (`run.ts`), so a
 * healthy seed settles long before.
 */
export const PENDING_ESCALATION_MS = 10 * 60_000;

/** Issue #4153 (A5): heartbeat staleness bound — 3× the default 60 s tick. */
export const HEARTBEAT_STALE_MS = 3 * 60_000;

const STARTED_WITH_TOKEN_HINT =
  " (hint: the daemon was launched with CLAUDE_CODE_OAUTH_TOKEN in its service env — a launch snapshot, it cannot show a later release)";

/** What the daemon's own record says about the token in its env. */
type DaemonEnvView =
  | { kind: "holds" }
  | { kind: "clean"; detail: string }
  | { kind: "stuck"; detail: string }
  | { kind: "unknown"; detail: string };

/**
 * Issue #4153 (B3): an exhaustive `switch`, so a state this doctor does not know
 * can never fall through to clean — the `never` check makes a new state a type
 * error here, and a value that bypassed the parser at runtime reads as unknown.
 */
function viewDaemonEnv(
  state: AmbientOnboardingTokenState | null,
  pendingForMs: number | null
): DaemonEnvView {
  if (state === null) {
    return {
      kind: "unknown",
      detail:
        "the daemon has no onboarding-token record (it predates #3731, is still starting, or its state file is unreadable)",
    };
  }
  switch (state) {
    case "retained":
      return { kind: "holds" };
    case "released":
      return {
        kind: "clean",
        detail: "the daemon released it after seeding the primary account",
      };
    case "absent":
      return { kind: "clean", detail: "the daemon started without one" };
    case "pending":
      if (pendingForMs !== null && pendingForMs > PENDING_ESCALATION_MS) {
        return {
          kind: "stuck",
          detail: `the daemon's account-store seed has been pending for ${Math.floor(pendingForMs / 60_000)} min — a healthy seed settles in seconds, and the onboarding token stays in the daemon env until it does; see the daemon journal for the boot seed`,
        };
      }
      return {
        kind: "unknown",
        detail: "the daemon's account-store seed is still in progress",
      };
    default: {
      const _exhaustive: never = state;
      return {
        kind: "unknown",
        detail: "the daemon recorded a state this doctor does not recognise",
      };
    }
  }
}

/**
 * Issue #3731 (R6, F1/F3/F4) + #4153: classify the ambient onboarding
 * `CLAUDE_CODE_OAUTH_TOKEN` for `hapi doctor` (PRESENCE only).
 *
 * The daemon env and the tmux global table are the two places the token leaked
 * from: every pane inherited it, and native Claude Code preferred it over a bound
 * account's isolated `CLAUDE_CONFIG_DIR` credentials. The daemon env is judged
 * from the daemon's OWN record of what it did (`released` / `retained` / …),
 * because its `/proc/<pid>/environ` never changes after launch — that read is
 * reported only as a labelled hint. A present token is a problem only when
 * isolated accounts exist; with none, it is simply the node's credential
 * (`info`). `ok` needs BOTH sources verified clean: the record says the token is
 * gone (`released` / `absent`) and the table read succeeded without it. The
 * isolated-account count matters only while a token is present, so an
 * unreadable account directory never blocks `ok`. Pure + exported for a unit
 * test; the inputs are names/booleans/counts/reasons, never a value.
 */
export function classifyAmbientOnboardingToken(
  input: AmbientTokenInputs
): AmbientTokenCheck {
  const hint = input.startedWithToken === true ? STARTED_WITH_TOKEN_HINT : "";
  const daemonEnv = viewDaemonEnv(
    input.daemonTokenState,
    input.pendingForMs ?? null
  );
  const tableUnreadable = `the tmux global table could not be read${input.tmuxTableUnknownReason ? ` (${input.tmuxTableUnknownReason})` : ""}`;

  // #4153 (A5): a seed stuck in `pending` is a daemon fault, whatever the rest says.
  if (daemonEnv.kind === "stuck") {
    const table =
      input.tmuxTableHasToken === true
        ? "; the tmux global table also holds the token"
        : input.tmuxTableHasToken === null
          ? `; ${tableUnreadable}`
          : "";
    return {
      level: "warn",
      message: `${daemonEnv.detail}${table} (#4153)${hint}`,
    };
  }

  const present: string[] = [];
  if (daemonEnv.kind === "holds") present.push("daemon env");
  if (input.tmuxTableHasToken === true) present.push("tmux global table");

  if (present.length > 0) {
    const where = present.join(" + ");
    if (input.isolatedAccountCount === null) {
      const why =
        input.isolatedAccountsUnknownReason ??
        "the isolated-account directory could not be read";
      return {
        level: "unknown",
        message: `ambient CLAUDE_CODE_OAUTH_TOKEN present (${where}); ${why}, so it is unknown whether it overrides one${hint}`,
      };
    }
    if (input.isolatedAccountCount === 0) {
      return {
        level: "info",
        message: `ambient CLAUDE_CODE_OAUTH_TOKEN present (${where}) — no isolated accounts on this node, so it cannot override one${hint}`,
      };
    }
    const remedies: string[] = [];
    if (daemonEnv.kind === "holds") {
      remedies.push(
        "the daemon kept it because the account store could not seed the primary account (see the daemon journal: 'Env-token account seed skipped' / 'Env-token fallback retained') — fix that cause, then restart the daemon"
      );
    }
    if (input.tmuxTableHasToken === true) {
      remedies.push(
        "a tmux server started before the fix still carries it in its global table — it is scrubbed on the next window creation"
      );
    }
    return {
      level: "warn",
      message: `ambient CLAUDE_CODE_OAUTH_TOKEN present (${where}) while ${input.isolatedAccountCount} isolated account(s) exist — ${remedies.join("; ")} (#3731)${hint}`,
    };
  }

  const unknowns: string[] = [];
  if (daemonEnv.kind === "unknown") unknowns.push(daemonEnv.detail);
  if (input.tmuxTableHasToken === null) unknowns.push(tableUnreadable);
  if (unknowns.length > 0 || daemonEnv.kind !== "clean") {
    return {
      level: "unknown",
      message: `could not verify — ${unknowns.join("; ")}; not reported as clean${hint}`,
    };
  }

  const tablePart =
    input.tmuxTableCleanNote ?? "the tmux global table is clean";
  return {
    level: "ok",
    message: `no ambient CLAUDE_CODE_OAUTH_TOKEN — ${daemonEnv.detail}; ${tablePart}${hint}`,
  };
}

/**
 * Issue #4153 (A5): a warn line when the daemon's last heartbeat is older than
 * {@link HEARTBEAT_STALE_MS} — its maintenance loop may be stuck, so its record
 * may be stale. `null` (print nothing) when fresh or not recorded. The bound
 * assumes the default 60 s tick; doctor cannot read the daemon's
 * `HAPI_DAEMON_HEARTBEAT_INTERVAL`, so a longer custom interval over-warns.
 */
export function classifyHeartbeatAge(
  lastHeartbeatAt: unknown,
  now: number
): AmbientTokenCheck | null {
  if (!isEpochMs(lastHeartbeatAt)) return null;
  const ageMs = now - lastHeartbeatAt;
  if (ageMs <= HEARTBEAT_STALE_MS) return null;
  return {
    level: "warn",
    message: `the daemon's last heartbeat was ${Math.round(ageMs / 1000)} s ago (over ${HEARTBEAT_STALE_MS / 1000} s, 3× the default 60 s tick) — its maintenance loop may be stuck, so its state record may be stale (#4153)`,
  };
}

/**
 * Count the isolated per-account config dirs (`<accountConfigsDir>/<uuid>/`).
 * `0` when the directory does not exist; `null` on any other read error
 * (permission, I/O) — an unreadable directory is UNKNOWN, not "no accounts".
 * #4153 (A2): `dir` is required — doctor passes the DAEMON's recorded directory,
 * never its own `configuration.accountConfigsDir`.
 */
export function countIsolatedAccountDirs(dir: string): number | null {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter(
      entry => entry.isDirectory() && UUID_REGEX.test(entry.name)
    ).length;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? 0 : null;
  }
}

/** Where doctor reads the daemon's tmux global table (#4153 A1). */
export type TmuxSocketTarget = { socketPath: string } | { socketName: string };

/** Injectable readers for {@link checkAmbientOnboardingToken} (tests stub them). */
export interface AmbientTokenReaders {
  readEnviron(pid: number): Promise<string>;
  readTable(target: TmuxSocketTarget): Promise<GlobalEnvRead>;
  countIsolated(dir: string): number | null;
}

const defaultAmbientTokenReaders: AmbientTokenReaders = {
  readEnviron: pid => readFile(`/proc/${pid}/environ`, "utf-8"),
  readTable: target =>
    new TmuxManager({
      sessionName: "socketName" in target ? target.socketName : "hapi-doctor",
      ...target,
    }).readGlobalEnvVarNamesDetailed(),
  countIsolated: dir => countIsolatedAccountDirs(dir),
};

/**
 * The daemon-state fields the ambient-token check reads, each typed `unknown`
 * (#4153 B3): `readDaemonState` is an unchecked cast, so every field is
 * validated here before use — the parse calls cannot be "simplified" away.
 */
export type AmbientTokenRecord = { pid: number } & Partial<
  Record<
    | "tmuxSessionName"
    | "tmuxSocketPath"
    | "accountConfigsDir"
    | "ambientOnboardingToken"
    | "pendingSince",
    unknown
  >
>;

export interface AmbientTokenCheckOptions {
  /** The daemon's own count of active windows on its socket (`/effective-count`);
   *  `null` when unreachable. The cross-check for a "no server" read (#4153 A1). */
  activeTmuxWindows: number | null;
  now?: number;
  readers?: AmbientTokenReaders;
}

/** An epoch-ms timestamp read back from the state file. */
function isEpochMs(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * #4153 (A1/A2): an absolute path with no control characters — the `-S` twin of
 * {@link isPlainSocketName}, checked before a recorded path reaches tmux argv or
 * the filesystem. The state file is 0600 and daemon-owned, so this is hygiene,
 * not a trust boundary.
 */
function isAbsolutePlainPath(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("/")) return false;
  if (value.length > 4096) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

interface TableVerdict {
  hasToken: boolean | null;
  unknownReason: string | null;
  cleanNote: string | null;
}

/**
 * Read the daemon's tmux global table on the daemon's RECORDED socket path
 * (`-S`), else its socket name (`-L`: the record's, else the launch env's).
 * A "no server" answer counts as clean only on the recorded path AND when the
 * daemon's own window count confirms it: the same path can be unreachable from a
 * doctor with a different mount or `/tmp` view, or after the socket file was
 * removed under a live server (#4153 A1).
 */
async function readDaemonTable(
  state: AmbientTokenRecord,
  environSocket: string | null,
  activeTmuxWindows: number | null,
  readers: AmbientTokenReaders
): Promise<TableVerdict> {
  const unknown = (reason: string): TableVerdict => ({
    hasToken: null,
    unknownReason: reason,
    cleanNote: null,
  });
  const socketPath = isAbsolutePlainPath(state.tmuxSocketPath)
    ? state.tmuxSocketPath
    : null;
  const socketName = isPlainSocketName(state.tmuxSessionName)
    ? state.tmuxSessionName
    : environSocket;
  const target: TmuxSocketTarget | null =
    socketPath !== null
      ? { socketPath }
      : socketName !== null
        ? { socketName }
        : null;
  if (target === null) {
    return unknown("the daemon's tmux socket could not be resolved");
  }
  let read: GlobalEnvRead;
  try {
    read = await readers.readTable(target);
  } catch (error) {
    return unknown(describeTmuxFailure(error));
  }
  if ("names" in read) {
    return {
      hasToken: read.names.has("CLAUDE_CODE_OAUTH_TOKEN"),
      unknownReason: null,
      cleanNote: null,
    };
  }
  if (!read.noServer) return unknown(read.error);
  if (socketPath === null) {
    return unknown(
      `no tmux server answered on socket "${socketName}", and the daemon recorded no socket path, so that name may resolve to a different directory than the daemon's`
    );
  }
  if (activeTmuxWindows === 0) {
    return {
      hasToken: false,
      unknownReason: null,
      cleanNote: `no tmux server is running on the daemon's socket ${socketPath} (the daemon reports 0 active windows)`,
    };
  }
  return unknown(
    activeTmuxWindows === null
      ? `no tmux server answered at ${socketPath}, and the daemon's capacity probe was unreachable to confirm it`
      : `socket path ${socketPath} unreachable while the daemon reports ${activeTmuxWindows} active tmux window(s)`
  );
}

/** Count the isolated accounts in the daemon's RECORDED directory (#4153 A2). */
function countDaemonAccounts(
  state: AmbientTokenRecord,
  readers: AmbientTokenReaders
): { count: number | null; unknownReason: string | null } {
  const dir = state.accountConfigsDir;
  if (!isAbsolutePlainPath(dir)) {
    return {
      count: null,
      unknownReason:
        "the daemon did not record its account-configs directory (it predates #4153), so its isolated accounts could not be counted",
    };
  }
  let count: number | null;
  try {
    count = readers.countIsolated(dir);
  } catch {
    count = null;
  }
  return count === null
    ? {
        count,
        unknownReason: `the daemon's account-configs directory ${dir} could not be read`,
      }
    : { count, unknownReason: null };
}

/**
 * Gather the #3731 ambient-token inputs for the running daemon and classify them.
 * Every daemon-side input comes from the daemon's OWN record in its state file,
 * never doctor's environment (#4153): the token disposition, the tmux socket
 * PATH it recorded (`-S`; a pre-#4153 record falls back to its socket name, then
 * its launch-env `HAPI_TMUX_SESSION_NAME`), and its account-configs directory.
 * `/proc/<pid>/environ` is still read, for the launch hint and that socket-name
 * fallback only. Anything unreachable is unknown. No value is ever returned.
 */
export async function checkAmbientOnboardingToken(
  state: AmbientTokenRecord,
  options: AmbientTokenCheckOptions
): Promise<AmbientTokenCheck> {
  const readers = options.readers ?? defaultAmbientTokenReaders;
  const now = options.now ?? Date.now();
  let startedWithToken: boolean | null = null;
  let environSocket: string | null = null;
  try {
    const environ = await readers.readEnviron(state.pid);
    startedWithToken = parseEnvironNames(environ).has(
      "CLAUDE_CODE_OAUTH_TOKEN"
    );
    environSocket = readTmuxSessionNameFromEnviron(environ);
  } catch {
    // unreadable launch env → the hint and the socket fallback stay unknown
  }

  const table = await readDaemonTable(
    state,
    environSocket,
    options.activeTmuxWindows,
    readers
  );
  const accounts = countDaemonAccounts(state, readers);
  return classifyAmbientOnboardingToken({
    daemonTokenState: parseAmbientOnboardingTokenState(
      state.ambientOnboardingToken
    ),
    startedWithToken,
    tmuxTableHasToken: table.hasToken,
    tmuxTableUnknownReason: table.unknownReason,
    tmuxTableCleanNote: table.cleanNote,
    isolatedAccountCount: accounts.count,
    isolatedAccountsUnknownReason: accounts.unknownReason,
    pendingForMs: isEpochMs(state.pendingSince)
      ? now - state.pendingSince
      : null,
  });
}

/** Issue #4155: printed in place of every non-public value in doctor output. */
export const REDACTED_VALUE = "<redacted>";

/**
 * Issue #4155 (R1/R13): allowlist view of a JSON record for `hapi doctor` /
 * `hapi daemon status`. A key prints verbatim only when `classes[key]` is
 * `"public"`; every other key — secret, or unknown to this binary (a newer
 * daemon's field, a server-written settings key) — prints as "<redacted>". The
 * key is kept: its presence is diagnostic. `Object.hasOwn` keeps inherited names
 * (`constructor`, `toString`) from counting as public, and `Object.fromEntries`
 * keeps a hostile `__proto__` key a plain property. Pure + exported for a test.
 */
export function redactForDisplay(
  record: unknown,
  classes: Readonly<Record<string, "public" | "secret">>
): Record<string, unknown> {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      Object.hasOwn(classes, key) && classes[key] === "public"
        ? value
        : REDACTED_VALUE,
    ])
  );
}

/**
 * Run doctor command specifically for daemon diagnostics
 */
export async function runDoctorDaemon(): Promise<void> {
  return runDoctorCommand("daemon");
}

export async function runDoctorCommand(
  filter?: "all" | "daemon"
): Promise<void> {
  // Default to 'all' if no filter specified
  if (!filter) {
    filter = "all";
  }

  console.log(chalk.bold.cyan("\n🩺 hapi CLI Doctor\n"));

  // For 'all' filter, show everything. For 'daemon', only show daemon-related info
  if (filter === "all") {
    // Version and basic info
    console.log(chalk.bold("📋 Basic Information"));
    // #4594: the build's real version, never cli/package.json's frozen 0.6.0.
    console.log(
      `hapi CLI Version: ${chalk.green(CLI_VERSION)} (built ${CLI_VERSION_TIMESTAMP})`
    );
    console.log(`Platform: ${chalk.green(process.platform)} ${process.arch}`);
    console.log(`Node.js Version: ${chalk.green(process.version)}`);
    console.log("");

    // Daemon spawn diagnostics
    console.log(chalk.bold("🔧 Daemon Spawn Diagnostics"));
    const projectRoot = projectPath();
    const cliEntrypoint = join(projectRoot, "src", "index.ts");

    if (isBunCompiled()) {
      console.log(`Executable: ${chalk.blue(process.execPath)}`);
      console.log(`Runtime Assets: ${chalk.blue(runtimePath())}`);
    } else {
      console.log(`Project Root: ${chalk.blue(projectRoot)}`);
      console.log(`CLI Entrypoint: ${chalk.blue(cliEntrypoint)}`);
      console.log(
        `CLI Exists: ${existsSync(cliEntrypoint) ? chalk.green("✓ Yes") : chalk.red("❌ No")}`
      );
    }
    console.log("");

    // Configuration
    console.log(chalk.bold("⚙️  Configuration"));
    console.log(`hapi Home: ${chalk.blue(configuration.happyHomeDir)}`);
    console.log(`Bot URL: ${chalk.blue(configuration.serverUrl)}`);
    console.log(`Logs Dir: ${chalk.blue(configuration.logsDir)}`);

    // Environment
    console.log(chalk.bold("\n🌍 Environment Variables"));
    const env = getEnvironmentInfo();
    console.log(
      `HAPI_HOME: ${env.HAPI_HOME ? chalk.green(env.HAPI_HOME) : chalk.gray("not set")}`
    );
    console.log(
      `HAPI_SERVER_URL: ${env.HAPI_SERVER_URL ? chalk.green(env.HAPI_SERVER_URL) : chalk.gray("not set")}`
    );
    console.log(
      `CLI_API_TOKEN: ${env.CLI_API_TOKEN_SET ? chalk.green("set") : chalk.gray("not set")}`
    );
    console.log(
      `DEBUG: ${env.DEBUG ? chalk.green(env.DEBUG) : chalk.gray("not set")}`
    );
    console.log(
      `NODE_ENV: ${env.NODE_ENV ? chalk.green(env.NODE_ENV) : chalk.gray("not set")}`
    );

    // Settings
    let settings;
    try {
      settings = await readSettings();
      console.log(chalk.bold("\n📄 Settings (settings.json):"));
      // Issue #4155 (R13) + #1733 (R10): allowlist, not a denylist. The old spread
      // masked only cliApiToken/openRouterApiKey and printed everything else —
      // including apiKeys[].key and the server-written federation.apiToken,
      // vapidKeys.privateKey and porterAgeKeys.identity the CLI never declares.
      console.log(
        chalk.gray(
          JSON.stringify(redactForDisplay(settings, SETTINGS_DISPLAY), null, 2)
        )
      );
    } catch (error) {
      console.log(chalk.bold("\n📄 Settings:"));
      console.log(chalk.red("❌ Failed to read settings"));
      logger.reportCaught(error, {
        category: "doctor-read-settings",
        severity: "warn",
      });
      settings = {};
    }

    // Authentication status (direct-connect)
    console.log(chalk.bold("\n🔐 Direct Connect Auth"));
    const envToken = process.env.CLI_API_TOKEN;
    const settingsToken = settings.cliApiToken;
    const hasToken = Boolean(envToken || settingsToken);
    const tokenSource = envToken
      ? "environment variable"
      : settingsToken
        ? "settings file"
        : "none";
    if (hasToken) {
      console.log(chalk.green(`✓ CLI_API_TOKEN is set (from ${tokenSource})`));
    } else {
      console.log(chalk.red("❌ CLI_API_TOKEN is not set"));
      console.log(
        chalk.gray(
          "  Run `hapi auth login` to configure or set CLI_API_TOKEN env var"
        )
      );
    }
  }

  // Daemon status - shown for both 'all' and 'daemon' filters
  console.log(chalk.bold("\n🤖 Daemon Status"));
  try {
    // Issue #4155 (R12): a READ-ONLY probe. Doctor is catalogued riskTier
    // "readonly" (commands/apiCatalog.entries.ts); the old
    // checkIfDaemonRunningAndCleanupStaleState() deleted a stale state file (and
    // could delete a live daemon's lock). A dead-pid record is now reported as
    // stale below, never deleted — daemon start still cleans stale state.
    const state = await readDaemonState();
    const isRunning =
      state !== null &&
      typeof state.pid === "number" &&
      isProcessAlive(state.pid);

    if (isRunning && state) {
      console.log(chalk.green("✓ Daemon is running"));
      console.log(`  PID: ${state.pid}`);
      console.log(`  Started: ${new Date(state.startTime).toLocaleString()}`);
      console.log(`  CLI Version: ${state.startedWithCliVersion}`);
      // #4594 (D-4594-1 A): a build difference is reported here, never acted on.
      // Judged from the record read above, so this probe stays read-only (R12).
      const buildSkew = describeDaemonBuildSkew(state.startedWithCliVersion);
      if (buildSkew) {
        console.log(chalk.yellow(`  ⚠️  Build skew: ${buildSkew}`));
      }
      if (state.httpPort) {
        console.log(`  HTTP Port: ${state.httpPort}`);
      }
      // Authoritative spawn-capacity (issue #1477): the daemon's effectiveCount —
      // the SAME number the spawn gate uses to accept/reject spawns. daemonPost
      // returns { error } when the daemon is unreachable, so guard on the numeric
      // shape before printing.
      const cap = await getDaemonEffectiveCount();
      if (
        typeof cap.effectiveCount === "number" &&
        typeof cap.max === "number"
      ) {
        const headroom = cap.max - cap.effectiveCount;
        console.log(
          `  Capacity: ${cap.effectiveCount}/${cap.max} live sessions (${headroom} slot${headroom === 1 ? "" : "s"} free)`
        );
        console.log(
          `    tracked PIDs: ${cap.trackedPids}, active tmux windows: ${cap.activeTmuxWindows}`
        );
      }
      // Issue #3731 (R6): ambient onboarding-token check — PRESENCE only, the
      // value is never read into output. Judged from the daemon's own record,
      // not its launch-time /proc environ (see checkAmbientOnboardingToken);
      // the daemon's window count confirms a "no server" read (#4153 A1).
      const now = Date.now();
      const tokenCheck = await checkAmbientOnboardingToken(state, {
        activeTmuxWindows:
          typeof cap.activeTmuxWindows === "number"
            ? cap.activeTmuxWindows
            : null,
        now,
      });
      const icon = {
        ok: chalk.green("✓"),
        info: chalk.blue("ℹ"),
        warn: chalk.yellow("⚠️"),
        unknown: chalk.gray("?"),
      };
      console.log(
        `  Ambient token: ${icon[tokenCheck.level]} ${tokenCheck.message}`
      );
      // Issue #4153 (A5): a stale heartbeat makes every recorded field suspect.
      const heartbeat = classifyHeartbeatAge(state.lastHeartbeatAt, now);
      if (heartbeat) {
        console.log(
          `  Heartbeat: ${icon[heartbeat.level]} ${heartbeat.message}`
        );
      }
    } else if (state && !isRunning) {
      console.log(
        chalk.yellow("⚠️  Daemon state exists but process not running (stale)")
      );
    } else {
      console.log(chalk.red("❌ Daemon is not running"));
    }

    // Show daemon state file
    if (state) {
      console.log(chalk.bold("\n📄 Daemon State:"));
      console.log(chalk.blue(`Location: ${configuration.daemonStateFile}`));
      // Issue #4155 (R1): allowlist — the controlToken (and any field this binary
      // does not know) prints as "<redacted>".
      console.log(
        chalk.gray(
          JSON.stringify(redactForDisplay(state, DAEMON_STATE_DISPLAY), null, 2)
        )
      );
    }

    // All hapi processes
    const allProcesses = await findAllHappyProcesses();
    if (allProcesses.length > 0) {
      console.log(chalk.bold("\n🔍 All hapi CLI Processes"));

      // Group by type
      const grouped = allProcesses.reduce(
        (groups, process) => {
          if (!groups[process.type]) groups[process.type] = [];
          groups[process.type].push(process);
          return groups;
        },
        {} as Record<string, typeof allProcesses>
      );

      // Display each group
      Object.entries(grouped).forEach(([type, processes]) => {
        const typeLabels: Record<string, string> = {
          current: "📍 Current Process",
          daemon: "🤖 Daemon",
          "daemon-version-check": "🔍 Daemon Version Check (stuck)",
          "daemon-spawned-session": "🔗 Daemon-Spawned Sessions",
          "user-session": "👤 User Sessions",
          "dev-daemon": "🛠️  Dev Daemon",
          "dev-daemon-version-check": "🛠️  Dev Daemon Version Check (stuck)",
          "dev-session": "🛠️  Dev Sessions",
          "dev-doctor": "🛠️  Dev Doctor",
          "dev-related": "🛠️  Dev Related",
          doctor: "🩺 Doctor",
          unknown: "❓ Unknown",
        };

        console.log(chalk.blue(`\n${typeLabels[type] || type}:`));
        processes.forEach(({ pid, command }) => {
          const color =
            type === "current"
              ? chalk.green
              : type.startsWith("dev")
                ? chalk.cyan
                : type.includes("daemon")
                  ? chalk.blue
                  : chalk.gray;
          console.log(`  ${color(`PID ${pid}`)}: ${chalk.gray(command)}`);
        });
      });
    } else {
      console.log(chalk.red("❌ No hapi processes found"));
    }

    if (filter === "all" && allProcesses.length > 1) {
      // More than just current process
      console.log(chalk.bold("\n💡 Process Management"));
      console.log(
        chalk.gray("To clean up runaway processes: hapi doctor clean")
      );
    }
  } catch (error) {
    console.log(chalk.red("❌ Error checking daemon status"));
    logger.reportCaught(error, {
      category: "doctor-daemon-status",
      severity: "warn",
    });
  }

  // Log files - only show for 'all' filter
  if (filter === "all") {
    console.log(chalk.bold("\n📝 Log Files"));

    // Get ALL log files
    const allLogs = getLogFiles(configuration.logsDir);

    if (allLogs.length > 0) {
      // Separate daemon and regular logs
      const daemonLogs = allLogs.filter(({ file }) => file.includes("daemon"));
      const regularLogs = allLogs.filter(
        ({ file }) => !file.includes("daemon")
      );

      // Show regular logs (max 10)
      if (regularLogs.length > 0) {
        console.log(chalk.blue("\nRecent Logs:"));
        const logsToShow = regularLogs.slice(0, 10);
        logsToShow.forEach(({ file, path, modified }) => {
          console.log(`  ${chalk.green(file)} - ${modified.toLocaleString()}`);
          console.log(chalk.gray(`    ${path}`));
        });
        if (regularLogs.length > 10) {
          console.log(
            chalk.gray(`  ... and ${regularLogs.length - 10} more log files`)
          );
        }
      }

      // Show daemon logs (max 5)
      if (daemonLogs.length > 0) {
        console.log(chalk.blue("\nDaemon Logs:"));
        const daemonLogsToShow = daemonLogs.slice(0, 5);
        daemonLogsToShow.forEach(({ file, path, modified }) => {
          console.log(`  ${chalk.green(file)} - ${modified.toLocaleString()}`);
          console.log(chalk.gray(`    ${path}`));
        });
        if (daemonLogs.length > 5) {
          console.log(
            chalk.gray(
              `  ... and ${daemonLogs.length - 5} more daemon log files`
            )
          );
        }
      } else {
        console.log(chalk.yellow("\nNo daemon log files found"));
      }
    } else {
      console.log(chalk.yellow("No log files found"));
    }

    // Support and bug reports
    console.log(chalk.bold("\n🐛 Support & Bug Reports"));
    const pkg = packageJson as unknown as {
      bugs?: string | { url?: string };
      homepage?: string;
    };
    const bugsUrl = typeof pkg.bugs === "string" ? pkg.bugs : pkg.bugs?.url;
    if (bugsUrl) {
      console.log(`Report issues: ${chalk.blue(bugsUrl)}`);
    }
    console.log(
      `Documentation: ${chalk.blue(pkg.homepage ?? "See project README")}`
    );
  }

  console.log(chalk.green("\n✅ Doctor diagnosis complete!\n"));
}
