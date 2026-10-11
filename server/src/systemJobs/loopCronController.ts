// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ErrorLogger } from "../logging/errorLogger";
import { classifyTickMessage, type LoopCronVerdict } from "./loopCronReader";

/**
 * loop-cron mutation controller (issue #2453, Task 3).
 *
 * The SOLE write path into `~/.claude/scripts/loop-cron.sh` (R9): pause / resume
 * / stop / purge / run(tick) / editSchedule(stop + arm --id --no-probe). NEVER
 * touches the crontab directly, NEVER `rm -rf`s a state dir (that is why Task 0
 * added `purge`).
 *
 * Safety posture:
 *  - Absolute-path + arg-array `execFile` (no shell) — `~` would be ENOENT and
 *    argv reaches execvp verbatim, so there is no interpolation/injection surface.
 *  - Every id is validated to the arm-time shape `^lc-<14 digits>-<pid>-<rand>$`,
 *    the magic `all` / `.` / `..` are rejected explicitly, AND the id must be a
 *    member of the caller's discovered-id allowlist before any exec.
 *  - ALWAYS async exec with an explicit timeout + SIGKILL — a `tick` can run
 *    ~155s worst case (bounded curls + a 120s gate); a sync exec would stall the
 *    Bun event loop (all SSE / websockets) for minutes.
 *  - Crontab-touching verbs (stop / purge / editSchedule) run under a per-process
 *    async mutex — `arm`/`remove_cron` are unlocked whole-crontab read-modify
 *    writes, so two overlapping server mutations could lose an update.
 */

export class LoopCronError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid-id"
      | "unknown-id"
      | "invalid-interval"
      | "invalid-action"
      | "exec-failed"
      | "timeout"
      | "bad-output" = "exec-failed",
    readonly stderr?: string
  ) {
    super(message);
    this.name = "LoopCronError";
  }
}

/** Result of a control-verb exec (raw). */
export interface LoopCronExecResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
}

/** Injectable exec seam (test hook). Absolute path, arg array, no shell. */
export type LoopCronExecFn = (
  scriptPath: string,
  args: string[],
  opts: { timeoutMs: number }
) => Promise<LoopCronExecResult>;

/** The verdict of a real tick (R4) plus the raw channels it was derived from. */
export interface RunNowResult {
  verdict: LoopCronVerdict;
  /** The parsed `DECISION:` value (script stdout), when present. */
  decision: string | null;
  exitCode: number;
  timedOut: boolean;
}

/** Echo shape of pause/resume/stop/purge. */
export interface LoopCronMutationResult {
  ok: boolean;
  id: string;
  label: string | null;
  sessionTag: string | null;
  /** The verb the script acknowledged (paused/resumed/stopped/purged). */
  verb: "paused" | "resumed" | "stopped" | "purged";
}

/** arm's echo shape (subset we consume). */
export interface LoopCronArmResult {
  ok: boolean;
  id: string;
  interval: string;
  firstTickNote?: string;
}

/** Echo shape of editAction (#3293) — confirms the persisted action text. */
export interface LoopCronEditActionResult {
  ok: boolean;
  id: string;
  /** The action text now persisted to action.txt (echoed back for confirmation). */
  actionText: string;
}

export interface LoopCronControllerDeps {
  /** Path to loop-cron.sh; default `~/.claude/scripts/loop-cron.sh`. */
  scriptPath?: string;
  /** Root of the state dirs; default `~/.claude/state/loop-cron`. */
  stateDirRoot?: string;
  /** Test seam — async exec. Default node execFile with timeout + SIGKILL. */
  execFn?: LoopCronExecFn;
  /** Test seam — read a file utf8 (raw config for re-arm / verdict fallback). */
  readFileFn?: (path: string) => string;
  /** Test seam — write a file utf8 (the action.txt edit path, #3293). */
  writeFileFn?: (path: string, content: string) => void;
  errorLogger?: ErrorLogger | null;
}

/** arm-time id shape: `lc-<14 digit UTC stamp>-<pid>-<rand>` (loop-cron.sh:1032). */
const LOOP_ID_RE = /^lc-\d{14}-\d+-\d+$/;
/** arm's interval grammar (loop-cron.sh interval_to_cron): 1-59m or 1-23h. */
const INTERVAL_RE = /^([1-9]|[1-5][0-9])m$|^([1-9]|1[0-9]|2[0-3])h$/;

const TICK_TIMEOUT_MS = 175_000; // worst-case tick ≈155s + margin
const MUTATE_TIMEOUT_MS = 30_000; // pause/resume flock -w 20 + margin
const ARM_TIMEOUT_MS = 45_000; // arm resolves the session over the network (3× curl -m 10)

/** DECISION: <v> (stdout) → R4 verdict. Six values (loop-cron.sh, ungated by Task 0). */
const DECISION_TO_VERDICT: Record<string, LoopCronVerdict> = {
  paused: "skipped:paused",
  done: "done",
  "user-backoff": "skipped:backoff",
  "gate-noop": "skipped:gate",
  sent: "sent",
  "send-failed": "send-failed",
};

/** last_status (config.json) → R4 verdict. Nine values; lifecycle ones map to unknown. */
const LAST_STATUS_TO_VERDICT: Record<string, LoopCronVerdict> = {
  armed: "unknown",
  paused: "skipped:paused",
  resumed: "unknown",
  stopped: "unknown",
  done: "done",
  "user-backoff": "skipped:backoff",
  "gate-noop": "skipped:gate",
  sent: "sent",
  "send-failed": "send-failed",
};

/** Map a DECISION: value to a verdict (unknown for an unrecognized value). */
export function decisionToVerdict(decision: string): LoopCronVerdict {
  return DECISION_TO_VERDICT[decision] ?? "unknown";
}

/** Map a last_status value to a verdict (unknown for an unrecognized value). */
export function lastStatusToVerdict(status: string): LoopCronVerdict {
  return LAST_STATUS_TO_VERDICT[status] ?? "unknown";
}

const defaultExec: LoopCronExecFn = (scriptPath, args, opts) =>
  new Promise(resolve => {
    execFile(
      scriptPath,
      args,
      {
        timeout: opts.timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 4 * 1024 * 1024,
        encoding: "utf8",
      },
      (err, stdout, stderr) => {
        const e = err as (Error & { code?: unknown; killed?: boolean }) | null;
        const timedOut = !!(e && e.killed);
        let code = 0;
        if (e) code = typeof e.code === "number" ? e.code : timedOut ? 124 : 1;
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          code,
          timedOut,
        });
      }
    );
  });

export class LoopCronController {
  private readonly scriptPath: string;
  private readonly stateDirRoot: string;
  private readonly execFn: LoopCronExecFn;
  private readonly readFileFn: (path: string) => string;
  private readonly writeFileFn: (path: string, content: string) => void;
  private readonly errorLogger: ErrorLogger | null;
  /** Serializes crontab-touching verbs (stop / purge / editSchedule). */
  private crontabQueue: Promise<unknown> = Promise.resolve();

  constructor(deps: LoopCronControllerDeps = {}) {
    this.scriptPath =
      deps.scriptPath ?? join(homedir(), ".claude/scripts/loop-cron.sh");
    this.stateDirRoot =
      deps.stateDirRoot ?? join(homedir(), ".claude/state/loop-cron");
    this.execFn = deps.execFn ?? defaultExec;
    this.readFileFn =
      deps.readFileFn ?? ((p: string) => readFileSync(p, "utf8"));
    this.writeFileFn =
      deps.writeFileFn ??
      ((p: string, c: string) => writeFileSync(p, c, "utf8"));
    this.errorLogger = deps.errorLogger ?? null;
  }

  // ── mutation verbs ─────────────────────────────────────────────────────────

  async pause(
    id: string,
    knownIds: Iterable<string>
  ): Promise<LoopCronMutationResult> {
    this.assertSafeId(id, knownIds);
    return this.runMutation("paused", ["pause", id], MUTATE_TIMEOUT_MS);
  }

  async resume(
    id: string,
    knownIds: Iterable<string>
  ): Promise<LoopCronMutationResult> {
    this.assertSafeId(id, knownIds);
    return this.runMutation("resumed", ["resume", id], MUTATE_TIMEOUT_MS);
  }

  /** stop: remove the crontab line, PRESERVE state. Crontab-touching → mutex. */
  async stop(
    id: string,
    knownIds: Iterable<string>
  ): Promise<LoopCronMutationResult> {
    this.assertSafeId(id, knownIds);
    return this.withCrontabLock(() =>
      this.runMutation("stopped", ["stop", id], MUTATE_TIMEOUT_MS)
    );
  }

  /** deleteLoop: purge = remove crontab line AND delete state (D1). The one irreversible verb. */
  async deleteLoop(
    id: string,
    knownIds: Iterable<string>
  ): Promise<LoopCronMutationResult> {
    this.assertSafeId(id, knownIds);
    return this.withCrontabLock(() =>
      this.runMutation("purged", ["purge", id], MUTATE_TIMEOUT_MS)
    );
  }

  /**
   * Run a real tick (R4) and return the verdict. NOT under the crontab mutex —
   * a tick only touches the crontab on the rare DONE path, and holding the mutex
   * for the ~155s worst case would serialize every mutation behind a slow tick.
   */
  async runNow(id: string, knownIds: Iterable<string>): Promise<RunNowResult> {
    this.assertSafeId(id, knownIds);
    const res = await this.execFn(this.scriptPath, ["tick", id], {
      timeoutMs: TICK_TIMEOUT_MS,
    });
    if (res.timedOut) {
      throw new LoopCronError(
        `loop-cron tick timed out after ${TICK_TIMEOUT_MS}ms (killed)`,
        "timeout"
      );
    }
    const decision = this.parseDecision(res.stdout);
    let verdict: LoopCronVerdict;
    if (decision) {
      verdict = decisionToVerdict(decision);
    } else {
      // No DECISION line: the token/auth/session-state/action-empty/concurrent
      // early-returns log to tick.log without echoing DECISION. Read the freshest
      // terminal tick.log verdict; then fall back to last_status. Never sent.
      verdict =
        this.newestTickLogVerdict(id) ??
        this.lastStatusVerdict(id) ??
        "unknown";
    }
    return { verdict, decision, exitCode: res.code, timedOut: false };
  }

  /**
   * editSchedule = stop + `arm --id <id> --no-probe`, re-armed from the loop's
   * PRESERVED raw config (so the id, `?highlight=` deep links, `ticks`, and
   * `tick.log` survive and no destructive gate probe fires). Crontab-touching on
   * both legs → the whole composite holds the mutex so nothing interleaves.
   */
  async editSchedule(
    id: string,
    newInterval: string,
    knownIds: Iterable<string>
  ): Promise<LoopCronArmResult> {
    this.assertSafeId(id, knownIds);
    if (!INTERVAL_RE.test(newInterval)) {
      throw new LoopCronError(
        `invalid interval '${newInterval}' — use Nm (1-59) or Nh (1-23)`,
        "invalid-interval"
      );
    }
    const cfg = this.readRawConfig(id);
    const armArgs = this.buildRearmArgs(id, newInterval, cfg);
    return this.withCrontabLock(async () => {
      await this.runMutation("stopped", ["stop", id], MUTATE_TIMEOUT_MS);
      const res = await this.execFn(this.scriptPath, armArgs, {
        timeoutMs: ARM_TIMEOUT_MS,
      });
      if (res.timedOut) {
        throw new LoopCronError(
          `loop-cron arm (re-schedule) timed out after ${ARM_TIMEOUT_MS}ms`,
          "timeout"
        );
      }
      if (res.code !== 0) {
        throw new LoopCronError(
          `loop-cron arm (re-schedule) failed (exit ${res.code})`,
          "exec-failed",
          res.stderr
        );
      }
      const parsed = this.parseJson(res.stdout);
      return {
        ok: parsed.ok === true,
        id: typeof parsed.id === "string" ? parsed.id : id,
        interval:
          typeof parsed.interval === "string" ? parsed.interval : newInterval,
        firstTickNote:
          typeof parsed.first_tick_note === "string"
            ? parsed.first_tick_note
            : undefined,
      };
    });
  }

  /**
   * editAction (#3293) = a guarded DIRECT write of the loop's `action.txt` — the
   * prompt/command a tick sends. Deliberately does NOT re-arm the crontab: the
   * armed cron line references `--action-file`, whose content is read fresh at
   * tick time, so a content change takes effect on the next tick with no re-arm.
   * Runs under the same serialization mutex as stop/purge/editSchedule so it
   * cannot interleave with a re-arm reading the config or a purge deleting the
   * state dir. Rejects empty/whitespace-only text (the sole write path must
   * self-protect — an empty action.txt yields the `error:action-empty` tick
   * verdict). NOT an exec — a filesystem write, so no timeout/SIGKILL machinery.
   */
  async editAction(
    id: string,
    actionText: string,
    knownIds: Iterable<string>
  ): Promise<LoopCronEditActionResult> {
    this.assertSafeId(id, knownIds);
    if (actionText.trim().length === 0) {
      throw new LoopCronError(
        "action text must not be empty",
        "invalid-action"
      );
    }
    const actionFile = join(this.stateDirRoot, id, "action.txt");
    return this.withCrontabLock(async () => {
      try {
        // Persist verbatim — the tick sends the file's content, so preserve the
        // user's prompt exactly (only whitespace-only is rejected, above).
        this.writeFileFn(actionFile, actionText);
      } catch (e) {
        throw new LoopCronError(
          `failed to write action.txt for ${id}: ${
            e instanceof Error ? e.message : String(e)
          }`,
          "exec-failed"
        );
      }
      return { ok: true, id, actionText };
    });
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async runMutation(
    verb: LoopCronMutationResult["verb"],
    args: string[],
    timeoutMs: number
  ): Promise<LoopCronMutationResult> {
    const res = await this.execFn(this.scriptPath, args, { timeoutMs });
    if (res.timedOut) {
      throw new LoopCronError(
        `loop-cron ${args[0]} timed out after ${timeoutMs}ms`,
        "timeout"
      );
    }
    if (res.code !== 0) {
      throw new LoopCronError(
        `loop-cron ${args[0]} failed (exit ${res.code})`,
        "exec-failed",
        res.stderr
      );
    }
    const parsed = this.parseJson(res.stdout);
    // The verb echoes {ok:true, <verb>:$id, label, session_tag}.
    const idOut = parsed[verb];
    return {
      ok: parsed.ok === true,
      id: typeof idOut === "string" ? idOut : args[1],
      label: typeof parsed.label === "string" ? parsed.label : null,
      sessionTag:
        typeof parsed.session_tag === "string" ? parsed.session_tag : null,
      verb,
    };
  }

  /** Reconstruct `arm <interval> --id <id> --no-probe …` from the raw config. */
  private buildRearmArgs(
    id: string,
    interval: string,
    cfg: Record<string, unknown>
  ): string[] {
    const session = strOrNull(cfg.session_tag) ?? strOrNull(cfg.session_uuid);
    if (!session) {
      throw new LoopCronError(
        `cannot re-schedule ${id}: config has no session_tag or session_uuid`,
        "bad-output"
      );
    }
    const actionFile = join(this.stateDirRoot, id, "action.txt");
    const args = [
      "arm",
      interval,
      "--id",
      id,
      "--no-probe",
      "--session",
      session,
      "--action-file",
      actionFile,
    ];
    const apiBase = strOrNull(cfg.api_base);
    if (apiBase) args.push("--api-base", apiBase);
    const settings = strOrNull(cfg.settings);
    if (settings) args.push("--settings", settings);
    // --label is always passed (verbatim, may be "") to preserve the loop's name.
    args.push("--label", typeof cfg.label === "string" ? cfg.label : "");
    const sentinel = strOrNull(cfg.done_sentinel);
    if (sentinel) args.push("--until-done", sentinel);
    const gate = strOrNull(cfg.gate_command);
    if (gate) args.push("--gate-command", gate);
    const hb = numOrNull(cfg.heartbeat_ticks);
    if (hb !== null) args.push("--heartbeat-ticks", String(hb));
    // --user-backoff-window / --model-watch ONLY when non-null — passing a literal
    // "null" dies in arm's numeric / on|off validators.
    const ubw = numOrNull(cfg.user_backoff_window_s);
    if (ubw !== null) args.push("--user-backoff-window", String(ubw));
    const mw = strOrNull(cfg.model_watch);
    if (mw === "on" || mw === "off") args.push("--model-watch", mw);
    return args;
  }

  private readRawConfig(id: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(
        this.readFileFn(join(this.stateDirRoot, id, "config.json"))
      );
      if (parsed && typeof parsed === "object") {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through
    }
    throw new LoopCronError(
      `cannot re-schedule ${id}: config.json unreadable`,
      "bad-output"
    );
  }

  private parseDecision(stdout: string): string | null {
    let found: string | null = null;
    for (const line of stdout.split("\n")) {
      const m = line.match(/^DECISION:\s*(\S+)\s*$/);
      if (m) found = m[1]; // last DECISION wins (one per tick in practice)
    }
    return found;
  }

  private newestTickLogVerdict(id: string): LoopCronVerdict | null {
    let lines: string[];
    try {
      lines = this.readFileFn(join(this.stateDirRoot, id, "tick.log")).split(
        "\n"
      );
    } catch {
      return null;
    }
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      const sp = line.indexOf(" ");
      const message = sp < 0 ? line : line.slice(sp + 1).trim();
      const verdict = classifyTickMessage(message);
      if (verdict) return verdict;
    }
    return null;
  }

  private lastStatusVerdict(id: string): LoopCronVerdict | null {
    try {
      const cfg = JSON.parse(
        this.readFileFn(join(this.stateDirRoot, id, "config.json"))
      );
      const status = cfg?.last_status;
      return typeof status === "string" ? lastStatusToVerdict(status) : null;
    } catch {
      return null;
    }
  }

  private parseJson(stdout: string): Record<string, unknown> {
    const trimmed = stdout.trim();
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through
    }
    throw new LoopCronError(
      `loop-cron produced unparseable output: ${trimmed.slice(0, 160)}`,
      "bad-output"
    );
  }

  /**
   * Reject anything that is not a real, discovered loop id BEFORE any exec. The
   * arm-time shape rejects `all` / `.` / `..` structurally (none match); the
   * explicit checks give a precise error; the allowlist stops a well-shaped but
   * nonexistent id from reaching the script.
   */
  private assertSafeId(id: string, knownIds: Iterable<string>): void {
    if (id === "all" || id === "." || id === "..") {
      throw new LoopCronError(
        `rejected reserved loop id '${id}'`,
        "invalid-id"
      );
    }
    if (!LOOP_ID_RE.test(id)) {
      throw new LoopCronError(`malformed loop id '${id}'`, "invalid-id");
    }
    const set = knownIds instanceof Set ? knownIds : new Set(knownIds);
    if (!set.has(id)) {
      throw new LoopCronError(
        `unknown loop id '${id}' (not in the discovered crontab/state)`,
        "unknown-id"
      );
    }
  }

  private withCrontabLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.crontabQueue.then(fn, fn);
    // Keep the chain alive regardless of success/failure of the wrapped op.
    this.crontabQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function numOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return null;
}
