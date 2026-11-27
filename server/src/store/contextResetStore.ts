// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";

import {
  CONTEXT_RESET_TERMINAL_STATES,
  type ContextResetState,
  type ContextResetTrigger,
} from "@hapi/protocol";

/**
 * The pending context-reset request of a session (issue #6559, Task 7).
 *
 * ONE row per session in `context_reset_requests`, created in
 * `Store.runMigrations()` (`store/index.ts`), like the watermark table. A new arm
 * replaces a TERMINAL row and is refused while a pending (`armed` / `firing`)
 * row exists. A replaced row's outcome is gone from this table, so the
 * `context_reset` turn event is the only history.
 *
 * Methods are synchronous and may throw; the service owns fail-open. Every
 * read-then-write runs under `txn.immediate()` (BEGIN IMMEDIATE), because a
 * deferred transaction that reads first throws SQLITE_BUSY at once under write
 * contention (server/CLAUDE.md, Database). `markFiring` is a single conditional
 * UPDATE with no transaction of its own, so it can run inside the message
 * insert's transaction (the service's record step).
 */

export interface NewContextResetRequest {
  sessionId: string;
  /** Minted by the wrapper. */
  armId: string;
  /** The arming turn's seq, or null when none was open. */
  turnSeq: number | null;
  resumeText: string;
  trigger: ContextResetTrigger;
  /** For a lane's stage arm: `claudedocs/.session-checkpoint-<HAPI_SESSION_ID>.md`. */
  checkpointPath?: string | null;
  fromStage?: string | null;
  toStage?: string | null;
  stageArgs?: string | null;
  /** `owner/repo#N`. */
  issueRef?: string | null;
  armedAtMs: number;
  deadlineAtMs: number;
  /** The session's context tokens at arm time. */
  contextBefore?: number | null;
}

export interface ContextResetRequestRow {
  sessionId: string;
  armId: string;
  turnSeq: number | null;
  resumeText: string;
  trigger: ContextResetTrigger;
  checkpointPath: string | null;
  fromStage: string | null;
  toStage: string | null;
  stageArgs: string | null;
  issueRef: string | null;
  state: ContextResetState;
  /** False once a turn other than the arming one ran, or the session respawned. */
  resetAllowed: boolean;
  deferReason: string | null;
  armedAtMs: number;
  deadlineAtMs: number;
  firedAtMs: number | null;
  /** The terminal state, or the wrapper's reported outcome when it differs. */
  outcome: string | null;
  outcomeReason: string | null;
  contextBefore: number | null;
  /** Server-minted; returned by no route. */
  deliveryId: string | null;
  fireAttempts: number;
  newConversationId: string | null;
}

type TerminalState = (typeof CONTEXT_RESET_TERMINAL_STATES)[number];

interface RawRow {
  session_id: string;
  arm_id: string;
  turn_seq: number | null;
  resume_text: string;
  trigger: string;
  checkpoint_path: string | null;
  from_stage: string | null;
  to_stage: string | null;
  state: string;
  reset_allowed: number;
  defer_reason: string | null;
  armed_at_ms: number;
  deadline_at_ms: number;
  fired_at_ms: number | null;
  outcome: string | null;
  outcome_reason: string | null;
  context_before: number | null;
  delivery_id: string | null;
  fire_attempts: number;
  new_conversation_id: string | null;
  stage_args: string | null;
  issue_ref: string | null;
}

const COLUMNS =
  "session_id, arm_id, turn_seq, resume_text, trigger, checkpoint_path, " +
  "from_stage, to_stage, state, reset_allowed, defer_reason, armed_at_ms, " +
  "deadline_at_ms, fired_at_ms, outcome, outcome_reason, context_before, " +
  "delivery_id, fire_attempts, new_conversation_id, stage_args, issue_ref";

const PENDING_SQL = "state IN ('armed', 'firing')";

function toRow(r: RawRow): ContextResetRequestRow {
  return {
    sessionId: r.session_id,
    armId: r.arm_id,
    turnSeq: r.turn_seq,
    resumeText: r.resume_text,
    trigger: r.trigger as ContextResetTrigger,
    checkpointPath: r.checkpoint_path,
    fromStage: r.from_stage,
    toStage: r.to_stage,
    stageArgs: r.stage_args,
    issueRef: r.issue_ref,
    state: r.state as ContextResetState,
    resetAllowed: r.reset_allowed !== 0,
    deferReason: r.defer_reason,
    armedAtMs: r.armed_at_ms,
    deadlineAtMs: r.deadline_at_ms,
    firedAtMs: r.fired_at_ms,
    outcome: r.outcome,
    outcomeReason: r.outcome_reason,
    contextBefore: r.context_before,
    deliveryId: r.delivery_id,
    fireAttempts: r.fire_attempts,
    newConversationId: r.new_conversation_id,
  };
}

export class ContextResetStore {
  constructor(private readonly db: Database) {}

  /**
   * Store a new pending request. Returns false (and writes nothing) while the
   * session already has a pending row; replaces a terminal row.
   */
  arm(input: NewContextResetRequest): boolean {
    const txn = this.db.transaction((): boolean => {
      const existing = this.db
        .prepare(
          `SELECT state FROM context_reset_requests WHERE session_id = @sid`
        )
        .get({ sid: input.sessionId }) as { state: string } | undefined;
      if (
        existing &&
        (existing.state === "armed" || existing.state === "firing")
      ) {
        return false;
      }
      this.db
        .prepare(
          `INSERT OR REPLACE INTO context_reset_requests (${COLUMNS})
           VALUES (@session_id, @arm_id, @turn_seq, @resume_text, @trigger,
             @checkpoint_path, @from_stage, @to_stage, 'armed', 1, NULL,
             @armed_at_ms, @deadline_at_ms, NULL, NULL, NULL, @context_before,
             NULL, 0, NULL, @stage_args, @issue_ref)`
        )
        .run({
          session_id: input.sessionId,
          arm_id: input.armId,
          turn_seq: input.turnSeq,
          resume_text: input.resumeText,
          trigger: input.trigger,
          checkpoint_path: input.checkpointPath ?? null,
          from_stage: input.fromStage ?? null,
          to_stage: input.toStage ?? null,
          armed_at_ms: input.armedAtMs,
          deadline_at_ms: input.deadlineAtMs,
          context_before: input.contextBefore ?? null,
          stage_args: input.stageArgs ?? null,
          issue_ref: input.issueRef ?? null,
        });
      return true;
    });
    return txn.immediate();
  }

  get(sessionId: string): ContextResetRequestRow | null {
    const row = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM context_reset_requests WHERE session_id = @sid`
      )
      .get({ sid: sessionId }) as RawRow | undefined;
    return row ? toRow(row) : null;
  }

  getByArmId(armId: string): ContextResetRequestRow | null {
    const row = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM context_reset_requests WHERE arm_id = @arm`
      )
      .get({ arm: armId }) as RawRow | undefined;
    return row ? toRow(row) : null;
  }

  /** Every pending (`armed` / `firing`) row: read at boot and by the backstop loop. */
  listPending(): ContextResetRequestRow[] {
    const rows = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM context_reset_requests WHERE ${PENDING_SQL}`
      )
      .all() as RawRow[];
    return rows.map(toRow);
  }

  /**
   * armed → firing, storing the delivery id. One conditional UPDATE with no
   * transaction of its own, so it can run inside the message insert's
   * transaction. True only when this call moved the row.
   *
   * ROUND RV10 item 3: a send that carries the reset flag passes
   * `requireResetAllowed`, so the move is one compare-and-set on "armed and the
   * reset still allowed". The service reads the row before awaits (the settings
   * read), and a turn that opens in that wait disallows the reset (binding 4).
   */
  markFiring(
    sessionId: string,
    armId: string,
    deliveryId: string,
    firedAtMs: number,
    opts: { requireResetAllowed?: boolean } = {}
  ): boolean {
    const resetSql = opts.requireResetAllowed ? " AND reset_allowed = 1" : "";
    const res = this.db
      .prepare(
        `UPDATE context_reset_requests
           SET state = 'firing', delivery_id = @delivery_id, fired_at_ms = @fired_at_ms
         WHERE session_id = @sid AND arm_id = @arm AND state = 'armed'${resetSql}`
      )
      .run({
        sid: sessionId,
        arm: armId,
        delivery_id: deliveryId,
        fired_at_ms: firedAtMs,
      });
    return res.changes === 1;
  }

  /**
   * Move a pending row to a terminal state. `fromStates` narrows which pending
   * states may move (default: both). `outcome` defaults to the state. True only
   * when this call moved the row; a terminal row never moves.
   */
  finish(
    sessionId: string,
    armId: string,
    opts: {
      state: TerminalState;
      fromStates?: readonly ("armed" | "firing")[];
      outcome?: string;
      reason?: string | null;
      newConversationId?: string | null;
    }
  ): boolean {
    if (
      !(CONTEXT_RESET_TERMINAL_STATES as readonly string[]).includes(opts.state)
    ) {
      throw new Error(`context-reset: ${opts.state} is not a terminal state`);
    }
    const from = opts.fromStates ?? ["armed", "firing"];
    const fromSql = from
      .map(s => (s === "armed" ? "'armed'" : "'firing'"))
      .join(", ");
    const res = this.db
      .prepare(
        `UPDATE context_reset_requests
           SET state = @state, outcome = @outcome, outcome_reason = @reason,
               new_conversation_id = COALESCE(@new_conversation_id, new_conversation_id)
         WHERE session_id = @sid AND arm_id = @arm AND state IN (${fromSql})`
      )
      .run({
        sid: sessionId,
        arm: armId,
        state: opts.state,
        outcome: opts.outcome ?? opts.state,
        reason: opts.reason ?? null,
        new_conversation_id: opts.newConversationId ?? null,
      });
    return res.changes === 1;
  }

  /** Record why a pending row waits. */
  setDeferReason(
    sessionId: string,
    armId: string,
    reason: string | null
  ): boolean {
    const res = this.db
      .prepare(
        `UPDATE context_reset_requests SET defer_reason = @reason
         WHERE session_id = @sid AND arm_id = @arm AND ${PENDING_SQL}`
      )
      .run({ sid: sessionId, arm: armId, reason });
    return res.changes === 1;
  }

  /**
   * A turn other than the arming one ran, or the session respawned: the pending
   * row is delivered without a reset. Safe to call twice.
   */
  disallowReset(sessionId: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE context_reset_requests SET reset_allowed = 0
         WHERE session_id = @sid AND ${PENDING_SQL}`
      )
      .run({ sid: sessionId });
    return res.changes === 1;
  }

  /** One more failed send; returns the new count, or null when the row is not pending. */
  incrementFireAttempts(sessionId: string, armId: string): number | null {
    const txn = this.db.transaction((): number | null => {
      const res = this.db
        .prepare(
          `UPDATE context_reset_requests SET fire_attempts = fire_attempts + 1
           WHERE session_id = @sid AND arm_id = @arm AND ${PENDING_SQL}`
        )
        .run({ sid: sessionId, arm: armId });
      if (res.changes !== 1) return null;
      const row = this.db
        .prepare(
          `SELECT fire_attempts FROM context_reset_requests WHERE session_id = @sid`
        )
        .get({ sid: sessionId }) as { fire_attempts: number } | undefined;
      return row ? row.fire_attempts : null;
    });
    return txn.immediate();
  }
}
