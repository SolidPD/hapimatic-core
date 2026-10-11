// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";

import type { HandoffState } from "@hapi/protocol";

/**
 * Persisted, restart-surviving slice of a session's watermark state (issue #2158).
 *
 * Only two facts MUST survive a restart, and both are safety-critical:
 *   - `handoffState` — specifically the `handing_off` value: a restart mid-handoff
 *     that forgot the input HOLD would reopen the reap race (`queueDrainObserver`
 *     would pop-and-lose the predecessor's queued message).
 *   - `suppressed` — a restart that forgot the disarm-suppression flag would
 *     re-arm a manually-disarmed session within one poll (a decorative disarm).
 *
 * `generation` is persisted alongside so a mid-handoff restart knows the inherited
 * packet generation (anti-chain cap). The transient `armed`/`deferredReason`/
 * `contextPercentage` fields are deliberately NOT persisted — a restart between
 * arm and fire is self-healing (the session re-arms on the next poll, it is still
 * over the watermark).
 */
export interface PersistedWatermarkRow {
  sessionId: string;
  handoffState: HandoffState;
  suppressed: boolean;
  generation: number;
  updatedAtMs: number;
}

interface WatermarkRow {
  session_id: string;
  handoff_state: string;
  suppressed: number;
  generation: number;
  updated_at_ms: number;
}

function toRow(row: WatermarkRow): PersistedWatermarkRow {
  return {
    sessionId: row.session_id,
    handoffState: row.handoff_state as HandoffState,
    suppressed: row.suppressed !== 0,
    generation: row.generation,
    updatedAtMs: row.updated_at_ms,
  };
}

/**
 * SQLite-backed persistence for the context-watermark handoff hold + disarm
 * suppression (issue #2158). The `context_watermark_state` table is created in
 * `Store.runMigrations()` (`store/index.ts`), NOT here (parity with the
 * initiative / file-claim store-direct entities). Methods are SYNCHRONOUS and MAY
 * THROW; the SERVICE layer owns fail-open, matching the off-request-path store
 * precedents. No FK to `sessions` (history + hold survive session churn; parity
 * with `session_file_claims`); no CHECK on `handoff_state` (house rule K1 —
 * canonical values are the TS union at the edge, not a DB constraint).
 */
export class WatermarkStore {
  constructor(
    private readonly db: Database,
    private readonly getNow: () => number = Date.now
  ) {}

  /** Insert-or-replace the full persisted slice for a session. */
  upsert(input: {
    sessionId: string;
    handoffState: HandoffState;
    suppressed: boolean;
    generation: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO context_watermark_state
           (session_id, handoff_state, suppressed, generation, updated_at_ms)
         VALUES (@session_id, @handoff_state, @suppressed, @generation, @updated_at_ms)
         ON CONFLICT(session_id) DO UPDATE SET
           handoff_state = @handoff_state,
           suppressed = @suppressed,
           generation = @generation,
           updated_at_ms = @updated_at_ms`
      )
      .run({
        session_id: input.sessionId,
        handoff_state: input.handoffState,
        suppressed: input.suppressed ? 1 : 0,
        generation: input.generation,
        updated_at_ms: this.getNow(),
      });
  }

  /** Update ONLY the handoff state (leaves suppression/generation intact). */
  setHandoffState(sessionId: string, handoffState: HandoffState): void {
    this.db
      .prepare(
        `INSERT INTO context_watermark_state
           (session_id, handoff_state, suppressed, generation, updated_at_ms)
         VALUES (@session_id, @handoff_state, 0, 0, @updated_at_ms)
         ON CONFLICT(session_id) DO UPDATE SET
           handoff_state = @handoff_state,
           updated_at_ms = @updated_at_ms`
      )
      .run({
        session_id: sessionId,
        handoff_state: handoffState,
        updated_at_ms: this.getNow(),
      });
  }

  /** Update ONLY the suppression flag (leaves handoff state/generation intact). */
  setSuppressed(sessionId: string, suppressed: boolean): void {
    this.db
      .prepare(
        `INSERT INTO context_watermark_state
           (session_id, handoff_state, suppressed, generation, updated_at_ms)
         VALUES (@session_id, 'idle', @suppressed, 0, @updated_at_ms)
         ON CONFLICT(session_id) DO UPDATE SET
           suppressed = @suppressed,
           updated_at_ms = @updated_at_ms`
      )
      .run({
        session_id: sessionId,
        suppressed: suppressed ? 1 : 0,
        updated_at_ms: this.getNow(),
      });
  }

  get(sessionId: string): PersistedWatermarkRow | null {
    const row = this.db
      .prepare(
        "SELECT session_id, handoff_state, suppressed, generation, updated_at_ms " +
          "FROM context_watermark_state WHERE session_id = @sid"
      )
      .get({ sid: sessionId }) as WatermarkRow | undefined;
    return row ? toRow(row) : null;
  }

  /** All persisted rows — read once at boot to hydrate the in-memory service. */
  all(): PersistedWatermarkRow[] {
    const rows = this.db
      .prepare(
        "SELECT session_id, handoff_state, suppressed, generation, updated_at_ms " +
          "FROM context_watermark_state"
      )
      .all() as WatermarkRow[];
    return rows.map(toRow);
  }

  delete(sessionId: string): void {
    this.db
      .prepare("DELETE FROM context_watermark_state WHERE session_id = @sid")
      .run({ sid: sessionId });
  }
}
