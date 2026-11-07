// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";
import { readThroughputState, writeThroughputState } from "./schema";

/**
 * Reads and writes for the throughput facts loop (issue #6164, epic #6163 A1).
 *
 * The only writer of `turns.throughput_json`. Every write is a compare-and-set
 * (section 4.3 of the directive): it changes no other column, it is a no-op
 * when the stored JSON is identical (so the change-seq trigger never fires for
 * an unchanged record), and it refuses when any fingerprint column moved since
 * the facts were computed. Facts are computed OUTSIDE any transaction; this
 * store then writes at most `maxRows` rows or `budgetMs` of work per
 * `BEGIN IMMEDIATE` transaction with a short busy wait, and reports SQLITE_BUSY
 * as a value so the loop retries next tick instead of stalling.
 */

/** The ledger columns a facts record is computed from. */
export interface FactsTurnRow {
  id: string;
  changeSeq: number;
  hapiSessionId: string;
  seq: number;
  ccSessionId: string | null;
  promptMsgUuid: string | null;
  status: string;
  startedAtMs: number;
  endedAtMs: number | null;
  transcriptPath: string | null;
  tokIn: number | null;
  tokOut: number | null;
  tokCacheRead: number | null;
  tokCacheWrite: number | null;
  namespace: string | null;
  repo: string | null;
  linkedIssue: string | null;
  throughputJson: string | null;
}

/**
 * Collection outcome per turn, kept ONLY here (node-local, never replicated).
 * `pending` / `deferred` rows are the loop's persisted work queue: discovery
 * marks a changed row `pending` before its cursor advances, so a restart loses
 * nothing; a live transcript's rows wait as `deferred`.
 */
export type FactsOutcome =
  | "pending"
  | "facts"
  | "missing"
  | "unaligned"
  | "read_error"
  | "too_large"
  | "out_of_window"
  | "deferred";

export interface ProgressRow {
  turnId: string;
  startedAtMs: number | null;
  fp: string | null;
  outcome: FactsOutcome;
  attempts: number;
  lastMs: number;
  fileSize: number | null;
  fileMtimeMs: number | null;
  bgFp: string | null;
}

/** The fingerprint columns as read when the facts were computed. */
export interface FactsExpectation {
  status: string;
  promptMsgUuid: string | null;
  transcriptPath: string | null;
  tokIn: number | null;
  tokOut: number | null;
  tokCacheRead: number | null;
  tokCacheWrite: number | null;
  startedAtMs: number;
}

export interface FactsWrite {
  id: string;
  json: string;
  expect: FactsExpectation;
}

export interface FactsBatchResult {
  /** How many of the given writes this call consumed (in order). */
  consumed: number;
  written: number;
  /** Already stored byte-identical: no write, no change-seq bump. */
  unchanged: number;
  /** A fingerprint column moved (or the row is gone): recompute next tick. */
  refused: number;
  /** The ids of the refused writes. */
  refusedIds: string[];
  /** SQLITE_BUSY: nothing in this batch was written; retry next tick. */
  busy: boolean;
}

export interface OpeningMessage {
  createdAtMs: number;
  sentFrom: string | null;
  originClass: string | null;
  originSessionId: string | null;
  /** The prompt text, for marker classification only — never stored. */
  text: string | null;
}

export interface BackgroundAgentRow {
  agentId: string;
  toolUseId: string | null;
  status: string;
  startedAtMs: number | null;
  endedAtMs: number | null;
  tokIn: number;
  tokOut: number;
  tokCacheRead: number;
  tokCacheWrite: number;
}

export interface BackgroundLaunch {
  toolUseId: string;
  turnId: string;
  hapiSessionId: string;
  agentId: string | null;
  launchedAtMs: number | null;
}

const ROW_COLUMNS = `id, change_seq, hapi_session_id, seq, cc_session_id,
  prompt_msg_uuid, status, started_at_ms, ended_at_ms, transcript_path,
  tok_in, tok_out, tok_cache_read, tok_cache_write, namespace, repo,
  linked_issue, throughput_json`;

const CAS_SQL = `UPDATE turns SET throughput_json = @json
  WHERE id = @id
    AND throughput_json IS NOT @json
    AND status IS @status
    AND prompt_msg_uuid IS @pu
    AND transcript_path IS @tp
    AND tok_in IS @ti
    AND tok_out IS @to
    AND tok_cache_read IS @tcr
    AND tok_cache_write IS @tcw
    AND started_at_ms IS @sa`;

/** Default write bounds (directive section 4.3). */
export const FACTS_WRITE_MAX_ROWS = 100;
export const FACTS_WRITE_BUDGET_MS = 25;
export const FACTS_WRITE_BUSY_TIMEOUT_MS = 250;

/** A `turns` row (any column set) as a {@link FactsTurnRow}. */
export function toFactsTurnRow(r: Record<string, unknown>): FactsTurnRow {
  const n = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const s = (v: unknown): string | null =>
    typeof v === "string" && v !== "" ? v : null;
  return {
    id: String(r.id),
    changeSeq: Number(r.change_seq ?? 0),
    hapiSessionId: String(r.hapi_session_id),
    seq: Number(r.seq ?? 0),
    ccSessionId: s(r.cc_session_id),
    promptMsgUuid: s(r.prompt_msg_uuid),
    status: String(r.status),
    startedAtMs: Number(r.started_at_ms ?? 0),
    endedAtMs: n(r.ended_at_ms),
    transcriptPath: s(r.transcript_path),
    tokIn: n(r.tok_in),
    tokOut: n(r.tok_out),
    tokCacheRead: n(r.tok_cache_read),
    tokCacheWrite: n(r.tok_cache_write),
    namespace: s(r.namespace),
    repo: s(r.repo),
    linkedIssue: s(r.linked_issue),
    throughputJson: s(r.throughput_json),
  };
}

/** The expectation a write carries for `row` (its fingerprint columns now). */
export function expectationOf(row: FactsTurnRow): FactsExpectation {
  return {
    status: row.status,
    promptMsgUuid: row.promptMsgUuid,
    transcriptPath: row.transcriptPath,
    tokIn: row.tokIn,
    tokOut: row.tokOut,
    tokCacheRead: row.tokCacheRead,
    tokCacheWrite: row.tokCacheWrite,
    startedAtMs: row.startedAtMs,
  };
}

function isBusyError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /database is locked|SQLITE_BUSY/i.test(message);
}

export class ThroughputFactsStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now
  ) {}

  /** Finalized local turns whose `change_seq` is past `cursor`, oldest change first. */
  listChangedSince(cursor: number, limit: number): FactsTurnRow[] {
    return (
      this.db
        .prepare(
          `SELECT ${ROW_COLUMNS} FROM turns
            WHERE change_seq > @cursor AND status != 'open'
            ORDER BY change_seq ASC LIMIT @limit`
        )
        .all({ cursor, limit }) as Array<Record<string, unknown>>
    ).map(toFactsTurnRow);
  }

  /** Every local turn of one Claude session (any status), oldest first. */
  listForCcSession(ccSessionId: string): FactsTurnRow[] {
    return (
      this.db
        .prepare(
          `SELECT ${ROW_COLUMNS} FROM turns
            WHERE cc_session_id = @cc
            ORDER BY started_at_ms ASC, seq ASC`
        )
        .all({ cc: ccSessionId }) as Array<Record<string, unknown>>
    ).map(toFactsTurnRow);
  }

  /** One local turn, or null. */
  getTurn(id: string): FactsTurnRow | null {
    const row = this.db
      .prepare(`SELECT ${ROW_COLUMNS} FROM turns WHERE id = @id`)
      .get({ id }) as Record<string, unknown> | undefined;
    return row ? toFactsTurnRow(row) : null;
  }

  /** The highest local `change_seq` (0 for an empty ledger). */
  maxChangeSeq(): number {
    const row = this.db
      .prepare("SELECT MAX(change_seq) AS m FROM turns")
      .get() as { m: number | null } | undefined;
    return row?.m ?? 0;
  }

  getProgress(ids: readonly string[]): Map<string, ProgressRow> {
    const out = new Map<string, ProgressRow>();
    if (ids.length === 0) return out;
    const stmt = this.db.prepare(
      `SELECT turn_id, started_at_ms, fp, outcome, attempts, last_ms,
              file_size, file_mtime_ms, bg_fp
         FROM throughput_turn_progress WHERE turn_id = @id`
    );
    for (const id of ids) {
      const r = stmt.get({ id }) as Record<string, unknown> | undefined;
      if (!r) continue;
      out.set(id, {
        turnId: String(r.turn_id),
        startedAtMs: (r.started_at_ms as number | null) ?? null,
        fp: (r.fp as string | null) ?? null,
        outcome: r.outcome as FactsOutcome,
        attempts: Number(r.attempts ?? 0),
        lastMs: Number(r.last_ms ?? 0),
        fileSize: (r.file_size as number | null) ?? null,
        fileMtimeMs: (r.file_mtime_ms as number | null) ?? null,
        bgFp: (r.bg_fp as string | null) ?? null,
      });
    }
    return out;
  }

  upsertProgress(rows: readonly ProgressRow[]): void {
    if (rows.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO throughput_turn_progress (
         turn_id, started_at_ms, fp, outcome, attempts, last_ms,
         file_size, file_mtime_ms, bg_fp
       ) VALUES (@id, @started, @fp, @outcome, @attempts, @last,
                 @size, @mtime, @bg)
       ON CONFLICT (turn_id) DO UPDATE SET
         started_at_ms = excluded.started_at_ms,
         fp            = excluded.fp,
         outcome       = excluded.outcome,
         attempts      = excluded.attempts,
         last_ms       = excluded.last_ms,
         file_size     = excluded.file_size,
         file_mtime_ms = excluded.file_mtime_ms,
         bg_fp         = excluded.bg_fp`
    );
    const apply = this.db.transaction((items: readonly ProgressRow[]) => {
      for (const p of items) {
        stmt.run({
          id: p.turnId,
          started: p.startedAtMs,
          fp: p.fp,
          outcome: p.outcome,
          attempts: p.attempts,
          last: p.lastMs,
          size: p.fileSize,
          mtime: p.fileMtimeMs,
          bg: p.bgFp,
        });
      }
    });
    apply.immediate(rows);
  }

  /**
   * The work queue: `pending` rows, and `deferred` rows last looked at no later
   * than `recheckBeforeMs`, newest turn first.
   */
  listWork(recheckBeforeMs: number, limit: number): ProgressRow[] {
    const rows = this.db
      .prepare(
        `SELECT turn_id FROM throughput_turn_progress
          WHERE outcome = 'pending'
             OR (outcome = 'deferred' AND last_ms <= @recheck)
          ORDER BY started_at_ms DESC LIMIT @limit`
      )
      .all({ recheck: recheckBeforeMs, limit }) as Array<{ turn_id: string }>;
    const progress = this.getProgress(rows.map(r => r.turn_id));
    return rows
      .map(r => progress.get(r.turn_id))
      .filter((p): p is ProgressRow => p !== undefined);
  }

  /** Whether any `pending` row exists (the loop's busy signal). */
  hasPending(): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM throughput_turn_progress WHERE outcome = 'pending' LIMIT 1"
        )
        .get()
    );
  }

  /** When facts were last collected for any turn of one Claude session. */
  lastCollectedMs(ccSessionId: string): number | null {
    const row = this.db
      .prepare(
        `SELECT MAX(p.last_ms) AS m FROM throughput_turn_progress p
           JOIN turns t ON t.id = p.turn_id
          WHERE t.cc_session_id = ? AND p.outcome = 'facts'`
      )
      .get(ccSessionId) as { m: number | null } | undefined;
    return row?.m ?? null;
  }

  /**
   * Drop progress rows of turns that started before `beforeMs`, and background
   * launches made before it. Returns the progress rows dropped.
   */
  pruneProgress(beforeMs: number): number {
    const res = this.db
      .prepare("DELETE FROM throughput_turn_progress WHERE started_at_ms < ?")
      .run(beforeMs);
    this.db
      .prepare("DELETE FROM throughput_bg_launches WHERE launched_at_ms < ?")
      .run(beforeMs);
    return res.changes;
  }

  /**
   * Write ONE bounded compare-and-set transaction from the head of `writes`:
   * at most `maxRows` rows or `budgetMs` of work. The caller yields to the
   * event loop and calls again with the rest (`writes.slice(consumed)`).
   */
  writeFactsBatch(
    writes: readonly FactsWrite[],
    opts: { maxRows?: number; budgetMs?: number; busyTimeoutMs?: number } = {}
  ): FactsBatchResult {
    const maxRows = opts.maxRows ?? FACTS_WRITE_MAX_ROWS;
    const budgetMs = opts.budgetMs ?? FACTS_WRITE_BUDGET_MS;
    const busyTimeoutMs = opts.busyTimeoutMs ?? FACTS_WRITE_BUSY_TIMEOUT_MS;
    const result: FactsBatchResult = {
      consumed: 0,
      written: 0,
      unchanged: 0,
      refused: 0,
      refusedIds: [],
      busy: false,
    };
    if (writes.length === 0) return result;

    const cas = this.db.prepare(CAS_SQL);
    const current = this.db.prepare(
      "SELECT throughput_json FROM turns WHERE id = ?"
    );
    const previousTimeout = this.readBusyTimeout();
    const start = this.now();
    let written = 0;
    let unchanged = 0;
    let refused = 0;
    const refusedIds: string[] = [];
    const txn = this.db.transaction(() => {
      let n = 0;
      while (n < writes.length && n < maxRows) {
        const w = writes[n]!;
        const res = cas.run({
          json: w.json,
          id: w.id,
          status: w.expect.status,
          pu: w.expect.promptMsgUuid,
          tp: w.expect.transcriptPath,
          ti: w.expect.tokIn,
          to: w.expect.tokOut,
          tcr: w.expect.tokCacheRead,
          tcw: w.expect.tokCacheWrite,
          sa: w.expect.startedAtMs,
        });
        if (res.changes > 0) {
          written += 1;
        } else {
          const row = current.get(w.id) as
            | { throughput_json: string | null }
            | undefined;
          if (row && row.throughput_json === w.json) unchanged += 1;
          else {
            refused += 1;
            refusedIds.push(w.id);
          }
        }
        n += 1;
        if (this.now() - start >= budgetMs) break;
      }
      return n;
    });
    try {
      this.setBusyTimeout(busyTimeoutMs);
      result.consumed = txn.immediate();
      result.written = written;
      result.unchanged = unchanged;
      result.refused = refused;
      result.refusedIds = refusedIds;
    } catch (error) {
      if (!isBusyError(error)) throw error;
      result.busy = true;
    } finally {
      this.setBusyTimeout(previousTimeout);
    }
    return result;
  }

  /** The session's own linked issue (`{number, repo}`), or null. */
  sessionLinkedIssue(
    hapiSessionId: string
  ): { number: number; repo: string } | null {
    const row = this.db
      .prepare("SELECT linked_issue FROM sessions WHERE id = ?")
      .get(hapiSessionId) as { linked_issue: string | null } | undefined;
    if (!row?.linked_issue) return null;
    try {
      const parsed = JSON.parse(row.linked_issue) as {
        number?: unknown;
        repo?: unknown;
      };
      return typeof parsed.number === "number" &&
        typeof parsed.repo === "string" &&
        parsed.repo !== ""
        ? { number: parsed.number, repo: parsed.repo }
        : null;
    } catch {
      return null;
    }
  }

  /** Whether the session row exists and is marked active. */
  sessionIsActive(hapiSessionId: string): boolean {
    const row = this.db
      .prepare("SELECT active FROM sessions WHERE id = ?")
      .get(hapiSessionId) as { active: number | null } | undefined;
    return row?.active === 1;
  }

  /**
   * The latest user message delivered to the session in `[afterMs, atMs]`
   * (server-stamped provenance for a turn's opening prompt). Read outside any
   * write transaction.
   */
  findOpeningMessage(
    hapiSessionId: string,
    afterMs: number,
    atMs: number
  ): OpeningMessage | null {
    const row = this.db
      .prepare(
        `SELECT content, created_at FROM messages
          WHERE session_id = @sid
            AND json_extract(content, '$.role') = 'user'
            AND created_at >= @after AND created_at <= @at
          ORDER BY created_at DESC LIMIT 1`
      )
      .get({ sid: hapiSessionId, after: afterMs, at: atMs }) as
      | { content: string; created_at: number }
      | undefined;
    if (!row) return null;
    let parsed: Record<string, unknown>;
    try {
      const value = JSON.parse(row.content) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
      }
      parsed = value as Record<string, unknown>;
    } catch {
      return null;
    }
    const meta =
      parsed.meta && typeof parsed.meta === "object"
        ? (parsed.meta as Record<string, unknown>)
        : {};
    const origin =
      meta.origin && typeof meta.origin === "object"
        ? (meta.origin as Record<string, unknown>)
        : {};
    const content = parsed.content;
    let text: string | null = null;
    if (typeof content === "string") text = content;
    else if (content && typeof content === "object") {
      const t = (content as Record<string, unknown>).text;
      if (typeof t === "string") text = t;
    }
    return {
      createdAtMs: row.created_at,
      sentFrom: typeof meta.sentFrom === "string" ? meta.sentFrom : null,
      originClass: typeof origin.class === "string" ? origin.class : null,
      originSessionId:
        typeof origin.sessionId === "string" && origin.sessionId !== ""
          ? origin.sessionId
          : null,
      text: text === null ? null : text.slice(0, 2000),
    };
  }

  /** The session's background-agent ledger rows. */
  listBackgroundAgents(hapiSessionId: string): BackgroundAgentRow[] {
    return (
      this.db
        .prepare(
          `SELECT agent_id, tool_use_id, status, started_at_ms, ended_at_ms,
                  tok_in, tok_out, tok_cache_read, tok_cache_write
             FROM background_agent_usage WHERE hapi_session_id = ?`
        )
        .all(hapiSessionId) as Array<Record<string, unknown>>
    ).map(r => ({
      agentId: String(r.agent_id),
      toolUseId: (r.tool_use_id as string | null) ?? null,
      status: String(r.status),
      startedAtMs: (r.started_at_ms as number | null) ?? null,
      endedAtMs: (r.ended_at_ms as number | null) ?? null,
      tokIn: Number(r.tok_in ?? 0),
      tokOut: Number(r.tok_out ?? 0),
      tokCacheRead: Number(r.tok_cache_read ?? 0),
      tokCacheWrite: Number(r.tok_cache_write ?? 0),
    }));
  }

  /** Background agents whose row ended after `sinceMs`, with their session. */
  listBackgroundAgentsEndedSince(
    sinceMs: number,
    limit: number
  ): Array<BackgroundAgentRow & { hapiSessionId: string }> {
    return (
      this.db
        .prepare(
          `SELECT hapi_session_id, agent_id, tool_use_id, status,
                  started_at_ms, ended_at_ms, tok_in, tok_out,
                  tok_cache_read, tok_cache_write
             FROM background_agent_usage
            WHERE ended_at_ms > @since
            ORDER BY ended_at_ms ASC LIMIT @limit`
        )
        .all({ since: sinceMs, limit }) as Array<Record<string, unknown>>
    ).map(r => ({
      hapiSessionId: String(r.hapi_session_id),
      agentId: String(r.agent_id),
      toolUseId: (r.tool_use_id as string | null) ?? null,
      status: String(r.status),
      startedAtMs: (r.started_at_ms as number | null) ?? null,
      endedAtMs: (r.ended_at_ms as number | null) ?? null,
      tokIn: Number(r.tok_in ?? 0),
      tokOut: Number(r.tok_out ?? 0),
      tokCacheRead: Number(r.tok_cache_read ?? 0),
      tokCacheWrite: Number(r.tok_cache_write ?? 0),
    }));
  }

  /** Record the background launches of a collected turn (replacing its old set). */
  replaceBackgroundLaunches(
    turnId: string,
    launches: readonly BackgroundLaunch[]
  ): void {
    const del = this.db.prepare(
      "DELETE FROM throughput_bg_launches WHERE turn_id = ?"
    );
    const ins = this.db.prepare(
      `INSERT INTO throughput_bg_launches (
         tool_use_id, turn_id, hapi_session_id, agent_id, launched_at_ms
       ) VALUES (@tool, @turn, @sid, @agent, @at)
       ON CONFLICT (tool_use_id) DO UPDATE SET
         turn_id = excluded.turn_id,
         hapi_session_id = excluded.hapi_session_id,
         agent_id = excluded.agent_id,
         launched_at_ms = excluded.launched_at_ms`
    );
    const apply = this.db.transaction(() => {
      del.run(turnId);
      for (const l of launches) {
        ins.run({
          tool: l.toolUseId,
          turn: l.turnId,
          sid: l.hapiSessionId,
          agent: l.agentId,
          at: l.launchedAtMs,
        });
      }
    });
    apply.immediate();
  }

  /** The launch rows of one turn. */
  listBackgroundLaunches(turnId: string): BackgroundLaunch[] {
    return (
      this.db
        .prepare(
          `SELECT tool_use_id, turn_id, hapi_session_id, agent_id, launched_at_ms
             FROM throughput_bg_launches WHERE turn_id = ?`
        )
        .all(turnId) as Array<Record<string, unknown>>
    ).map(r => ({
      toolUseId: String(r.tool_use_id),
      turnId: String(r.turn_id),
      hapiSessionId: String(r.hapi_session_id),
      agentId: (r.agent_id as string | null) ?? null,
      launchedAtMs: (r.launched_at_ms as number | null) ?? null,
    }));
  }

  /** The turn that launched a background agent (by tool-use id), or null. */
  launchingTurnOf(toolUseId: string): string | null {
    const row = this.db
      .prepare(
        "SELECT turn_id FROM throughput_bg_launches WHERE tool_use_id = ?"
      )
      .get(toolUseId) as { turn_id: string } | undefined;
    return row?.turn_id ?? null;
  }

  getState(key: string): string | null {
    return readThroughputState(this.db, key);
  }

  setState(key: string, value: string): void {
    writeThroughputState(this.db, key, value, this.now());
  }

  private readBusyTimeout(): number {
    const row = this.db.prepare("PRAGMA busy_timeout").get() as
      | Record<string, unknown>
      | undefined;
    const value = row ? Object.values(row)[0] : undefined;
    return typeof value === "number" ? value : 5000;
  }

  private setBusyTimeout(ms: number): void {
    const safe = Math.max(0, Math.floor(ms));
    this.db.prepare(`PRAGMA busy_timeout = ${safe}`).get();
  }
}
