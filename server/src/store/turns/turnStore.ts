// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";
import type {
  MirrorAdjustmentRow,
  MirrorTurnRow,
  SessionMetadataFilterOptions,
  SessionMetadataQuery,
  SessionMetadataTurn,
  SessionTokenTotals,
  SessionWorkflowBadge,
  TurnFeedDigestDay,
  TurnTokenBreakdown,
  TurnWorkflowBreakdown,
  WorkflowLabelEvent,
} from "@hapi/protocol";

import { newUuidV7 } from "./ids";
import { BINDING_COLUMNS, tableHasColumns } from "./schema";
import type {
  AppendEventsInput,
  FinalizeTurnInput,
  OpenTurnInput,
  TurnEventInput,
  TurnRow,
  TurnStatus,
} from "./types";

/**
 * The exact SQL prepared by {@link TurnStore.getWorkflowBadge}, hoisted to a
 * module-level constant so the perf-regression plan-shape guard
 * (`turnStore.readers.test.ts`, #2448) can `EXPLAIN QUERY PLAN` the REAL
 * shipping query rather than a re-declared copy that could silently drift.
 * Byte-identical to the former inline literal — see `getWorkflowBadge` for the
 * semantics and the load-bearing join-order pin (which forces the
 * `turns(hapi_session_id)` -> `idx_turn_events_turn` nesting the guard asserts).
 */
export const WORKFLOW_BADGE_SQL = `SELECT
           ?2                      AS issue_number,
           json_group_array(label) AS active_labels_json,
           MAX(ts_ms)              AS last_event_ts_ms
         FROM (
           SELECT label, ts_ms, kind,
                  ROW_NUMBER() OVER (
                    PARTITION BY label
                    ORDER BY ts_ms DESC, id DESC
                  ) AS rn
           FROM (
             SELECT
               json_extract(te.payload, '$.label') AS label,
               te.ts_ms AS ts_ms,
               te.kind  AS kind,
               te.id    AS id
             -- CROSS JOIN = SQLite's documented join-order directive: force
             -- turns(hapi_session_id) -> turn_events(turn_id) index nesting.
             -- Without it the planner (no ANALYZE stats) drives from
             -- idx_turn_events_kind and re-scans every label event per call
             -- (~50ms at prod scale vs ~0.6ms with the forced order).
             FROM turns t
             CROSS JOIN turn_events te ON te.turn_id = t.id
             WHERE t.hapi_session_id = ?1
               AND te.kind IN ('label_added', 'label_removed')
               AND json_extract(te.payload, '$.issue_number') = ?2
             UNION ALL
             SELECT wr.label, wr.ts_ms, wr.kind, wr.id
             FROM workflow_reconcile wr
             WHERE wr.hapi_session_id = ?1 AND wr.issue_number = ?2
           )
         )
         WHERE rn = 1 AND kind = 'label_added'
         GROUP BY 1`;

/**
 * Raw synchronous CRUD for the per-turn telemetry tables (issue #1663).
 *
 * `TurnStore` is the low-level DB surface — its methods are SYNCHRONOUS and MAY
 * THROW (constraint violations, locked DB). The fail-open `TurnWriteService`
 * (Task 7) wraps these calls off the caller's path so a write failure never
 * blocks or crashes a session (R6). Every inserted row gets a UUIDv7 id (R4) and
 * a `node_id` (R5). Mirrors the `errorLog.ts` named-param `@field` INSERT style
 * under `bun:sqlite` `{ strict: true }`.
 */
export class TurnStore {
  constructor(private readonly db: Database) {}

  /** Issue #4824: latched once the billing-attribution columns are seen. */
  private bindingColumnsPresent = false;

  /**
   * Issue #4824: whether `turns` has `auth_binding_kind` / `api_key_id`. The
   * ALTERs are fail-open, so on a boot where they failed the writers and readers
   * leave the columns out instead of throwing on every turn (re-checked until
   * present; the next boot retries the ALTERs).
   */
  private hasBindingColumns(): boolean {
    if (!this.bindingColumnsPresent) {
      this.bindingColumnsPresent = tableHasColumns(
        this.db,
        "turns",
        BINDING_COLUMNS
      );
    }
    return this.bindingColumnsPresent;
  }

  /**
   * Open a turn at UserPromptSubmit. Mints the UUIDv7 id, forces `status='open'`,
   * and returns the new turn id (callers use it for `appendEvents`). Throws on a
   * `(hapi_session_id, seq)` UNIQUE conflict (the operational key, D1).
   */
  insertOpenTurn(input: OpenTurnInput): string {
    const id = newUuidV7();
    // Issue #4824: the binding is an identity column, written here and never by
    // the finalize UPDATE, so a later switch cannot re-attribute this turn.
    const binding = this.hasBindingColumns();
    this.db
      .prepare(
        `INSERT INTO turns (
           id, hapi_session_id, seq, cc_session_id, status, started_at_ms, node_id,
           namespace, launcher, account_id, plan_tier, safe_mode, session_mode,
           permission_mode, session_name, linked_issue, orchestration_id,
           model_provider, model_id, context_window, cwd, repo, is_worktree,
           git_branch, git_sha_start, git_dirty, capture_source, transcript_path,
           recorder_version, schema_version${binding ? ", auth_binding_kind, api_key_id" : ""}
         ) VALUES (
           @id, @hapi_session_id, @seq, @cc_session_id, 'open', @started_at_ms, @node_id,
           @namespace, @launcher, @account_id, @plan_tier, @safe_mode, @session_mode,
           @permission_mode, @session_name, @linked_issue, @orchestration_id,
           @model_provider, @model_id, @context_window, @cwd, @repo, @is_worktree,
           @git_branch, @git_sha_start, @git_dirty, @capture_source, @transcript_path,
           @recorder_version, @schema_version${binding ? ", @auth_binding_kind, @api_key_id" : ""}
         )`
      )
      .run({
        ...(binding
          ? {
              auth_binding_kind: input.authBindingKind ?? null,
              api_key_id: input.apiKeyId ?? null,
            }
          : {}),
        id,
        hapi_session_id: input.hapiSessionId,
        seq: input.seq,
        cc_session_id: input.ccSessionId ?? null,
        started_at_ms: input.startedAtMs,
        node_id: input.nodeId,
        namespace: input.namespace ?? null,
        launcher: input.launcher ?? null,
        account_id: input.accountId ?? null,
        plan_tier: input.planTier ?? null,
        safe_mode: toBit(input.safeMode),
        session_mode: input.sessionMode ?? null,
        permission_mode: input.permissionMode ?? null,
        session_name: input.sessionName ?? null,
        linked_issue: input.linkedIssue ?? null,
        orchestration_id: input.orchestrationId ?? null,
        model_provider: input.modelProvider ?? null,
        model_id: input.modelId ?? null,
        context_window: input.contextWindow ?? null,
        cwd: input.cwd ?? null,
        repo: input.repo ?? null,
        is_worktree: toBit(input.isWorktree),
        git_branch: input.gitBranch ?? null,
        git_sha_start: input.gitShaStart ?? null,
        git_dirty: toBit(input.gitDirty),
        capture_source: input.captureSource ?? null,
        transcript_path: input.transcriptPath ?? null,
        recorder_version: input.recorderVersion ?? null,
        schema_version: input.schemaVersion ?? 1,
      });
    return id;
  }

  /**
   * Finalize a turn at Stop. Keyed by the operational `(hapi_session_id, seq)`
   * pair (D1). UPDATEs the turn row and batch-INSERTs any `events` in ONE
   * transaction. Optional columns are backfilled with `COALESCE(@field, field)`
   * so a finalize never wipes an open-time value it doesn't provide; `cc_session_id`
   * / `prompt_msg_uuid` backfill (Sub C) trips the partial unique index (R3) on a
   * duplicate finalize with a known transcript uuid. Throws if no matching open
   * turn exists (the FIFO write-service guarantees open-before-finalize; a miss is
   * a real anomaly the write service surfaces via the error log).
   */
  finalizeTurn(input: FinalizeTurnInput): void {
    const apply = this.db.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE turns SET
             ended_at_ms              = @ended_at_ms,
             duration_ms              = @duration_ms,
             status                   = @status,
             cc_session_id            = COALESCE(@cc_session_id, cc_session_id),
             prompt_msg_uuid          = COALESCE(@prompt_msg_uuid, prompt_msg_uuid),
             model_provider           = COALESCE(@model_provider, model_provider),
             model_id                 = COALESCE(@model_id, model_id),
             tok_in                   = COALESCE(@tok_in, tok_in),
             tok_out                  = COALESCE(@tok_out, tok_out),
             tok_cache_read           = COALESCE(@tok_cache_read, tok_cache_read),
             tok_cache_write          = COALESCE(@tok_cache_write, tok_cache_write),
             tokens_extra             = COALESCE(@tokens_extra, tokens_extra),
             cost_in                  = COALESCE(@cost_in, cost_in),
             cost_out                 = COALESCE(@cost_out, cost_out),
             cost_cache_read          = COALESCE(@cost_cache_read, cost_cache_read),
             cost_cache_write         = COALESCE(@cost_cache_write, cost_cache_write),
             cost_total               = COALESCE(@cost_total, cost_total),
             rate_card_id             = COALESCE(@rate_card_id, rate_card_id),
             context_used_tokens      = COALESCE(@context_used_tokens, context_used_tokens),
             context_remaining_tokens = COALESCE(@context_remaining_tokens, context_remaining_tokens),
             git_sha_end              = COALESCE(@git_sha_end, git_sha_end),
             git_dirty                = COALESCE(@git_dirty, git_dirty),
             capture_source           = COALESCE(@capture_source, capture_source),
             transcript_path          = COALESCE(@transcript_path, transcript_path),
             prompt_hash              = COALESCE(@prompt_hash, prompt_hash),
             recorder_version         = COALESCE(@recorder_version, recorder_version),
             schema_version           = COALESCE(@schema_version, schema_version)
           WHERE hapi_session_id = @hapi_session_id AND seq = @seq`
        )
        .run({
          hapi_session_id: input.hapiSessionId,
          seq: input.seq,
          ended_at_ms: input.endedAtMs,
          duration_ms: input.durationMs,
          status: input.status,
          cc_session_id: input.ccSessionId ?? null,
          prompt_msg_uuid: input.promptMsgUuid ?? null,
          model_provider: input.modelProvider ?? null,
          model_id: input.modelId ?? null,
          tok_in: input.tokIn ?? null,
          tok_out: input.tokOut ?? null,
          tok_cache_read: input.tokCacheRead ?? null,
          tok_cache_write: input.tokCacheWrite ?? null,
          tokens_extra: serializeJson(input.tokensExtra),
          cost_in: input.costIn ?? null,
          cost_out: input.costOut ?? null,
          cost_cache_read: input.costCacheRead ?? null,
          cost_cache_write: input.costCacheWrite ?? null,
          cost_total: input.costTotal ?? null,
          rate_card_id: input.rateCardId ?? null,
          context_used_tokens: input.contextUsedTokens ?? null,
          context_remaining_tokens: input.contextRemainingTokens ?? null,
          git_sha_end: input.gitShaEnd ?? null,
          git_dirty: toBit(input.gitDirty),
          capture_source: input.captureSource ?? null,
          transcript_path: input.transcriptPath ?? null,
          prompt_hash: input.promptHash ?? null,
          recorder_version: input.recorderVersion ?? null,
          schema_version: input.schemaVersion ?? null,
        });

      if (result.changes === 0) {
        throw new Error(
          `finalizeTurn: no turn for (hapiSessionId=${input.hapiSessionId}, seq=${input.seq})`
        );
      }

      const events = input.events;
      if (events && events.length > 0) {
        const turn = this.db
          .prepare(
            "SELECT id, node_id FROM turns WHERE hapi_session_id = ? AND seq = ?"
          )
          .get(input.hapiSessionId, input.seq) as
          | { id: string; node_id: string }
          | undefined;
        if (turn) {
          this.insertEvents(turn.id, turn.node_id, events);
        }
      }
    });
    apply();
  }

  /** Append events to an already-open turn (uses the caller-provided node_id). */
  appendEvents(input: AppendEventsInput): void {
    if (input.events.length === 0) return;
    const apply = this.db.transaction(() => {
      this.insertEvents(input.turnId, input.nodeId, input.events);
    });
    apply();
  }

  /** Orphan-sweep helper (Sub B): turns still `status='open'`. */
  getOpenTurns(): TurnRow[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM turns WHERE status = 'open' ORDER BY started_at_ms ASC"
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToTurn);
  }

  /**
   * Latest OPEN turn for a session, or `null` — issue #1673 (Sub K).
   * The error-log dual-write (`TurnErrorMirror`) resolves an `error_logs.session_id`
   * to the turn it should attribute against. Indexed by `idx_turns_session_seq` +
   * `idx_turns_status`. Synchronous read; MAY throw (the fail-open mirror wraps it).
   */
  getOpenTurnForSession(hapiSessionId: string): TurnRow | null {
    const row = this.db
      .prepare(
        "SELECT * FROM turns WHERE hapi_session_id = ? AND status = 'open' ORDER BY seq DESC LIMIT 1"
      )
      .get(hapiSessionId) as Record<string, unknown> | undefined;
    return row ? rowToTurn(row) : null;
  }

  /**
   * Latest turn (ANY status) for a session, or `null` — issue #4386. Unlike
   * {@link getOpenTurnForSession} this drops the `status = 'open'` filter, so the
   * agent-peek path can resolve a session's `cc_session_id` + `transcript_path`
   * even after its turn has closed (the row carries both from turn open).
   * Indexed by `idx_turns_session_seq`. Synchronous read.
   */
  getLatestTurnForSession(hapiSessionId: string): TurnRow | null {
    const row = this.db
      .prepare(
        "SELECT * FROM turns WHERE hapi_session_id = ? ORDER BY seq DESC LIMIT 1"
      )
      .get(hapiSessionId) as Record<string, unknown> | undefined;
    return row ? rowToTurn(row) : null;
  }

  /** Single-turn lookup by id. */
  getTurnById(id: string): TurnRow | null {
    const row = this.db.prepare("SELECT * FROM turns WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToTurn(row) : null;
  }

  /**
   * Highest `seq` recorded for a session (0 if none) — issue #1664 (Sub B).
   * The server-side seq allocator (`turnLifecycle.openTurn`) seeds its in-memory
   * high-water mark from this on the first turn it opens in a process, so a
   * fresh process never re-issues a `seq` that a prior generation already
   * persisted (the operational `UNIQUE(hapi_session_id, seq)` key, D1).
   * Synchronous read; never on the session critical path.
   */
  getMaxSeq(hapiSessionId: string): number {
    const row = this.db
      .prepare("SELECT MAX(seq) AS maxSeq FROM turns WHERE hapi_session_id = ?")
      .get(hapiSessionId) as { maxSeq: number | null } | undefined;
    return row?.maxSeq ?? 0;
  }

  /**
   * Mark a still-open turn orphaned — issue #1664 (Sub B orphan sweep, R5) +
   * issue #2248 (lower-bound duration).
   *
   * Sets `status='orphaned'`, `ended_at_ms` to the caller-supplied
   * last-observed-activity WATERMARK (NOT the sweep wall-clock), and derives
   * `duration_ms = MAX(0, ended_at_ms - started_at_ms)` — a strict lower bound.
   *
   * Pre-#2248 this left `duration_ms` NULL, which excluded ~10% of turns (840/8,125
   * in the prod audit) from ALL time aggregation and systematically under-counted
   * work time. The caller (`TurnLifecycle.resolveOrphanClose`) now resolves the
   * watermark (transcript last message, else the `started_at_ms` floor → duration 0)
   * and clamps it to a sane ceiling, so a wall-clock-since-sweep multi-hour phantom
   * (the R6 hazard that originally justified the NULL) cannot arise. Provenance is
   * preserved: `status='orphaned'` still distinguishes a swept row from an organic
   * `completed`, and the sweep records an `orphan_close` turn_event with the
   * watermark source.
   *
   * The `status='open'` guard makes this idempotent and ensures it never clobbers
   * an already-finalized row. Returns true iff a row flipped (so the sweep can
   * count/log). Synchronous.
   */
  markOrphaned(hapiSessionId: string, seq: number, endedAtMs: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE turns
            SET status = 'orphaned',
                ended_at_ms = @ended_at_ms,
                duration_ms = MAX(0, @ended_at_ms - started_at_ms)
          WHERE hapi_session_id = @hapi_session_id AND seq = @seq AND status = 'open'`
      )
      .run({ hapi_session_id: hapiSessionId, seq, ended_at_ms: endedAtMs });
    return result.changes > 0;
  }

  /**
   * Earliest `started_at_ms` among LATER turns of the same session (seq > given),
   * or null when this is the session's last turn — issue #2248. Used by the orphan
   * sweep as an UPPER BOUND on a stale-open turn's activity window, so a later
   * turn's transcript messages are never mis-attributed to an earlier orphan.
   * Synchronous; off any session critical path.
   */
  getNextTurnStartMs(hapiSessionId: string, seq: number): number | null {
    const row = this.db
      .prepare(
        "SELECT MIN(started_at_ms) AS nextStart FROM turns WHERE hapi_session_id = ? AND seq > ?"
      )
      .get(hapiSessionId, seq) as { nextStart: number | null } | undefined;
    return row?.nextStart ?? null;
  }

  /**
   * Session-level token + cost totals from the `v_session_totals` view — issue
   * #1671 (epic #1662, Sub I). The view is the AUTHORITATIVE source for session
   * token totals (the web client aggregate undercounts — 50-msg pages + browser
   * memory, D10). Read-only; never on the prompt/reply path. Returns null when
   * the session has no recorded turns yet.
   */
  getSessionTotals(hapiSessionId: string): SessionTokenTotals | null {
    const row = this.db
      .prepare("SELECT * FROM v_session_totals WHERE hapi_session_id = ?")
      .get(hapiSessionId) as Record<string, unknown> | undefined;
    return row ? rowToSessionTotals(row) : null;
  }

  /**
   * Per-turn token + cost breakdown for a session, ascending by `seq` — issue
   * #1671. Each turn is one prompt→Stop cycle (the DB turn boundary, D10/S-7);
   * the web footer correlates a turn to its concluding message by timestamp
   * bracket. `cost_total` is the rate-card-computed API value (Sub E).
   */
  getTurnBreakdown(hapiSessionId: string): TurnTokenBreakdown[] {
    const rows = this.db
      .prepare(
        `SELECT seq, started_at_ms, ended_at_ms, status, model_id,
                tok_in, tok_out, tok_cache_read, tok_cache_write, cost_total,
                launcher${this.hasBindingColumns() ? ", auth_binding_kind" : ""}
           FROM turns WHERE hapi_session_id = ? ORDER BY seq ASC`
      )
      .all(hapiSessionId) as Array<Record<string, unknown>>;
    return rows.map(rowToTurnBreakdown);
  }

  /**
   * Per-turn resolved workflow label events for a session, ascending by `seq` —
   * issue #1672 (Sub J). JOINs `turns` to `turn_events` (kind `label_added` /
   * `label_removed`), parsing each event's payload for `label` + `issue_number`.
   * Events whose payload lacks a resolved label/issue (the parser's `unresolved`
   * variable-form events) are SKIPPED — the reconcile job (R6) recovers those.
   * Only turns with >= 1 resolved label event are returned. Read-only; never on
   * the prompt/reply path. Feeds the per-turn workflow chip (R1/R5).
   */
  getTurnWorkflowBreakdown(hapiSessionId: string): TurnWorkflowBreakdown[] {
    const rows = this.db
      .prepare(
        `SELECT t.seq AS seq, t.started_at_ms AS started_at_ms,
                t.ended_at_ms AS ended_at_ms, te.kind AS kind,
                te.payload AS payload, te.ts_ms AS ts_ms
           FROM turns t
           JOIN turn_events te ON te.turn_id = t.id
          WHERE t.hapi_session_id = ?
            AND te.kind IN ('label_added', 'label_removed')
          ORDER BY t.seq ASC, te.ts_ms ASC`
      )
      .all(hapiSessionId) as Array<Record<string, unknown>>;

    // Group by seq; collect only resolved label events (R5). A turn with solely
    // unresolved events contributes no chip.
    const bySeq = new Map<number, TurnWorkflowBreakdown>();
    for (const r of rows) {
      const event = rowToWorkflowEvent(r);
      if (event === null) continue; // unresolved variable-form event (R6 recovers)
      const seq = r.seq as number;
      let entry = bySeq.get(seq);
      if (!entry) {
        entry = {
          seq,
          startedAtMs: r.started_at_ms as number,
          endedAtMs: (r.ended_at_ms as number | null) ?? null,
          events: [],
        };
        bySeq.set(seq, entry);
      }
      entry.events.push(event);
    }
    return Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);
  }

  /**
   * Net active workflow labels for a (session, issue) pair — issue #1672
   * (Sub J, R2): the non-monotonic "latest event per label wins" rule (R4)
   * over turn-derived label events UNION'd with `workflow_reconcile` (R6), so
   * a removed checkpoint naturally drops out of `active_labels_json`. Returns
   * null when the session has no workflow-state row for that issue. Read-only.
   *
   * Deliberately replicates `v_workflow_state` scoped to one pair instead of
   * SELECTing from the view: the view's window function blocks SQLite's WHERE
   * pushdown, so a keyed lookup against it recomputes the WHOLE view — a scan
   * of every label event ever recorded (~141ms at prod scale). #1804 made this
   * a per-session call in the `/api/sessions` + federation list projections,
   * where the synchronous recompute serialized the event loop (~1.5s per list
   * request — the 2026-07-29 prod sluggishness incident). Filtering BEFORE the
   * window (indexed: `turns` UNIQUE(hapi_session_id, seq) prefix +
   * `idx_turn_events_turn`) makes the cost O(one pair's events). Equivalence
   * with the view is pinned by turnStore.readers.test.ts.
   */
  getWorkflowBadge(
    hapiSessionId: string,
    issueNumber: number
  ): SessionWorkflowBadge | null {
    const row = this.db
      .prepare(WORKFLOW_BADGE_SQL)
      .get(hapiSessionId, issueNumber) as Record<string, unknown> | undefined;
    if (!row) return null;
    let activeLabels: string[] = [];
    try {
      const parsed: unknown = JSON.parse(
        (row.active_labels_json as string | null) ?? "[]"
      );
      if (Array.isArray(parsed)) {
        activeLabels = parsed.filter((x): x is string => typeof x === "string");
      }
    } catch {
      activeLabels = [];
    }
    return {
      issueNumber: row.issue_number as number,
      activeLabels,
      lastEventTsMs: (row.last_event_ts_ms as number | null) ?? null,
    };
  }

  /**
   * Replace ALL reconcile rows for a (session, issue) with the supplied set —
   * issue #1672 (Sub J, R6). "Replace" semantics keep `workflow_reconcile` a
   * faithful mirror of GitHub's current timeline snapshot, so the call is
   * idempotent per reconcile cycle. One transaction: DELETE the pair's rows, then
   * batch-INSERT. `node_id` stamps the federation origin (R5). INSERT OR IGNORE
   * tolerates a (label, ts_ms) collision within the same snapshot. MAY throw —
   * the reconcile service wraps it fail-open.
   */
  replaceReconcileLabels(
    hapiSessionId: string,
    issueNumber: number,
    nodeId: string,
    events: Array<{
      label: string;
      kind: "label_added" | "label_removed";
      tsMs: number;
    }>
  ): void {
    const apply = this.db.transaction(() => {
      this.db
        .prepare(
          "DELETE FROM workflow_reconcile WHERE hapi_session_id = ? AND issue_number = ?"
        )
        .run(hapiSessionId, issueNumber);
      const stmt = this.db.prepare(
        `INSERT OR IGNORE INTO workflow_reconcile
           (id, hapi_session_id, issue_number, label, kind, ts_ms, node_id)
         VALUES (@id, @hapi_session_id, @issue_number, @label, @kind, @ts_ms, @node_id)`
      );
      for (const ev of events) {
        stmt.run({
          id: newUuidV7(),
          hapi_session_id: hapiSessionId,
          issue_number: issueNumber,
          label: ev.label,
          kind: ev.kind,
          ts_ms: ev.tsMs,
          node_id: nodeId,
        });
      }
    });
    apply();
  }

  /**
   * Node-global session totals from the `v_session_totals` view — the federation
   * read path (issue #1674, epic #1662 Sub L). Bounds by an optional activity
   * window + a hard LIMIT so a heavy node stays under the 10s federation fan-out
   * budget. Reuses the same `rowToSessionTotals` mapper as `getSessionTotals`
   * (V1 parity). Read-only; never on the prompt/reply path.
   *
   * Window semantics: a session is included when its activity window
   * [first_started_at_ms, last_ended_at_ms] OVERLAPS [fromMs, toMs]. An open
   * session (last_ended_at_ms NULL) is treated as still active, so it passes any
   * `fromMs` lower bound. Rows are newest-activity-first.
   */
  getAllSessionTotals(opts?: {
    fromMs?: number;
    toMs?: number;
    limit?: number;
  }): SessionTokenTotals[] {
    const limit = Math.min(Math.max(opts?.limit ?? 500, 1), 2000);
    const clauses: string[] = [];
    const params: Record<string, number> = { limit };
    if (opts?.fromMs !== undefined) {
      clauses.push("(last_ended_at_ms IS NULL OR last_ended_at_ms >= @fromMs)");
      params.fromMs = opts.fromMs;
    }
    if (opts?.toMs !== undefined) {
      clauses.push("first_started_at_ms <= @toMs");
      params.toMs = opts.toMs;
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT * FROM v_session_totals ${where}
         ORDER BY COALESCE(last_ended_at_ms, first_started_at_ms) DESC
         LIMIT @limit`
      )
      .all(params) as Array<Record<string, unknown>>;
    return rows.map(rowToSessionTotals);
  }

  /**
   * Node-local per-turn query for the admin session-metadata surface (issue
   * #1675, epic #1662 Sub M). Read-only SELECT over `turns` with conditional
   * WHERE on the six filter dimensions; `eventKind` matches turns containing ≥1
   * `turn_events` row of that kind via an EXISTS subquery (hits `idx_turn_events_kind`).
   * Bounded by a hard LIMIT (default 500, max 2000) + OFFSET; newest-started-first.
   * Mirrors `getAllSessionTotals`' named-param clause-array style. Never on the
   * prompt/reply path.
   */
  queryTurns(opts?: SessionMetadataQuery): SessionMetadataTurn[] {
    const limit = Math.min(Math.max(opts?.limit ?? 500, 1), 2000);
    const offset = Math.max(opts?.offset ?? 0, 0);
    const clauses: string[] = [];
    const params: Record<string, string | number> = { limit, offset };
    if (opts?.sessionId !== undefined) {
      clauses.push("t.hapi_session_id = @sessionId");
      params.sessionId = opts.sessionId;
    }
    if (opts?.fromMs !== undefined) {
      clauses.push("t.started_at_ms >= @fromMs");
      params.fromMs = opts.fromMs;
    }
    if (opts?.toMs !== undefined) {
      clauses.push("t.started_at_ms <= @toMs");
      params.toMs = opts.toMs;
    }
    if (opts?.repo !== undefined) {
      clauses.push("t.repo = @repo");
      params.repo = opts.repo;
    }
    if (opts?.modelId !== undefined) {
      clauses.push("t.model_id = @modelId");
      params.modelId = opts.modelId;
    }
    if (opts?.accountId !== undefined) {
      clauses.push("t.account_id = @accountId");
      params.accountId = opts.accountId;
    }
    if (opts?.eventKind !== undefined) {
      clauses.push(
        "EXISTS (SELECT 1 FROM turn_events te WHERE te.turn_id = t.id AND te.kind = @eventKind)"
      );
      params.eventKind = opts.eventKind;
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT t.id, t.hapi_session_id, t.seq, t.status, t.started_at_ms,
                t.ended_at_ms, t.duration_ms, t.node_id, t.namespace,
                t.session_name, t.linked_issue, t.repo, t.model_provider,
                t.model_id, t.account_id, t.tok_in, t.tok_out, t.tok_cache_read,
                t.tok_cache_write, t.cost_total${this.hasBindingColumns() ? ", t.auth_binding_kind, t.api_key_id" : ""}
           FROM turns t ${where}
           ORDER BY t.started_at_ms DESC
           LIMIT @limit OFFSET @offset`
      )
      .all(params) as Array<Record<string, unknown>>;
    return rows.map(rowToSessionMetadataTurn);
  }

  /**
   * Distinct filter values for the admin session-metadata filter dropdowns
   * (issue #1675). repos/models/accounts from `turns`; eventKinds from
   * `turn_events`. Read-only; sorted, NULLs excluded.
   */
  getTurnFilterOptions(): SessionMetadataFilterOptions {
    const distinct = (sql: string): string[] =>
      (this.db.prepare(sql).all() as Array<{ v: string }>).map(r => r.v);
    return {
      repos: distinct(
        "SELECT DISTINCT repo AS v FROM turns WHERE repo IS NOT NULL ORDER BY repo"
      ),
      models: distinct(
        "SELECT DISTINCT model_id AS v FROM turns WHERE model_id IS NOT NULL ORDER BY model_id"
      ),
      accounts: distinct(
        "SELECT DISTINCT account_id AS v FROM turns WHERE account_id IS NOT NULL ORDER BY account_id"
      ),
      eventKinds: distinct(
        "SELECT DISTINCT kind AS v FROM turn_events ORDER BY kind"
      ),
    };
  }

  private insertEvents(
    turnId: string,
    nodeId: string,
    events: TurnEventInput[]
  ): void {
    const stmt = this.db.prepare(
      `INSERT INTO turn_events (id, turn_id, node_id, ts_ms, kind, name, payload)
       VALUES (@id, @turn_id, @node_id, @ts_ms, @kind, @name, @payload)`
    );
    for (const event of events) {
      stmt.run({
        id: newUuidV7(),
        turn_id: turnId,
        node_id: nodeId,
        ts_ms: event.tsMs,
        kind: event.kind,
        name: event.name ?? null,
        payload: serializeJson(event.payload),
      });
    }
  }

  // ─────────────── turn-ledger mirror feed readers (issue #4614) ───────────────

  /**
   * This database's ledger incarnation id — minted ONCE, lazily (TurnStore is
   * constructed before runMigrations creates the table, so the ctor can't mint).
   * Stored INSIDE the db so it travels with a backup/restore; a rebuilt VM gets a
   * fresh empty db and mints a NEW incarnation, which makes peers resync (R5).
   */
  getLedgerIncarnation(): string {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO turn_ledger_identity (id, incarnation_id, created_at_ms)
         VALUES (1, @id, @ts)`
      )
      .run({ id: newUuidV7(), ts: Date.now() });
    const row = this.db
      .prepare("SELECT incarnation_id FROM turn_ledger_identity WHERE id = 1")
      .get() as { incarnation_id: string } | null;
    return row?.incarnation_id ?? "";
  }

  /** Max FINALIZED-turn change_seq (origin high-water mark for lag + rewind, R5). */
  getMaxFinalizedChangeSeq(): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(change_seq), 0) AS m FROM turns WHERE status != 'open'"
      )
      .get() as { m: number };
    return row.m;
  }

  /** Max adjustments change_seq. */
  getMaxAdjustmentChangeSeq(): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(change_seq), 0) AS m FROM timelog_adjustments"
      )
      .get() as { m: number };
    return row.m;
  }

  /**
   * Feed page of FINALIZED turns changed since `cursor` (R2). Only `status !=
   * 'open'` replicates (R7). Each row carries the FULL origin row as `rowJson`
   * so an origin column unknown to the puller survives (R9).
   */
  getTurnFeedPage(cursor: number, limit: number): MirrorTurnRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM turns
          WHERE change_seq > @cursor AND status != 'open'
          ORDER BY change_seq ASC LIMIT @limit`
      )
      .all({ cursor, limit }) as Array<Record<string, unknown>>;
    return rows.map(r => ({
      turnId: String(r.id),
      changeSeq: Number(r.change_seq),
      hapiSessionId: String(r.hapi_session_id),
      namespace: (r.namespace as string | null) ?? null,
      status: String(r.status),
      startedAtMs: (r.started_at_ms as number | null) ?? null,
      endedAtMs: (r.ended_at_ms as number | null) ?? null,
      durationMs: (r.duration_ms as number | null) ?? null,
      rowJson: JSON.stringify(r),
    }));
  }

  /** Feed page of timelog_adjustments changed since `cursor` (append-only on origin). */
  getAdjustmentsFeedPage(cursor: number, limit: number): MirrorAdjustmentRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM timelog_adjustments
          WHERE change_seq > @cursor
          ORDER BY change_seq ASC LIMIT @limit`
      )
      .all({ cursor, limit }) as Array<Record<string, unknown>>;
    return rows.map(r => ({
      adjustmentId: String(r.id),
      changeSeq: Number(r.change_seq),
      hapiSessionId: String(r.hapi_session_id),
      namespace: (r.namespace as string | null) ?? null,
      tsMs: (r.ts_ms as number | null) ?? null,
      rowJson: JSON.stringify(r),
    }));
  }

  /**
   * Per-UTC-day (count, checksum) digest over FINALIZED turns for silent-drift
   * detection (R10). checksum = SUM(change_seq) per day — order-independent and
   * cheap; a hand-alteration shifts either the count or the sum.
   */
  getTurnDigest(): TurnFeedDigestDay[] {
    return this.db
      .prepare(
        `SELECT date(started_at_ms / 1000, 'unixepoch') AS date,
                COUNT(*) AS count,
                COALESCE(SUM(change_seq), 0) AS checksum
           FROM turns WHERE status != 'open'
          GROUP BY date ORDER BY date`
      )
      .all() as TurnFeedDigestDay[];
  }
}

/** Boolean → SQLite INTEGER 0/1; null/undefined → NULL. */
function toBit(value: boolean | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return value ? 1 : 0;
}

/** Structured value → JSON TEXT; null/undefined → NULL. */
function serializeJson(
  value: Record<string, unknown> | null | undefined
): string | null {
  if (value === null || value === undefined) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

/** Map a raw `turns` DB row (snake_case) to the `TurnRow` contract (camelCase). */
function rowToTurn(r: Record<string, unknown>): TurnRow {
  return {
    id: r.id as string,
    hapiSessionId: r.hapi_session_id as string,
    seq: r.seq as number,
    ccSessionId: (r.cc_session_id as string | null) ?? null,
    promptMsgUuid: (r.prompt_msg_uuid as string | null) ?? null,
    status: r.status as TurnStatus,
    startedAtMs: r.started_at_ms as number,
    endedAtMs: (r.ended_at_ms as number | null) ?? null,
    durationMs: (r.duration_ms as number | null) ?? null,
    nodeId: r.node_id as string,
    namespace: (r.namespace as string | null) ?? null,
    launcher: (r.launcher as string | null) ?? null,
    accountId: (r.account_id as string | null) ?? null,
    planTier: (r.plan_tier as string | null) ?? null,
    // Issue #4824: undefined (no column yet) maps to null like a legacy row.
    authBindingKind: (r.auth_binding_kind as string | null) ?? null,
    apiKeyId: (r.api_key_id as string | null) ?? null,
    safeMode: (r.safe_mode as number | null) ?? null,
    sessionMode: (r.session_mode as string | null) ?? null,
    permissionMode: (r.permission_mode as string | null) ?? null,
    sessionName: (r.session_name as string | null) ?? null,
    linkedIssue: (r.linked_issue as string | null) ?? null,
    orchestrationId: (r.orchestration_id as string | null) ?? null,
    modelProvider: (r.model_provider as string | null) ?? null,
    modelId: (r.model_id as string | null) ?? null,
    contextWindow: (r.context_window as number | null) ?? null,
    cwd: (r.cwd as string | null) ?? null,
    repo: (r.repo as string | null) ?? null,
    isWorktree: (r.is_worktree as number | null) ?? null,
    gitBranch: (r.git_branch as string | null) ?? null,
    gitShaStart: (r.git_sha_start as string | null) ?? null,
    gitShaEnd: (r.git_sha_end as string | null) ?? null,
    gitDirty: (r.git_dirty as number | null) ?? null,
    tokIn: (r.tok_in as number | null) ?? null,
    tokOut: (r.tok_out as number | null) ?? null,
    tokCacheRead: (r.tok_cache_read as number | null) ?? null,
    tokCacheWrite: (r.tok_cache_write as number | null) ?? null,
    tokensExtra: (r.tokens_extra as string | null) ?? null,
    costIn: (r.cost_in as number | null) ?? null,
    costOut: (r.cost_out as number | null) ?? null,
    costCacheRead: (r.cost_cache_read as number | null) ?? null,
    costCacheWrite: (r.cost_cache_write as number | null) ?? null,
    costTotal: (r.cost_total as number | null) ?? null,
    rateCardId: (r.rate_card_id as string | null) ?? null,
    contextUsedTokens: (r.context_used_tokens as number | null) ?? null,
    contextRemainingTokens:
      (r.context_remaining_tokens as number | null) ?? null,
    captureSource: (r.capture_source as string | null) ?? null,
    transcriptPath: (r.transcript_path as string | null) ?? null,
    promptHash: (r.prompt_hash as string | null) ?? null,
    schemaVersion: r.schema_version as number,
    recorderVersion: (r.recorder_version as string | null) ?? null,
  };
}

/**
 * Map a `v_session_totals` row (snake_case) to the shared `SessionTokenTotals`
 * (camelCase) — issue #1671. SUM/MAX over NULL columns is NULL in SQLite, so
 * every aggregate is nullable except `turn_count` (COUNT, always a number).
 */
function rowToSessionTotals(r: Record<string, unknown>): SessionTokenTotals {
  return {
    hapiSessionId: r.hapi_session_id as string,
    nodeId: (r.node_id as string | null) ?? null,
    namespace: (r.namespace as string | null) ?? null,
    turnCount: (r.turn_count as number | null) ?? 0,
    firstStartedAtMs: (r.first_started_at_ms as number | null) ?? null,
    lastEndedAtMs: (r.last_ended_at_ms as number | null) ?? null,
    totalDurationMs: (r.total_duration_ms as number | null) ?? null,
    totalTokIn: (r.total_tok_in as number | null) ?? null,
    totalTokOut: (r.total_tok_out as number | null) ?? null,
    totalTokCacheRead: (r.total_tok_cache_read as number | null) ?? null,
    totalTokCacheWrite: (r.total_tok_cache_write as number | null) ?? null,
    totalCost: (r.total_cost as number | null) ?? null,
    lastSeq: (r.last_seq as number | null) ?? null,
    lastModelId: (r.last_model_id as string | null) ?? null,
    lastAccountId: (r.last_account_id as string | null) ?? null,
    lastLinkedIssue: (r.last_linked_issue as string | null) ?? null,
    lastRepo: (r.last_repo as string | null) ?? null,
    // Issue #4824: the split of `totalCost` by each turn's recorded binding —
    // real charges (key / gateway), API-equivalent value (subscription), and
    // rows with no recognized binding. NULL while no row of a bucket is priced.
    realCost: (r.real_cost as number | null) ?? null,
    equivalentCost: (r.equivalent_cost as number | null) ?? null,
    unattributedCost: (r.unattributed_cost as number | null) ?? null,
  };
}

/** Map a `turns` row subset (snake_case) to the shared `TurnTokenBreakdown`. */
function rowToTurnBreakdown(r: Record<string, unknown>): TurnTokenBreakdown {
  return {
    seq: r.seq as number,
    startedAtMs: r.started_at_ms as number,
    endedAtMs: (r.ended_at_ms as number | null) ?? null,
    status: r.status as string,
    modelId: (r.model_id as string | null) ?? null,
    tokIn: (r.tok_in as number | null) ?? null,
    tokOut: (r.tok_out as number | null) ?? null,
    tokCacheRead: (r.tok_cache_read as number | null) ?? null,
    tokCacheWrite: (r.tok_cache_write as number | null) ?? null,
    costTotal: (r.cost_total as number | null) ?? null,
    // Issue #4068: the per-turn launcher gates the web's pty/tmux footer pass.
    launcher: (r.launcher as string | null) ?? null,
    // Issue #4824: the binding the turn ran under — colours its footer figure.
    authBindingKind: (r.auth_binding_kind as string | null) ?? null,
  };
}

/**
 * Map a (turns JOIN turn_events) label-event row to a `WorkflowLabelEvent`, or
 * `null` when the payload lacks a resolved label/issue_number (an `unresolved`
 * variable-form event — issue #1672 R5/R6). The Sub C parser records resolved
 * events with `payload: { label, issue_number }` and unresolved ones with
 * `{ unresolved: true, raw }`.
 */
function rowToWorkflowEvent(
  r: Record<string, unknown>
): WorkflowLabelEvent | null {
  const payloadRaw = r.payload as string | null;
  if (!payloadRaw) return null;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(payloadRaw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const label = payload.label;
  const issueNumber = payload.issue_number;
  if (typeof label !== "string" || typeof issueNumber !== "number") {
    return null;
  }
  const kind = r.kind as string;
  if (kind !== "label_added" && kind !== "label_removed") return null;
  return { kind, label, issueNumber, tsMs: r.ts_ms as number };
}

/**
 * Map a `turns` row subset (snake_case) to the curated `SessionMetadataTurn`
 * (camelCase) for the admin session-metadata grid (issue #1675). NULLable
 * columns surface as `<type> | null`, matching the shared schema.
 */
function rowToSessionMetadataTurn(
  r: Record<string, unknown>
): SessionMetadataTurn {
  return {
    id: r.id as string,
    hapiSessionId: r.hapi_session_id as string,
    seq: r.seq as number,
    status: r.status as string,
    startedAtMs: r.started_at_ms as number,
    endedAtMs: (r.ended_at_ms as number | null) ?? null,
    durationMs: (r.duration_ms as number | null) ?? null,
    nodeId: r.node_id as string,
    namespace: (r.namespace as string | null) ?? null,
    sessionName: (r.session_name as string | null) ?? null,
    linkedIssue: (r.linked_issue as string | null) ?? null,
    repo: (r.repo as string | null) ?? null,
    modelProvider: (r.model_provider as string | null) ?? null,
    modelId: (r.model_id as string | null) ?? null,
    accountId: (r.account_id as string | null) ?? null,
    tokIn: (r.tok_in as number | null) ?? null,
    tokOut: (r.tok_out as number | null) ?? null,
    tokCacheRead: (r.tok_cache_read as number | null) ?? null,
    tokCacheWrite: (r.tok_cache_write as number | null) ?? null,
    costTotal: (r.cost_total as number | null) ?? null,
    // Issue #4824 (R9): the turn's binding, so cost can be reported per key.
    authBindingKind: (r.auth_binding_kind as string | null) ?? null,
    apiKeyId: (r.api_key_id as string | null) ?? null,
  };
}
