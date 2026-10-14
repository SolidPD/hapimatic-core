// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { configuration } from "@/configuration";
import { readSettings, updateSettings } from "@/persistence";
import {
  AVAILABLE_LAUNCHER_KINDS,
  type ClaudeRemoteLauncherKind,
} from "@/claude/launcherDispatch";
import {
  reapOrphanedSessions,
  listRemoteLauncherWindows,
  matchRemoteWindowRows,
  type RemoteWindowRow,
} from "@/claude/launcherShared";
import {
  resolveLauncherKind,
  VALID_KINDS,
  type ResolvedLauncher,
} from "@hapi/protocol/launcherResolver";
import { isBunCompiled } from "@/projectPath";
import { TMUX_REMOTE_WINDOW_PREFIX } from "@/tmux/types";
import type { CommandDefinition } from "./types";

// Instance-coherence helpers (#1433): detect when the invoking binary's name
// suffix disagrees with HAPI_HOME's basename suffix, which usually means
// HAPI_HOME was inherited from a parent shell (another Hapimatic instance).
// `runSet` refuses to write in that case unless --force is passed; `runStatus`
// and `runDoctor` surface advisory warnings.
export function detectBinarySuffix(execPath: string): string | null {
  if (!execPath) return null;
  const name = basename(execPath);
  const m = name.match(/^hapimatic-(.+?)(?:\.exe)?$/);
  return m ? m[1] : null;
}

export function detectHomeSuffix(happyHomeDir: string): string | null {
  if (!happyHomeDir) return null;
  const name = basename(happyHomeDir);
  const m = name.match(/^\.hapimatic-(.+)$/);
  return m ? m[1] : null;
}

export function instanceCoherenceCheck(
  execPath: string,
  happyHomeDir: string
): { ok: boolean; binarySuffix: string | null; homeSuffix: string | null } {
  const binarySuffix = detectBinarySuffix(execPath);
  const homeSuffix = detectHomeSuffix(happyHomeDir);
  if (!binarySuffix || !homeSuffix) {
    return { ok: true, binarySuffix, homeSuffix };
  }
  return { ok: binarySuffix === homeSuffix, binarySuffix, homeSuffix };
}

interface ParsedFlags {
  json: boolean;
  dryRun: boolean;
  force: boolean;
  includeDead: boolean;
}

function parseFlags(args: string[]): ParsedFlags {
  return {
    json: args.includes("--json") || args.includes("-j"),
    dryRun: args.includes("--dry-run"),
    force: args.includes("--force") || args.includes("-f"),
    includeDead: args.includes("--include-dead"),
  };
}

function which(binary: string): boolean {
  const r = spawnSync("which", [binary], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  return r.status === 0;
}

function runBinary(binary: string, args: string[], timeoutMs: number): boolean {
  const r = spawnSync(binary, args, {
    stdio: ["ignore", "ignore", "ignore"],
    timeout: timeoutMs,
  });
  return r.status === 0;
}

function bunRuntimePresent(): boolean {
  return (
    typeof globalThis.Bun === "object" &&
    typeof globalThis.Bun?.spawn === "function"
  );
}

function checkDependencies(
  kind: ClaudeRemoteLauncherKind
): Record<string, boolean> {
  const deps: Record<string, boolean> = { claude: which("claude") };
  if ((kind as string) === "tmux") {
    deps.tmux = which("tmux");
  }
  return deps;
}

async function resolveStatus(): Promise<{
  resolved: ResolvedLauncher;
  dependencies: Record<string, boolean>;
  settingsValue: string | undefined;
}> {
  const env = process.env.HAPI_CLAUDE_LAUNCHER;
  const settings = await readSettings();
  const settingsValue = settings.launcher;
  const resolved = resolveLauncherKind(env, settingsValue);
  const dependencies = checkDependencies(resolved.kind);
  return { resolved, dependencies, settingsValue };
}

function printStatusHuman(
  resolved: ResolvedLauncher,
  dependencies: Record<string, boolean>
): void {
  console.log(`Active launcher: ${resolved.kind}`);
  console.log(`Source:          ${resolved.source}`);
  if (resolved.rejected) {
    console.log(
      `⚠ Rejected value: ${JSON.stringify(resolved.rejectedValue)} (invalid; fell through)`
    );
  }
  console.log("Dependencies:");
  for (const [name, ok] of Object.entries(dependencies)) {
    console.log(
      `  ${ok ? "✓" : "✗"} ${name}${ok ? "" : " (NOT FOUND on PATH)"}`
    );
  }
}

async function runStatus(flags: ParsedFlags): Promise<number> {
  const { resolved, dependencies } = await resolveStatus();
  const coherence = instanceCoherenceCheck(
    process.execPath,
    configuration.happyHomeDir
  );
  const warnings: string[] = [];
  if (!coherence.ok) {
    warnings.push(
      `Binary '${basename(process.execPath)}' (suffix '${coherence.binarySuffix}') does not match HAPI_HOME '${configuration.happyHomeDir}' (suffix '${coherence.homeSuffix}'). Reading from inherited HAPI_HOME — value may not reflect the binary's expected instance.`
    );
  }
  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          kind: resolved.kind,
          source: resolved.source,
          rejected: resolved.rejected,
          rejectedValue: resolved.rejectedValue ?? null,
          dependencies,
          warnings,
        },
        null,
        2
      )
    );
  } else {
    for (const w of warnings) {
      console.log(`⚠  ${w}`);
    }
    if (warnings.length > 0) console.log("");
    printStatusHuman(resolved, dependencies);
    if ((resolved.kind as string) === "tmux") {
      console.log("");
      console.log(
        "Tip: `hapi launcher attach` lists live claude TUIs on the remote socket to attach to."
      );
    }
  }
  return dependencies.claude === false ? 2 : 0;
}

function restartHint(): string {
  const home = configuration.happyHomeDir;
  if (home.includes(".hapimatic-private")) {
    return "systemctl --user restart hapimatic-private  # ⚠ PROD — disconnects web/PWA clients";
  }
  if (home.includes(".hapimatic-dev")) {
    return "systemctl --user restart hapimatic-dev";
  }
  const wtMatch = home.match(/\.hapimatic-wt-(\d+)/);
  if (wtMatch) {
    return `scripts/worktree-build.sh --restart  # worktree port ${wtMatch[1]}`;
  }
  return "systemctl --user restart <your-hapimatic-service>";
}

async function runSet(
  rawKind: string | undefined,
  flags: ParsedFlags
): Promise<number> {
  if (!rawKind) {
    console.error(
      `Error: missing launcher kind. Usage: hapi launcher set <${VALID_KINDS.join("|")}>`
    );
    return 3;
  }
  const kind = rawKind.trim().toLowerCase();
  if (!(AVAILABLE_LAUNCHER_KINDS as string[]).includes(kind)) {
    console.error(
      `Error: '${rawKind}' is not a valid launcher kind. Available: ${AVAILABLE_LAUNCHER_KINDS.join(", ")}`
    );
    return 3;
  }

  // Instance-coherence gate (#1433): refuse to write when the invoking binary's
  // name suffix doesn't match HAPI_HOME's basename suffix, unless the operator
  // passes --force. Defends against cross-instance contamination where
  // `hapimatic-dev launcher set X` is run from a Hapimatic-private session
  // (where HAPI_HOME=~/.hapimatic-private is inherited from the spawning
  // daemon) and silently writes to PROD's settings.json.
  const coherence = instanceCoherenceCheck(
    process.execPath,
    configuration.happyHomeDir
  );
  if (!coherence.ok && !flags.force) {
    const binName = basename(process.execPath);
    const fixHome = `HAPI_HOME=$HOME/.hapimatic-${coherence.binarySuffix} ${binName} launcher set ${kind}`;
    if (flags.json) {
      console.log(
        JSON.stringify(
          {
            ok: false,
            error: "instance_coherence_check_failed",
            binarySuffix: coherence.binarySuffix,
            homeSuffix: coherence.homeSuffix,
            happyHomeDir: configuration.happyHomeDir,
            settingsFile: configuration.settingsFile,
            fix: fixHome,
            forceFlag: "--force",
          },
          null,
          2
        )
      );
    } else {
      console.error(
        `Error: refusing to write — binary '${binName}' (suffix '${coherence.binarySuffix}') does not match HAPI_HOME '${configuration.happyHomeDir}' (suffix '${coherence.homeSuffix}').`
      );
      console.error(
        "This usually means HAPI_HOME was inherited from a parent shell (e.g., another Hapimatic instance)."
      );
      console.error("");
      console.error(
        `Either pin HAPI_HOME explicitly:\n  ${fixHome}\nOr re-run with --force to write to '${configuration.happyHomeDir}' anyway.`
      );
    }
    return 4;
  }

  await updateSettings(current => ({
    ...current,
    launcher: kind as ClaudeRemoteLauncherKind,
  }));
  const hint = restartHint();
  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          launcher: kind,
          settingsFile: configuration.settingsFile,
          restartCommand: hint,
        },
        null,
        2
      )
    );
  } else {
    console.log(`✓ Wrote launcher='${kind}' to ${configuration.settingsFile}`);
    console.log("");
    console.log("Restart the service for the change to take effect:");
    console.log(`  ${hint}`);
    console.log("");
    console.log(
      "Note: HAPI_CLAUDE_LAUNCHER env var (if set in the service unit) STILL overrides settings.json."
    );
    console.log(
      "Use `hapi launcher status` to confirm the active launcher after restart."
    );
  }
  return 0;
}

interface DoctorCheck {
  n: number;
  name: string;
  pass: boolean;
  detail: string;
}

function scanRecentLogs(): { count: number; sample: string | null } {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  let count = 0;
  let sample: string | null = null;
  let files: string[] = [];
  try {
    files = readdirSync(configuration.logsDir);
  } catch {
    return { count: 0, sample: null };
  }
  const patterns =
    /\[launcherDispatch\]|claudePty\.ts|claudePtyLauncher\.ts|Rejected invalid HAPI_CLAUDE_LAUNCHER/;
  for (const f of files) {
    if (!f.endsWith(".log")) continue;
    const path = join(configuration.logsDir, f);
    try {
      const st = statSync(path);
      if (st.mtimeMs < cutoff) continue;
      const lines = readFileSync(path, "utf8").split("\n");
      for (const line of lines) {
        if (patterns.test(line) && /error|fail|reject/i.test(line)) {
          count++;
          if (!sample) sample = line.slice(0, 200);
        }
      }
    } catch {
      // ignore unreadable logs
    }
  }
  return { count, sample };
}

function recommendAction(
  resolved: ResolvedLauncher,
  checks: DoctorCheck[]
): string {
  const fails = checks.filter(c => !c.pass);
  if (fails.length === 0) return "All checks passed — no action needed.";
  if (!checks[1]?.pass) {
    return `Install missing dependency before using launcher='${resolved.kind}'. See claudedocs/pty-launcher-runbook.md.`;
  }
  if (!checks[2]?.pass) {
    if (resolved.kind === "pty") {
      return "Rebuild Hapimatic with Bun (the PTY launcher requires Bun.spawn from a compiled hapi binary). Run: bun run build:single-exe";
    }
    return `Smoke check failed for launcher='${resolved.kind}'. Review the runbook escalation section.`;
  }
  if (!checks[3]?.pass) {
    return `Recent launcher failures detected — run 'hapi launcher set sdk' to roll back to the safe default, then restart the service.`;
  }
  if (resolved.rejected) {
    return `Fix the rejected ${resolved.source} value (was: ${JSON.stringify(resolved.rejectedValue)}). Use 'hapi launcher set ${resolved.kind}' to write a known-good value.`;
  }
  return "See claudedocs/pty-launcher-runbook.md for guidance.";
}

async function runDoctor(flags: ParsedFlags): Promise<number> {
  const { resolved, dependencies } = await resolveStatus();
  const checks: DoctorCheck[] = [];

  // Check 1: current launcher resolves cleanly via priority chain
  checks.push({
    n: 1,
    name: "Current launcher",
    pass: !resolved.rejected,
    detail: resolved.rejected
      ? `kind=${resolved.kind} (source=${resolved.source}) — but ${resolved.source !== "env" ? "env" : "settings"} value '${resolved.rejectedValue}' was rejected`
      : `kind=${resolved.kind} (source=${resolved.source})`,
  });

  // Check 2: dependencies present on PATH
  const depEntries = Object.entries(dependencies);
  const allDepsOk = depEntries.every(([, ok]) => ok);
  checks.push({
    n: 2,
    name: "Dependencies",
    pass: allDepsOk,
    detail: depEntries
      .map(([k, v]) => `${k}=${v ? "ok" : "MISSING"}`)
      .join(", "),
  });

  // Check 3: binary smoke (per launcher kind) — NEVER spawn a real session
  let smokeOk = false;
  let smokeDetail = "";
  if (resolved.kind === "sdk") {
    if (!dependencies.claude) {
      smokeDetail = "claude binary not on PATH";
    } else {
      const ok = runBinary("claude", ["--version"], 5000);
      smokeOk = ok;
      smokeDetail = ok
        ? "claude --version exited 0 (within 5s)"
        : "claude --version failed or timed out";
    }
  } else if (resolved.kind === "pty") {
    const bunOk = bunRuntimePresent();
    const compiled = isBunCompiled();
    const claudeOk =
      dependencies.claude && runBinary("claude", ["--version"], 5000);
    smokeOk = bunOk && compiled && claudeOk;
    smokeDetail = `Bun.spawn=${bunOk ? "ok" : "MISSING"}, isBunCompiled=${compiled ? "ok" : "FALSE (running in dev mode?)"}, claude --version=${claudeOk ? "ok" : "fail"}`;
  } else if (resolved.kind === "tmux") {
    const claudeOk =
      dependencies.claude && runBinary("claude", ["--version"], 5000);
    const tmuxOk =
      dependencies.tmux === true && runBinary("tmux", ["-V"], 2000);
    smokeOk = claudeOk && tmuxOk;
    smokeDetail = `claude --version=${claudeOk ? "ok" : "fail"}, tmux -V=${tmuxOk ? "ok" : "fail"}`;
  } else {
    smokeDetail = `unsupported launcher kind: ${resolved.kind}`;
  }
  checks.push({
    n: 3,
    name: "Smoke (binary smoke, not session spawn)",
    pass: smokeOk,
    detail: smokeDetail,
  });

  // Check 4: recent launcher failures in last 24h
  const recent = scanRecentLogs();
  checks.push({
    n: 4,
    name: "Recent failures (last 24h)",
    pass: recent.count === 0,
    detail:
      recent.count === 0
        ? "no launcher-related errors found"
        : `${recent.count} entries (sample: ${recent.sample ?? ""})`,
  });

  // Check 5: recommended action
  const action = recommendAction(resolved, checks);
  checks.push({
    n: 5,
    name: "Recommended action",
    pass: true,
    detail: action,
  });

  // Determine exit code
  let exitCode = 0;
  if (!checks[0].pass && resolved.source === "default" && resolved.rejected) {
    exitCode = 3; // invalid kind in env/settings
  } else if (!checks[1].pass) {
    exitCode = 2; // dependency missing
  } else if (!checks[2].pass || !checks[3].pass) {
    exitCode = 1; // runtime/recent-failures
  }

  // Instance-coherence advisory (#1433): non-blocking signal alongside the 5 checks
  const coherence = instanceCoherenceCheck(
    process.execPath,
    configuration.happyHomeDir
  );
  const warnings: string[] = [];
  if (!coherence.ok) {
    warnings.push(
      `Binary '${basename(process.execPath)}' (suffix '${coherence.binarySuffix}') does not match HAPI_HOME '${configuration.happyHomeDir}' (suffix '${coherence.homeSuffix}'). Diagnostic reads from inherited HAPI_HOME — may not reflect the binary's expected instance.`
    );
  }

  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          launcher: {
            kind: resolved.kind,
            source: resolved.source,
            rejected: resolved.rejected,
            rejectedValue: resolved.rejectedValue ?? null,
          },
          checks: checks.map(c => ({
            n: c.n,
            name: c.name,
            pass: c.pass,
            detail: c.detail,
          })),
          recommendedAction: action,
          exitCode,
          warnings,
          coherence: {
            ok: coherence.ok,
            binarySuffix: coherence.binarySuffix,
            homeSuffix: coherence.homeSuffix,
          },
        },
        null,
        2
      )
    );
  } else {
    for (const w of warnings) {
      console.log(`⚠  ${w}`);
    }
    if (warnings.length > 0) console.log("");
    console.log(
      `hapi launcher doctor — active launcher: ${resolved.kind} (${resolved.source})`
    );
    console.log("");
    for (const c of checks) {
      const mark = c.pass ? "PASS" : "FAIL";
      console.log(`[${c.n}/5] ${mark}: ${c.name}`);
      console.log(`        ${c.detail}`);
    }
    console.log("");
    console.log(`Exit code: ${exitCode}`);
  }

  return exitCode;
}

async function runReap(flags: ParsedFlags): Promise<number> {
  const result = await reapOrphanedSessions({
    dryRun: flags.dryRun,
    includeDead: flags.includeDead,
  });
  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          daemonAlive: result.daemonAlive,
          daemonPid: result.daemonPid,
          candidates: result.orphans.map(o => ({
            windowName: o.windowName,
            windowIndex: o.windowIndex,
            paneDead: o.paneDead,
          })),
          killed: result.killed,
          dryRun: result.dryRun,
          foreignSkipped: result.foreignSkipped,
          deadSkipped: result.deadSkipped,
        },
        null,
        2
      )
    );
  } else {
    const aliveMark = result.daemonAlive ? "alive" : "dead";
    const pidStr =
      result.daemonPid !== null ? `pid=${result.daemonPid}` : "pid=unknown";
    console.log(
      `Daemon (${configuration.daemonStateFile}): ${aliveMark} (${pidStr})`
    );
    console.log(
      `Orphan candidates (prefix=${TMUX_REMOTE_WINDOW_PREFIX}): ${result.orphans.length}`
    );
    for (const o of result.orphans) {
      console.log(
        `  - ${o.windowName} (index=${o.windowIndex}, paneDead=${o.paneDead})`
      );
    }
    if (result.foreignSkipped > 0 || result.deadSkipped > 0) {
      const parts: string[] = [];
      if (result.foreignSkipped > 0) {
        parts.push(
          `${result.foreignSkipped} owned by another instance on the shared socket`
        );
      }
      if (result.deadSkipped > 0) {
        parts.push(
          `${result.deadSkipped} dead-pane window(s) — pass --include-dead to reap`
        );
      }
      console.log(`Skipped: ${parts.join("; ")}.`);
    }
    if (result.dryRun) {
      console.log("--dry-run set; no windows killed.");
    } else if (result.orphans.length > 0) {
      console.log(
        `Killed ${result.killed} of ${result.orphans.length} orphan window(s).`
      );
    }
  }
  return 0;
}

/** Human label for a remote window row: human name → tag → placeholder. */
function attachLabel(row: RemoteWindowRow): string {
  return row.displayName ?? row.hapiSessionId ?? "(unidentified)";
}

/** tmux argv to attach the current terminal to a remote-launcher window (#1609 index target). */
function attachCommand(row: RemoteWindowRow): string[] {
  return [
    "-L",
    configuration.tmuxRemoteSessionName,
    "attach",
    "-t",
    `${configuration.tmuxRemoteSessionName}:${row.windowIndex}`,
  ];
}

/** Child env for the attach exec — TMUX stripped so a nested attach from inside
 * tmux doesn't abort with "sessions should be nested with care". */
function attachEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.TMUX;
  return env;
}

function printAttachTable(rows: RemoteWindowRow[]): void {
  console.log(
    `Remote-launcher windows (socket '${configuration.tmuxRemoteSessionName}'):`
  );
  rows.forEach((row, i) => {
    const dead = row.paneDead ? " [dead pane]" : "";
    const tag = row.hapiSessionId ? ` tag=${row.hapiSessionId}` : "";
    console.log(
      `  ${i + 1}. ${attachLabel(row)} — ${row.windowName} (index=${row.windowIndex}${tag})${dead}`
    );
  });
}

function printAttachCommand(row: RemoteWindowRow): void {
  console.log(`Attach to ${attachLabel(row)} (${row.windowName}):`);
  console.log(`  tmux ${attachCommand(row).join(" ")}`);
}

function attachToWindow(row: RemoteWindowRow): number {
  console.log(`Attaching to ${attachLabel(row)} (${row.windowName}) …`);
  const r = spawnSync("tmux", attachCommand(row), {
    stdio: "inherit",
    env: attachEnv(),
  });
  if (r.error) {
    console.error(`Failed to attach: ${r.error.message}`);
    return 1;
  }
  return r.status ?? 0;
}

async function runAttach(
  flags: ParsedFlags,
  query: string | undefined
): Promise<number> {
  const rows = await listRemoteLauncherWindows();

  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          windows: rows.map(r => ({
            windowName: r.windowName,
            windowIndex: r.windowIndex,
            hapiSessionId: r.hapiSessionId,
            displayName: r.displayName,
            paneDead: r.paneDead,
          })),
        },
        null,
        2
      )
    );
    return 0;
  }

  // Instance-coherence advisory (non-blocking; mirror runStatus). Display names
  // resolve against the inherited HAPI_HOME's store — flag a mismatch so an
  // operator listing from a foreign shell isn't surprised by tag-only rows.
  const coherence = instanceCoherenceCheck(
    process.execPath,
    configuration.happyHomeDir
  );
  if (!coherence.ok) {
    console.log(
      `⚠  Binary '${basename(process.execPath)}' (suffix '${coherence.binarySuffix}') does not match HAPI_HOME '${configuration.happyHomeDir}' (suffix '${coherence.homeSuffix}'). Display names resolve against that instance's store; windows from other instances list with tag-only identity.`
    );
    console.log("");
  }

  if (rows.length === 0) {
    console.log(
      `No remote-launcher windows on socket '${configuration.tmuxRemoteSessionName}'.`
    );
    console.log(
      "(Live claude TUIs appear here only under the tmux launcher — `hapi launcher status`.)"
    );
    return 0;
  }

  // No query → list all (no-arg lists; never auto-attaches).
  if (!query) {
    printAttachTable(rows);
    console.log("");
    console.log(
      "Attach by session name or issue number, e.g. `hapi launcher attach 1652`."
    );
    return 0;
  }

  const matched = matchRemoteWindowRows(rows, query);

  if (matched.length === 0) {
    console.log(`No window matched '${query}'. All remote-launcher windows:`);
    printAttachTable(rows);
    return 1;
  }

  if (matched.length === 1) {
    const row = matched[0];
    // Unique match: attach when interactive, else print the command (Fallback
    // Preservation Rule — never dead-end a non-TTY caller).
    if (process.stdout.isTTY) {
      return attachToWindow(row);
    }
    printAttachCommand(row);
    return 0;
  }

  // Ambiguous → show the filtered table so the operator can refine.
  console.log(
    `'${query}' matched ${matched.length} windows — refine the query:`
  );
  printAttachTable(matched);
  return 0;
}

function printHelp(isError = false): number {
  const out = isError ? console.error : console.log;
  out("Usage: hapi launcher <status|set|doctor|reap|attach> [flags]");
  out("");
  out("Subcommands:");
  out(
    "  status [--json]                Print active launcher + source + dependencies"
  );
  out(
    "  set <kind> [--json] [--force]  Persist launcher choice to settings.json"
  );
  out(
    "                                 (does NOT restart the service — prints the command)"
  );
  out(
    "                                 --force bypasses the binary↔HAPI_HOME coherence check"
  );
  out("  doctor [--json]                Run 5-check health diagnostic");
  out(
    "  reap [--dry-run] [--json]      Kill orphaned remote tmux windows whose"
  );
  out(
    "       [--include-dead]          daemon (per daemon.state.json) is dead."
  );
  out(
    "                                 Reaps ONLY this instance's own windows on the"
  );
  out(
    "                                 shared socket; --include-dead also reaps windows"
  );
  out("                                 with an unreadable (dead) pane.");
  out(
    "  attach [query] [--json]        List live remote-launcher claude windows"
  );
  out(
    "                                 (hapi-remote-* on the shared socket) with human"
  );
  out(
    "                                 session names. With a TTY + a unique query match,"
  );
  out(
    "                                 attach to that window's Claude TUI; non-TTY prints"
  );
  out(
    "                                 the tmux command. query fuzzy-matches session"
  );
  out(
    "                                 name / issue number. No-arg lists all."
  );
  out("");
  out(`Available launcher kinds: ${AVAILABLE_LAUNCHER_KINDS.join(", ")}`);
  out("");
  out(
    "Priority chain: HAPI_CLAUDE_LAUNCHER env > settings.json launcher > 'sdk' default"
  );
  out("");
  out("Runbook: claudedocs/pty-launcher-runbook.md");
  return isError ? 1 : 0;
}

export const launcherCommand: CommandDefinition = {
  name: "launcher",
  requiresRuntimeAssets: false,
  run: async ({ commandArgs }) => {
    const sub = commandArgs[0];
    const rest = commandArgs.slice(1);
    let exit = 0;
    if (sub === "status") {
      exit = await runStatus(parseFlags(rest));
    } else if (sub === "set") {
      const kind = rest[0];
      exit = await runSet(kind, parseFlags(rest.slice(1)));
    } else if (sub === "doctor") {
      exit = await runDoctor(parseFlags(rest));
    } else if (sub === "reap") {
      exit = await runReap(parseFlags(rest));
    } else if (sub === "attach") {
      // First non-flag arg is the fuzzy query (session name / issue number).
      const query = rest.find(a => !a.startsWith("-"));
      exit = await runAttach(parseFlags(rest), query);
    } else if (sub === undefined) {
      exit = printHelp(false);
    } else {
      console.error(`Error: unknown subcommand '${sub}'`);
      console.error("");
      exit = printHelp(true);
    }
    process.exit(exit);
  },
};
