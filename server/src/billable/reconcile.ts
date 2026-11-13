// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";
import type { ErrorLogger } from "../logging/errorLogger";
import { newUuidV7 } from "../store/turns/ids";
import type { IntervalWriteCounters } from "./intervalWriteService";

/**
 * The billable-time daily check (issue #6586, R10, R18, R19).
 *
 * Once a day the hub compares its clocks on this node's own rows (the local
 * `sessions`, `thinking_intervals`, `billable_shadow_stretches` and `messages`
 * tables; mirrored intervals are checked on the node that recorded them), writes
 * what it finds to `billable_reconcile`, and logs one summary line. When the
 * clocks agree it writes only the run row.
 *
 * Sections: `timer` (`on`: stored timer against the stored interval sum),
 * `memory` (`on`: the in-memory timer against the stored one, which is what
 * catches a close that never landed), `orphan_open` (`on` and `shadow`: an open
 * row neither the tracker nor a queued write owns), `shadow` (`shadow`: the old
 * clock against the tracker's measurements, stretch by stretch), `silence` (`on`
 * and `shadow`, ruling D2-A: an interval of 30 minutes or more holding more than
 * 30 minutes without a message, flagged for a person, never shortened).
 *
 * Switching a node from `shadow` to `on` has THREE conditions:
 * 1. Ruling D1-A / F1-a — the daily-check criterion `evaluateBillableFlip` tests:
 *    the latest run is in `shadow` and less than 25 hours old; every run of the
 *    last 7 days is in `shadow` with no `unexplained` and no `orphan_open` row;
 *    and those runs compared at least one stretch.
 * 2. Ruling TP-1 (Matt Starfield, 2026-11-12) — the process-identity issue #6647
 *    has landed, because until the hub can tell which process sent a heartbeat or
 *    a state write, a second live process on a session can make the waiting rule
 *    bill a wait.
 * 3. The ruling on review finding F3 (2026-11-12) — the `carried_forward` id rule
 *    has landed: a `carried_forward` row made again after a restore of the same
 *    database gets the same `id` as the first one, as the `opening_balance` row
 *    does from this build on (store/billable/startup.ts). Until then such a row
 *    reaches a puller under a new random id and its amount is counted twice.
 *    Only a boot in `on` writes `carried_forward` rows.
 * `evaluateBillableFlip` reads `billable_reconcile` only and cannot test
 * conditions 2 and 3, so its `met` speaks for condition 1 alone.
 * The switch is a setting change plus a restart, and when to make it is the
 * operator's decision; nothing here switches a node.
 */

export const FLIP_WINDOW_MS = 604_800_000;
export const FLIP_MIN_STRETCHES = 1;

const PERIOD_MARGIN_MS = 60_000;
const LATEST_RUN_MAX_AGE_MS = 25 * 60 * 60 * 1000;
const RETENTION_MS = 7_776_000_000;
const SILENCE_MS = 1_800_000;
const RESIDUAL_TOLERANCE_MS = 1_000;
const WAIT_TOLERANCE_MS = 2_000;
const WRITE_LAG_MS = 60_000;
const SDK_TIMEOUT_MS = 10_000;
const TMUX_PTY_TIMEOUT_MS = 30_000;
const SWEEP_TICK_MS = 5_000;
const LATE_TIMER_MS = 2_000;
const DAY_MS = 86_400_000;
const FIRST_RUN_DELAY_MS = 300_000;

const BALANCE_CAUSES = ["opening_balance", "carried_forward"];
const BALANCE_IN = BALANCE_CAUSES.map(c => `'${c}'`).join(", ");
const EXPLAINED_GROUP_CAUSES = [
  "hub_restart",
  "hub_shutdown",
  "session_deleted",
];
const RUNNING_GROUP_CAUSES = ["waiting_on_person", "rollover"];

/**
 * Closed interval groups recorded in `shadow` with no old-clock row and no open
 * row, whose latest end is in (from, to]. Read once to hold the period (below)
 * and once to compare.
 */
const NO_LEGACY_GROUPS_SQL =
  "SELECT t.hapi_session_id, t.namespace, t.stretch_started_at_ms, t.launcher_kind, " +
  "SUM(t.duration_ms) AS intervals_ms, MAX(t.ended_at_ms) AS last_end " +
  "FROM thinking_intervals t WHERE t.recorded_mode = 'shadow' AND t.ended_at_ms IS NOT NULL " +
  `AND t.end_cause NOT IN (${BALANCE_IN}) ` +
  "AND NOT EXISTS (SELECT 1 FROM billable_shadow_stretches b WHERE " +
  "b.hapi_session_id = t.hapi_session_id AND b.stretch_started_at_ms = t.stretch_started_at_ms) " +
  "AND NOT EXISTS (SELECT 1 FROM thinking_intervals o WHERE o.ended_at_ms IS NULL AND " +
  "o.hapi_session_id = t.hapi_session_id AND o.stretch_started_at_ms = t.stretch_started_at_ms) " +
  "GROUP BY t.hapi_session_id, t.stretch_started_at_ms " +
  "HAVING MAX(t.ended_at_ms) > ? AND MAX(t.ended_at_ms) <= ?";

export type ReconcileSection =
  | "timer"
  | "memory"
  | "orphan_open"
  | "shadow"
  | "silence";

export type ReconcileDetailKind =
  | "timer"
  | "memory"
  | "orphan_open"
  | "shadow_session"
  | "unexplained"
  | "silence";

/** What only the running server knows; the manual script passes `null`. */
export interface ReconcileLive {
  trackedOpenStartMs(sessionId: string): number | null;
  hasQueuedOp(sessionId: string): boolean;
  oldestQueuedOpAgeMs(): number;
  cachedSessions(): Array<{
    id: string;
    namespace: string;
    serverAccumulatedMs: number;
  }>;
  counters(): IntervalWriteCounters;
  liveAttachCount(): number;
}

export interface ReconcileDetail {
  kind: ReconcileDetailKind;
  namespace: string | null;
  hapiSessionId: string | null;
  intervalId: string | null;
  stretchStartedAtMs: number | null;
  aMs: number | null;
  bMs: number | null;
  diffMs: number | null;
  detail: Record<string, unknown> | null;
}

export interface ReconcileRunDetail {
  counts: Record<ReconcileDetailKind, number>;
  silenceChecked: number;
  silenceUnchecked: number;
  stretchesCompared: number;
  stallTrims: number;
  waitUnchecked: number;
  liveAttaches: number | null;
  closedSinceLastRun: {
    hub_restart: number;
    superseded: number;
    rollover: number;
    clamped: number;
  };
  writeService: IntervalWriteCounters | null;
  periodFromMs: number;
  periodToMs: number;
  intervalSeqFrom: number;
  intervalSeqThrough: number;
}

export interface ReconcileResult {
  run: ReconcileRunDetail;
  details: ReconcileDetail[];
}

interface PreviousRun {
  periodToMs: number;
  intervalSeqThrough: number;
  setAsideCount: number | null;
}

function emptyCounts(): Record<ReconcileDetailKind, number> {
  return {
    timer: 0,
    memory: 0,
    orphan_open: 0,
    shadow_session: 0,
    unexplained: 0,
    silence: 0,
  };
}

function readPreviousRun(db: Database): PreviousRun {
  const row = db
    .prepare(
      "SELECT detail_json FROM billable_reconcile WHERE row_type = 'run' ORDER BY run_at_ms DESC LIMIT 1"
    )
    .get() as { detail_json: string | null } | null;
  if (!row?.detail_json) {
    return { periodToMs: 0, intervalSeqThrough: 0, setAsideCount: null };
  }
  try {
    const d = JSON.parse(row.detail_json) as Partial<ReconcileRunDetail>;
    return {
      periodToMs: typeof d.periodToMs === "number" ? d.periodToMs : 0,
      intervalSeqThrough:
        typeof d.intervalSeqThrough === "number" ? d.intervalSeqThrough : 0,
      setAsideCount:
        typeof d.writeService?.setAsideCount === "number"
          ? d.writeService.setAsideCount
          : null,
    };
  } catch {
    return { periodToMs: 0, intervalSeqThrough: 0, setAsideCount: null };
  }
}

function launcherTimeoutMs(launcherKind: string): number {
  return launcherKind === "tmux" || launcherKind === "pty"
    ? TMUX_PTY_TIMEOUT_MS
    : SDK_TIMEOUT_MS;
}

interface StretchRow {
  hapi_session_id: string;
  namespace: string;
  stretch_started_at_ms: number;
  legacy_ended_at_ms: number;
  legacy_ms: number;
  intervals_ms: number;
  wait_ms: number;
  trim_ms: number;
  launcher_kind: string;
  wait_ref_ms: number;
  wait_ref_incomplete: number;
  sweep_gap_ms: number;
  site: string;
}

interface SessionShadowSum {
  namespace: string;
  legacyMs: number;
  intervalsMs: number;
  diffMs: number;
  waitMs: number;
  trimMs: number;
  restartMs: number;
  residualMs: number;
  stretches: number;
  anyDiff: boolean;
}

const yieldToEventLoop = (): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, 0));

/**
 * Read and return what a run would write, without writing. With `sinceMs`, both
 * period cursors are replaced: stretch rows recorded after it and closed rows
 * ended after it are examined, whatever earlier runs compared; a group with no
 * old-clock row is reported only when it ended inside the retention. Everything that
 * reads `live` runs before the first `await`, so live and stored values come from
 * one synchronous slice.
 */
export async function computeBillableReconcile(input: {
  db: Database;
  nowMs: number;
  sections: ReconcileSection[];
  live: ReconcileLive | null;
  sinceMs?: number;
}): Promise<ReconcileResult> {
  const { db, nowMs, live } = input;
  const sections = new Set(input.sections);
  const details: ReconcileDetail[] = [];
  const prev = readPreviousRun(db);

  let periodToMs = nowMs - PERIOD_MARGIN_MS;
  if (live) {
    const bound = nowMs - live.oldestQueuedOpAgeMs() - 1;
    if (bound < periodToMs) periodToMs = bound;
  }
  if (periodToMs < prev.periodToMs) periodToMs = prev.periodToMs;
  const intervalSeqThrough = (
    db
      .prepare(
        "SELECT COALESCE(MAX(change_seq), 0) AS m FROM thinking_intervals WHERE ended_at_ms IS NOT NULL"
      )
      .get() as { m: number }
  ).m;
  const since = input.sinceMs;
  const stretchFrom = since ?? prev.periodToMs;
  // With `sinceMs`, a group that ended before the retention is not read as one
  // with no old-clock row: the daily run has deleted that row (below), and the
  // interval rows are kept.
  const groupsFrom =
    since === undefined ? stretchFrom : Math.max(since, nowMs - RETENTION_MS);

  // A group the comparison skips for a queued op of its session must fall in the
  // next run's window, because the queued op can be another stretch's and nothing
  // else brings the group back: hold this run's period below its latest end, never
  // below the previous run's. The stretches section reads the held period too, so
  // a stretch row after it waits for the next run and is still compared once.
  if (live && sections.has("shadow")) {
    const candidates = db
      .prepare(NO_LEGACY_GROUPS_SQL)
      .all(groupsFrom, periodToMs) as Array<{
      hapi_session_id: string;
      last_end: number;
    }>;
    for (const g of candidates) {
      if (!live.hasQueuedOp(g.hapi_session_id)) continue;
      const held = Math.max(g.last_end - 1, prev.periodToMs);
      if (held < periodToMs) periodToMs = held;
    }
  }

  // Closed rows "since the last run": by change_seq (assigned when a close is
  // written), or by end time when `sinceMs` replaces the cursors.
  const closedSinceClause =
    since !== undefined
      ? "ended_at_ms > ?"
      : "change_seq > ? AND change_seq <= ?";
  const closedSinceArgs: number[] =
    since !== undefined
      ? [since]
      : [prev.intervalSeqThrough, intervalSeqThrough];

  // ── timer (on) ──
  if (sections.has("timer")) {
    const rows = db
      .prepare(
        "SELECT s.id, s.namespace, COALESCE(s.server_accumulated_ms, 0) AS timer, " +
          "(SELECT COALESCE(SUM(t.duration_ms), 0) FROM thinking_intervals t " +
          "WHERE t.hapi_session_id = s.id AND t.ended_at_ms IS NOT NULL) AS closed " +
          "FROM sessions s"
      )
      .all() as Array<{
      id: string;
      namespace: string;
      timer: number;
      closed: number;
    }>;
    for (const r of rows) {
      if (r.timer !== r.closed) {
        details.push({
          kind: "timer",
          namespace: r.namespace,
          hapiSessionId: r.id,
          intervalId: null,
          stretchStartedAtMs: null,
          aMs: r.timer,
          bMs: r.closed,
          diffMs: r.timer - r.closed,
          detail: null,
        });
      }
    }
  }

  // ── memory (on; needs live) ──
  if (sections.has("memory") && live) {
    const storedTimer = db.prepare(
      "SELECT COALESCE(server_accumulated_ms, 0) AS t FROM sessions WHERE id = ?"
    );
    for (const s of live.cachedSessions()) {
      if (live.trackedOpenStartMs(s.id) != null || live.hasQueuedOp(s.id))
        continue;
      const row = storedTimer.get(s.id) as { t: number } | null;
      if (row == null) continue;
      if (s.serverAccumulatedMs !== row.t) {
        details.push({
          kind: "memory",
          namespace: s.namespace,
          hapiSessionId: s.id,
          intervalId: null,
          stretchStartedAtMs: null,
          aMs: s.serverAccumulatedMs,
          bMs: row.t,
          diffMs: s.serverAccumulatedMs - row.t,
          detail: null,
        });
      }
    }
  }

  // ── orphan_open (on and shadow; needs live) ──
  if (sections.has("orphan_open") && live) {
    const open = db
      .prepare(
        "SELECT id, hapi_session_id, namespace, stretch_started_at_ms, started_at_ms, " +
          "last_seen_at_ms, launcher_kind FROM thinking_intervals WHERE ended_at_ms IS NULL"
      )
      .all() as Array<{
      id: string;
      hapi_session_id: string;
      namespace: string;
      stretch_started_at_ms: number;
      started_at_ms: number;
      last_seen_at_ms: number;
      launcher_kind: string;
    }>;
    for (const r of open) {
      if (live.trackedOpenStartMs(r.hapi_session_id) === r.started_at_ms)
        continue;
      if (live.hasQueuedOp(r.hapi_session_id)) continue;
      details.push({
        kind: "orphan_open",
        namespace: r.namespace,
        hapiSessionId: r.hapi_session_id,
        intervalId: r.id,
        stretchStartedAtMs: r.stretch_started_at_ms,
        aMs: null,
        bMs: null,
        diffMs: null,
        detail: {
          startedAtMs: r.started_at_ms,
          lastSeenAtMs: r.last_seen_at_ms,
          launcherKind: r.launcher_kind,
        },
      });
    }
  }

  // ── shadow (shadow) ──
  let stretchesCompared = 0;
  let stallTrims = 0;
  let waitUnchecked = 0;
  if (sections.has("shadow")) {
    const perSession = new Map<string, SessionShadowSum>();
    const sum = (sid: string, namespace: string): SessionShadowSum => {
      let s = perSession.get(sid);
      if (!s) {
        s = {
          namespace,
          legacyMs: 0,
          intervalsMs: 0,
          diffMs: 0,
          waitMs: 0,
          trimMs: 0,
          restartMs: 0,
          residualMs: 0,
          stretches: 0,
          anyDiff: false,
        };
        perSession.set(sid, s);
      }
      return s;
    };
    const rowsOfKey = db.prepare(
      "SELECT COALESCE(SUM(duration_ms), 0) AS n FROM thinking_intervals WHERE " +
        "hapi_session_id = ? AND stretch_started_at_ms = ? AND ended_at_ms IS NOT NULL " +
        `AND end_cause NOT IN (${BALANCE_IN})`
    );

    // Stretches with an old-clock row, recorded in the period.
    const stretches = db
      .prepare(
        "SELECT * FROM billable_shadow_stretches WHERE recorded_at_ms > ? AND recorded_at_ms <= ? " +
          "ORDER BY recorded_at_ms, id"
      )
      .all(stretchFrom, periodToMs) as StretchRow[];
    for (const s of stretches) {
      stretchesCompared++;
      const diffMs = s.legacy_ms - s.intervals_ms;
      const residualMs = diffMs - s.wait_ms - s.trim_ms;
      const rowsMs = (
        rowsOfKey.get(s.hapi_session_id, s.stretch_started_at_ms) as {
          n: number;
        }
      ).n;
      const rowsDiffMs = s.intervals_ms - rowsMs;
      const reasons: string[] = [];
      if (Math.abs(residualMs) > RESIDUAL_TOLERANCE_MS)
        reasons.push("residual");
      if (Math.abs(rowsDiffMs) > RESIDUAL_TOLERANCE_MS)
        reasons.push("rows_mismatch");
      const timeoutMs = launcherTimeoutMs(s.launcher_kind);
      const trimLimitMs =
        timeoutMs + Math.max(SWEEP_TICK_MS, s.sweep_gap_ms) + LATE_TIMER_MS;
      if (s.trim_ms > trimLimitMs) {
        reasons.push("trim");
      } else if (s.trim_ms > timeoutMs + SWEEP_TICK_MS + LATE_TIMER_MS) {
        stallTrims++;
      }
      if (s.wait_ref_incomplete === 1) {
        waitUnchecked++;
      } else if (
        s.wait_ms + s.trim_ms < s.wait_ref_ms - WAIT_TOLERANCE_MS ||
        (s.launcher_kind === "sdk" &&
          s.wait_ms > s.wait_ref_ms + WAIT_TOLERANCE_MS)
      ) {
        reasons.push("wait_mismatch");
      }
      const acc = sum(s.hapi_session_id, s.namespace);
      acc.legacyMs += s.legacy_ms;
      acc.intervalsMs += s.intervals_ms;
      acc.diffMs += diffMs;
      acc.waitMs += s.wait_ms;
      acc.trimMs += s.trim_ms;
      acc.residualMs += residualMs;
      acc.stretches++;
      if (diffMs !== 0) acc.anyDiff = true;
      for (const reason of reasons) {
        details.push({
          kind: "unexplained",
          namespace: s.namespace,
          hapiSessionId: s.hapi_session_id,
          intervalId: null,
          stretchStartedAtMs: s.stretch_started_at_ms,
          aMs: s.legacy_ms,
          bMs: s.intervals_ms,
          diffMs,
          detail: {
            reason,
            waitMs: s.wait_ms,
            trimMs: s.trim_ms,
            residualMs,
            rowsMs,
            waitRefMs: s.wait_ref_ms,
            sweepGapMs: s.sweep_gap_ms,
            launcherKind: s.launcher_kind,
            legacyEndedAtMs: s.legacy_ended_at_ms,
            site: s.site,
            lastEndCause: null,
          },
        });
      }
    }

    // Interval groups recorded in `shadow` with no old-clock row.
    const groups = db
      .prepare(NO_LEGACY_GROUPS_SQL)
      .all(groupsFrom, periodToMs) as Array<{
      hapi_session_id: string;
      namespace: string;
      stretch_started_at_ms: number;
      launcher_kind: string;
      intervals_ms: number;
      last_end: number;
    }>;
    const lastCause = db.prepare(
      "SELECT end_cause FROM thinking_intervals WHERE hapi_session_id = ? AND stretch_started_at_ms = ? " +
        `AND ended_at_ms IS NOT NULL AND end_cause NOT IN (${BALANCE_IN}) ` +
        "ORDER BY ended_at_ms DESC, started_at_ms DESC LIMIT 1"
    );
    for (const g of groups) {
      if (live?.hasQueuedOp(g.hapi_session_id)) continue;
      const cause =
        (
          lastCause.get(g.hapi_session_id, g.stretch_started_at_ms) as {
            end_cause: string;
          } | null
        )?.end_cause ?? "";
      if (RUNNING_GROUP_CAUSES.includes(cause)) continue;
      stretchesCompared++;
      const acc = sum(g.hapi_session_id, g.namespace);
      const diffMs = -g.intervals_ms;
      acc.intervalsMs += g.intervals_ms;
      acc.diffMs += diffMs;
      acc.stretches++;
      if (diffMs !== 0) acc.anyDiff = true;
      if (EXPLAINED_GROUP_CAUSES.includes(cause)) {
        acc.restartMs += g.intervals_ms;
        continue;
      }
      acc.residualMs += diffMs;
      details.push({
        kind: "unexplained",
        namespace: g.namespace,
        hapiSessionId: g.hapi_session_id,
        intervalId: null,
        stretchStartedAtMs: g.stretch_started_at_ms,
        aMs: null,
        bMs: g.intervals_ms,
        diffMs,
        detail: {
          reason: "no_legacy",
          waitMs: 0,
          trimMs: 0,
          residualMs: diffMs,
          rowsMs: g.intervals_ms,
          waitRefMs: null,
          sweepGapMs: null,
          launcherKind: g.launcher_kind,
          legacyEndedAtMs: null,
          site: null,
          lastEndCause: cause,
        },
      });
    }

    for (const [sid, s] of perSession) {
      if (!s.anyDiff) continue;
      details.push({
        kind: "shadow_session",
        namespace: s.namespace,
        hapiSessionId: sid,
        intervalId: null,
        stretchStartedAtMs: null,
        aMs: s.legacyMs,
        bMs: s.intervalsMs,
        diffMs: s.diffMs,
        detail: {
          waitMs: s.waitMs,
          trimMs: s.trimMs,
          restartMs: s.restartMs,
          residualMs: s.residualMs,
          stretches: s.stretches,
        },
      });
    }

    if (live) {
      const runLevel = (
        reason: string,
        extra: Record<string, unknown>
      ): void => {
        details.push({
          kind: "unexplained",
          namespace: null,
          hapiSessionId: null,
          intervalId: null,
          stretchStartedAtMs: null,
          aMs: null,
          bMs: null,
          diffMs: null,
          detail: { reason, ...extra },
        });
      };
      const oldest = live.oldestQueuedOpAgeMs();
      if (oldest > WRITE_LAG_MS)
        runLevel("write_lag", { oldestQueuedOpAgeMs: oldest });
      const setAside = live.counters().setAsideCount;
      if (setAside > 0 && setAside !== prev.setAsideCount) {
        runLevel("set_aside", {
          setAsideCount: setAside,
          previous: prev.setAsideCount,
        });
      }
    }
  }

  // Values read from `live` before the first await.
  const liveAttaches = live ? live.liveAttachCount() : null;
  const writeService = live ? live.counters() : null;

  const closedSinceLastRun = {
    hub_restart: 0,
    superseded: 0,
    rollover: 0,
    clamped: 0,
  };
  const closedRows = db
    .prepare(
      `SELECT end_cause, flags FROM thinking_intervals WHERE ended_at_ms IS NOT NULL AND ${closedSinceClause}`
    )
    .all(...closedSinceArgs) as Array<{
    end_cause: string | null;
    flags: string | null;
  }>;
  for (const r of closedRows) {
    if (r.end_cause === "hub_restart") closedSinceLastRun.hub_restart++;
    if (r.end_cause === "superseded") closedSinceLastRun.superseded++;
    if (r.end_cause === "rollover") closedSinceLastRun.rollover++;
    if (r.flags) {
      try {
        if ((JSON.parse(r.flags) as { clamped?: unknown }).clamped === true) {
          closedSinceLastRun.clamped++;
        }
      } catch {
        // A malformed flags value is not a clamp.
      }
    }
  }

  // ── silence (on and shadow; ruling D2-A) ──
  let silenceChecked = 0;
  let silenceUnchecked = 0;
  if (sections.has("silence")) {
    const long = db
      .prepare(
        "SELECT id, hapi_session_id, namespace, launcher_kind, started_at_ms, ended_at_ms, duration_ms " +
          `FROM thinking_intervals WHERE ended_at_ms IS NOT NULL AND end_cause NOT IN (${BALANCE_IN}) ` +
          `AND duration_ms >= ? AND ${closedSinceClause} ORDER BY change_seq`
      )
      .all(SILENCE_MS, ...closedSinceArgs) as Array<{
      id: string;
      hapi_session_id: string;
      namespace: string;
      launcher_kind: string;
      started_at_ms: number;
      ended_at_ms: number;
      duration_ms: number;
    }>;
    const anyMessage = db.prepare(
      "SELECT 1 AS one FROM messages WHERE session_id = ? LIMIT 1"
    );
    const inside = db.prepare(
      "SELECT created_at FROM messages WHERE session_id = ? AND created_at >= ? AND created_at <= ? " +
        "ORDER BY created_at"
    );
    for (let i = 0; i < long.length; i++) {
      // Each query scans one session's messages on the hub's single thread.
      if (i > 0) await yieldToEventLoop();
      const r = long[i];
      if (anyMessage.get(r.hapi_session_id) == null) {
        // An empty table (a deleted session) is not evidence of silence.
        silenceUnchecked++;
        continue;
      }
      silenceChecked++;
      const times = (
        inside.all(r.hapi_session_id, r.started_at_ms, r.ended_at_ms) as Array<{
          created_at: number;
        }>
      ).map(m => m.created_at);
      const points = [r.started_at_ms, ...times, r.ended_at_ms];
      let gap = 0;
      let gapStartMs = r.started_at_ms;
      let gapEndMs = r.started_at_ms;
      for (let p = 1; p < points.length; p++) {
        const g = points[p] - points[p - 1];
        if (g > gap) {
          gap = g;
          gapStartMs = points[p - 1];
          gapEndMs = points[p];
        }
      }
      if (gap > SILENCE_MS) {
        details.push({
          kind: "silence",
          namespace: r.namespace,
          hapiSessionId: r.hapi_session_id,
          intervalId: r.id,
          stretchStartedAtMs: null,
          aMs: gap,
          bMs: r.duration_ms,
          diffMs: null,
          detail: {
            launcherKind: r.launcher_kind,
            gapStartMs,
            gapEndMs,
            messagesInside: times.length,
          },
        });
      }
    }
  }

  const counts = emptyCounts();
  for (const d of details) counts[d.kind]++;
  return {
    run: {
      counts,
      silenceChecked,
      silenceUnchecked,
      stretchesCompared,
      stallTrims,
      waitUnchecked,
      liveAttaches,
      closedSinceLastRun,
      writeService,
      periodFromMs: prev.periodToMs,
      periodToMs,
      intervalSeqFrom: prev.intervalSeqThrough,
      intervalSeqThrough,
    },
    details,
  };
}

export type BillableReconcileLogger = Pick<
  ErrorLogger,
  "info" | "warn" | "error"
>;

/**
 * The daily entry. Never throws and never rejects: it runs from a timer, and the
 * server installs no `unhandledRejection` handler. On a throw it writes no row and
 * logs with `persist: false`.
 */
export async function runBillableReconcile(input: {
  db: Database;
  mode: "on" | "shadow";
  nowMs: number;
  live: ReconcileLive | null;
  errorLogger: BillableReconcileLogger | null;
}): Promise<
  | { ok: true; runId: string; counts: Record<ReconcileDetailKind, number> }
  | { ok: false }
> {
  const { db, mode, nowMs, errorLogger } = input;
  try {
    const sections: ReconcileSection[] =
      mode === "on"
        ? ["timer", "memory", "orphan_open", "silence"]
        : ["shadow", "orphan_open", "silence"];
    const { run, details } = await computeBillableReconcile({
      db,
      nowMs,
      sections,
      live: input.live,
    });
    const runId = newUuidV7();
    const insert = db.prepare(
      "INSERT INTO billable_reconcile (run_id, run_at_ms, row_type, mode, kind, namespace, " +
        "hapi_session_id, interval_id, stretch_started_at_ms, a_ms, b_ms, diff_ms, detail_json) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    const write = db.transaction(() => {
      insert.run(
        runId,
        nowMs,
        "run",
        mode,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        JSON.stringify(run)
      );
      for (const d of details) {
        insert.run(
          runId,
          nowMs,
          "detail",
          mode,
          d.kind,
          d.namespace,
          d.hapiSessionId,
          d.intervalId,
          d.stretchStartedAtMs,
          d.aMs,
          d.bMs,
          d.diffMs,
          d.detail === null ? null : JSON.stringify(d.detail)
        );
      }
      db.prepare(
        "DELETE FROM billable_reconcile WHERE row_type = 'detail' AND run_at_ms < ?"
      ).run(nowMs - RETENTION_MS);
      db.prepare(
        "DELETE FROM billable_shadow_stretches WHERE recorded_at_ms < ?"
      ).run(nowMs - RETENTION_MS);
    });
    write.immediate();

    const c = run.counts;
    const flagged =
      c.timer + c.memory + c.orphan_open + c.unexplained + c.silence > 0;
    const line =
      `billable reconcile mode=${mode} run=${runId} timer=${c.timer} memory=${c.memory} ` +
      `orphan_open=${c.orphan_open} shadow_session=${c.shadow_session} ` +
      `unexplained=${c.unexplained} silence=${c.silence} stretches=${run.stretchesCompared} ` +
      `liveAttaches=${run.liveAttaches ?? "n/a"}`;
    const options = {
      category: "billable-intervals",
      context: { runId, counts: c },
    };
    if (flagged) errorLogger?.warn(line, options);
    else errorLogger?.info(line, options);
    return { ok: true, runId, counts: c };
  } catch (error) {
    try {
      errorLogger?.error("billable reconcile failed", {
        category: "billable-intervals",
        persist: false,
        context: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
    } catch {
      // Must never throw from a timer.
    }
    return { ok: false };
  }
}

/** 5 minutes after boot when there is no run or the last is a day old; else the rest of the day. */
export function nextReconcileDelayMs(input: {
  lastRunAtMs: number | null;
  nowMs: number;
}): number {
  const { lastRunAtMs, nowMs } = input;
  if (lastRunAtMs === null || nowMs - lastRunAtMs >= DAY_MS)
    return FIRST_RUN_DELAY_MS;
  return Math.max(FIRST_RUN_DELAY_MS, lastRunAtMs + DAY_MS - nowMs);
}

export interface LatestReconcile {
  run: {
    runId: string;
    runAtMs: number;
    mode: string;
    detail: Record<string, unknown> | null;
  } | null;
  details: Array<{
    kind: string;
    sessionId: string | null;
    intervalId: string | null;
    stretchStartedAtMs: number | null;
    aMs: number | null;
    bMs: number | null;
    diffMs: number | null;
    detail: Record<string, unknown> | null;
  }>;
}

function parseJson(value: string | null): Record<string, unknown> | null {
  if (value === null) return null;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The latest run and its detail rows in the caller's namespace (`/api/billable-time/reconcile/latest`). */
export function readLatestReconcile(
  db: Database,
  namespace: string
): LatestReconcile {
  const run = db
    .prepare(
      "SELECT run_id, run_at_ms, mode, detail_json FROM billable_reconcile WHERE row_type = 'run' " +
        "ORDER BY run_at_ms DESC LIMIT 1"
    )
    .get() as {
    run_id: string;
    run_at_ms: number;
    mode: string;
    detail_json: string | null;
  } | null;
  if (!run) return { run: null, details: [] };
  const details = db
    .prepare(
      "SELECT kind, hapi_session_id, interval_id, stretch_started_at_ms, a_ms, b_ms, diff_ms, detail_json " +
        "FROM billable_reconcile WHERE run_id = ? AND row_type = 'detail' AND namespace = ?"
    )
    .all(run.run_id, namespace) as Array<{
    kind: string;
    hapi_session_id: string | null;
    interval_id: string | null;
    stretch_started_at_ms: number | null;
    a_ms: number | null;
    b_ms: number | null;
    diff_ms: number | null;
    detail_json: string | null;
  }>;
  return {
    run: {
      runId: run.run_id,
      runAtMs: run.run_at_ms,
      mode: run.mode,
      detail: parseJson(run.detail_json),
    },
    details: details.map(d => ({
      kind: d.kind,
      sessionId: d.hapi_session_id,
      intervalId: d.interval_id,
      stretchStartedAtMs: d.stretch_started_at_ms,
      aMs: d.a_ms,
      bMs: d.b_ms,
      diffMs: d.diff_ms,
      detail: parseJson(d.detail_json),
    })),
  };
}

/**
 * The daily-check part of the flip criterion (ruling D1-A / F1-a). It reads
 * `billable_reconcile` only. Two more conditions apply that this function cannot
 * test: the process-identity issue #6647 has landed (ruling TP-1), and the
 * `carried_forward` id rule has landed (the ruling on review finding F3).
 */
export function evaluateBillableFlip(
  db: Database,
  nowMs: number
): { met: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const latest = db
    .prepare(
      "SELECT run_at_ms, mode FROM billable_reconcile WHERE row_type = 'run' ORDER BY run_at_ms DESC LIMIT 1"
    )
    .get() as { run_at_ms: number; mode: string } | null;
  if (!latest) {
    return { met: false, reasons: ["no daily check has run"] };
  }
  if (latest.mode !== "shadow")
    reasons.push(`the latest daily check ran in ${latest.mode}, not shadow`);
  if (nowMs - latest.run_at_ms >= LATEST_RUN_MAX_AGE_MS) {
    reasons.push("the latest daily check is 25 hours old or older");
  }
  const windowStart = nowMs - FLIP_WINDOW_MS;
  const runs = db
    .prepare(
      "SELECT run_id, mode, detail_json FROM billable_reconcile WHERE row_type = 'run' AND run_at_ms >= ?"
    )
    .all(windowStart) as Array<{
    run_id: string;
    mode: string;
    detail_json: string | null;
  }>;
  if (runs.some(r => r.mode !== "shadow")) {
    reasons.push("a daily check of the last 7 days did not run in shadow");
  }
  const flagged = db
    .prepare(
      "SELECT kind, COUNT(*) AS n FROM billable_reconcile WHERE row_type = 'detail' AND run_at_ms >= ? " +
        "AND kind IN ('unexplained', 'orphan_open') GROUP BY kind"
    )
    .all(windowStart) as Array<{ kind: string; n: number }>;
  for (const f of flagged) {
    reasons.push(`the last 7 days hold ${f.n} ${f.kind} row(s)`);
  }
  let compared = 0;
  for (const r of runs) {
    const d = parseJson(r.detail_json);
    if (typeof d?.stretchesCompared === "number")
      compared += d.stretchesCompared;
  }
  if (compared < FLIP_MIN_STRETCHES) {
    reasons.push(
      `the last 7 days compared ${compared} stretch(es), fewer than ${FLIP_MIN_STRETCHES}`
    );
  }
  return { met: reasons.length === 0, reasons };
}
