// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines -- Grandfathered god-file (Epic 0, #2077); decomposition verdict tracked in claudedocs/architecture-hotspot-review.md. */
/**
 * TmuxManager
 *
 * Manages tmux sessions and windows for persistent Claude sessions.
 * Provides an interface for creating, querying, and controlling tmux windows.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { logger } from "@/ui/logger";
import { configuration } from "@/configuration";
import { describeErrorKind } from "@/persistence";
import {
  API_KEY_HELPER_OUTRANKING_ENV_VARS,
  BINDING_ENV_VARS,
  SDK_SIGNAL_ENV_VARS,
} from "@/claude/launcherShared";
import { SECRET_ENV_VARS } from "@/sandbox/secretEnvVars";
import { shellEscape } from "@/utils/shellEscape";
import type { OwnedWindowTarget } from "./windowOwnership";
import {
  ensureTmuxServerContained,
  startTmuxServerInSlice,
  type ContainmentOutcome,
} from "./sessionSlice";
import {
  TMUX_REMOTE_WINDOW_PREFIX,
  TMUX_IDENTITY_USER_OPTION,
  TMUX_ARCHIVE_USER_OPTION,
} from "./types";
import type {
  TmuxWindow,
  TmuxSession,
  TmuxManagerOptions,
  CreateWindowOptions,
  CreateWindowResult,
  SendKeysOptions,
  OrphanedSession,
} from "./types";

/**
 * Issue #2646 (OmniBox Phase-1, Path 3): the credential set the long-lived tmux
 * server must NOT freeze into its global env table (the `tmux show-environment`
 * read path). The union of {@link BINDING_ENV_VARS} (CLAUDE_CODE_OAUTH_TOKEN,
 * CLAUDE_CONFIG_DIR, HAPI_ACCOUNT_UUID, HAPI_API_KEY_ID, HAPI_API_KEY_MASKED) and
 * {@link SECRET_ENV_VARS} (CLI_API_TOKEN
 * and the other daemon-only secrets). Derived from the canonical sets, never
 * hardcoded. `GH_TOKEN` is now IN the strip via SECRET_ENV_VARS membership —
 * #2672 (D999-10, branch A) RETIRED the former D4 pass-through: agents must not
 * hold GitHub auth at all (onboarding no longer plants a PAT; re-delivery is the
 * gateway-side broker follow-up tracked on #2672). This whole set is applied
 * ONLY when the sandbox gate is ON (caller-gated at the `runTmux` /
 * `scrubServerGlobalEnv` sites). With the gate OFF the tmux seed env is unchanged,
 * but `scrubServerGlobalEnv` still scrubs the `BINDING_ENV_VARS` subset from the
 * global table (#3731 R3) — the only gate-OFF difference from pre-#2646.
 */
let _omniboxServerEnvStrip: ReadonlySet<string> | undefined;
export function omniboxServerEnvStrip(): ReadonlySet<string> {
  // Lazy + memoized: building this union at MODULE-INIT time would spread
  // BINDING_ENV_VARS before `launcherShared` finished initializing it under the
  // TmuxManager ↔ launcherShared import cycle (BINDING_ENV_VARS `undefined` →
  // "not iterable"). Deferring to first call — after all modules load — is the
  // same reason `buildTmuxSpawnEnv` only references these sets inside function
  // bodies. Callers are runtime-only (`runTmux` / `scrubServerGlobalEnv`).
  return (_omniboxServerEnvStrip ??= new Set<string>([
    ...BINDING_ENV_VARS,
    ...SECRET_ENV_VARS,
  ]));
}

/**
 * Build the environment for a spawned `tmux` subprocess, stripping every
 * {@link SDK_SIGNAL_ENV_VARS} member from the ambient `process.env` copy BEFORE
 * layering the per-instance `instanceEnv` overrides (issue #1692, Task 2 —
 * prevention layer).
 *
 * Why: {@link TmuxManager.runTmux} spawns EVERY tmux command with this env. The
 * FIRST tmux command to create the shared `hapimatic-remote` server freezes the
 * spawning process's environment into the tmux server process AND its global
 * environment table — and every pane spawned on that socket thereafter inherits
 * it. The Hapimatic launcher process can self-poison its own `process.env` (e.g.
 * `extractSDKMetadataAsync` → `query()` sets `CLAUDE_CODE_ENTRYPOINT=sdk-ts`), so
 * an un-scrubbed spawn would SEED a fresh server with a billing signal. Stripping
 * the signal vars here ensures Hapimatic never seeds a contaminated server.
 *
 * NOT sufficient ALONE for an ALREADY-contaminated shared server (its frozen
 * global table persists across this process) — that is why the per-pane `unset`
 * in `buildTmuxEnvFileCommand` is the load-bearing fix (Task 1) and the
 * `set-environment -gr` global-table scrub (Task 3) remediates a live table.
 *
 * Pure + exported for unit testing (mirrors the `buildLauncherEnv` /
 * `buildTmuxEnvFileCommand` extraction pattern — no mocking, per cli/CLAUDE.md).
 * Derived from the canonical {@link SDK_SIGNAL_ENV_VARS} set, never hardcoded.
 * `undefined` ambient values are dropped (matches `buildLauncherEnv`).
 *
 * Issue #4884: {@link API_KEY_HELPER_OUTRANKING_ENV_VARS} (`ANTHROPIC_AUTH_TOKEN`,
 * `ANTHROPIC_API_KEY`) is also stripped, ungated, so a daemon whose own env carries
 * one never seeds a server that hands it to every pane — parity with how
 * `ANTHROPIC_API_KEY` was already kept out as an SDK signal var.
 */
export function buildTmuxSpawnEnv(
  processEnv: NodeJS.ProcessEnv,
  instanceEnv: Record<string, string>,
  credentialStrip?: ReadonlySet<string>
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(processEnv)) {
    if (value === undefined) continue;
    if (SDK_SIGNAL_ENV_VARS.has(key)) continue;
    // #4884: an env credential that outranks the session's subscription login.
    if (API_KEY_HELPER_OUTRANKING_ENV_VARS.has(key)) continue;
    // #2646 (OmniBox Phase-1, Path 3 — caller-gated): also strip the credential
    // set ({@link omniboxServerEnvStrip}) from the ambient copy so the
    // long-lived tmux server never freezes it into its global env table. Ambient
    // only (matching the SDK strip — the daemon's `this.env` is empty); per-session
    // creds still reach agents via the 0600 env file. `undefined` (gate OFF) is a
    // no-op ⇒ byte-identical to pre-#2646 (R6).
    if (credentialStrip?.has(key)) continue;
    env[key] = value;
  }
  // Per-instance overrides win over the ambient copy (verbatim precedence of
  // the prior `{ ...process.env, ...this.env }` spread). `this.env` is the
  // instance's own override map and never carries SDK signal vars.
  for (const [key, value] of Object.entries(instanceEnv)) {
    env[key] = value;
  }
  return env;
}

/**
 * The variable names `scrubServerGlobalEnv` removes from a socket's tmux GLOBAL
 * environment table. Pure + exported for unit testing (issue #4884), like
 * {@link buildTmuxSpawnEnv}; it references the imported sets only inside its body
 * because of the TmuxManager ↔ launcherShared import cycle.
 *
 * - sandbox ON: {@link SDK_SIGNAL_ENV_VARS} ∪ {@link omniboxServerEnvStrip} (#2646)
 * - sandbox OFF: {@link SDK_SIGNAL_ENV_VARS} ∪ {@link BINDING_ENV_VARS} (#3731 R3)
 * - both: ∪ {@link API_KEY_HELPER_OUTRANKING_ENV_VARS} (#4884) — an
 *   `ANTHROPIC_AUTH_TOKEN` frozen into the table outranks every pane's
 *   subscription credential, exactly like the `ANTHROPIC_API_KEY` already
 *   scrubbed as an SDK signal var.
 */
export function buildServerGlobalScrubSet(sandboxOn: boolean): Set<string> {
  return new Set<string>([
    ...SDK_SIGNAL_ENV_VARS,
    ...(sandboxOn ? omniboxServerEnvStrip() : BINDING_ENV_VARS),
    ...API_KEY_HELPER_OUTRANKING_ENV_VARS,
  ]);
}

/**
 * Issue #3734: parse the two-token output of
 * `new-window -P -F '#{window_index} #{window_id}'` → `{ index, id }`.
 *
 * tmux emits `<index> <id>` on one line (e.g. `2 @1`). Both tokens are
 * space-free (a non-negative integer and `@<digits>`), so a plain space is the
 * safe delimiter — unlike the `\x1f` separator `listWindows()` uses, which tmux
 * 3.4+ vis-escapes to the literal `\037` (the #1841 trap). Defensive: an
 * unparseable index → null (callers fall back to name lookup, #1315), an id not
 * matching `/^@\d+$/` → null (callers fall back to the identity query then the
 * name, #3734). Pure + exported for a CI unit test.
 */
export function parseCreateWindowOutput(output: string): {
  index: number | null;
  id: string | null;
} {
  const [indexTok, idTok] = output.trim().split(/\s+/);
  const parsedIndex = parseInt(indexTok ?? "", 10);
  const index = isNaN(parsedIndex) ? null : parsedIndex;
  const id = idTok && /^@\d+$/.test(idTok) ? idTok : null;
  return { index, id };
}

/**
 * Issue #3732 (ruling D1, Option C′): parse the dedicated identity query
 * `list-windows -F '#{window_index} #{window_id} #{@hapi_identity}'` — one row
 * per window, three SPACE-separated tokens. All three are space-free by
 * construction: the index is an integer, `#{window_id}` is `@N`, and
 * `@hapi_identity` is a session TAG (`hapi-<ms>-<base36>`, `shared/src/sessionId.ts`).
 * A window with no identity renders `1 @0 ` (empty third token → `identity:
 * undefined`). This query NEVER touches the `\x1f`-delimited 8-column
 * `listWindows()` parser (so #1841's fix and #2245's field-7 contract are
 * untouched) and pays no `windowExists` retry budget. Pure + exported for a CI
 * unit test. Rows with an unparseable index are dropped (defensive, mirrors the
 * #1609 filter in `listWindows()`).
 */
export function parseWindowIdentityOutput(
  output: string
): Array<{ index: number; id?: string; identity?: string }> {
  return output
    .trim()
    .split("\n")
    .filter(line => line.trim())
    .map(line => {
      // Split on the FIRST two spaces only — identity is space-free, but a
      // defensive slice-join keeps a hypothetical space in the (never-observed)
      // identity from truncating the row. index/id are always the first two.
      const parts = line.split(" ");
      const index = parseInt(parts[0] ?? "", 10);
      const idTok = parts[1];
      const identityTok = parts.slice(2).join(" ");
      return {
        index,
        id: idTok && /^@\d+$/.test(idTok) ? idTok : undefined,
        identity: identityTok ? identityTok : undefined,
      };
    })
    .filter(row => !isNaN(row.index));
}

/**
 * Issue #4218: parse `list-windows -F '#{window_id} #{@hapi_identity}
 * #{window_name}'` output. NAME is LAST because a name may contain spaces; it is
 * the rejoined remainder. Splits on SINGLE spaces, never a whitespace run: a
 * window with no identity renders `@1  another` (a double space — premise P4 of
 * the #4218 directive, tmux 3.3a), and a `/\s+/` split would shift the name into
 * the identity slot. Rows whose first token is not an `@N` id are dropped.
 * Pure + exported for a CI unit test.
 */
export function parseWindowsWithIdentityOutput(
  output: string
): Array<{ id: string; identity: string | null; name: string }> {
  const rows: Array<{ id: string; identity: string | null; name: string }> = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split(" ");
    const id = parts[0] ?? "";
    if (!/^@\d+$/.test(id)) continue;
    const identity = parts[1] ?? "";
    rows.push({
      id,
      identity: identity ? identity : null,
      name: parts.slice(2).join(" "),
    });
  }
  return rows;
}

/**
 * The field separator in `listWindows()`'s `list-windows -F` row: the ASCII
 * Unit Separator (0x1f) instead of `|`, because a window name may contain `|`.
 */
export const LIST_WINDOWS_SEP = "\x1f";

/**
 * Issue #1841: parse `listWindows()`'s 8-field `list-windows -F` output —
 * index, name, active, panes, pane_dead, pane_pid, `@hapi_archive`, and
 * `pane_start_command` LAST (free text; any separator-split remainder is
 * rejoined, #2683).
 *
 * tmux 3.3a prints the 0x1f separator as a raw byte. tmux 3.4+ vis-escapes
 * control bytes below 0x20 in `-F` output, so the same row arrives with the
 * literal four characters `\037` between fields: a plain `split("\x1f")` saw
 * one field per line and every row was dropped, so `listWindows()` returned
 * `[]` on every tmux-3.4 host. Option C′: a line that carries the raw byte is
 * split as is (3.3a output parses byte-identically), and only a line without
 * it has `\037` decoded back to the separator. tmux 3.4+ does not double a
 * literal backslash, so a window name holding the literal text `\037` is
 * split there — an accepted edge.
 *
 * Rows that still do not parse (no separator → undefined name / NaN index)
 * are dropped (#1609). Pure + exported for a CI unit test.
 */
export function parseWindowListOutput(output: string): TmuxWindow[] {
  return parseWindowListOutputDetailed(output).windows;
}

/**
 * Issue #5202 (U1): {@link parseWindowListOutput} plus the raw rows it
 * dropped. A dropped row is invisible to every non-strict caller (they get a
 * short list), which is the signature that hid the tmux 3.4+ `\037` bug across
 * #1315, #1609 and #1628 — so {@link TmuxManager.listWindows} logs the count.
 */
export function parseWindowListOutputDetailed(output: string): {
  windows: TmuxWindow[];
  dropped: string[];
} {
  const SEP = LIST_WINDOWS_SEP;
  const windows: TmuxWindow[] = [];
  const dropped: string[] = [];
  for (const line of output.trim().split("\n")) {
    if (!line.trim()) continue;
    const normalized = line.includes(SEP) ? line : line.replace(/\\037/g, SEP);
    const parts = normalized.split(SEP);
    const [index, name, active, panes, paneDead, panePidStr, archiveTag] =
      parts;
    const parsedPid = parseInt(panePidStr, 10);
    const window: TmuxWindow = {
      index: parseInt(index, 10),
      name,
      active: active === "1",
      paneCount: parseInt(panes, 10),
      paneDead: paneDead === "1",
      panePid: isNaN(parsedPid) ? undefined : parsedPid,
      // #2683: unset ("") on death-orphans, "1" on deliberate
      // archive-for-reconnect windows.
      archiveTag: archiveTag === "1",
      // #2683: pane_start_command is the final field; rejoin any
      // SEP-split remainder defensively.
      paneStartCommand: parts.slice(7).join(SEP) || undefined,
    };
    // #1609: drop rows that did not parse (missing separator → undefined
    // name / NaN index). On SL7 (tmux 3.4, daemon process context) a
    // malformed row crashed the #1600 remote-window reaper with
    // `undefined is not an object (window.name.startsWith)`, aborting the
    // whole reap and orphaning live claude processes. A dropped row only
    // degrades name-based lookup for that window — consumers holding the
    // captured index are unaffected.
    if (typeof window.name === "string" && !isNaN(window.index)) {
      windows.push(window);
    } else {
      dropped.push(line);
    }
  }
  return { windows, dropped };
}

/**
 * #5202 (U1) / #5614: at most one dropped-row warning per tmux socket per 60 s,
 * shared by every manager in this process on that socket.
 */
export const LIST_WINDOWS_DROP_WARN_INTERVAL_MS = 60_000;

/**
 * #5614: epoch ms of the last dropped-row warning, by socket. Module-level,
 * because the heartbeat (`healthScheduler.ts`) and the capacity paths
 * (`sessionTracker.ts`) build a new manager per call, so an instance field
 * never held the limit for them.
 */
const lastDropWarnAtBySocket = new Map<string, number>();

/** Test-only: forget when each socket last logged a dropped row. */
export function resetDroppedRowWarnLimitForTest(): void {
  lastDropWarnAtBySocket.clear();
}

/**
 * Issue #4218: parse the exact-name pane-pid probe
 * (`display-message -p '#{pane_pid} #{window_name}'`). The pid is space-free,
 * so it is the first token and the name is the rejoined remainder. Returns the
 * pid only when the echoed name EQUALS the requested one — tmux answers an
 * absent `=name` target with the ACTIVE window. Pure + exported for CI.
 */
export function parseExactNamePidProbe(
  output: string,
  expectedName: string
): number | null {
  const line = output.replace(/\r?\n$/, "");
  const space = line.indexOf(" ");
  if (space <= 0) return null;
  const pid = parseInt(line.slice(0, space), 10);
  if (isNaN(pid) || line.slice(space + 1) !== expectedName) return null;
  return pid;
}

/**
 * Issue #4218 (K1-ext): parse the `display-message -p '#{window_id}
 * #{@hapi_identity}'` echo read. tmux 3.3a reads an absent `@N` as an EMPTY
 * line (rc 0) and does not fall back to the current window (directive premise
 * P3); the echoed `#{window_id}` must still equal the expected id before the
 * identity is trusted — insurance against a version-dependent fallback (tmux
 * 3.4 is unverified). `expectedId` is null for a name/index target (resolved
 * by the caller), in which case any `@N` echo counts. Pure + exported for CI.
 */
export function parseWindowIdentityProbe(
  output: string,
  expectedId: string | null
): { exists: boolean; identity: string | null } {
  const line = output.replace(/\r?\n$/, "");
  const parts = line.split(" ");
  const id = parts[0] ?? "";
  const exists =
    /^@\d+$/.test(id) && (expectedId === null || id === expectedId);
  if (!exists) return { exists: false, identity: null };
  const identity = parts.slice(1).join(" ").trim();
  return { exists: true, identity: identity ? identity : null };
}

/**
 * Issue #3731 (Task 2c): parse `tmux show-environment -g` output into the SET of
 * variable NAMES currently present in the server's global environment table.
 *
 * `show-environment -g` prints one `NAME=value` line per set variable and a
 * `-NAME` line for a variable marked for removal (`set-environment -gr`; `-gu`
 * deletes the variable outright and prints no line) — a `-NAME` line is NOT a
 * present variable (a pane spawned afterwards does not inherit it), so it is
 * excluded. Values are discarded here and NEVER returned:
 * callers (the #3731 daemon warning, `hapi doctor`) only need presence, and the
 * table can hold a credential. Blank, malformed, or non-identifier lines are
 * ignored. Pure + exported for a CI unit test.
 */
export function parseTmuxGlobalEnvNames(output: string): Set<string> {
  const names = new Set<string>();
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("-")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const name = line.slice(0, eq);
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) names.add(name);
  }
  return names;
}

/**
 * Issue #3731 (F6): whether a tmux argv dumps environment VALUES. Such output can
 * hold a credential, so `runTmux` keeps it out of every log line and error
 * message. Matches the command and its `showenv` alias anywhere in the argv, not
 * only at `args[0]`, so a reordered or prefixed call is still covered.
 */
export function isEnvDumpCommand(args: readonly string[]): boolean {
  return args.some(arg => arg === "show-environment" || arg === "showenv");
}

/**
 * Issue #3731 (F3): whether a failed tmux call means "this socket has no server".
 * That is a definitive answer for a table read — no server, no global table, so
 * nothing is ambient — and is distinct from a real failure (permission, timeout,
 * missing binary), which must read as UNKNOWN, never as clean.
 */
export function isNoTmuxServerError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /no server running/i.test(message) ||
    /error connecting to .*\(No such file or directory\)/i.test(message)
  );
}

/**
 * Issue #4218: whether a failed tmux call means the server or the target
 * SESSION does not exist — a definitive "no windows", as opposed to a fault.
 * Measured on tmux 3.3a: no server → `error connecting to … (No such file or
 * directory)` ({@link isNoTmuxServerError}); a missing session → `can't find
 * session: <name>`; a server running with ZERO sessions → `no current target`
 * (#4443: the window while a concurrent spawn's `new-session` is starting the
 * server). Anything else is a fault. An unrecognized message (another tmux
 * version) therefore reads as a fault, which every ownership caller treats as
 * "refuse" — the safe side.
 */
export function isAbsentTmuxSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    isNoTmuxServerError(error) ||
    /can't find session/i.test(message) ||
    /no current target/i.test(message)
  );
}

/**
 * Issue #4218: a /proc read error that means the process is GONE (exited
 * between the pane-pid read and the walk) — a legitimate "absent", unlike
 * EACCES / EMFILE / EIO, which an ownership read must treat as a fault.
 */
export function isVanishedProcessError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ESRCH";
}

/** Default bound for a diagnostic `show-environment` read (#3731 F3). */
export const GLOBAL_ENV_READ_TIMEOUT_MS = 3000;

/**
 * Issue #4153 (A4): one read of a socket's tmux GLOBAL environment table, with
 * the reason when it failed. `noServer` marks the {@link isNoTmuxServerError}
 * class, which each caller interprets for its own socket. `error` is value-free:
 * an env dump's stdout never reaches an error message (#3731 F6).
 */
export type GlobalEnvRead =
  | { names: Set<string> }
  | { error: string; noServer: boolean };

/**
 * The #3731 three-outcome view of a {@link GlobalEnvRead}: the names, an EMPTY set
 * when the socket has no server, or `null` (unknown) on any other failure. Right
 * only on a socket whose "no server" answer can be trusted — the daemon's own.
 */
export function globalEnvNamesOrNull(read: GlobalEnvRead): Set<string> | null {
  if ("names" in read) return read.names;
  return read.noServer ? new Set<string>() : null;
}

/** A failure as a single bounded line, for a log or `hapi doctor` (#4153 A4). */
export function describeTmuxFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 200);
}

export class TmuxManager {
  private readonly sessionName: string;
  private readonly socketName: string | undefined;
  private readonly socketPath: string | undefined;
  private readonly defaultCwd: string;
  private readonly env: Record<string, string>;

  constructor(options: TmuxManagerOptions) {
    this.sessionName = options.sessionName;
    this.socketName = options.socketName;
    this.socketPath = options.socketPath;
    this.defaultCwd = options.defaultCwd ?? process.cwd();
    this.env = options.env ?? {};
  }

  /**
   * The `-L` socket this manager talks to (`undefined` = tmux's default
   * socket). Read by `windowOwnership.ts` to tell the daemon socket
   * (`configuration.tmuxSessionName`, where `@hapi_identity` is a session tag)
   * from the remote-launcher socket (`configuration.tmuxRemoteSessionName`,
   * where it is a display name — #4238 R6).
   */
  get socket(): string | undefined {
    return this.socketName;
  }

  /** The tmux session this manager creates windows in. */
  get session(): string {
    return this.sessionName;
  }

  /**
   * Check if tmux is available on the system
   */
  async isTmuxAvailable(): Promise<boolean> {
    try {
      // Use -V to check version - this always succeeds if tmux is installed
      await this.runTmux(["-V"]);
      return true;
    } catch (error) {
      // If the error is about tmux not being found, return false
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("spawn") || msg.includes("ENOENT")) {
        return false;
      }
      // Other errors mean tmux command ran but something else failed
      // Still means tmux is available
      return true;
    }
  }

  /**
   * Ensure the hapimatic tmux session exists
   */
  async ensureSession(): Promise<boolean> {
    const exists = await this.sessionExists();
    // #4743: try to create the session (and so the server) inside the sessions
    // slice first; on any failure fall through to the plain start below.
    const createdInSlice = !exists && (await this.createSessionInSlice());
    if (!exists && !createdInSlice) {
      try {
        // Create detached session with a placeholder window
        await this.runTmux([
          "new-session",
          "-d",
          "-s",
          this.sessionName,
          "-n",
          "control",
          "-c",
          this.defaultCwd,
        ]);
        logger.info(`[TmuxManager] Created session "${this.sessionName}"`);
      } catch (error) {
        logger.warn(`[TmuxManager] Failed to create session: ${error}`);
        return false;
      }
    } else if (exists) {
      logger.debug(
        `[TmuxManager] Session "${this.sessionName}" already exists`
      );
    }

    // Session hardening — applied UNCONDITIONALLY, even when the session
    // already exists (#1609): a session created by an older binary (or one
    // surviving a crashed run) must also receive newly added options.
    // Idempotent; each set-option is a ms-scale roundtrip.
    try {
      // Prevent tmux from destroying the session when all windows are closed.
      // Without this, disconnecting all Hapimatic sessions kills every window,
      // which causes tmux to destroy the session — making the desktop shortcut
      // show an error instead of reattaching.
      await this.runTmux([
        "set-option",
        "-t",
        this.sessionName,
        "exit-empty",
        "off",
      ]);

      // Prevent tmux from renaming windows based on running process.
      // Without this, there's a race where the window gets renamed before
      // resolveWindowTarget() can find it by the original name. (#930)
      await this.runTmux([
        "set-option",
        "-t",
        this.sessionName,
        "automatic-rename",
        "off",
      ]);

      // Keep windows alive after their process exits. Without this,
      // a quickly-exiting shell could destroy the window before
      // createWindow() sets the per-window remain-on-exit option.
      await this.runTmux([
        "set-option",
        "-t",
        this.sessionName,
        "remain-on-exit",
        "on",
      ]);

      // Keep window indices stable when other windows close. A user tmux.conf
      // with `set -g renumber-windows on` (e.g. SL7's) would otherwise
      // re-index windows on any close, dangling the index captured from
      // `new-window -P -F` that index-based targeting depends on. (#1609)
      await this.runTmux([
        "set-option",
        "-t",
        this.sessionName,
        "renumber-windows",
        "off",
      ]);
    } catch (error) {
      // Non-fatal: the session exists and is usable; the hardening is
      // best-effort defense against user-conf interference.
      logger.warn(`[TmuxManager] Failed to apply session options: ${error}`);
    }

    // #4743: a server started before this change, or by another process (RP1's
    // desktop launcher), is adopted into the sessions slice before the next
    // pane is forked. Best-effort; never fails the spawn.
    const containment = await this.ensureServerContained();
    if (containment === "no-server") {
      // The session exists, so a server is running: reading its pid failed
      // (e.g. a tmux timeout under load) and containment was not checked.
      logger.warn(
        `[TmuxManager] could not read the tmux server pid for -L ${this.socketName} — containment not checked for this spawn`
      );
    }

    return true;
  }

  /**
   * #4743: start the session — and so the tmux server — inside the sessions
   * slice. Returns true when the session exists afterwards; false means the
   * caller runs its plain `new-session`. Only for a named socket: the default
   * socket belongs to the user's own tmux.
   */
  private async createSessionInSlice(): Promise<boolean> {
    const socketName = this.socketName;
    if (!socketName) return false;
    const outcome = await startTmuxServerInSlice({
      socketName,
      tmuxArgs: [
        "new-session",
        "-d",
        "-s",
        this.sessionName,
        "-n",
        "control",
        "-c",
        this.defaultCwd,
      ],
      env: buildTmuxSpawnEnv(
        process.env,
        this.env,
        configuration.omniboxSandboxEnabled
          ? omniboxServerEnvStrip()
          : undefined
      ),
      serverRunning: async () => (await this.readServerPid()) !== null,
    });
    if (outcome === "started") {
      logger.info(`[TmuxManager] Created session "${this.sessionName}"`);
      return true;
    }
    // A concurrent creator makes `tmux new-session` exit non-zero with
    // "duplicate session" — the session exists, so do not start a second one.
    return outcome === "failed" && (await this.sessionExists());
  }

  /**
   * #4743: the pid of this socket's tmux server, or null when none is running.
   */
  async readServerPid(): Promise<number | null> {
    try {
      const out = await this.runTmux(["display-message", "-p", "#{pid}"], {
        timeoutMs: GLOBAL_ENV_READ_TIMEOUT_MS,
      });
      const pid = Number.parseInt(out.trim(), 10);
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  /**
   * #4743: make sure this socket's running tmux server is inside the sessions
   * slice, adopting it if not. Never starts a server and never throws.
   */
  async ensureServerContained(): Promise<ContainmentOutcome> {
    const socketName = this.socketName;
    if (!socketName) return "disabled";
    return ensureTmuxServerContained({
      socketName,
      readServerPid: () => this.readServerPid(),
    });
  }

  /**
   * Check if our session exists
   */
  async sessionExists(): Promise<boolean> {
    try {
      await this.runTmux(["has-session", "-t", this.sessionName]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get information about the session
   */
  async getSession(): Promise<TmuxSession | null> {
    if (!(await this.sessionExists())) {
      return null;
    }

    const windows = await this.listWindows();
    const attachedCheck = await this.runTmux([
      "display-message",
      "-t",
      this.sessionName,
      "-p",
      "#{session_attached}",
    ]);

    return {
      name: this.sessionName,
      attached: attachedCheck.trim() === "1",
      windows,
    };
  }

  /**
   * Create a new window for a Claude session.
   *
   * Returns `{ created, index }` — surfacing the window index captured race-free
   * from `new-window -P -F #{window_index}` (#945) lets callers use index-based
   * targeting for follow-up operations, bypassing `list-windows -F`, which read
   * as stale/empty on tmux 3.4+ (#1315; the mechanism was the escaped `\x1f`
   * separator, fixed by #1841). `index` may be null on parse failure even
   * when `created` is true; callers should fall back to name-based lookup in
   * that case.
   */
  async createWindow(
    options: CreateWindowOptions
  ): Promise<CreateWindowResult> {
    await this.ensureSession();

    // #1692 (Task 3): scrub the shared server's GLOBAL env table of SDK billing
    // signals BEFORE spawning the window, so the new pane cannot inherit a frozen
    // CLAUDE_CODE_ENTRYPOINT=sdk-ts (etc.) from a server that was first created by
    // an SDK-context process (or a pre-fix Hapimatic binary). #3731 (R3): the same
    // scrub also removes the account-binding set (a frozen onboarding
    // CLAUDE_CODE_OAUTH_TOKEN), ungated — see scrubServerGlobalEnv. Defense-in-depth
    // around the load-bearing per-pane `unset` in buildTmuxEnvFileCommand —
    // covers panes that do NOT route through that helper and keeps
    // `show-environment -g` clean for diagnostics. Best-effort; never blocks
    // window creation.
    await this.scrubServerGlobalEnv();

    // Pre-flight check: does this window already exist?
    //
    // Uses a single listWindows() call (NOT windowExists which retries) —
    // the success path here is "window doesn't exist, proceed to create".
    // The retry-budget bump in windowExists (#1315 defense-in-depth) is for
    // POST-create verification scenarios where the window SHOULD exist; here
    // we want fast "no" so a busy session doesn't pay the full retry budget
    // on every new-window call.
    const existingWindows = await this.listWindows();
    if (existingWindows.some(w => w.name === options.name)) {
      logger.warn(`[TmuxManager] Window "${options.name}" already exists`);
      return { created: false, index: null, id: null };
    }

    try {
      // NOTE (#1609): deliberately NO `-a` flag. `new-window -a` inserts at
      // current-window+1 and SHIFTS every later window's index up by one —
      // dangling the captured index any LIVE session holds for its window
      // (its index-targeted send-keys would then type into another session's
      // claude). Plain `new-window -t <session>` assigns the lowest unused
      // index and never moves existing windows, so captured indices stay
      // stable for the window's lifetime (paired with `renumber-windows off`
      // set in ensureSession, which covers the window-close renumber case).
      const args = [
        "new-window",
        "-t",
        this.sessionName,
        "-n",
        options.name,
        "-c",
        options.cwd,
        "-d", // Don't switch to the new window
      ];

      // Use -P -F to capture the window index directly from the new-window
      // command.  This is race-free — the index comes from the same command
      // that creates the window, avoiding a stale list-windows result on
      // tmux 3.4 where the window may not yet appear.  (#945)
      // CRITICAL: -P -F must come BEFORE the shell-command argument.
      // tmux treats the last positional arg as the shell command — flags
      // placed after it become part of the command string.  (#961)
      // #3734: capture the session-unique window id (@N) ALONGSIDE the index,
      // SPACE-separated. Both tokens are space-free, and a space survives tmux
      // 3.4's control-byte vis-escaping (which mangles the `\x1f` listWindows()
      // separator — the #1841 trap), verified on 3.3a and 3.4. The @N is the
      // collision-safe 1:1 lifecycle key (persisted as tmuxWindowId).
      args.push("-P", "-F", "#{window_index} #{window_id}");

      // If a command is specified, add it LAST (tmux positional arg)
      if (options.command) {
        const fullCommand = options.args
          ? `${options.command} ${options.args.join(" ")}`
          : options.command;
        args.push(fullCommand);
      }

      const output = await this.runTmux(args);
      const { index: windowIndex, id: windowId } =
        parseCreateWindowOutput(output);

      // Keep the window alive after its process exits so archive
      // (disconnect) doesn't destroy the window.  The pane becomes a
      // "dead pane" that can later be respawned on reconnect.
      // Use the captured index for safe targeting (#794, #945).
      //
      // #4443: the window exists from here on, so a failure below must not
      // report `created:false` — a caller would then treat its own live
      // window as a name conflict. The failure is still not harmless:
      // ensureSession's session-level `remain-on-exit` reaches only the
      // session's current window (measured on tmux 3.3a), so this call is the
      // only source of the option for a spawned window, which then closes when
      // its process exits instead of leaving a dead pane. `automatic-rename`
      // is already off here, because `new-window -n` turns it off.
      if (windowIndex !== null) {
        const target = `${this.sessionName}:${windowIndex}`;
        try {
          await this.runTmux([
            "set-option",
            "-t",
            target,
            "remain-on-exit",
            "on",
          ]);

          // Preserve the explicitly-set window name. Without this, tmux
          // renames windows to the currently running program (e.g. "sleep"),
          // breaking window-name-based lookups in resolveUniqueWindowName().
          await this.runTmux([
            "set-option",
            "-wt",
            target,
            "automatic-rename",
            "off",
          ]);
        } catch (error) {
          logger.warn(
            `[TmuxManager] Created window "${options.name}" but could not set its options: ${error}`
          );
        }
      }

      logger.info(
        `[TmuxManager] Created window "${options.name}" in ${options.cwd}`
      );
      return { created: true, index: windowIndex, id: windowId };
    } catch (error) {
      logger.warn(`[TmuxManager] Failed to create window: ${error}`);
      return { created: false, index: null, id: null };
    }
  }

  /**
   * Create a window, deterministically replacing a stale pre-existing window of
   * the same name if one survives from a prior process (#1581 / #1585).
   *
   * createWindow() refuses (`created:false`) when a same-named window already
   * exists. On a respawn where the prior window survived (remain-on-exit kept it
   * alive after a fire-and-forget teardown), that refusal used to surface as a
   * hard error with no recovery. This helper kills the survivor, confirms it is
   * gone (bounded poll — tmux 3.4+ list-windows can briefly report a just-killed
   * window as still present), then recreates. Killing is safe even in the rare
   * race where the old process is still alive — a respawn intends to REPLACE it.
   * The hard-fail throw is PRESERVED as the terminal fallback for a genuine,
   * unresolvable creation failure (Fallback Preservation Rule).
   *
   * Returns the CreateWindowResult of the successful create so callers can use
   * the race-free window index (#945/#1315). Accepts the full CreateWindowOptions
   * so daemon callers can pass an initial `command`.
   *
   * This is the single shared implementation behind all three window-creation
   * sites: claudeTmuxLauncher, claudeTmuxRemote (via createOrReplaceRemoteWindow),
   * and tmuxSpawnAdapter's new-window branch.
   *
   * `onNameConflict` (#4443) chooses what a refused first create means.
   * `"replace"` (the default) kills the same-named window and recreates, which
   * is the #1581/#1585 stale-survivor behavior. `"fail"` returns the refused
   * result and never kills: a caller whose name may belong to ANOTHER live
   * window (the daemon's named spawns, where a concurrent spawn or a
   * server→tmux rename can land on the same name) must not name-kill it.
   */
  async createOrReplaceWindow(
    options: CreateWindowOptions,
    opts: { onNameConflict?: "replace" | "fail" } = {}
  ): Promise<CreateWindowResult> {
    const first = await this.createWindow(options);
    if (first.created) return first;

    if (opts.onNameConflict === "fail") {
      logger.warn(
        `[TmuxManager] window "${options.name}" already exists — not replacing (onNameConflict: fail, #4443)`
      );
      return first;
    }

    // Window already exists — a prior process's remain-on-exit window survived a
    // fire-and-forget teardown. Replace it deterministically (#1581/#1585).
    logger.warn(
      `[TmuxManager] window "${options.name}" already exists — killing stale window and recreating (#1581/#1585)`
    );
    // #4218: TmuxManager is below the OwnedWindowTarget boundary — its own
    // replace-kill goes through the unchecked primitive. Callers that cannot
    // prove the same-named window is theirs pass onNameConflict "fail" (#4443).
    await this.killWindowUnchecked(options.name);

    // Confirm the window is gone BEFORE recreating. tmux 3.4+ `list-windows` can
    // briefly report a just-killed window as still present; the recreate's
    // single-shot pre-flight would then refuse again. Bounded poll (10×200ms=2s)
    // mirrors windowExists's retry budget.
    for (let attempt = 0; attempt < 10; attempt++) {
      const windows = await this.listWindows();
      if (!windows.some(w => w.name === options.name)) break;
      if (attempt < 9) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    const second = await this.createWindow(options);
    if (!second.created) {
      throw new Error(
        `Failed to create tmux window after replacing stale window: ${options.name}`
      );
    }
    return second;
  }

  /**
   * Kill a window by name or index (#1609 — dual-type target; see
   * resolveDualTarget for why numeric targets bypass name lookup).
   * Window target: an `OwnedWindowTarget` — resolveDualTarget trusts any `@N`
   * verbatim, so ownership is proven by the caller (windowOwnership.ts, #4218).
   */
  async killWindow(windowTarget: OwnedWindowTarget): Promise<boolean> {
    return this.killWindowUnchecked(windowTarget);
  }

  /** The kill primitive behind {@link killWindow}; internal to TmuxManager. */
  private async killWindowUnchecked(
    windowTarget: string | number
  ): Promise<boolean> {
    const target = await this.resolveDualTarget(windowTarget);
    if (!target) {
      logger.debug(`[TmuxManager] Window "${windowTarget}" does not exist`);
      return false;
    }

    try {
      await this.runTmux(["kill-window", "-t", target]);
      logger.info(`[TmuxManager] Killed window "${windowTarget}"`);
      return true;
    } catch (error) {
      logger.warn(`[TmuxManager] Failed to kill window: ${error}`);
      return false;
    }
  }

  /**
   * Set a window-level option
   * Window target: an `OwnedWindowTarget` — resolveDualTarget trusts any `@N`
   * verbatim, so ownership is proven by the caller (windowOwnership.ts, #4218).
   */
  async setWindowOption(
    windowName: OwnedWindowTarget,
    option: string,
    value: string
  ): Promise<boolean> {
    // #3734: accept an `@N` id target too (name-only → id-safe).
    const target = await this.resolveDualTarget(windowName);
    if (!target) {
      logger.debug(
        `[TmuxManager] Window "${windowName}" does not exist, cannot set option`
      );
      return false;
    }

    try {
      await this.runTmux(["set-window-option", "-t", target, option, value]);
      logger.debug(
        `[TmuxManager] Set window option "${option}=${value}" on "${windowName}"`
      );
      return true;
    } catch (error) {
      logger.warn(`[TmuxManager] Failed to set window option: ${error}`);
      return false;
    }
  }

  /**
   * Rename a window
   * Window target: an `OwnedWindowTarget` — resolveDualTarget trusts any `@N`
   * verbatim, so ownership is proven by the caller (windowOwnership.ts, #4218).
   */
  async renameWindow(
    oldName: OwnedWindowTarget,
    newName: string
  ): Promise<boolean> {
    // #3734: accept an `@N` id target too, so renaming session A's window can
    // never resolve to session B's same-named window (name-only → id-safe).
    const target = await this.resolveDualTarget(oldName);
    if (!target) {
      logger.debug(`[TmuxManager] Window "${oldName}" does not exist`);
      return false;
    }

    try {
      await this.runTmux(["rename-window", "-t", target, newName]);
      logger.info(`[TmuxManager] Renamed window "${oldName}" to "${newName}"`);
      return true;
    } catch (error) {
      logger.warn(`[TmuxManager] Failed to rename window: ${error}`);
      return false;
    }
  }

  /**
   * Set a window's human-meaningful identity via the `@hapi_identity` tmux USER
   * OPTION (issue #1652) — surfaced to an attached operator by the remote
   * session's pane-border / window-status display formats (see
   * {@link applyRemoteIdentityDisplayFormats}).
   *
   * 🔴 Does NOT rename the window — names are reap-load-bearing (#1628). Uses a
   * pane-scoped user option (`set-option -p`) so it resolves in BOTH the
   * pane-border-format and window-status-format render contexts (each remote
   * launcher window has exactly one pane, so the active-pane option drives the
   * window-status render). A user option is immune to the TUI's OSC 0/2 title
   * writes that clobber `pane_title` (the `allow-set-title` off-switch needs
   * tmux ≥3.5; fleet runs 3.3a/3.4).
   *
   * Best-effort: returns false (never throws) on any tmux failure — a failed
   * identity set MUST NOT break the spawn path (#1652 R6). Mirrors
   * {@link killWindow}'s dual-target + boolean shape, so index-based targeting
   * (#1609) works post-create.
   * Window target: an `OwnedWindowTarget` — resolveDualTarget trusts any `@N`
   * verbatim, so ownership is proven by the caller (windowOwnership.ts, #4218).
   */
  async setWindowIdentity(
    windowTarget: OwnedWindowTarget,
    identity: string
  ): Promise<boolean> {
    const target = await this.resolveDualTarget(windowTarget);
    if (!target) {
      logger.debug(
        `[TmuxManager] Window "${windowTarget}" does not exist; cannot set identity`
      );
      return false;
    }

    try {
      await this.runTmux([
        "set-option",
        "-p",
        "-t",
        target,
        TMUX_IDENTITY_USER_OPTION,
        identity,
      ]);
      return true;
    } catch (error) {
      logger.warn(`[TmuxManager] Failed to set window identity: ${error}`);
      return false;
    }
  }

  /**
   * Apply the remote session's identity DISPLAY formats once (issue #1652):
   * pane-border + status-line formats rendering `#{@hapi_identity}` (with a
   * `#{window_name}` fallback for windows that have no identity yet, e.g. the
   * `control` window). Window NAMES are untouched — `tmux list-windows` still
   * shows `hapi-remote-<uuid>` (#1628 reap invariant, #1652 R5).
   *
   * 🔴 Called ONLY by the remote tmux launcher (`claudeTmuxRemote.ts`) — wrapper
   * sockets never call it, so their visuals are unchanged. The options are set
   * with `set-option -g` against THIS instance's isolated `-L` socket
   * (`runTmux` prepends `-L <socketName>`), so "global" is scoped to the
   * Hapimatic-exclusive `hapimatic-remote` server, not the host's tmux. `-g`
   * is version-safe across the fleet's tmux 3.3a/3.4 for the mixed
   * window-option (`pane-border-*`) + session-option (`window-status-*`) set.
   *
   * Best-effort: returns false (never throws) on any tmux failure. Idempotent —
   * each set-option is a ms-scale roundtrip, safe to re-apply on every spawn.
   */
  async applyRemoteIdentityDisplayFormats(): Promise<boolean> {
    // `#{?@hapi_identity,#{@hapi_identity},#{window_name}}`: render the identity
    // when set+non-empty, else fall back to the window name (so the `control`
    // window and any not-yet-identified pane still render a sensible label).
    const identityOrName = `#{?${TMUX_IDENTITY_USER_OPTION},#{${TMUX_IDENTITY_USER_OPTION}},#{window_name}}`;
    const formats: Array<[string, string]> = [
      ["pane-border-status", "top"],
      ["pane-border-format", ` ${identityOrName} `],
      ["window-status-format", ` #{window_index}:${identityOrName} `],
      ["window-status-current-format", ` #{window_index}:${identityOrName} `],
    ];
    try {
      for (const [option, value] of formats) {
        await this.runTmux(["set-option", "-g", option, value]);
      }
      return true;
    } catch (error) {
      logger.warn(
        `[TmuxManager] Failed to apply remote identity display formats: ${error}`
      );
      return false;
    }
  }

  /**
   * Check if a window exists by name.
   * Retries to handle tmux 3.4+ stale list-windows data. (#959, #1315; on 3.4
   * the empty listing was the escaped separator, fixed by #1841.)
   */
  async windowExists(name: string): Promise<boolean> {
    // #3734: an `@N` window-id target is resolved server-globally by tmux and
    // is never a listWindows() `name` column, so probe it DIRECTLY rather than
    // scanning by name. `display-message -t @N -p '#{window_id}'` returns `@N`
    // when the window exists and EMPTY (exit 0) or errors when it does not
    // (verified on tmux 3.3a) — so the existence verdict is `output === name`,
    // NOT the exit code. This is load-bearing for the stop path: without it,
    // substituting `@N` for the name would make windowExists(@N) false and skip
    // killProcessTree/killWindow → a live-process leak (#1349 class). An absent
    // id reads empty → false. ⚠️ EXISTENCE ONLY, not ownership: `@N` is unique
    // within one tmux-server lifetime, but a NEW server numbers from `@0` again,
    // so a persisted id can name another session's live window after a server
    // restart (#4218/#4238). Ownership is `resolveOwnedWindow` (windowOwnership.ts).
    if (/^@\d+$/.test(name)) {
      try {
        const out = await this.runTmux([
          "display-message",
          "-t",
          name,
          "-p",
          "#{window_id}",
        ]);
        return out.trim() === name;
      } catch {
        return false;
      }
    }
    // Budget: 10 × 200ms = 2s. The architectural fix for tmux 3.4+ stale
    // list-windows is index-based targeting (see getWindowPidByIndex); this
    // wider retry is the fallback for reconnect/recovery paths where the
    // index isn't available. #1018 confirmed retries alone don't fully solve
    // tmux 3.4, but a wider budget still helps marginal cases. (#1315) #1841
    // found why retries never helped on 3.4: list-windows printed the `\x1f`
    // separator as the literal `\037`, so every row was dropped.
    for (let attempt = 0; attempt < 10; attempt++) {
      const windows = await this.listWindows();
      if (windows.some(w => w.name === name)) return true;
      if (attempt < 9) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
    return false;
  }

  /**
   * Resolve a dual-type window target to a tmux target specifier (#1609).
   *
   * Numeric targets — the window index captured race-free from
   * `new-window -P -F '#{window_index}'` (#945/#1315) — are addressed
   * directly as `<session>:<index>`, bypassing the name-based
   * `resolveWindowTarget()` → `listWindows()` path entirely. That path
   * returned stale/empty data on tmux 3.4 (the #1315 symptom, recurring in the
   * remote launcher as #1609 on SL7/WSL2; mechanism and fix: #1841, the
   * escaped `\x1f` separator). String targets keep the existing
   * name-based lookup — the fallback surface for callers without an index
   * (Fallback Preservation Rule).
   */
  private async resolveDualTarget(
    windowTarget: string | number
  ): Promise<string | null> {
    if (typeof windowTarget === "number") {
      return `${this.sessionName}:${windowTarget}`;
    }
    // #3734: a persisted window id (`@N`) is a tmux built-in target resolved
    // server-globally — return it VERBATIM (no listWindows() scan). `@N`
    // addresses exactly one window, so it never resolves to a same-NAMED window.
    // It is an ADDRESS, not ownership: ids restart at `@0` with each tmux
    // server, so a persisted id from an earlier server can address another
    // session's window (#4218/#4238) — mutators take an `OwnedWindowTarget`
    // for that reason (windowOwnership.ts). An absent id is not uniform across
    // commands (measured, tmux 3.3a): a mutator such as `kill-window` or
    // `set-option -w` exits 1 → the caller's catch returns false; but
    // `display-message -t @N -p` answers an absent id with an EMPTY line and
    // exit 0, so a reader sees empty output, not an error — the ownership
    // probes echo-verify the id for this reason. A present id resolves bare
    // and `<session>:`-prefixed on tmux 3.3a and 3.4.
    if (/^@\d+$/.test(windowTarget)) {
      return windowTarget;
    }
    return this.resolveWindowTarget(windowTarget);
  }

  /**
   * Resolve a window name to a safe tmux target specifier.
   *
   * Window names may contain characters that tmux's target parser
   * interprets specially: `.` (pane separator), `#` (format expansion),
   * and fnmatch(3) wildcards (`*`, `?`, `[`).  Using the numeric window
   * index sidesteps all parsing ambiguity.  (Issue #794)
   *
   * Uses listWindows() (which reads structured `-F` format output, not
   * target specifiers) so the name comparison happens in JavaScript.
   */
  private async resolveWindowTarget(
    windowName: string
  ): Promise<string | null> {
    // Budget: 10 × 200ms = 2s. The architectural fix for tmux 3.4+ stale
    // list-windows is index-based targeting (see getWindowPidByIndex); this
    // wider retry is the fallback for cases where the caller doesn't have
    // the index (reconnect, recovery). (#945, #959, #1315)
    for (let attempt = 0; attempt < 10; attempt++) {
      const windows = await this.listWindows();
      const w = windows.find(win => win.name === windowName);
      if (w) return `${this.sessionName}:${w.index}`;
      if (attempt < 9) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
    return null;
  }

  /**
   * List all windows in the session. Best-effort by default: any fault reads
   * as `[]`. With `strict` (#4218), only an absent tmux session/server reads as
   * `[]` ({@link isAbsentTmuxSessionError}); any other tmux fault THROWS, so a
   * caller guarding a destructive or resurrecting action can tell "no windows"
   * from "could not list them". Rows are parsed by
   * {@link parseWindowListOutput}, which handles tmux 3.4+'s `\037`-escaped
   * separator (#1841).
   */
  async listWindows(strict = false): Promise<TmuxWindow[]> {
    if (!strict && !(await this.sessionExists())) {
      return [];
    }

    const SEP = LIST_WINDOWS_SEP;
    let output: string;
    try {
      output = await this.runTmux([
        "list-windows",
        "-t",
        this.sessionName,
        "-F",
        // #2683: two trailing fields — `@hapi_archive` (orphan-reaper
        // discriminator) and `pane_start_command` (positive session-window
        // identification). pane_start_command is LAST because a launch command
        // is free text; the parser rejoins any SEP-split remainder.
        `#{window_index}${SEP}#{window_name}${SEP}#{window_active}${SEP}#{window_panes}${SEP}#{pane_dead}${SEP}#{pane_pid}${SEP}#{${TMUX_ARCHIVE_USER_OPTION}}${SEP}#{pane_start_command}`,
      ]);
    } catch (error) {
      if (strict && !isAbsentTmuxSessionError(error)) throw error;
      logger.warn(`[TmuxManager] Failed to list windows: ${error}`);
      return [];
    }

    const { windows, dropped } = parseWindowListOutputDetailed(output);
    if (dropped.length > 0) this.warnDroppedWindowRows(dropped, windows.length);
    // #1841 / #4443: tmux exited 0 and printed rows, yet none parsed — an
    // output format this parser does not understand. A strict caller must not
    // read that as "no windows" (the dedup would hand out a name a live window
    // holds), so it throws. Raised outside the try above so the message text
    // can never be mistaken for an absent-session error.
    if (strict && windows.length === 0 && output.trim()) {
      const lines = output
        .trim()
        .split("\n")
        .filter(line => line.trim());
      throw new Error(
        `[TmuxManager] list-windows printed ${lines.length} line(s) but none parsed: ${JSON.stringify((lines[0] ?? "").slice(0, 80))}`
      );
    }
    return windows;
  }

  /**
   * Issue #5202 (U1): make a partial parse visible. Rate-limited to one line
   * per {@link LIST_WINDOWS_DROP_WARN_INTERVAL_MS} per tmux socket, shared by
   * every manager in this process on that socket (#5614), so the per-call managers of the
   * heartbeat and capacity paths log about one line a minute, not one per call.
   */
  private warnDroppedWindowRows(dropped: string[], parsed: number): void {
    const key = this.socketPath
      ? `-S ${this.socketPath}`
      : `-L ${this.socketName ?? "default"}`;
    const now = Date.now();
    const last = lastDropWarnAtBySocket.get(key);
    if (last !== undefined && now - last < LIST_WINDOWS_DROP_WARN_INTERVAL_MS) {
      return;
    }
    lastDropWarnAtBySocket.set(key, now);
    logger.warn(
      `[TmuxManager] list-windows: dropped ${dropped.length} of ${dropped.length + parsed} row(s) that did not parse (#5202): ${JSON.stringify(dropped[0].slice(0, 80))}`
    );
  }

  /**
   * Issue #3732 (ruling D1, Option C′): enumerate windows by IDENTITY via a
   * DEDICATED query that returns `#{window_index} #{window_id} #{@hapi_identity}`
   * per row (SPACE-separated). This is the 1:N resolution key — several windows
   * can carry the same `@hapi_identity` (leaked duplicates), and the delete /
   * reconnect-dedupe / heartbeat-reaper paths resolve them by exact-TAG equality.
   *
   * 🔴 Deliberately NOT an extension of `listWindows()` (the 8-column
   * `\x1f`-delimited `-F` row at its `TMUX_ARCHIVE_USER_OPTION` line): (a) the
   * `\x1f` separator is vis-escaped to the literal `\037` on tmux 3.4+ (the #1841
   * bug) whereas a SPACE survives, and all three tokens here are space-free by
   * construction; (b) keeping this query separate means #1841's parser fix and
   * #2245's field-7 `archiveTag` contract are untouched — #1841 gates nothing.
   * Returns only `TmuxWindow.index/id/identity`; the other fields are absent
   * (this is NOT a substitute for `listWindows()`). Best-effort → [] on fault.
   */
  async listWindowIdentities(): Promise<TmuxWindow[]> {
    if (!(await this.sessionExists())) {
      return [];
    }
    try {
      const output = await this.runTmux([
        "list-windows",
        "-t",
        this.sessionName,
        "-F",
        `#{window_index} #{window_id} #{${TMUX_IDENTITY_USER_OPTION}}`,
      ]);
      return parseWindowIdentityOutput(output).map(row => ({
        index: row.index,
        // NAME is intentionally absent: this query does not return it (a name
        // may contain spaces and would corrupt the space-split). Consumers key
        // on id/identity; a display-message by @N fetches the name if needed.
        name: "",
        active: false,
        paneCount: 0,
        id: row.id,
        identity: row.identity,
      }));
    } catch (error) {
      logger.warn(`[TmuxManager] Failed to list window identities: ${error}`);
      return [];
    }
  }

  /**
   * Issue #4218: the NAME resolver for ownership checks — every window's
   * `#{window_id} #{@hapi_identity} #{window_name}` (see
   * {@link parseWindowsWithIdentityOutput}). `resolveOwnedWindow` uses it to
   * turn a window NAME into the `@N` of the single window holding it, so a
   * same-titled session's window is never addressed by name.
   *
   * Unlike {@link listWindowIdentities}, a tmux fault THROWS rather than
   * returning [] — an ownership caller must not read "the listing failed" as
   * "no such window". Only a definitively ABSENT server or session (see
   * {@link isAbsentTmuxSessionError}) returns [] — it has no windows. There is
   * deliberately no `sessionExists()` pre-check: that helper reads every
   * `has-session` failure, faults included, as "no session".
   */
  async listWindowsWithIdentity(): Promise<
    Array<{ id: string; identity: string | null; name: string }>
  > {
    let output: string;
    try {
      output = await this.runTmux([
        "list-windows",
        "-t",
        this.sessionName,
        "-F",
        `#{window_id} #{${TMUX_IDENTITY_USER_OPTION}} #{window_name}`,
      ]);
    } catch (error) {
      if (isAbsentTmuxSessionError(error)) return [];
      throw error;
    }
    return parseWindowsWithIdentityOutput(output);
  }

  /**
   * Send keys to a window. `options.target` is an `OwnedWindowTarget` (#4218)
   * holding a window NAME or a numeric index — a name is matched by a
   * `listWindows()` scan, so an `@N` is not resolved here.
   */
  async sendKeys(options: SendKeysOptions): Promise<boolean> {
    // Numeric targets (window index) are safe to use directly.
    // String targets (window name) must be resolved to an index to
    // avoid tmux target-specifier parsing issues with special chars (#794).
    let target: string;
    if (typeof options.target === "number") {
      target = `${this.sessionName}:${options.target}`;
    } else {
      const resolved = await this.resolveWindowTarget(options.target);
      if (!resolved) {
        logger.warn(
          `[TmuxManager] sendKeys: window "${options.target}" not found`
        );
        return false;
      }
      target = resolved;
    }

    try {
      const args = ["send-keys", "-t", target];
      // #1599: `-l` (literal) sends the keys as raw characters, bypassing
      // tmux key-name interpretation. Additive — callers that omit `literal`
      // produce a byte-identical command.
      if (options.literal) {
        args.push("-l");
      }
      args.push(options.keys);
      if (options.enter) {
        args.push("Enter");
      }
      await this.runTmux(args);
      return true;
    } catch (error) {
      logger.warn(`[TmuxManager] Failed to send keys: ${error}`);
      return false;
    }
  }

  /**
   * Stream a window's pane output to a file via `tmux pipe-pane`.
   *
   * Per `man tmux` (verified against tmux 3.3a on RP1, host running this code):
   * `pipe-pane [-IOo] [-t target-pane] [shell-command]`. The `-O` flag means
   * "pane output → shell-command stdin". A pane may only have ONE pipe-pane
   * active at a time: a subsequent pipe-pane closes the existing pipe before
   * executing the new shell-command. Calling pipe-pane with no shell-command
   * closes the current pipe (we use `options.enabled = false` for this).
   *
   * Critical caveats:
   * - **Tmux drops bytes** if the consumer (file/FIFO) is unreadable. The
   *   launcher caller is responsible for keeping a reader open on the target
   *   path before output begins flowing.
   * - **Bytes between pipe-close and pipe-open are lost** (tmux does not
   *   buffer at the pipe layer). The launcher should keep the pipe open for
   *   the entire session lifetime.
   *
   * Issue #1310 Task 5.
   * Window target: an `OwnedWindowTarget` — resolveDualTarget trusts any `@N`
   * verbatim, so ownership is proven by the caller (windowOwnership.ts, #4218).
   */
  async pipePaneToFile(
    windowTarget: OwnedWindowTarget,
    outputPath: string,
    options?: { enabled?: boolean }
  ): Promise<boolean> {
    const target = await this.resolveDualTarget(windowTarget);
    if (!target) {
      logger.warn(
        `[TmuxManager] pipePaneToFile: window "${windowTarget}" not found`
      );
      return false;
    }
    const enabled = options?.enabled ?? true;
    try {
      if (enabled) {
        // Consolidated single-quote escaper (issue #3748, Sub H) — wrapping in
        // single quotes neutralizes spaces, $, backticks; the shared impl
        // handles any embedded single quote in the path.
        const escapedPath = shellEscape(outputPath);
        await this.runTmux([
          "pipe-pane",
          "-t",
          target,
          "-O",
          `cat >> ${escapedPath}`,
        ]);
      } else {
        // pipe-pane with no shell-command closes the existing pipe.
        await this.runTmux(["pipe-pane", "-t", target]);
      }
      return true;
    } catch (error) {
      logger.warn(
        `[TmuxManager] Failed to pipe-pane to ${outputPath}: ${error}`
      );
      return false;
    }
  }

  /**
   * Resize a window to the given dimensions via `tmux resize-window`.
   *
   * Uses `resize-window` (NOT `resize-pane`) because launcher windows are
   * single-pane and the launcher resizes the whole window. Per `man tmux`:
   * `resize-window -t <target> -x <cols> -y <rows>`. Issue #1310 Task 7.
   * Window target: an `OwnedWindowTarget` — resolveDualTarget trusts any `@N`
   * verbatim, so ownership is proven by the caller (windowOwnership.ts, #4218).
   */
  async resizeWindow(
    windowTarget: OwnedWindowTarget,
    cols: number,
    rows: number
  ): Promise<boolean> {
    const target = await this.resolveDualTarget(windowTarget);
    if (!target) {
      logger.warn(
        `[TmuxManager] resizeWindow: window "${windowTarget}" not found`
      );
      return false;
    }
    try {
      await this.runTmux([
        "resize-window",
        "-t",
        target,
        "-x",
        String(cols),
        "-y",
        String(rows),
      ]);
      return true;
    } catch (error) {
      logger.warn(
        `[TmuxManager] Failed to resize window "${windowTarget}": ${error}`
      );
      return false;
    }
  }

  /**
   * Capture the content of a window's pane
   */
  async capturePane(windowName: string, lines: number = 100): Promise<string> {
    // #3734: accept an `@N` id target too (name-only → id-safe).
    const target = await this.resolveDualTarget(windowName);
    if (!target) return "";

    try {
      const output = await this.runTmux([
        "capture-pane",
        "-t",
        target,
        "-p",
        "-S",
        `-${lines}`,
      ]);
      return output;
    } catch (error) {
      logger.warn(`[TmuxManager] Failed to capture pane: ${error}`);
      return "";
    }
  }

  /**
   * Check if a process is running in a window by checking if the pane is
   * responsive. Accepts a name or index target (#1609 — see resolveDualTarget).
   */
  async isWindowAlive(windowTarget: string | number): Promise<boolean> {
    const target = await this.resolveDualTarget(windowTarget);
    if (!target) return false;

    try {
      // Check pane_pid to see if the process is still running
      const output = await this.runTmux([
        "display-message",
        "-t",
        target,
        "-p",
        "#{pane_pid}",
      ]);
      const pid = parseInt(output.trim(), 10);
      if (!pid || isNaN(pid)) {
        return false;
      }

      // Check if the process is still alive
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    } catch {
      return false;
    }
  }

  /**
   * Check if a window's pane is dead (process exited but window persists
   * due to remain-on-exit).  Returns true if the window exists and the
   * pane is in "dead" state.
   */
  async isPaneDead(windowName: string): Promise<boolean> {
    // #3734: accept an `@N` id target too (name-only → id-safe).
    const target = await this.resolveDualTarget(windowName);
    if (!target) return false;

    try {
      const output = await this.runTmux([
        "display-message",
        "-t",
        target,
        "-p",
        "#{pane_dead}",
      ]);
      return output.trim() === "1";
    } catch (err) {
      logger.warn(
        `[TmuxManager] isPaneDead("${windowName}"): ${err instanceof Error ? err.message : err}`
      );
      return false;
    }
  }

  /**
   * Get the foreground command running in a window's pane
   * (`#{pane_current_command}`). Accepts a name or index target
   * (#1609 — see resolveDualTarget).
   *
   * Issue #1741: the tmux remote launcher `exec`s claude into the pane, so a
   * HEALTHY pane reports `node`/`bun`/`claude`, while a pane where the
   * `exec claude` send-keys was LOST reports the login shell (`bash`/`-bash`).
   * This is the positive signal `isWindowAlive` (pane_pid liveness) cannot
   * provide — a live login-shell pane is indistinguishable from a running
   * Claude by pid alone. Returns null on empty output or any tmux fault
   * (never throws — callers preserve their prior verdict on a null read,
   * mirroring decideWrapperAlive's null-tolerant contract).
   */
  async getPaneCurrentCommand(
    windowTarget: string | number
  ): Promise<string | null> {
    const target = await this.resolveDualTarget(windowTarget);
    if (!target) return null;

    try {
      const output = await this.runTmux([
        "display-message",
        "-t",
        target,
        "-p",
        "#{pane_current_command}",
      ]);
      const cmd = output.trim();
      return cmd.length > 0 ? cmd : null;
    } catch (err) {
      logger.warn(
        `[TmuxManager] getPaneCurrentCommand("${windowTarget}"): ${err instanceof Error ? err.message : err}`
      );
      return null;
    }
  }

  /**
   * Respawn a dead pane in a window with a new command.
   * Used to relaunch a process in an existing window after the previous
   * process exited (e.g., reconnecting to a disconnected session).
   * Window target: an `OwnedWindowTarget` — resolveDualTarget trusts any `@N`
   * verbatim, so ownership is proven by the caller (windowOwnership.ts, #4218).
   */
  async respawnPane(
    windowName: OwnedWindowTarget,
    command: string,
    cwd?: string
  ): Promise<boolean> {
    // #3734: accept an `@N` id target too — a same-title collision must never
    // respawn-pane -k INTO another session's live pane (name-only → id-safe).
    const target = await this.resolveDualTarget(windowName);
    if (!target) {
      logger.warn(
        `[TmuxManager] respawnPane: window "${windowName}" not found`
      );
      return false;
    }

    try {
      const args = [
        "respawn-pane",
        "-t",
        target,
        "-k", // kill any existing (dead) process first
      ];
      if (cwd) {
        args.push("-c", cwd);
      }
      args.push(command);

      await this.runTmux(args);
      logger.info(`[TmuxManager] Respawned pane in window "${windowName}"`);
      return true;
    } catch (error) {
      logger.warn(`[TmuxManager] Failed to respawn pane: ${error}`);
      return false;
    }
  }

  /**
   * Check if a process has active child processes.
   * Used to distinguish active Claude sessions (has children) from
   * disconnected sessions (bare shell, no children).
   */
  async hasActiveChildren(pid: number): Promise<boolean> {
    try {
      const content = await readFile(
        `/proc/${pid}/task/${pid}/children`,
        "utf-8"
      );
      return content.trim().length > 0;
    } catch (err) {
      const code =
        err instanceof Error && "code" in err
          ? (err as { code: string }).code
          : undefined;
      if (code !== "ENOENT" && code !== "ESRCH") {
        logger.warn(
          `[TmuxManager] hasActiveChildren(${pid}): ${err instanceof Error ? err.message : err}`
        );
      }
      return false;
    }
  }

  /**
   * Get the PID of the process running in a window. Accepts a name or index
   * target (#1609 — see resolveDualTarget).
   */
  /**
   * Issue #3734: read a window's CURRENT name, addressed by a name/`@N`/index
   * target (via {@link resolveDualTarget}). Used by the heartbeat rename-sync to
   * detect an out-of-band rename of the SPECIFIC window (`@N`) rather than
   * scanning by the stored name (which can first-match a same-titled sibling).
   * Returns null on absent/fault.
   */
  async getWindowName(windowTarget: string | number): Promise<string | null> {
    const target = await this.resolveDualTarget(windowTarget);
    if (!target) return null;
    try {
      const out = await this.runTmux([
        "display-message",
        "-t",
        target,
        "-p",
        "#{window_name}",
      ]);
      const name = out.trim();
      return name.length > 0 ? name : null;
    } catch {
      return null;
    }
  }

  async getWindowPid(windowTarget: string | number): Promise<number | null> {
    const target = await this.resolveDualTarget(windowTarget);
    if (!target) return null;

    try {
      const output = await this.runTmux([
        "display-message",
        "-t",
        target,
        "-p",
        "#{pane_pid}",
      ]);
      const pid = parseInt(output.trim(), 10);
      return isNaN(pid) ? null : pid;
    } catch (err) {
      logger.warn(
        `[TmuxManager] getWindowPid("${windowTarget}"): ${err instanceof Error ? err.message : err}`
      );
      return null;
    }
  }

  /**
   * Get the PID of the process running in a window, addressed by index.
   *
   * Bypasses `list-windows -F` (it read as empty on tmux 3.4 even seconds after
   * a fresh new-window, because the `\x1f` separator arrived as the literal
   * `\037` — #1841). Uses `display-message -t <session>:<index>`
   * directly with the index captured race-free from `new-window -P -F` (#945).
   * Callers MUST pair this with a name-based fallback via `getWindowPid` for
   * reconnect/recovery paths where the index isn't available. See issue #1315.
   */
  async getWindowPidByIndex(windowIndex: number): Promise<number | null> {
    if (isNaN(windowIndex) || windowIndex < 0) return null;
    try {
      const output = await this.runTmux([
        "display-message",
        "-t",
        `${this.sessionName}:${windowIndex}`,
        "-p",
        "#{pane_pid}",
      ]);
      const pid = parseInt(output.trim(), 10);
      return isNaN(pid) ? null : pid;
    } catch (err) {
      logger.warn(
        `[TmuxManager] getWindowPidByIndex(${windowIndex}): ${err instanceof Error ? err.message : err}`
      );
      return null;
    }
  }

  /**
   * Get the PID of the process running in a window, addressed by EXACT name.
   *
   * Uses tmux's `=` target prefix — `<session>:=<name>` — which forces
   * exact-match window-name resolution INSIDE the tmux server, bypassing both
   * fnmatch pattern matching and the client-side `list-windows` path that
   * returned stale/empty data on tmux 3.4 in the daemon process context (#1628 —
   * the reaper-blindness recurrence of the #1315/#1609 corruption class, whose
   * mechanism #1841 traced to the escaped `\x1f` separator).
   * Absent windows are the expected common case (the #1628 reaper probes
   * retry-suffix candidate names), so failures log at debug, not warn.
   *
   * ⚠️ #4218: for an ABSENT name, `display-message -t <session>:=<name>` exits 0
   * and answers for the session's ACTIVE window instead (measured on tmux 3.3a;
   * the #4218 re-review measured the same on 3.4) — `kill-window` with the same
   * target does fail. The reaper kills the returned pid's process tree, so an
   * unverified answer could kill another live session's launcher. The probe
   * therefore echoes `#{window_name}` and returns a pid only when it IS the
   * requested name ({@link parseExactNamePidProbe}).
   */
  async getWindowPidByExactName(windowName: string): Promise<number | null> {
    try {
      const output = await this.runTmux([
        "display-message",
        "-t",
        `${this.sessionName}:=${windowName}`,
        "-p",
        "#{pane_pid} #{window_name}",
      ]);
      return parseExactNamePidProbe(output, windowName);
    } catch (err) {
      logger.debug(
        `[TmuxManager] getWindowPidByExactName("${windowName}"): ${err instanceof Error ? err.message : err}`
      );
      return null;
    }
  }

  /**
   * Kill a window addressed by EXACT name via the `=` target prefix —
   * server-side resolution, no list-windows dependency (#1628; see
   * getWindowPidByExactName). Returns false when the window does not exist
   * (the expected common case for candidate-name probing) or the kill fails.
   * Window target: an `OwnedWindowTarget` holding a window NAME. tmux still
   * resolves an `@N` or an index after the `=` prefix (measured, tmux 3.3a:
   * `kill-window -t s:=@1` kills `@1`), so any other form is a real kill, not
   * a no-op — pass only a name. Ownership is proven by the caller
   * (windowOwnership.ts, #4218).
   */
  async killWindowByExactName(windowName: OwnedWindowTarget): Promise<boolean> {
    try {
      await this.runTmux([
        "kill-window",
        "-t",
        `${this.sessionName}:=${windowName}`,
      ]);
      logger.info(`[TmuxManager] Killed window "${windowName}" (exact-name)`);
      return true;
    } catch (err) {
      logger.debug(
        `[TmuxManager] killWindowByExactName("${windowName}"): ${err instanceof Error ? err.message : err}`
      );
      return false;
    }
  }

  /**
   * Issue #4218 (K1-ext): one read for both existence and `@hapi_identity` —
   * `display-message -t <target> -p '#{window_id} #{@hapi_identity}'`, parsed by
   * {@link parseWindowIdentityProbe} (for an `@N` target the echoed id must
   * equal the target). Fault-discriminated: an absent window is
   * `{ exists: false }`, while a tmux fault (timeout, spawn failure, a server
   * error) THROWS — so an ownership caller never reads a fault as "gone".
   */
  async probeWindowIdentity(
    target: string
  ): Promise<{ exists: boolean; identity: string | null }> {
    const isId = /^@\d+$/.test(target);
    const resolved = isId ? target : await this.resolveDualTarget(target);
    if (!resolved) return { exists: false, identity: null };
    const out = await this.runTmux([
      "display-message",
      "-t",
      resolved,
      "-p",
      `#{window_id} #{${TMUX_IDENTITY_USER_OPTION}}`,
    ]);
    return parseWindowIdentityProbe(out, isId ? target : null);
  }

  /**
   * K1 (pinned by #4218; #4038 and #4080 consume it): the window's
   * `@hapi_identity`, or null when the window is missing OR the option is
   * empty. Echo-verified via {@link probeWindowIdentity}. A tmux fault throws
   * (`windowOwnedBy` maps it to false; `resolveOwnedWindow` reads
   * {@link probeWindowIdentity} directly and maps its throw to `fault`).
   */
  async getWindowIdentity(target: string): Promise<string | null> {
    return (await this.probeWindowIdentity(target)).identity;
  }

  /**
   * Issue #2245/#3734: is a window tagged `@hapi_archive` (a deliberate
   * archive-for-reconnect window, #2683)? Accepts a name, `@N` id, or numeric
   * index target (via {@link resolveDualTarget}). Restart recovery consults the
   * archive signal on the SPECIFIC resolved window (its persisted `@N`) rather
   * than a name-matched `listWindows()` row, so a same-title collision cannot
   * read another session's tag. Best-effort → false on any fault (matches the
   * `listWindows()` `archiveTag === "1"` read), UNLESS `strict` is set: then a
   * tmux fault on the tag read THROWS (#4218), so a caller guarding a kill can
   * tell "not archived" from "could not read the tag". `strict` covers that
   * read only: a NAME target that cannot be resolved still reads as `false`
   * (the name scan is best-effort), and tmux answers an absent `@N` with an
   * empty line, which also reads as `false` — pass an `@N` already proven to
   * exist (as `classifyArchivedZombies` does).
   */
  async isArchiveTagged(
    windowTarget: string | number,
    strict = false
  ): Promise<boolean> {
    const target = await this.resolveDualTarget(windowTarget);
    if (!target) return false;
    try {
      const out = await this.runTmux([
        "display-message",
        "-t",
        target,
        "-p",
        `#{${TMUX_ARCHIVE_USER_OPTION}}`,
      ]);
      return out.trim() === "1";
    } catch (error) {
      if (strict) throw error;
      return false;
    }
  }

  /**
   * Issue #4218 (review M1): the ownership read of a window's `HAPI_SESSION_ID`
   * — like {@link getWindowHapiSessionId}, but a tmux fault on the pane-pid
   * read THROWS instead of reading as "no pid". `getWindowPid` swallows every
   * error into null, which an ownership caller would misread as "this pane
   * carries no session" (`unverifiable`) rather than a fault. Null means the
   * window is absent, the pane has no pid, or no process in its tree carries
   * the variable. `@N` targets only, echo-verified like
   * {@link probeWindowIdentity}: a NAME or index target can resolve to a
   * different window (an absent index answers for the active window). The
   * /proc walk is strict: only a vanished process (ENOENT/ESRCH) reads as
   * absent; any other read error (EACCES, EMFILE, EIO) throws.
   */
  async probeWindowHapiSessionId(target: string): Promise<string | null> {
    if (!/^@\d+$/.test(target)) {
      throw new Error(
        `probeWindowHapiSessionId: an @N target is required, got "${target}"`
      );
    }
    const out = await this.runTmux([
      "display-message",
      "-t",
      target,
      "-p",
      "#{window_id} #{pane_pid}",
    ]);
    const [id, pidTok] = out.trim().split(" ");
    if (id !== target) return null;
    const pid = parseInt(pidTok ?? "", 10);
    if (isNaN(pid)) return null;
    return this.findHapiSessionIdInTree(pid, true);
  }

  /**
   * Get the HAPI_SESSION_ID from a window's process tree.
   * Walks the process tree downward from the pane PID, checking
   * /proc/PID/environ for each descendant until HAPI_SESSION_ID is found.
   * Accepts a name or index target (#1609 — see resolveDualTarget).
   */
  async getWindowHapiSessionId(
    windowTarget: string | number
  ): Promise<string | null> {
    const pid = await this.getWindowPid(windowTarget);
    if (!pid) return null;
    return this.findHapiSessionIdInTree(pid);
  }

  /**
   * Recursively search a process tree for HAPI_SESSION_ID in /proc/PID/environ.
   * Walks depth-first from the given PID through all descendants.
   */
  private async findHapiSessionIdInTree(
    pid: number,
    strict = false
  ): Promise<string | null> {
    try {
      const environ = await readFile(`/proc/${pid}/environ`, "utf-8");
      const entry = environ
        .split("\0")
        .find(e => e.startsWith("HAPI_SESSION_ID="));
      if (entry) return entry.split("=", 2)[1];
    } catch (error) {
      // Process may have exited or permission denied — continue to children.
      // #4218: in strict (ownership) mode only a vanished process is absent.
      if (strict && !isVanishedProcessError(error)) throw error;
    }

    const children = await this.getChildPids(pid, strict);
    for (const child of children) {
      const found = await this.findHapiSessionIdInTree(child, strict);
      if (found) return found;
    }

    return null;
  }

  /**
   * Get direct child PIDs of a process via /proc filesystem.
   */
  private async getChildPids(pid: number, strict = false): Promise<number[]> {
    try {
      const content = await readFile(
        `/proc/${pid}/task/${pid}/children`,
        "utf-8"
      );
      return content
        .trim()
        .split(/\s+/)
        .filter(s => s.length > 0)
        .map(s => parseInt(s, 10))
        .filter(n => !isNaN(n));
    } catch (error) {
      if (strict && !isVanishedProcessError(error)) throw error;
      return [];
    }
  }

  /**
   * Get the current name of a window by its index.
   *
   * Return shape distinguishes "tmux query failed" (transient subprocess
   * fault) from "window genuinely missing or unnamed". The orphan-check at
   * `daemon/run.ts` requires this distinction to avoid silent
   * de-registration on transient tmux faults (#1329).
   *
   * - `{ ok: true, name: <string> }` — tmux returned a non-empty name
   * - `{ ok: true, name: null }` — tmux succeeded but window has no name /
   *                                index is recycled (legitimate-orphan signal)
   * - `{ ok: false, error }`     — tmux subprocess threw; caller MUST NOT
   *                                treat as orphan evidence
   */
  async getWindowNameByIndex(
    windowIndex: number
  ): Promise<{ ok: true; name: string | null } | { ok: false; error: Error }> {
    try {
      const output = await this.runTmux([
        "display-message",
        "-t",
        `${this.sessionName}:${windowIndex}`,
        "-p",
        "#{window_name}",
      ]);
      return { ok: true, name: output.trim() || null };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.warn(
        `[TmuxManager] getWindowNameByIndex(${windowIndex}) failed: ${error.message}`
      );
      return { ok: false, error };
    }
  }

  /**
   * Get window index by name
   * Returns the window index for a given name, or null if not found
   */
  async getWindowIndex(windowName: string): Promise<number | null> {
    // Use listWindows() + JS comparison to avoid tmux target-specifier
    // parsing issues with special characters in window names (#794).
    const windows = await this.listWindows();
    const w = windows.find(win => win.name === windowName);
    return w?.index ?? null;
  }

  /**
   * Find windows in the current tmux session whose name starts with the
   * given prefix, but only when the daemon recorded in daemonStateFile is
   * dead (probed via process.kill(state.pid, 0)).
   *
   * Returns an empty array when the daemon is alive, when the state file
   * is missing/unreadable/corrupt, or when no windows match the prefix.
   * The conservative defaults are deliberate: false-negatives (missed
   * orphans) are recoverable; false-positives (killing active sessions)
   * are not. See issue #1428 R4 + R6.
   *
   * @param daemonStateFile  Absolute path to ~/.hapimatic-*&#x2F;daemon.state.json
   * @param windowPrefix     Window-name prefix to match (default: TMUX_REMOTE_WINDOW_PREFIX)
   * @param opts.ownedTags   When provided (non-null), reap ONLY windows whose pane
   *                         HAPI_SESSION_ID is in this set (this instance's own
   *                         windows on the shared socket). Foreign-tagged windows
   *                         are NEVER reaped — the cross-instance kill hazard (#1655).
   *                         Omitted/null = legacy behavior (reap every prefix match).
   * @param opts.includeDead When true, also reap candidates whose pane tag is
   *                         unreadable (dead pane / process-tree walk failed).
   *                         Default false (conservative, #1428 R4/R6).
   * @returns `{ orphans, foreignSkipped, deadSkipped }` — the skip counts let the
   *          CLI explain why a window was spared. Shape is unconditional (also when
   *          opts is omitted, so the param-less path stays type-stable — #1655).
   */
  async findOrphanedSessions(
    daemonStateFile: string,
    windowPrefix: string = TMUX_REMOTE_WINDOW_PREFIX,
    opts?: { ownedTags?: ReadonlySet<string> | null; includeDead?: boolean }
  ): Promise<{
    orphans: OrphanedSession[];
    foreignSkipped: number;
    deadSkipped: number;
  }> {
    let deadDaemonPid: number | null = null;
    try {
      if (!existsSync(daemonStateFile)) {
        logger.debug(
          `[TmuxManager] findOrphanedSessions: state file missing at ${daemonStateFile} — assuming daemon alive, no orphans`
        );
        return { orphans: [], foreignSkipped: 0, deadSkipped: 0 };
      }
      const raw = await readFile(daemonStateFile, "utf-8");
      const state = JSON.parse(raw) as { pid?: number };
      if (typeof state.pid !== "number") {
        logger.debug(
          `[TmuxManager] findOrphanedSessions: state file has no pid field — assuming daemon alive, no orphans`
        );
        return { orphans: [], foreignSkipped: 0, deadSkipped: 0 };
      }
      try {
        process.kill(state.pid, 0);
        // No throw → daemon alive → no orphans.
        return { orphans: [], foreignSkipped: 0, deadSkipped: 0 };
      } catch (e: unknown) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === "ESRCH") {
          // PID does not exist → daemon dead → proceed to enumerate.
          deadDaemonPid = state.pid;
        } else if (err.code === "EPERM") {
          // PID exists but we lack permission to signal → ASSUME ALIVE (conservative).
          logger.debug(
            `[TmuxManager] findOrphanedSessions: EPERM probing pid ${state.pid} — assuming daemon alive`
          );
          return { orphans: [], foreignSkipped: 0, deadSkipped: 0 };
        } else {
          throw err;
        }
      }
    } catch (err) {
      // Issue #4155 (R10): the code/class only — a JSON.parse message can quote
      // daemon.state.json, which holds the controlToken.
      logger.warn(
        `[TmuxManager] findOrphanedSessions: daemon state unreadable (${describeErrorKind(err)}) — assuming daemon alive, no orphans`
      );
      return { orphans: [], foreignSkipped: 0, deadSkipped: 0 };
    }
    // Reaching here: deadDaemonPid is non-null; daemon is confirmed dead.
    const windows = await this.listWindows();
    const ownedTags = opts?.ownedTags ?? null;
    const includeDead = opts?.includeDead ?? false;
    const orphans: OrphanedSession[] = [];
    let foreignSkipped = 0;
    let deadSkipped = 0;
    for (const w of windows) {
      if (!w.name.startsWith(windowPrefix)) continue;

      // Ownership scoping (#1655): on the shared `hapimatic-remote` socket a
      // dead daemon must reap ONLY this instance's own windows. Without this,
      // one instance's reap kills another instance's LIVE claude windows.
      // When ownedTags is null (param-less call), this block is skipped and
      // every prefix-matching window is pushed — verbatim legacy behavior (R5).
      if (ownedTags) {
        const tag = await this.getWindowHapiSessionId(w.index);
        if (tag) {
          if (!ownedTags.has(tag)) {
            // Foreign window — another instance owns it. NEVER reap: a
            // cross-instance false-positive is unrecoverable (#1428 R4/R6).
            foreignSkipped++;
            logger.debug(
              `[TmuxManager] findOrphanedSessions: skipping foreign window "${w.name}" (tag=${tag} not in owned set)`
            );
            continue;
          }
          // tag is owned → fall through and push.
        } else {
          // Unreadable tag (dead pane / process-tree walk failed). Conservative
          // default: reap ONLY when includeDead is explicitly set (#1428 R4/R6).
          if (!includeDead) {
            deadSkipped++;
            logger.debug(
              `[TmuxManager] findOrphanedSessions: skipping unreadable-tag window "${w.name}" (pass --include-dead to reap)`
            );
            continue;
          }
          // includeDead → fall through and push.
        }
      }

      orphans.push({
        windowName: w.name,
        windowIndex: w.index,
        paneDead: !!w.paneDead,
        deadDaemonPid: deadDaemonPid!,
      });
    }
    return { orphans, foreignSkipped, deadSkipped };
  }

  /**
   * Kill the entire tmux server for this socket — every session and window on
   * it, with no ownership check. TEST TEARDOWN ONLY: use it when the
   * TmuxManager owns a dedicated socket (a unique socketName per test run). The
   * ownership source guard (`ownedTargetGuard.test.ts`, rule 7b) fails on a
   * `.killServer(` call outside a `*.test.ts` file in `cli/src` or `scripts/`
   * (#4529).
   */
  async killServer(): Promise<boolean> {
    try {
      await this.runTmux(["kill-server"]);
      logger.info(
        `[TmuxManager] Killed tmux server (socket: ${this.socketName ?? "default"})`
      );
      return true;
    } catch {
      // Server already dead or never started — not an error
      return true;
    }
  }

  /**
   * Reset terminal state in a window after a process exits.
   * This cleans up raw mode, alternate screen buffer, and other terminal modes
   * that may have been left in an inconsistent state.
   * Window target: an `OwnedWindowTarget` — resolveDualTarget trusts any `@N`
   * verbatim, so ownership is proven by the caller (windowOwnership.ts, #4218).
   */
  async resetWindowTerminal(windowName: OwnedWindowTarget): Promise<boolean> {
    // #3734: accept an `@N` id target too (name-only → id-safe).
    const target = await this.resolveDualTarget(windowName);
    if (!target) {
      logger.debug(
        `[TmuxManager] Window "${windowName}" does not exist, skipping reset`
      );
      return false;
    }

    try {
      // Send ANSI escape sequences to reset terminal state:
      // \x1b[?1049l - Exit alternate screen buffer
      // \x1b[?1004l - Disable focus reporting
      // \x1b[?2004l - Disable bracketed paste mode
      // \x1b[>4;0m  - Disable kitty keyboard protocol
      // \x1bc       - Full terminal reset (RIS - Reset to Initial State)
      const resetSequence = "\x1b[?1049l\x1b[?1004l\x1b[?2004l\x1b[>4;0m\x1bc";

      // Use send-keys with -l (literal) flag to send escape sequences
      await this.runTmux(["send-keys", "-t", target, "-l", resetSequence]);

      // Also send 'reset' command followed by Enter as a backup
      // This ensures the shell gets a clean state
      await this.runTmux(["send-keys", "-t", target, "reset", "Enter"]);

      logger.info(
        `[TmuxManager] Reset terminal state for window "${windowName}"`
      );
      return true;
    } catch (error) {
      logger.warn(`[TmuxManager] Failed to reset window terminal: ${error}`);
      return false;
    }
  }

  /**
   * Issue #3731 (Task 2c, F3): the NAMES of the variables present in this socket's
   * tmux GLOBAL environment table (`show-environment -g`), parsed by
   * {@link parseTmuxGlobalEnvNames}. Values are never returned or logged — the table
   * can hold a credential (the #3731 onboarding token), and callers (the daemon's
   * ambient-token warning, `hapi doctor`) need presence only.
   *
   * Read-only: `show-environment` never creates a server. Three outcomes:
   * - a `Set` of names — the read succeeded;
   * - an EMPTY set — the socket has no server, so there is no table to hold anything;
   * - `null` — the read failed or timed out (bounded by `timeoutMs`, so a wedged
   *   tmux cannot hang the caller). Callers treat `null` as UNKNOWN, never as clean.
   */
  async readGlobalEnvVarNames(
    timeoutMs: number = GLOBAL_ENV_READ_TIMEOUT_MS
  ): Promise<Set<string> | null> {
    return globalEnvNamesOrNull(
      await this.readGlobalEnvVarNamesDetailed(timeoutMs)
    );
  }

  /**
   * Issue #4153 (A4): {@link readGlobalEnvVarNames} with the failure REASON kept,
   * for callers that must say why a read failed (`hapi doctor`, the daemon's
   * spawn-time probe log) or that cannot treat "no server" as clean (doctor
   * probing a recorded socket path it may not share a `/tmp` view with).
   */
  async readGlobalEnvVarNamesDetailed(
    timeoutMs: number = GLOBAL_ENV_READ_TIMEOUT_MS
  ): Promise<GlobalEnvRead> {
    try {
      const out = await this.runTmux(["show-environment", "-g"], { timeoutMs });
      return { names: parseTmuxGlobalEnvNames(out) };
    } catch (error) {
      return {
        error: describeTmuxFailure(error),
        noServer: isNoTmuxServerError(error),
      };
    }
  }

  // ==================== Private Methods ====================

  /**
   * Scrub every {@link SDK_SIGNAL_ENV_VARS} member — and, ungated since #3731,
   * every {@link BINDING_ENV_VARS} member — from this socket's tmux GLOBAL
   * environment table (issue #1692, Task 3 — defense-in-depth).
   *
   * Remediates a server whose global env table was ALREADY poisoned before this
   * fix shipped — created by a pre-fix Hapimatic binary, or by a non-Hapimatic /
   * SDK-context process that created the shared `hapimatic-remote` socket first.
   * `set-environment -gr <var>` (the remove form) marks the var for removal from
   * any subsequently-spawned process's environment, so even a pane that does NOT
   * route through `buildTmuxEnvFileCommand` is clean, and `show-environment -g`
   * reads clean for diagnostics. The `-gr` flag (vs `-gu`) was confirmed
   * empirically on the installed tmux (3.3a): a pane spawned AFTER `-gr` does not
   * inherit the var; the `tmuxEnvScrub.integration.test.ts` Case B regression
   * test pins this.
   *
   * Idempotent and cheap (the removals run concurrently). Best-effort: a
   * failure is swallowed — a remediation miss is covered by the load-bearing
   * per-pane `unset`, and this must NEVER block window creation. Deliberately
   * does NOT use `kill-server`/socket-recreate, which would kill every other
   * instance's live sessions on the shared socket (#1655).
   */
  private async scrubServerGlobalEnv(): Promise<void> {
    // #2646 (OmniBox Phase-1, Task 7a): when the sandbox is ON, ALSO scrub the
    // credential set from the global env table of an ALREADY-running server —
    // one created before this fix, or surviving a daemon restart via
    // `KillMode=process` (so its poisoned table would otherwise keep leaking via
    // `tmux show-environment` even after a correct code fix, false-failing V4).
    // GH_TOKEN rides omniboxServerEnvStrip() into the scrub — #2672 retired the
    // former D4 pass-through. Gate OFF ⇒ SDK_SIGNAL vars plus the account-binding
    // set (below).
    //
    // Issue #3731 (R3): the account-binding set (BINDING_ENV_VARS —
    // CLAUDE_CODE_OAUTH_TOKEN / CLAUDE_CONFIG_DIR / HAPI_ACCOUNT_UUID /
    // HAPI_API_KEY_ID / HAPI_API_KEY_MASKED) is scrubbed
    // UNGATED. A binding var in a GLOBAL table is contamination by definition (every
    // per-session binding travels in that session's 0600 env file), and the exposure
    // lives on default-configured cloud VMs where the sandbox switch is OFF: the
    // daemon-created server froze the onboarding token into its table, every pane
    // inherited it, and it overrode each bound account's isolated credentials. A
    // server created by an older daemon survives the deploy (KillMode=process), so
    // this remediation runs on the next window creation. Safe for unbound sessions
    // because their instance credential now arrives explicitly (#3731 R0b).
    //
    // Issue #4884: both states also scrub ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY
    // (buildServerGlobalScrubSet).
    const toScrub = buildServerGlobalScrubSet(
      configuration.omniboxSandboxEnabled
    );
    await Promise.all(
      [...toScrub].map(async varName => {
        try {
          await this.runTmux(["set-environment", "-gr", varName]);
        } catch {
          // best-effort — covered by the load-bearing per-pane unset; never
          // block window creation on a global-table remediation miss.
        }
      })
    );
  }

  private runTmux(
    args: string[],
    options: { timeoutMs?: number } = {}
  ): Promise<string> {
    // #4153: an explicit socket PATH (`-S`) wins over a socket name (`-L`).
    const socketArgs = this.socketPath
      ? ["-S", this.socketPath]
      : this.socketName
        ? ["-L", this.socketName]
        : [];
    const fullArgs = [...socketArgs, ...args];
    const diagnostic = process.env.HAPI_TMUX_DIAGNOSTIC === "1";
    // #3731 (F6): an env dump's stdout can hold a credential — keep it out of the
    // diagnostic log AND out of every error message a caller might log.
    const envDump = isEnvDumpCommand(args);

    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        fn();
      };
      const child = spawn("tmux", fullArgs, {
        // #1692 (Task 2): scrub SDK_SIGNAL_ENV_VARS from the spawn env so the
        // FIRST tmux command to create the shared server never seeds it (and its
        // global env table) with a billing signal carried by a self-poisoned
        // launcher process.env. Replaces the prior `{ ...process.env, ...this.env }`.
        env: buildTmuxSpawnEnv(
          process.env,
          this.env,
          // #2646 (OmniBox Phase-1, Path 3): strip the credential set from the
          // tmux-server seed env when the sandbox is ON (byte-identical when OFF).
          configuration.omniboxSandboxEnabled
            ? omniboxServerEnvStrip()
            : undefined
        ),
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", data => {
        stdout += data.toString();
      });

      child.stderr?.on("data", data => {
        stderr += data.toString();
      });

      if (options.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          child.kill("SIGKILL");
          settle(() =>
            reject(
              new Error(
                `tmux timed out after ${options.timeoutMs}ms: ${fullArgs.join(" ")}`
              )
            )
          );
        }, options.timeoutMs);
      }

      child.on("error", error => {
        if (diagnostic) {
          logger.debug(
            `[TmuxManager:DIAG] spawn-error tmux ${fullArgs.join(" ")}: ${error.message}`
          );
        }
        settle(() => reject(new Error(`tmux spawn failed: ${error.message}`)));
      });

      child.on("close", code => {
        // #3731 (F6): the only stdout text allowed into a log line or an error.
        const safeStdout = envDump
          ? "[redacted: show-environment output]"
          : stdout;
        if (diagnostic) {
          const out = safeStdout.slice(0, 500).replace(/\n/g, "\\n");
          const err = stderr.slice(0, 500).replace(/\n/g, "\\n");
          logger.debug(
            `[TmuxManager:DIAG] tmux ${fullArgs.join(" ")} → exit=${code} stdout="${out}" stderr="${err}"`
          );
        }
        if (code === 0) {
          settle(() => resolve(stdout));
        } else {
          settle(() =>
            reject(
              new Error(
                `tmux exited with code ${code}: ${stderr || safeStdout}`
              )
            )
          );
        }
      });
    });
  }
}
