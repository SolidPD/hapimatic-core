// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #6204 (plan 4.1, 4.2, 5.1, 5.3, 5.4; Task 5): the writes on the
 * timer marks, the lowered cuts, the counter epochs (3c), the copy state, the
 * baselines and the runs.
 *
 * A part of `TimeEntryStore`, never a second writer (the Project Manager's
 * ruling on Task 5's file size): only `timeEntryStore.ts` imports or builds
 * this class, the store's methods of the plan's names hand on to it, and the
 * store opens every transaction (one `IMMEDIATE` on its one connection). No
 * method here opens one. Each of these six tables is written from this file
 * alone; `entryWriters.test.ts` checks that per table.
 */
import type { Database } from "bun:sqlite";
import type {
  BaselineInput,
  CopyStateInput,
  CutsInput,
  EpochInput,
  RunCloseInput,
  RunOpenInput,
  TimeEntryEpochSource,
  TimerMarkInput,
} from "./timeEntryInputs";
import { TimeEntryDomainError } from "./timeEntryRows";

const EPOCH_SOURCES: readonly TimeEntryEpochSource[] = [
  "timer-fall",
  "history-resync",
];

type MarkRow = {
  latest_ms: number | null;
  pending_ms: number | null;
  pending_poll_at: number | null;
  pending_tick_at: number | null;
  pending_thinking: number | null;
  pending_thinking_since: number | null;
  confirmed_ms: number | null;
  confirmed_epoch: number | null;
  high_raw_ms: number | null;
  epoch: number;
  baseline_ms: number | null;
};

export class TimeEntryMarks {
  constructor(private readonly db: Database) {}

  private mark(namespace: string, sessionId: string): MarkRow | null {
    return this.db
      .prepare(
        `SELECT latest_ms, pending_ms, pending_poll_at, pending_tick_at, pending_thinking,
                pending_thinking_since, confirmed_ms, confirmed_epoch, high_raw_ms, epoch, baseline_ms
           FROM time_entry_timer_marks WHERE namespace = ? AND session_id = ?`
      )
      .get(namespace, sessionId) as MarkRow | null;
  }

  private ensureMark(
    namespace: string,
    sessionId: string,
    originNodeId: string
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO time_entry_timer_marks
           (namespace, session_id, origin_node_id, epoch, baseline_settled)
         VALUES (?, ?, ?, 0, 0)`
      )
      .run(namespace, sessionId, originNodeId);
  }

  /**
   * 5.4's three slots, mechanically: `latest` is replaced by every reading;
   * `pending` takes a reading only when it is empty, or when it was taken
   * before the cut and this one after it; a confirmation the caller decided
   * (for the pending reading it names by its tick time, or a local reading at
   * once) moves it to `confirmed` and the latest becomes the new pending.
   * The removal mark (3.4) is written or cleared with it.
   */
  putTimerMark(m: TimerMarkInput): { confirmed: boolean } {
    this.ensureMark(m.namespace, m.sessionId, m.originNodeId);
    const before = this.mark(m.namespace, m.sessionId)!;
    const r = m.reading;
    if (r !== undefined) {
      const takePending =
        before.pending_ms === null ||
        (before.pending_poll_at !== null &&
          before.pending_poll_at < m.cutMs &&
          r.pollAt >= m.cutMs);
      this.db
        .prepare(
          `UPDATE time_entry_timer_marks
              SET latest_ms = ?, latest_poll_at = ?, latest_tick_at = ?,
                  latest_thinking = ?, latest_thinking_since = ?
            WHERE namespace = ? AND session_id = ?`
        )
        .run(
          r.ms,
          r.pollAt,
          r.tickAt,
          r.thinking ? 1 : 0,
          r.thinkingSince,
          m.namespace,
          m.sessionId
        );
      if (takePending && m.confirm?.kind !== "local") this.setPending(m, r);
    }
    let confirmed = false;
    const c = m.confirm;
    if (c !== undefined) {
      const now = this.mark(m.namespace, m.sessionId)!;
      const source =
        c.kind === "local"
          ? r === undefined
            ? null
            : { ms: r.ms, pollAt: r.pollAt, tickAt: r.tickAt }
          : now.pending_ms !== null && now.pending_tick_at === c.pendingTickAt
            ? {
                ms: now.pending_ms,
                pollAt: this.pendingPoll(m),
                tickAt: now.pending_tick_at,
              }
            : null;
      if (source !== null) {
        confirmed = true;
        const high = Math.max(
          now.confirmed_epoch === now.epoch ? (now.high_raw_ms ?? 0) : 0,
          source.ms
        );
        this.db
          .prepare(
            `UPDATE time_entry_timer_marks
                SET confirmed_ms = ?, confirmed_poll_at = ?, confirmed_tick_at = ?,
                    confirmed_mode = ?, confirmed_epoch = epoch, high_raw_ms = ?
              WHERE namespace = ? AND session_id = ?`
          )
          .run(
            source.ms,
            source.pollAt,
            source.tickAt,
            c.mode,
            high,
            m.namespace,
            m.sessionId
          );
        if (c.kind === "pending") {
          // The latest becomes the new pending.
          this.db
            .prepare(
              `UPDATE time_entry_timer_marks
                  SET pending_ms = latest_ms, pending_poll_at = latest_poll_at,
                      pending_tick_at = latest_tick_at, pending_thinking = latest_thinking,
                      pending_thinking_since = latest_thinking_since
                WHERE namespace = ? AND session_id = ?`
            )
            .run(m.namespace, m.sessionId);
        }
      }
    }
    // The fall slot and the last shadow reading move on the caller's word only (3c).
    if (m.fall === "clear") {
      this.db
        .prepare(
          `UPDATE time_entry_timer_marks SET fall_ms = NULL, fall_poll_at = NULL
            WHERE namespace = ? AND session_id = ?`
        )
        .run(m.namespace, m.sessionId);
    } else if (m.fall !== undefined) {
      this.db
        .prepare(
          `UPDATE time_entry_timer_marks SET fall_ms = ?, fall_poll_at = ?
            WHERE namespace = ? AND session_id = ?`
        )
        .run(m.fall.ms, m.fall.pollAt, m.namespace, m.sessionId);
    }
    if (m.lastShadow !== undefined) {
      this.db
        .prepare(
          `UPDATE time_entry_timer_marks SET last_shadow_ms = ?, last_shadow_at = ?
            WHERE namespace = ? AND session_id = ?`
        )
        .run(m.lastShadow.ms, m.lastShadow.at, m.namespace, m.sessionId);
    }
    if (m.removed === "clear") {
      this.db
        .prepare(
          `UPDATE time_entry_timer_marks
              SET removed_ms = NULL, removed_at = NULL, removed_mode = NULL, removed_via = NULL
            WHERE namespace = ? AND session_id = ?`
        )
        .run(m.namespace, m.sessionId);
    } else if (m.removed !== undefined) {
      this.db
        .prepare(
          `UPDATE time_entry_timer_marks
              SET removed_ms = ?, removed_at = ?, removed_mode = ?, removed_via = ?
            WHERE namespace = ? AND session_id = ?`
        )
        .run(
          m.removed.ms,
          m.removed.at,
          m.removed.mode,
          m.removed.via,
          m.namespace,
          m.sessionId
        );
    }
    return { confirmed };
  }

  private pendingPoll(m: TimerMarkInput): number | null {
    const row = this.db
      .prepare(
        `SELECT pending_poll_at FROM time_entry_timer_marks WHERE namespace = ? AND session_id = ?`
      )
      .get(m.namespace, m.sessionId) as { pending_poll_at: number | null };
    return row.pending_poll_at;
  }

  private setPending(
    m: TimerMarkInput,
    r: NonNullable<TimerMarkInput["reading"]>
  ): void {
    this.db
      .prepare(
        `UPDATE time_entry_timer_marks
            SET pending_ms = ?, pending_poll_at = ?, pending_tick_at = ?,
                pending_thinking = ?, pending_thinking_since = ?
          WHERE namespace = ? AND session_id = ?`
      )
      .run(
        r.ms,
        r.pollAt,
        r.tickAt,
        r.thinking ? 1 : 0,
        r.thinkingSince,
        m.namespace,
        m.sessionId
      );
  }

  /** 4.1 rule 1: each row's cut is only ever lowered. Answers how many were lowered or set. */
  lowerCut(c: CutsInput): number {
    let changed = 0;
    for (const cut of c.cuts) {
      changed += this.db
        .prepare(
          `INSERT INTO time_entry_cuts (namespace, session_id, event_id, epoch, cut_ms, lowered_at, source)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (namespace, session_id, event_id, epoch) DO UPDATE
             SET cut_ms = excluded.cut_ms, lowered_at = excluded.lowered_at, source = excluded.source
           WHERE excluded.cut_ms < time_entry_cuts.cut_ms`
        )
        .run(
          c.namespace,
          c.sessionId,
          cut.eventId,
          cut.epoch,
          cut.cutMs,
          c.now,
          c.source
        ).changes;
    }
    return changed;
  }

  /**
   * 4.2: epoch e+1 opens at the fallen reading R, once (the caller names e),
   * and its `time_entry_epochs` row is written with the marks row (3c): kept
   * for the session's life, because a later epoch's start bounds this one.
   */
  openEpoch(e: EpochInput): "opened" | "unchanged" {
    if (!EPOCH_SOURCES.includes(e.source)) {
      throw new TimeEntryDomainError("source", "is not an epoch source");
    }
    this.ensureMark(e.namespace, e.sessionId, e.originNodeId);
    const before = this.mark(e.namespace, e.sessionId)!;
    const opened =
      this.db
        .prepare(
          `UPDATE time_entry_timer_marks
              SET epoch = epoch + 1, high_raw_ms = ?, confirmed_ms = ?, confirmed_poll_at = ?,
                  confirmed_epoch = epoch + 1
            WHERE namespace = ? AND session_id = ? AND epoch = ?`
        )
        .run(e.startMs, e.startMs, e.at, e.namespace, e.sessionId, e.fromEpoch)
        .changes === 1;
    if (!opened) return "unchanged";
    this.db
      .prepare(
        `INSERT INTO time_entry_epochs
           (namespace, session_id, epoch, start_ms, start_at, prev_high_raw_ms, source, opened_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        e.namespace,
        e.sessionId,
        e.fromEpoch + 1,
        e.startMs,
        e.at,
        before.high_raw_ms,
        e.source,
        e.now
      );
    return "opened";
  }

  /**
   * 5.4: what the engine saw of an origin's copies; an omitted drained time
   * keeps its value. `restore_pending_at` (5.6 step 1, 3c) moves on the
   * caller's word: a value sets it, null releases it, omitted keeps it.
   */
  putCopyState(s: CopyStateInput): void {
    const keepRestore = s.restorePendingAt === undefined ? 1 : 0;
    this.db
      .prepare(
        `INSERT INTO time_entry_copy_state
           (namespace, origin_node_id, history_drained_at, intervals_drained_at, origin_mode,
            origin_incarnation, turn_mirror_off, restore_pending_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (namespace, origin_node_id) DO UPDATE SET
           history_drained_at = COALESCE(excluded.history_drained_at, history_drained_at),
           intervals_drained_at = COALESCE(excluded.intervals_drained_at, intervals_drained_at),
           origin_mode = excluded.origin_mode, origin_incarnation = excluded.origin_incarnation,
           turn_mirror_off = excluded.turn_mirror_off,
           restore_pending_at = CASE WHEN ? = 1 THEN time_entry_copy_state.restore_pending_at
                                     ELSE excluded.restore_pending_at END,
           updated_at = excluded.updated_at`
      )
      .run(
        s.namespace,
        s.originNodeId,
        s.historyDrainedAt ?? null,
        s.intervalsDrainedAt ?? null,
        s.originMode,
        s.originIncarnation,
        s.turnMirrorOff ? 1 : 0,
        s.restorePendingAt ?? null,
        s.now,
        keepRestore
      );
  }

  /**
   * 5.1: `first` stores every session's baseline reading, the node's row
   * (`log_from` = its moment) and one `done` run row at the current cut;
   * `handover` needs the old owner's `released` row and starts at its time;
   * `late` adopts a session's first reading when it has none.
   */
  putBaseline(b: BaselineInput): "applied" | "exists" | "refused" {
    if (b.kind === "late") {
      this.ensureMark(b.namespace, b.sessionId, b.originNodeId);
      return this.db
        .prepare(
          `UPDATE time_entry_timer_marks
              SET baseline_ms = ?, baseline_kind = 'late', baseline_at = ?, baseline_tracked = ?
            WHERE namespace = ? AND session_id = ? AND baseline_ms IS NULL`
        )
        .run(b.baselineMs, b.at, b.tracked ? 1 : 0, b.namespace, b.sessionId)
        .changes === 1
        ? "applied"
        : "exists";
    }
    const has = (kind: string) =>
      this.db
        .prepare(
          `SELECT at FROM time_entry_baselines WHERE namespace = ? AND origin_node_id = ? AND kind = ?`
        )
        .get(b.namespace, b.originNodeId, kind) as { at: number } | null;
    if (has(b.kind) !== null) return "exists";
    let logFrom = b.at;
    if (b.kind === "handover") {
      const released = has("released");
      if (released === null) return "refused";
      logFrom = released.at;
    }
    this.db
      .prepare(
        `INSERT INTO time_entry_baselines (namespace, origin_node_id, kind, at, log_from, owner_node_id, detail_json)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(b.namespace, b.originNodeId, b.kind, b.at, logFrom, b.ownerNodeId);
    if (b.kind === "first") {
      for (const s of b.sessions) {
        this.ensureMark(b.namespace, s.sessionId, b.originNodeId);
        this.db
          .prepare(
            `UPDATE time_entry_timer_marks
                SET baseline_ms = ?, baseline_kind = 'first', baseline_at = ?, baseline_tracked = ?
              WHERE namespace = ? AND session_id = ?`
          )
          .run(s.baselineMs, b.at, s.tracked ? 1 : 0, b.namespace, s.sessionId);
      }
      this.db
        .prepare(
          `INSERT OR IGNORE INTO time_entry_runs (namespace, night, cut_ms, zone, state, started_at, finished_at, sessions, entries, minutes, detail_json)
           VALUES (?, ?, ?, ?, 'done', ?, ?, 0, 0, 0, NULL)`
        )
        .run(b.namespace, b.run.night, b.run.cutMs, b.run.zone, b.at, b.at);
    }
    return "applied";
  }

  /** 5.1 handover step 1: the old owner releases each of its origins, last. */
  releaseOwner(o: {
    namespace: string;
    ownerNodeId: string;
    at: number;
  }): string[] {
    const origins = this.db
      .prepare(
        `SELECT origin_node_id FROM time_entry_baselines b
          WHERE namespace = ? AND owner_node_id = ? AND kind IN ('first', 'handover')
            AND NOT EXISTS (SELECT 1 FROM time_entry_baselines r WHERE r.namespace = b.namespace
                              AND r.origin_node_id = b.origin_node_id AND r.kind = 'released')
          ORDER BY origin_node_id`
      )
      .all(o.namespace, o.ownerNodeId) as { origin_node_id: string }[];
    for (const { origin_node_id } of origins) {
      this.db
        .prepare(
          `INSERT INTO time_entry_baselines (namespace, origin_node_id, kind, at, log_from, owner_node_id, detail_json)
           VALUES (?, ?, 'released', ?, ?, ?, NULL)`
        )
        .run(o.namespace, origin_node_id, o.at, o.at, o.ownerNodeId);
    }
    return origins.map(r => r.origin_node_id);
  }

  /** 5.3: the run at a cut; a run left running is taken up again, a blocked one reopened. */
  openRun(r: RunOpenInput): { id: number; state: string } {
    const found = this.db
      .prepare(
        `SELECT id, state FROM time_entry_runs WHERE namespace = ? AND cut_ms = ?`
      )
      .get(r.namespace, r.cutMs) as { id: number; state: string } | null;
    if (found !== null && found.state !== "blocked") return found;
    if (found !== null) {
      this.db
        .prepare(
          `UPDATE time_entry_runs SET state = 'running', started_at = ?, finished_at = NULL WHERE id = ?`
        )
        .run(r.now, found.id);
      return { id: found.id, state: "running" };
    }
    const result = this.db
      .prepare(
        `INSERT INTO time_entry_runs (namespace, night, cut_ms, zone, state, started_at, finished_at, sessions, entries, minutes, detail_json)
         VALUES (?, ?, ?, ?, 'running', ?, NULL, NULL, NULL, NULL, NULL)`
      )
      .run(r.namespace, r.night, r.cutMs, r.zone, r.now);
    return { id: Number(result.lastInsertRowid), state: "running" };
  }

  closeRun(r: RunCloseInput): boolean {
    return (
      this.db
        .prepare(
          `UPDATE time_entry_runs SET state = ?, finished_at = ?, sessions = ?, entries = ?, minutes = ?, detail_json = ?
            WHERE namespace = ? AND id = ? AND state = 'running'`
        )
        .run(
          r.state,
          r.now,
          r.sessions,
          r.entries,
          r.minutes,
          r.detail === null ? null : JSON.stringify(r.detail),
          r.namespace,
          r.id
        ).changes === 1
    );
  }
}
