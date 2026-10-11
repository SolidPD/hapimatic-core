// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Cron } from "croner";

import type { ErrorLogger } from "../logging/errorLogger";

/**
 * loop-cron state reader (issue #2453, Task 2).
 *
 * READ-ONLY normalization of the `~/.claude/scripts/loop-cron.sh` state dirs
 * (`~/.claude/state/loop-cron/<id>/{config.json,action.txt,tick.log}`) into a
 * `LoopCronInfo` the portal can render. This module NEVER mutates loop state —
 * every write goes through `loopCronController` shelling out to `loop-cron.sh`
 * (R9). Best-effort per id: a missing/corrupt state dir yields a minimal record,
 * never throws.
 *
 * The join key from the crontab side is Task 1's `# LOOP-CRON:<id>` marker; the
 * ids discovered there are passed to `read()`. State dirs with no crontab line
 * (a stopped or self-terminated `done` loop) are ALSO enumerated so they surface
 * as orphaned/stalled cards until purged (the rp1-home#1280 immortal-loop class,
 * the reason Task 0 added `purge`).
 */

/** Badge/summary state (R1). `worstState` in the summary is exactly these three. */
export type LoopCronState = "live" | "paused" | "stalled";

/**
 * The widened Run-now / run-history verdict (R4 + D2). The script emits six
 * `DECISION:` values and eleven distinct tick outcomes; a 4-member enum could not
 * represent a failed send, an auth failure, or a self-terminated loop, which is
 * the exact silent ambiguity this feature removes. `error:*` flattens the four
 * distinguishable hard-error `SKIP:` outcomes; `unknown` is the honest catch-all
 * — success (`sent`) is NEVER a fallback.
 */
export type LoopCronVerdict =
  | "sent"
  | "send-failed"
  | "skipped:paused"
  | "skipped:gate"
  | "skipped:backoff"
  | "skipped:concurrent"
  | "done"
  | "error:token"
  | "error:auth"
  | "error:session-state"
  | "error:action-empty"
  | "unknown";

/** One parsed recent tick.log terminal outcome (newest first in `runHistory`). */
export interface LoopCronRunEntry {
  /** ms since epoch of the log line, or null if the line's stamp is unparseable. */
  atMs: number | null;
  /** The mapped verdict — honest skip reasons, no false-green. */
  verdict: LoopCronVerdict;
  /** The raw log message (timestamp stripped) for display. */
  message: string;
}

/**
 * Normalized loop-cron record. EVERY config-derived field is optional/nullable:
 * of the live state dirs only a subset carry `paused`, and older entries lack
 * `gate_command` / `consecutive_noops` / `user_backoff_window_s` / `session_tag`
 * / `last_user_activity_utc` entirely (Task 2 optionality warning). All
 * timestamps are emitted as ms numbers (never raw ISO strings) so the web union
 * does not gain a third timestamp unit.
 */
export interface LoopCronInfo {
  id: string;
  /** config.label, falling back to `id` when empty/absent. */
  label: string;
  sessionUuid: string | null;
  sessionTag: string | null;
  apiBase: string | null;
  /** Parsed port of `apiBase` — the D5 own-instance discriminator. */
  apiBasePort: number | null;
  /** Human label for the loop's target instance (prod/dev/worktree/host:port). */
  instanceLabel: string;
  settings: string | null;
  intervalHuman: string | null;
  intervalCron: string | null;
  gateCommand: string | null;
  heartbeatTicks: number | null;
  consecutiveNoops: number | null;
  /** Raw `user_backoff_window_s` from config (may be null or 0). */
  userBackoffWindowS: number | null;
  /** The applied backoff: `cfg ?? (gate_command ? 900 : 0)` (`??`, never `||`). */
  effectiveBackoffS: number;
  modelWatch: string | null;
  doneSentinel: string | null;
  paused: boolean;
  ticks: number | null;
  lastStatus: string | null;
  createdAtMs: number | null;
  lastTickAtMs: number | null;
  pausedAtMs: number | null;
  doneAtMs: number | null;
  lastUserActivityAtMs: number | null;
  /** Newest tick.log line stamp — the liveness signal (log() fires on all outcomes). */
  newestTickLogAtMs: number | null;
  /** Next scheduled fire (croner, from intervalCron), or null when unscheduled. */
  nextFireAtMs: number | null;
  /** Derived state (R1). */
  state: LoopCronState;
  /** Send-failed axis (amber card overlay) — distinct from `state` (R4/Task 9). */
  degraded: boolean;
  /** Self-terminated via DONE sentinel (clean completion, distinct from stalled). */
  done: boolean;
  /** Whether an installed crontab line was discovered for this id (Task 1). */
  hasCrontabLine: boolean;
  /** action.txt content (read-only provenance), or null if absent/empty. */
  action: string | null;
  /** Recent terminal tick outcomes, newest first. */
  runHistory: LoopCronRunEntry[];
}

/**
 * Terminal tick-outcome matchers, in precedence order (the script's own order).
 * Each maps a tick.log MESSAGE (timestamp already stripped) to an R4 verdict.
 * Anchored to the START of the message + a discriminating token so precursor
 * lines (`gate: escalate`, `gate: no-op but heartbeat floor …`, model-watch,
 * zombie, config-write, armed) match NONE of these and are filtered out of the
 * run history rather than mis-mapped. Verified against loop-cron.sh (live, 1406
 * lines): 317/330/352/359/374/458/570/799/828/889/905.
 */
const TERMINAL_MATCHERS: ReadonlyArray<[RegExp, LoopCronVerdict]> = [
  [/^SKIP: paused\b/, "skipped:paused"],
  [/^SKIP: prior tick still running\b/, "skipped:concurrent"],
  [/^SKIP: token unreadable\b/, "error:token"],
  [/^SKIP: auth failed\b/, "error:auth"],
  [/^SKIP: session .* state unreadable\b/, "error:session-state"],
  [/^SKIP: action\.txt empty\b/, "error:action-empty"],
  [/^DONE sentinel matched\b/, "done"],
  [/^user-priority backoff:/, "skipped:backoff"],
  // `gate: no-op (n/hb) — no turn fired` — the paren form is unique to the
  // no-op RETURN path; `gate: no-op but heartbeat floor …` has no paren and is a
  // precursor to a send, so it is deliberately NOT matched here.
  [/^gate: no-op \(\d+\/\d+\)/, "skipped:gate"],
  [/^tick sent \(active=/, "sent"],
  [/^send FAILED\b/, "send-failed"],
];

/**
 * Classify a tick.log MESSAGE. Returns the verdict for a terminal outcome, or
 * `null` for a recognized precursor/informational line (filtered from history).
 * A message that matches nothing is treated by the caller as `unknown` — never
 * as `sent`.
 */
export function classifyTickMessage(message: string): LoopCronVerdict | null {
  for (const [re, verdict] of TERMINAL_MATCHERS) {
    if (re.test(message)) return verdict;
  }
  return null;
}

/** Parse an ISO-8601 (or any Date-parseable) stamp to ms, or null. */
function isoToMs(v: unknown): number | null {
  if (typeof v !== "string" || v.length === 0) return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

/** Coerce a config value to a finite number, else null. */
function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Coerce a config value to a non-empty string, else null. */
function toStr(v: unknown): string | null {
  if (typeof v === "string" && v.length > 0) return v;
  return null;
}

/** Human interval (`4m`, `1h`) → ms, or null when unparseable. */
function intervalHumanToMs(human: string | null): number | null {
  if (!human) return null;
  const m = human.match(/^(\d+)\s*m$/i);
  if (m) return Number(m[1]) * 60_000;
  const h = human.match(/^(\d+)\s*h$/i);
  if (h) return Number(h[1]) * 3_600_000;
  return null;
}

/** Display label for a loop's target instance from its api_base. */
export function instanceLabelFor(apiBase: string | null): string {
  if (!apiBase) return "unknown";
  try {
    const u = new URL(apiBase);
    const port = u.port || (u.protocol === "https:" ? "443" : "80");
    const known: Record<string, string> = { "3008": "prod", "3009": "dev" };
    let role = known[port];
    if (!role) {
      const p = Number(port);
      if (p >= 3010 && p <= 3019) role = "worktree";
    }
    return role ? `${role} (${u.hostname}:${port})` : `${u.hostname}:${port}`;
  } catch {
    return apiBase;
  }
}

function portOf(apiBase: string | null): number | null {
  if (!apiBase) return null;
  try {
    const u = new URL(apiBase);
    const port = u.port || (u.protocol === "https:" ? "443" : "80");
    return toNum(port);
  } catch {
    return null;
  }
}

export interface LoopCronReaderDeps {
  /** Root of the state dirs. Default `~/.claude/state/loop-cron`. */
  stateDirRoot?: string;
  /** Test seam — read a file as utf8 (throws like a missing file). */
  readFileFn?: (path: string) => string;
  /** Test seam — list a dir's entries (throws like a missing dir). */
  readdirFn?: (path: string) => string[];
  /** Test seam — current time in ms (staleness + next-fire). */
  now?: () => number;
  errorLogger?: ErrorLogger | null;
}

/** How many trailing tick.log lines to parse (bounds work on huge logs). */
const TICKLOG_TAIL_LINES = 250;
/** How many terminal outcomes to surface in the run history. */
const RUN_HISTORY_LIMIT = 15;
/** Minimum stale threshold regardless of interval. */
const STALE_FLOOR_MS = 2 * 60_000;

/** Reads + normalizes loop-cron state. Best-effort; never throws. */
export class LoopCronReader {
  private readonly root: string;
  private readonly readFileFn: (path: string) => string;
  private readonly readdirFn: (path: string) => string[];
  private readonly now: () => number;

  constructor(private readonly deps: LoopCronReaderDeps = {}) {
    this.root = deps.stateDirRoot ?? join(homedir(), ".claude/state/loop-cron");
    this.readFileFn =
      deps.readFileFn ?? ((p: string) => readFileSync(p, "utf8"));
    this.readdirFn = deps.readdirFn ?? ((p: string) => readdirSync(p));
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Read all loops: the union of ids discovered in the crontab (Task 1) and the
   * state dirs on disk. `hasCrontabLine` is true only for the former.
   */
  read(crontabLoopIds: string[] = []): LoopCronInfo[] {
    const cronSet = new Set(crontabLoopIds);
    const ids = new Set<string>(crontabLoopIds);
    try {
      for (const entry of this.readdirFn(this.root)) {
        // loop-cron ids are `lc-<14 digits>-<pid>-<rand>`; be permissive but skip
        // dotfiles / non-loop siblings.
        if (entry.startsWith("lc-")) ids.add(entry);
      }
    } catch {
      // No state root (fresh host / wrong user) — fall back to crontab ids only.
    }
    const out: LoopCronInfo[] = [];
    for (const id of ids) {
      out.push(this.readOne(id, cronSet.has(id)));
    }
    return out;
  }

  /** Best-effort read of one loop. Never throws — corrupt input → minimal record. */
  readOne(id: string, hasCrontabLine: boolean): LoopCronInfo {
    const dir = join(this.root, id);
    const cfg = this.readJson(join(dir, "config.json"));
    const action = this.readActionText(join(dir, "action.txt"));
    const { runHistory, newestTickLogAtMs } = this.readTickLog(
      join(dir, "tick.log")
    );

    const label = toStr(cfg.label) ?? id;
    const apiBase = toStr(cfg.api_base);
    const intervalHuman = toStr(cfg.interval_human);
    const intervalCron = toStr(cfg.interval_cron);
    const gateCommand = toStr(cfg.gate_command);
    const paused = cfg.paused === true;
    const lastStatus = toStr(cfg.last_status);
    const doneAtMs = isoToMs(cfg.done_utc);
    const done = lastStatus === "done" || doneAtMs !== null;

    const userBackoffWindowS = toNum(cfg.user_backoff_window_s);
    const effectiveBackoffS = userBackoffWindowS ?? (gateCommand ? 900 : 0);

    const nowMs = this.now();
    const intervalMs =
      intervalHumanToMs(intervalHuman) ?? this.intervalFromCron(intervalCron);
    const nextFireAtMs = this.nextFire(intervalCron, nowMs);

    const newestVerdict = runHistory.length > 0 ? runHistory[0].verdict : null;

    const state = this.deriveState({
      paused,
      hasCrontabLine,
      done,
      newestTickLogAtMs,
      lastTickAtMs: isoToMs(cfg.last_tick_utc),
      createdAtMs: isoToMs(cfg.created_utc),
      intervalMs,
      newestVerdict,
      nowMs,
    });

    return {
      id,
      label,
      sessionUuid: toStr(cfg.session_uuid),
      sessionTag: toStr(cfg.session_tag),
      apiBase,
      apiBasePort: portOf(apiBase),
      instanceLabel: instanceLabelFor(apiBase),
      settings: toStr(cfg.settings),
      intervalHuman,
      intervalCron,
      gateCommand,
      heartbeatTicks: toNum(cfg.heartbeat_ticks),
      consecutiveNoops: toNum(cfg.consecutive_noops),
      userBackoffWindowS,
      effectiveBackoffS,
      modelWatch: toStr(cfg.model_watch),
      doneSentinel: toStr(cfg.done_sentinel),
      paused,
      ticks: toNum(cfg.ticks),
      lastStatus,
      createdAtMs: isoToMs(cfg.created_utc),
      lastTickAtMs: isoToMs(cfg.last_tick_utc),
      pausedAtMs: isoToMs(cfg.paused_utc),
      doneAtMs,
      lastUserActivityAtMs: isoToMs(cfg.last_user_activity_utc),
      newestTickLogAtMs,
      nextFireAtMs,
      state,
      degraded: newestVerdict === "send-failed" || lastStatus === "send-failed",
      done,
      hasCrontabLine,
      action,
      runHistory,
    };
  }

  private deriveState(o: {
    paused: boolean;
    hasCrontabLine: boolean;
    done: boolean;
    newestTickLogAtMs: number | null;
    lastTickAtMs: number | null;
    createdAtMs: number | null;
    intervalMs: number | null;
    newestVerdict: LoopCronVerdict | null;
    nowMs: number;
  }): LoopCronState {
    // A paused loop is a deliberate amber state; it still fires cron + logs
    // `SKIP: paused`, so age never overrides it.
    if (o.paused) return "paused";
    // Stopped / self-terminated (done) — no schedule, cannot make progress.
    if (!o.hasCrontabLine) return "stalled";
    // Age-based staleness: cron stopped firing. Keyed on the newest tick.log line
    // (log() fires on ALL outcomes), NOT last_tick_utc (unwritten on the
    // Hapimatic-down path, which would false-RED healthy loops during an outage).
    const ref = o.newestTickLogAtMs ?? o.lastTickAtMs ?? o.createdAtMs;
    if (ref === null) return "stalled";
    if (o.intervalMs !== null) {
      const threshold = Math.max(2 * o.intervalMs, STALE_FLOOR_MS);
      if (o.nowMs - ref > threshold) return "stalled";
    }
    // V5: a loop firing on schedule but hitting a hard connectivity error
    // (auth/token/session-state unreadable — the Hapimatic-target-down case) is
    // NOT healthy; render stalled, never false-green.
    if (
      o.newestVerdict === "error:auth" ||
      o.newestVerdict === "error:token" ||
      o.newestVerdict === "error:session-state"
    ) {
      return "stalled";
    }
    return "live";
  }

  /** Two-fire diff via croner, for the stale threshold when interval_human is absent. */
  private intervalFromCron(cron: string | null): number | null {
    if (!cron) return null;
    try {
      const c = new Cron(cron);
      const n1 = c.nextRun();
      if (!n1) return null;
      const n2 = c.nextRun(n1);
      if (!n2) return null;
      const d = n2.getTime() - n1.getTime();
      return d > 0 ? d : null;
    } catch {
      return null;
    }
  }

  private nextFire(cron: string | null, nowMs: number): number | null {
    if (!cron) return null;
    try {
      const next = new Cron(cron).nextRun(new Date(nowMs));
      return next ? next.getTime() : null;
    } catch {
      return null;
    }
  }

  private readJson(path: string): Record<string, unknown> {
    try {
      const raw = this.readFileFn(path);
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  private readActionText(path: string): string | null {
    try {
      const text = this.readFileFn(path).trim();
      return text.length > 0 ? text : null;
    } catch {
      return null;
    }
  }

  private readTickLog(path: string): {
    runHistory: LoopCronRunEntry[];
    newestTickLogAtMs: number | null;
  } {
    let lines: string[];
    try {
      lines = this.readFileFn(path).split("\n");
    } catch {
      return { runHistory: [], newestTickLogAtMs: null };
    }
    // Bound parse work to the tail regardless of file size.
    const tail = lines.slice(-TICKLOG_TAIL_LINES).filter(l => l.trim() !== "");
    let newestTickLogAtMs: number | null = null;
    if (tail.length > 0) {
      newestTickLogAtMs = this.stampOf(tail[tail.length - 1]);
    }
    const runHistory: LoopCronRunEntry[] = [];
    for (let i = tail.length - 1; i >= 0; i--) {
      const { atMs, message } = this.splitLine(tail[i]);
      const verdict = classifyTickMessage(message);
      if (verdict === null) continue; // precursor / info line — not an outcome
      runHistory.push({ atMs, verdict, message });
      if (runHistory.length >= RUN_HISTORY_LIMIT) break;
    }
    return { runHistory, newestTickLogAtMs };
  }

  /** `<ISO-stamp> <message>` → { atMs, message }. */
  private splitLine(line: string): { atMs: number | null; message: string } {
    const sp = line.indexOf(" ");
    if (sp < 0) return { atMs: null, message: line.trim() };
    return {
      atMs: isoToMs(line.slice(0, sp)),
      message: line.slice(sp + 1).trim(),
    };
  }

  private stampOf(line: string): number | null {
    const sp = line.indexOf(" ");
    return sp < 0 ? null : isoToMs(line.slice(0, sp));
  }
}
