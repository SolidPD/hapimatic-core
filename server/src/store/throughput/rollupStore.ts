// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";
import {
  rateCardSourceFor,
  rateCardsGeneration,
  type RateCardSource,
} from "./rateCardSource";
import {
  ROLLUP_TABLES,
  readThroughputState,
  writeThroughputState,
} from "./schema";

/**
 * Per-day throughput rollups (issue #6164, epic #6163 A1 — directive 4.4).
 *
 * Node-local, derived and rebuildable: the rollup loop recomputes a dirty
 * `(origin, day)` bucket WHOLE from local turns and deduplicated mirror rows,
 * then {@link replaceBucket} swaps it in one short IMMEDIATE transaction. The
 * REST summary reads only these tables — an indexed `GROUP BY` over whole UTC
 * days — and never parses `row_json`.
 *
 * Namespace scope: every row carries the turn's namespace (`ns`); readers
 * apply `(ns = $ns OR (ns IS NULL AND $owner = 1))`, the transcript store's
 * pattern (`transcriptIndexStore.ts` SCOPE_SQL), so a NULL-namespace row is
 * visible only to the node's owning namespace.
 */

export interface RollupScope {
  namespace: string;
  /** True when the caller's namespace is the node's owning namespace. */
  isOwner: boolean;
}

export interface TokenSumsRow {
  tokIn: number;
  tokOut: number;
  tokCr: number;
  tokW1: number;
  tokW5: number;
  tokWu: number;
}

export interface CostRollupRow extends TokenSumsRow {
  ns: string | null;
  account: string;
  model: string;
  stage: string;
  src: string;
  turns: number;
  calls: number;
  usdIn: number;
  usdOut: number;
  usdCr: number;
  usdW1: number;
  usdW5: number;
  usdWu: number;
  usdTotal: number;
  usdFallback: number;
}

export interface EffortRollupRow {
  ns: string | null;
  account: string;
  model: string;
  effort: string;
  calls: number;
}

export interface CtxRollupRow {
  ns: string | null;
  kind: "main" | "sub" | "start";
  bin: number;
  n: number;
}

export interface IdleRollupRow {
  ns: string | null;
  cls: string;
  n: number;
  w1: number;
  w5: number;
  usd: number;
}

export interface SessionRollupRow extends TokenSumsRow {
  ns: string | null;
  sessionId: string;
  label: string | null;
  account: string;
  issueKey: string | null;
  turns: number;
  calls: number;
  usdTotal: number;
  firstMs: number | null;
  lastMs: number | null;
}

export interface IssueRollupRow extends TokenSumsRow {
  ns: string | null;
  issueKey: string;
  stage: string;
  turns: number;
  calls: number;
  usdTotal: number;
}

export interface TestsRollupRow {
  ns: string | null;
  unit: string;
  failRuns: number;
  sessions: number;
  firstMs: number | null;
  lastMs: number | null;
}

export interface CovRollupRow {
  ns: string | null;
  turns: number;
  withFacts: number;
  recovered: number;
  tokNullNoFacts: number;
  orphaned: number;
  calls: number;
  testRuns: number;
  testFail: number;
  usdTotal: number;
  usdUnattributed: number;
  usdFallback: number;
  latestMs: number | null;
}

/** A mirrored turn as the rollup reads it (the full origin row as JSON). */
export interface MirrorSourceRow {
  rowJson: string;
  turnId: string;
  incarnation: string;
  originChangeSeq: number;
  mirroredAtMs: number;
}

/** One account-day of quota-model inputs (R7). */
export interface QuotaDayRow {
  accountId: string;
  day: string;
  firstUtil: number | null;
  lastUtil: number | null;
  firstMs: number | null;
  lastMs: number | null;
  samples: number;
  /** A drop of more than 5 percentage points inside the day: a weekly reset. */
  resetCrossed: boolean;
  tokIn: number;
  tokOut: number;
  tokCr: number;
  tokW1: number;
  tokW5: number;
  /** Cache writes of unknown TTL (ledger rows without facts). */
  tokWu: number;
  /** That day's tokens on turns with no account (shown beside the fit). */
  unattributedTok: number;
}

/** Everything one `(origin, day)` bucket holds. */
export interface RollupBucket {
  cost: CostRollupRow[];
  effort: EffortRollupRow[];
  ctx: CtxRollupRow[];
  idle: IdleRollupRow[];
  session: SessionRollupRow[];
  issue: IssueRollupRow[];
  tests: TestsRollupRow[];
  cov: CovRollupRow[];
}

export function emptyRollupBucket(): RollupBucket {
  return {
    cost: [],
    effort: [],
    ctx: [],
    idle: [],
    session: [],
    issue: [],
    tests: [],
    cov: [],
  };
}

/** Grouping columns a cost read may use (whitelisted; never interpolated raw). */
export const COST_GROUP_COLUMNS = [
  "account",
  "model",
  "stage",
  "src",
  "origin",
  "day",
] as const;
export type CostGroupColumn = (typeof COST_GROUP_COLUMNS)[number];

/** One grouped cost read: the group keys plus the summed measures. */
export interface CostGroupRow extends TokenSumsRow {
  keys: Partial<Record<CostGroupColumn, string>>;
  turns: number;
  calls: number;
  usdIn: number;
  usdOut: number;
  usdCr: number;
  usdW1: number;
  usdW5: number;
  usdWu: number;
  usdTotal: number;
  usdFallback: number;
}

export interface CoverageGroupRow {
  origin: string;
  turns: number;
  withFacts: number;
  recovered: number;
  tokNullNoFacts: number;
  orphaned: number;
  calls: number;
  testRuns: number;
  testFail: number;
  usdTotal: number;
  usdUnattributed: number;
  usdFallback: number;
  latestMs: number | null;
  /** Turns of the window's last 2 days (for "recent rows have no facts"). */
  recentTurns: number;
  recentWithFacts: number;
}

const SCOPE_SQL = "(ns = $ns OR (ns IS NULL AND $owner = 1))";
const GENERATION_KEY = "rollup.generation";

/** The six token sums every rollup read selects (read back by `tokenSumsOf`). */
const SUM_TOKEN_COLUMNS = `
  SUM(tok_in) AS tok_in, SUM(tok_out) AS tok_out, SUM(tok_cr) AS tok_cr,
  SUM(tok_w1) AS tok_w1, SUM(tok_w5) AS tok_w5, SUM(tok_wu) AS tok_wu`;

const SUM_COST_COLUMNS = `
  SUM(turns) AS turns, SUM(calls) AS calls, ${SUM_TOKEN_COLUMNS},
  SUM(usd_in) AS usd_in, SUM(usd_out) AS usd_out, SUM(usd_cr) AS usd_cr,
  SUM(usd_w1) AS usd_w1, SUM(usd_w5) AS usd_w5, SUM(usd_wu) AS usd_wu,
  SUM(usd_total) AS usd_total, SUM(usd_fallback) AS usd_fallback`;

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** The token sums of a row read with `SUM_TOKEN_COLUMNS` (or the stored columns). */
function tokenSumsOf(r: Record<string, unknown>): TokenSumsRow {
  return {
    tokIn: num(r.tok_in),
    tokOut: num(r.tok_out),
    tokCr: num(r.tok_cr),
    tokW1: num(r.tok_w1),
    tokW5: num(r.tok_w5),
    tokWu: num(r.tok_wu),
  };
}

function scopeParams(scope: RollupScope): { ns: string; owner: number } {
  return { ns: scope.namespace, owner: scope.isOwner ? 1 : 0 };
}

/** Opaque, stable pagination cursor (a row offset). */
export function decodeCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  const n = Number.parseInt(cursor, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export class ThroughputRollupStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now
  ) {}

  // ─────────────────────────── writer side ───────────────────────────

  /** Mark buckets dirty (idempotent; keeps the earliest mark). */
  markDirty(buckets: ReadonlyArray<{ origin: string; day: string }>): void {
    if (buckets.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO throughput_rollup_dirty (origin, day, marked_at_ms)
       VALUES (@origin, @day, @at)
       ON CONFLICT (origin, day) DO NOTHING`
    );
    const at = this.now();
    const apply = this.db.transaction(() => {
      for (const b of buckets) stmt.run({ origin: b.origin, day: b.day, at });
    });
    apply.immediate();
  }

  /** Mark every bucket that already holds rollups since `sinceDay` dirty. */
  markAllDirtySince(sinceDay: string): number {
    const res = this.db
      .prepare(
        `INSERT INTO throughput_rollup_dirty (origin, day, marked_at_ms)
         SELECT DISTINCT origin, day, @at FROM throughput_rollup_cov
          WHERE day >= @since
         ON CONFLICT (origin, day) DO NOTHING`
      )
      .run({ at: this.now(), since: sinceDay });
    return res.changes;
  }

  /** The oldest-marked dirty buckets. */
  listDirty(limit: number): Array<{ origin: string; day: string }> {
    return this.db
      .prepare(
        `SELECT origin, day FROM throughput_rollup_dirty
          ORDER BY marked_at_ms ASC, day DESC LIMIT ?`
      )
      .all(limit) as Array<{ origin: string; day: string }>;
  }

  countDirty(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM throughput_rollup_dirty")
      .get() as { c: number };
    return row.c;
  }

  /**
   * Swap one bucket's rollups: delete its old rows from every rollup table,
   * insert the new ones and clear its dirty mark — one IMMEDIATE transaction.
   * Bumps the rollup generation (the summary's memo / ETag key).
   */
  replaceBucket(origin: string, day: string, bucket: RollupBucket): void {
    const db = this.db;
    const del = ROLLUP_TABLES.map(t =>
      db.prepare(`DELETE FROM ${t} WHERE day = @day AND origin = @origin`)
    );
    const insCost = db.prepare(
      `INSERT INTO throughput_rollup_cost (
         ns, origin, day, account, model, stage, src, turns, calls,
         tok_in, tok_out, tok_cr, tok_w1, tok_w5, tok_wu,
         usd_in, usd_out, usd_cr, usd_w1, usd_w5, usd_wu, usd_total, usd_fallback
       ) VALUES (
         @ns, @origin, @day, @account, @model, @stage, @src, @turns, @calls,
         @tin, @tout, @tcr, @tw1, @tw5, @twu,
         @uin, @uout, @ucr, @uw1, @uw5, @uwu, @utotal, @ufb
       )`
    );
    const insEffort = db.prepare(
      `INSERT INTO throughput_rollup_effort (ns, origin, day, account, model, effort, calls)
       VALUES (@ns, @origin, @day, @account, @model, @effort, @calls)`
    );
    const insCtx = db.prepare(
      `INSERT INTO throughput_rollup_ctx (ns, origin, day, kind, bin, n)
       VALUES (@ns, @origin, @day, @kind, @bin, @n)`
    );
    const insIdle = db.prepare(
      `INSERT INTO throughput_rollup_idle (ns, origin, day, cls, n, w1, w5, usd)
       VALUES (@ns, @origin, @day, @cls, @n, @w1, @w5, @usd)`
    );
    const insSession = db.prepare(
      `INSERT INTO throughput_rollup_session (
         ns, origin, day, session_id, label, account, issue_key, turns, calls,
         tok_in, tok_out, tok_cr, tok_w1, tok_w5, tok_wu, usd_total, first_ms, last_ms
       ) VALUES (
         @ns, @origin, @day, @sid, @label, @account, @issue, @turns, @calls,
         @tin, @tout, @tcr, @tw1, @tw5, @twu, @usd, @first, @last
       )`
    );
    const insIssue = db.prepare(
      `INSERT INTO throughput_rollup_issue (
         ns, origin, day, issue_key, stage, turns, calls,
         tok_in, tok_out, tok_cr, tok_w1, tok_w5, tok_wu, usd_total
       ) VALUES (
         @ns, @origin, @day, @issue, @stage, @turns, @calls,
         @tin, @tout, @tcr, @tw1, @tw5, @twu, @usd
       )`
    );
    const insTests = db.prepare(
      `INSERT INTO throughput_rollup_tests (ns, origin, day, unit, fail_runs, sessions, first_ms, last_ms)
       VALUES (@ns, @origin, @day, @unit, @fail, @sessions, @first, @last)`
    );
    const insCov = db.prepare(
      `INSERT INTO throughput_rollup_cov (
         ns, origin, day, turns, with_facts, recovered, tok_null_no_facts, orphaned,
         calls, test_runs, test_fail, usd_total, usd_unattributed, usd_fallback, latest_ms
       ) VALUES (
         @ns, @origin, @day, @turns, @facts, @recovered, @nofacts, @orphaned,
         @calls, @truns, @tfail, @usd, @unattr, @fb, @latest
       )`
    );
    const clearDirty = db.prepare(
      "DELETE FROM throughput_rollup_dirty WHERE origin = @origin AND day = @day"
    );
    const key = { origin, day };
    const apply = db.transaction(() => {
      for (const d of del) d.run(key);
      for (const r of bucket.cost) {
        insCost.run({
          ...key,
          ns: r.ns,
          account: r.account,
          model: r.model,
          stage: r.stage,
          src: r.src,
          turns: r.turns,
          calls: r.calls,
          tin: r.tokIn,
          tout: r.tokOut,
          tcr: r.tokCr,
          tw1: r.tokW1,
          tw5: r.tokW5,
          twu: r.tokWu,
          uin: r.usdIn,
          uout: r.usdOut,
          ucr: r.usdCr,
          uw1: r.usdW1,
          uw5: r.usdW5,
          uwu: r.usdWu,
          utotal: r.usdTotal,
          ufb: r.usdFallback,
        });
      }
      for (const r of bucket.effort) {
        insEffort.run({
          ...key,
          ns: r.ns,
          account: r.account,
          model: r.model,
          effort: r.effort,
          calls: r.calls,
        });
      }
      for (const r of bucket.ctx) {
        insCtx.run({ ...key, ns: r.ns, kind: r.kind, bin: r.bin, n: r.n });
      }
      for (const r of bucket.idle) {
        insIdle.run({
          ...key,
          ns: r.ns,
          cls: r.cls,
          n: r.n,
          w1: r.w1,
          w5: r.w5,
          usd: r.usd,
        });
      }
      for (const r of bucket.session) {
        insSession.run({
          ...key,
          ns: r.ns,
          sid: r.sessionId,
          label: r.label,
          account: r.account,
          issue: r.issueKey,
          turns: r.turns,
          calls: r.calls,
          tin: r.tokIn,
          tout: r.tokOut,
          tcr: r.tokCr,
          tw1: r.tokW1,
          tw5: r.tokW5,
          twu: r.tokWu,
          usd: r.usdTotal,
          first: r.firstMs,
          last: r.lastMs,
        });
      }
      for (const r of bucket.issue) {
        insIssue.run({
          ...key,
          ns: r.ns,
          issue: r.issueKey,
          stage: r.stage,
          turns: r.turns,
          calls: r.calls,
          tin: r.tokIn,
          tout: r.tokOut,
          tcr: r.tokCr,
          tw1: r.tokW1,
          tw5: r.tokW5,
          twu: r.tokWu,
          usd: r.usdTotal,
        });
      }
      for (const r of bucket.tests) {
        insTests.run({
          ...key,
          ns: r.ns,
          unit: r.unit,
          fail: r.failRuns,
          sessions: r.sessions,
          first: r.firstMs,
          last: r.lastMs,
        });
      }
      for (const r of bucket.cov) {
        insCov.run({
          ...key,
          ns: r.ns,
          turns: r.turns,
          facts: r.withFacts,
          recovered: r.recovered,
          nofacts: r.tokNullNoFacts,
          orphaned: r.orphaned,
          calls: r.calls,
          truns: r.testRuns,
          tfail: r.testFail,
          usd: r.usdTotal,
          unattr: r.usdUnattributed,
          fb: r.usdFallback,
          latest: r.latestMs,
        });
      }
      clearDirty.run(key);
      const gen = Number(readThroughputState(db, GENERATION_KEY) ?? "0");
      writeThroughputState(db, GENERATION_KEY, String(gen + 1), this.now());
    });
    apply.immediate();
  }

  /** Delete every rollup (and dirty mark) of one origin. */
  deleteOrigin(origin: string): number {
    let removed = 0;
    const apply = this.db.transaction(() => {
      for (const t of ROLLUP_TABLES) {
        removed += this.db
          .prepare(`DELETE FROM ${t} WHERE origin = ?`)
          .run(origin).changes;
      }
      this.db
        .prepare("DELETE FROM throughput_rollup_dirty WHERE origin = ?")
        .run(origin);
    });
    apply.immediate();
    return removed;
  }

  /** Delete rollups (and dirty marks) of days before `beforeDay`. */
  pruneBefore(beforeDay: string): number {
    let removed = 0;
    const apply = this.db.transaction(() => {
      for (const t of ROLLUP_TABLES) {
        removed += this.db
          .prepare(`DELETE FROM ${t} WHERE day < ?`)
          .run(beforeDay).changes;
      }
      this.db
        .prepare("DELETE FROM throughput_rollup_dirty WHERE day < ?")
        .run(beforeDay);
    });
    apply.immediate();
    return removed;
  }

  /** The rollup generation (bumped on every bucket swap). */
  generation(): number {
    return Number(readThroughputState(this.db, GENERATION_KEY) ?? "0");
  }

  getState(key: string): string | null {
    return readThroughputState(this.db, key);
  }

  setState(key: string, value: string): void {
    writeThroughputState(this.db, key, value, this.now());
  }

  // ─────────────────────────── reader side ───────────────────────────

  /** Summed cost lines over `[fromDay, toDay]`, grouped by whitelisted columns. */
  sumCost(
    fromDay: string,
    toDay: string,
    scope: RollupScope,
    groupBy: readonly CostGroupColumn[]
  ): CostGroupRow[] {
    const cols = groupBy.filter(c =>
      (COST_GROUP_COLUMNS as readonly string[]).includes(c)
    );
    const select = cols.length > 0 ? `${cols.join(", ")},` : "";
    const group = cols.length > 0 ? `GROUP BY ${cols.join(", ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT ${select} ${SUM_COST_COLUMNS}
           FROM throughput_rollup_cost
          WHERE day >= $from AND day <= $to AND ${SCOPE_SQL}
          ${group}`
      )
      .all({ from: fromDay, to: toDay, ...scopeParams(scope) }) as Array<
      Record<string, unknown>
    >;
    return rows
      .filter(r => r.turns !== null || cols.length > 0)
      .map(r => {
        const keys: Partial<Record<CostGroupColumn, string>> = {};
        for (const c of cols) keys[c] = String(r[c] ?? "");
        return {
          keys,
          turns: num(r.turns),
          calls: num(r.calls),
          ...tokenSumsOf(r),
          usdIn: num(r.usd_in),
          usdOut: num(r.usd_out),
          usdCr: num(r.usd_cr),
          usdW1: num(r.usd_w1),
          usdW5: num(r.usd_w5),
          usdWu: num(r.usd_wu),
          usdTotal: num(r.usd_total),
          usdFallback: num(r.usd_fallback),
        };
      });
  }

  /** Effort × model call counts. */
  sumEffort(
    fromDay: string,
    toDay: string,
    scope: RollupScope
  ): Array<{ effort: string; model: string; calls: number }> {
    return (
      this.db
        .prepare(
          `SELECT effort, model, SUM(calls) AS calls
             FROM throughput_rollup_effort
            WHERE day >= $from AND day <= $to AND ${SCOPE_SQL}
            GROUP BY effort, model ORDER BY calls DESC`
        )
        .all({ from: fromDay, to: toDay, ...scopeParams(scope) }) as Array<
        Record<string, unknown>
      >
    ).map(r => ({
      effort: String(r.effort),
      model: String(r.model),
      calls: num(r.calls),
    }));
  }

  /** Context histograms by kind (`{ kind: { bin: n } }`). */
  ctxHistograms(
    fromDay: string,
    toDay: string,
    scope: RollupScope
  ): Record<"main" | "sub" | "start", Record<string, number>> {
    const out: Record<"main" | "sub" | "start", Record<string, number>> = {
      main: {},
      sub: {},
      start: {},
    };
    const rows = this.db
      .prepare(
        `SELECT kind, bin, SUM(n) AS n FROM throughput_rollup_ctx
          WHERE day >= $from AND day <= $to AND ${SCOPE_SQL}
          GROUP BY kind, bin`
      )
      .all({ from: fromDay, to: toDay, ...scopeParams(scope) }) as Array<{
      kind: string;
      bin: number;
      n: number;
    }>;
    for (const r of rows) {
      if (r.kind === "main" || r.kind === "sub" || r.kind === "start") {
        out[r.kind][String(r.bin)] = num(r.n);
      }
    }
    return out;
  }

  /** Post-idle rewrites by wait class. */
  idleByClass(
    fromDay: string,
    toDay: string,
    scope: RollupScope
  ): Array<{ cls: string; n: number; w1: number; w5: number; usd: number }> {
    return (
      this.db
        .prepare(
          `SELECT cls, SUM(n) AS n, SUM(w1) AS w1, SUM(w5) AS w5, SUM(usd) AS usd
             FROM throughput_rollup_idle
            WHERE day >= $from AND day <= $to AND ${SCOPE_SQL}
            GROUP BY cls ORDER BY usd DESC`
        )
        .all({ from: fromDay, to: toDay, ...scopeParams(scope) }) as Array<
        Record<string, unknown>
      >
    ).map(r => ({
      cls: String(r.cls),
      n: num(r.n),
      w1: num(r.w1),
      w5: num(r.w5),
      usd: num(r.usd),
    }));
  }

  /** Per-origin coverage sums; `recentFromDay` bounds the "recent" columns. */
  coverage(
    fromDay: string,
    toDay: string,
    recentFromDay: string,
    scope: RollupScope
  ): CoverageGroupRow[] {
    return (
      this.db
        .prepare(
          `SELECT origin,
                  SUM(turns) AS turns, SUM(with_facts) AS with_facts,
                  SUM(recovered) AS recovered,
                  SUM(tok_null_no_facts) AS tok_null_no_facts,
                  SUM(orphaned) AS orphaned, SUM(calls) AS calls,
                  SUM(test_runs) AS test_runs, SUM(test_fail) AS test_fail,
                  SUM(usd_total) AS usd_total,
                  SUM(usd_unattributed) AS usd_unattributed,
                  SUM(usd_fallback) AS usd_fallback,
                  MAX(latest_ms) AS latest_ms,
                  SUM(CASE WHEN day >= $recent THEN turns ELSE 0 END) AS recent_turns,
                  SUM(CASE WHEN day >= $recent THEN with_facts ELSE 0 END) AS recent_facts
             FROM throughput_rollup_cov
            WHERE day >= $from AND day <= $to AND ${SCOPE_SQL}
            GROUP BY origin ORDER BY turns DESC`
        )
        .all({
          from: fromDay,
          to: toDay,
          recent: recentFromDay,
          ...scopeParams(scope),
        }) as Array<Record<string, unknown>>
    ).map(r => ({
      origin: String(r.origin),
      turns: num(r.turns),
      withFacts: num(r.with_facts),
      recovered: num(r.recovered),
      tokNullNoFacts: num(r.tok_null_no_facts),
      orphaned: num(r.orphaned),
      calls: num(r.calls),
      testRuns: num(r.test_runs),
      testFail: num(r.test_fail),
      usdTotal: num(r.usd_total),
      usdUnattributed: num(r.usd_unattributed),
      usdFallback: num(r.usd_fallback),
      latestMs: (r.latest_ms as number | null) ?? null,
      recentTurns: num(r.recent_turns),
      recentWithFacts: num(r.recent_facts),
    }));
  }

  /** Sessions in the window, by cost (identity-bearing; paged). */
  sessions(
    fromDay: string,
    toDay: string,
    scope: RollupScope,
    offset: number,
    limit: number
  ): { rows: SessionRollupRow[]; total: number } {
    const params = { from: fromDay, to: toDay, ...scopeParams(scope) };
    const total = (
      this.db
        .prepare(
          `SELECT COUNT(DISTINCT session_id) AS c FROM throughput_rollup_session
            WHERE day >= $from AND day <= $to AND ${SCOPE_SQL}`
        )
        .get(params) as { c: number }
    ).c;
    const rows = this.db
      .prepare(
        `SELECT session_id,
                MAX(ns) AS ns,
                MAX(label) AS label,
                MAX(account) AS account,
                MAX(issue_key) AS issue_key,
                SUM(turns) AS turns, SUM(calls) AS calls, ${SUM_TOKEN_COLUMNS},
                SUM(usd_total) AS usd_total,
                MIN(first_ms) AS first_ms, MAX(last_ms) AS last_ms
           FROM throughput_rollup_session
          WHERE day >= $from AND day <= $to AND ${SCOPE_SQL}
          GROUP BY session_id
          ORDER BY usd_total DESC, session_id ASC
          LIMIT $limit OFFSET $offset`
      )
      .all({ ...params, limit, offset }) as Array<Record<string, unknown>>;
    return {
      total,
      rows: rows.map(r => ({
        ns: (r.ns as string | null) ?? null,
        sessionId: String(r.session_id),
        label: (r.label as string | null) ?? null,
        account: String(r.account ?? "unattributed"),
        issueKey: (r.issue_key as string | null) ?? null,
        turns: num(r.turns),
        calls: num(r.calls),
        ...tokenSumsOf(r),
        usdTotal: num(r.usd_total),
        firstMs: (r.first_ms as number | null) ?? null,
        lastMs: (r.last_ms as number | null) ?? null,
      })),
    };
  }

  /** Issues in the window, by cost (identity-bearing; paged). */
  issues(
    fromDay: string,
    toDay: string,
    scope: RollupScope,
    offset: number,
    limit: number
  ): {
    rows: Array<
      TokenSumsRow & {
        issueKey: string;
        turns: number;
        calls: number;
        usdTotal: number;
      }
    >;
    total: number;
  } {
    const params = { from: fromDay, to: toDay, ...scopeParams(scope) };
    const total = (
      this.db
        .prepare(
          `SELECT COUNT(DISTINCT issue_key) AS c FROM throughput_rollup_issue
            WHERE day >= $from AND day <= $to AND ${SCOPE_SQL}`
        )
        .get(params) as { c: number }
    ).c;
    const rows = this.db
      .prepare(
        `SELECT issue_key,
                SUM(turns) AS turns, SUM(calls) AS calls, ${SUM_TOKEN_COLUMNS},
                SUM(usd_total) AS usd_total
           FROM throughput_rollup_issue
          WHERE day >= $from AND day <= $to AND ${SCOPE_SQL}
          GROUP BY issue_key
          ORDER BY usd_total DESC, issue_key ASC
          LIMIT $limit OFFSET $offset`
      )
      .all({ ...params, limit, offset }) as Array<Record<string, unknown>>;
    return {
      total,
      rows: rows.map(r => ({
        issueKey: String(r.issue_key),
        turns: num(r.turns),
        calls: num(r.calls),
        ...tokenSumsOf(r),
        usdTotal: num(r.usd_total),
      })),
    };
  }

  /**
   * All-time cost and stage-turns per issue key (for the per-issue facts rows):
   * the rollup keys issue rows by stage, so a turn counts once per stage it
   * touched (#6355 item 1).
   */
  issueTotals(
    keys: readonly string[],
    scope: RollupScope
  ): Map<string, { usd: number; turns: number }> {
    const out = new Map<string, { usd: number; turns: number }>();
    if (keys.length === 0) return out;
    const stmt = this.db.prepare(
      `SELECT SUM(usd_total) AS usd, SUM(turns) AS turns
         FROM throughput_rollup_issue
        WHERE issue_key = $key AND ${SCOPE_SQL}`
    );
    for (const key of keys) {
      const r = stmt.get({ key, ...scopeParams(scope) }) as
        | { usd: number | null; turns: number | null }
        | undefined;
      if (r && r.turns !== null) {
        out.set(key, { usd: num(r.usd), turns: num(r.turns) });
      }
    }
    return out;
  }

  /**
   * Agent-run failing units in the window (identity-bearing). Returns every
   * unit: the caller pages.
   */
  tests(
    fromDay: string,
    toDay: string,
    scope: RollupScope
  ): Array<{
    unit: string;
    failRuns: number;
    sessions: number;
    firstMs: number | null;
    lastMs: number | null;
  }> {
    return (
      this.db
        .prepare(
          `SELECT unit, SUM(fail_runs) AS fail_runs, SUM(sessions) AS sessions,
                  MIN(first_ms) AS first_ms, MAX(last_ms) AS last_ms
             FROM throughput_rollup_tests
            WHERE day >= $from AND day <= $to AND ${SCOPE_SQL}
            GROUP BY unit`
        )
        .all({ from: fromDay, to: toDay, ...scopeParams(scope) }) as Array<
        Record<string, unknown>
      >
    ).map(r => ({
      unit: String(r.unit),
      failRuns: num(r.fail_runs),
      sessions: num(r.sessions),
      firstMs: (r.first_ms as number | null) ?? null,
      lastMs: (r.last_ms as number | null) ?? null,
    }));
  }

  // ─────────────────────────── rollup sources ───────────────────────────

  /** Rate-card reads for the TTL-aware pricer. */
  rateCards(): RateCardSource {
    return rateCardSourceFor(this.db);
  }

  /** Changes whenever the stored rate cards change. */
  rateCardsGeneration(): string {
    return rateCardsGeneration(this.db);
  }

  /** Local finalized turns that started in `[fromMs, toMs)` (full rows). */
  localTurnsInRange(
    fromMs: number,
    toMs: number
  ): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT * FROM turns
          WHERE started_at_ms >= ? AND started_at_ms < ? AND status != 'open'`
      )
      .all(fromMs, toMs) as Array<Record<string, unknown>>;
  }

  /** One origin's mirrored rows that started in `[fromMs, toMs)`, every incarnation. */
  mirrorRowsInRange(
    origin: string,
    fromMs: number,
    toMs: number
  ): MirrorSourceRow[] {
    return (
      this.db
        .prepare(
          `SELECT row_json, origin_incarnation, origin_change_seq, mirrored_at_ms, turn_id
             FROM turn_mirror
            WHERE origin_node_id = ? AND started_at_ms >= ? AND started_at_ms < ?
              AND status != 'open'`
        )
        .all(origin, fromMs, toMs) as Array<Record<string, unknown>>
    ).map(r => ({
      rowJson: String(r.row_json),
      turnId: String(r.turn_id),
      incarnation: String(r.origin_incarnation),
      originChangeSeq: num(r.origin_change_seq),
      mirroredAtMs: num(r.mirrored_at_ms),
    }));
  }

  /** Local rows changed after `cursor` (any status), in change order. */
  localChangesSince(
    cursor: number,
    limit: number
  ): Array<{ startedAtMs: number; changeSeq: number }> {
    return (
      this.db
        .prepare(
          `SELECT started_at_ms, change_seq FROM turns
            WHERE change_seq > ? ORDER BY change_seq ASC LIMIT ?`
        )
        .all(cursor, limit) as Array<{
        started_at_ms: number;
        change_seq: number;
      }>
    ).map(r => ({ startedAtMs: r.started_at_ms, changeSeq: r.change_seq }));
  }

  /** Each origin's current incarnation and pulled cursor (#4614). */
  mirrorCursors(): Array<{
    origin: string;
    incarnation: string;
    turnCursor: number;
  }> {
    return (
      this.db
        .prepare(
          "SELECT origin_node_id, origin_incarnation, turn_cursor FROM turn_mirror_cursor"
        )
        .all() as Array<{
        origin_node_id: string;
        origin_incarnation: string;
        turn_cursor: number;
      }>
    ).map(r => ({
      origin: r.origin_node_id,
      incarnation: r.origin_incarnation,
      turnCursor: r.turn_cursor,
    }));
  }

  /** Every (origin, incarnation) in the mirror with its highest change. */
  mirrorIncarnations(): Array<{
    origin: string;
    incarnation: string;
    maxSeq: number;
  }> {
    return (
      this.db
        .prepare(
          `SELECT origin_node_id, origin_incarnation, MAX(origin_change_seq) AS m
             FROM turn_mirror GROUP BY origin_node_id, origin_incarnation`
        )
        .all() as Array<{
        origin_node_id: string;
        origin_incarnation: string;
        m: number;
      }>
    ).map(r => ({
      origin: r.origin_node_id,
      incarnation: r.origin_incarnation,
      maxSeq: r.m,
    }));
  }

  /** One incarnation's mirror rows changed after `cursor`, in change order. */
  mirrorChangesSince(
    origin: string,
    incarnation: string,
    cursor: number,
    limit: number
  ): Array<{ startedAtMs: number | null; seq: number }> {
    return (
      this.db
        .prepare(
          `SELECT started_at_ms, origin_change_seq FROM turn_mirror
            WHERE origin_node_id = ? AND origin_incarnation = ? AND origin_change_seq > ?
            ORDER BY origin_change_seq ASC LIMIT ?`
        )
        .all(origin, incarnation, cursor, limit) as Array<{
        started_at_ms: number | null;
        origin_change_seq: number;
      }>
    ).map(r => ({ startedAtMs: r.started_at_ms, seq: r.origin_change_seq }));
  }

  // ─────────────────────────── quota days ───────────────────────────

  /** Upsert one account-day of the quota model's inputs (R7). */
  upsertQuotaDay(row: QuotaDayRow): void {
    this.db
      .prepare(
        `INSERT INTO throughput_quota_daily (
           account_id, day, first_util, last_util, first_ms, last_ms, samples,
           reset_crossed, tok_in, tok_out, tok_cr, tok_w1, tok_w5, tok_wu,
           unattributed_tok, updated_at_ms
         ) VALUES (
           @account, @day, @firstUtil, @lastUtil, @firstMs, @lastMs, @samples,
           @reset, @tin, @tout, @tcr, @tw1, @tw5, @twu, @unattr, @updated
         )
         ON CONFLICT (account_id, day) DO UPDATE SET
           first_util = excluded.first_util, last_util = excluded.last_util,
           first_ms = excluded.first_ms, last_ms = excluded.last_ms,
           samples = excluded.samples, reset_crossed = excluded.reset_crossed,
           tok_in = excluded.tok_in, tok_out = excluded.tok_out,
           tok_cr = excluded.tok_cr, tok_w1 = excluded.tok_w1,
           tok_w5 = excluded.tok_w5, tok_wu = excluded.tok_wu,
           unattributed_tok = excluded.unattributed_tok,
           updated_at_ms = excluded.updated_at_ms`
      )
      .run({
        account: row.accountId,
        day: row.day,
        firstUtil: row.firstUtil,
        lastUtil: row.lastUtil,
        firstMs: row.firstMs,
        lastMs: row.lastMs,
        samples: row.samples,
        reset: row.resetCrossed ? 1 : 0,
        tin: row.tokIn,
        tout: row.tokOut,
        tcr: row.tokCr,
        tw1: row.tokW1,
        tw5: row.tokW5,
        twu: row.tokWu,
        unattr: row.unattributedTok,
        updated: this.now(),
      });
  }

  /** Every account-day since `sinceDay`, oldest first. */
  listQuotaDays(sinceDay: string): QuotaDayRow[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM throughput_quota_daily WHERE day >= ?
            ORDER BY day ASC, account_id ASC`
        )
        .all(sinceDay) as Array<Record<string, unknown>>
    ).map(r => ({
      accountId: String(r.account_id),
      day: String(r.day),
      firstUtil: (r.first_util as number | null) ?? null,
      lastUtil: (r.last_util as number | null) ?? null,
      firstMs: (r.first_ms as number | null) ?? null,
      lastMs: (r.last_ms as number | null) ?? null,
      samples: num(r.samples),
      resetCrossed: r.reset_crossed === 1,
      ...tokenSumsOf(r),
      unattributedTok: num(r.unattributed_tok),
    }));
  }

  /** Delete quota days before `beforeDay`. */
  pruneQuotaBefore(beforeDay: string): number {
    return this.db
      .prepare("DELETE FROM throughput_quota_daily WHERE day < ?")
      .run(beforeDay).changes;
  }

  /** Per-account tokens by category for one UTC day (all origins, all namespaces). */
  accountTokensForDay(day: string): Map<string, TokenSumsRow> {
    const out = new Map<string, TokenSumsRow>();
    const rows = this.db
      .prepare(
        `SELECT account, ${SUM_TOKEN_COLUMNS}
           FROM throughput_rollup_cost WHERE day = ?
          GROUP BY account`
      )
      .all(day) as Array<Record<string, unknown>>;
    for (const r of rows) out.set(String(r.account), tokenSumsOf(r));
    return out;
  }
}
