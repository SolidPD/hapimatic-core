// SPDX-License-Identifier: AGPL-3.0-only
import {
  CONTEXT_BIN_TOKENS,
  STAGE_BACKGROUND,
  STAGE_NONE,
  SupervisedLoop,
  binIndexFor,
  parseTurnFacts,
  utcDayOf,
  type JobFailureEvent,
  type JobRegistry,
  type ThroughputSource,
  type TurnFacts,
} from "@hapi/protocol";
import type {
  CostRollupRow,
  CovRollupRow,
  MirrorSourceRow,
  RollupBucket,
  ThroughputRollupStore,
} from "../store/throughput/rollupStore";
import {
  ThroughputPricer,
  addPricedLine,
  emptyPricedLine,
  type PriceTokens,
  type PricedLine,
} from "./pricing";
import { fingerprintOfRow } from "./turnFacts";

/**
 * Per-day throughput rollups — the `throughput-rollup` loop (issue #6164, A1 —
 * R5, R14; directive 4.4).
 *
 * Runs on every node. It folds this node's finalized turns AND every mirrored
 * origin's rows into per-`(origin, day)` buckets that the REST summary reads
 * with an indexed `GROUP BY`; nothing on the request path parses `row_json`.
 *
 * Per row:
 *  - Headline tokens come from the LEDGER columns (`tok_*` with the
 *    `tokens_extra.cache_creation` TTL split; no split → TTL-unknown writes).
 *  - When the row carries facts whose fingerprint still matches, the ledger
 *    totals are ALLOCATED across the facts' stage × model lines in proportion
 *    (largest remainder), so every breakdown sums exactly to the ledger total.
 *  - When `tok_*` are NULL and facts exist, the facts' own tokens count as
 *    `recovered` — a separate line, never merged into `ledger`.
 *  - Background agents (`facts.bg`) are their own `background` source.
 *  - Mirror rows are deduplicated across origin incarnations by
 *    `(cc_session_id, prompt_msg_uuid)`, else `(origin, turn_id)`.
 *
 * Dirty buckets come from cursors (local `change_seq`; per mirror incarnation
 * `origin_change_seq`); a bucket is rebuilt whole and swapped in one short
 * transaction. A rate-card change re-prices every bucket.
 */

export const ROLLUP_LOOP_NAME = "throughput-rollup";
export const ROLLUP_TICK_BUDGET_MS = 750;
export const ROLLUP_BUSY_MS = 5_000;
export const ROLLUP_IDLE_MS = 60_000;
export const ROLLUP_RETENTION_DAYS = 400;
const CHANGE_BATCH = 5_000;
const DIRTY_BATCH = 50;
const DAY_MS = 86_400_000;

const LOCAL_CURSOR_KEY = "rollup.local_cursor";
const LOCAL_ORIGIN_KEY = "rollup.local_origin";
const MIRROR_BOOTSTRAP_KEY = "rollup.mirror_bootstrapped";
const CARDS_KEY = "rollup.rate_cards";
const PRUNE_KEY = "rollup.pruned_day";
const mirrorCursorKey = (origin: string, incarnation: string) =>
  `rollup.mirror.${origin}.${incarnation}`;

// ─────────────────────────── per-row resolution ───────────────────────────

/** One priced line of a turn. */
export interface ResolvedLine {
  stage: string;
  model: string;
  src: ThroughputSource;
  calls: number;
  tokens: PriceTokens;
  usd: PricedLine;
}

/** A turn row resolved for aggregation. */
export interface ResolvedRow {
  id: string;
  ns: string | null;
  sessionId: string;
  sessionName: string | null;
  seq: number;
  status: string;
  startedAtMs: number;
  account: string | null;
  model: string | null;
  issueKey: string | null;
  ccSessionId: string | null;
  promptMsgUuid: string | null;
  ledgerNull: boolean;
  /** Facts whose fingerprint matches the row, else null. */
  facts: TurnFacts | null;
  lines: ResolvedLine[];
}

const SYNTHETIC_MODEL = "<synthetic>";
const UNKNOWN_MODEL = "unknown";
export const UNATTRIBUTED_ACCOUNT = "unattributed";

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/**
 * Split an integer `total` across `weights` (largest remainder; sums exactly).
 * All-zero weights put everything on `fallbackIndex`.
 */
export function allocate(
  total: number,
  weights: readonly number[],
  fallbackIndex = 0
): number[] {
  const out = weights.map(() => 0);
  if (weights.length === 0 || total === 0) return out;
  const sum = weights.reduce((s, w) => s + Math.max(0, w), 0);
  if (sum <= 0) {
    out[Math.min(Math.max(0, fallbackIndex), out.length - 1)] = total;
    return out;
  }
  const raw = weights.map(w => (total * Math.max(0, w)) / sum);
  let given = 0;
  for (let i = 0; i < raw.length; i += 1) {
    out[i] = Math.floor(raw[i]!);
    given += out[i]!;
  }
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < total - given; k += 1)
    out[order[k % order.length]!.i]! += 1;
  return out;
}

function parseExtraSplit(raw: unknown): { e1: number; e5: number } | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const cc = (value as { cache_creation?: unknown }).cache_creation;
  if (!cc || typeof cc !== "object") return null;
  const c = cc as Record<string, unknown>;
  return {
    e1: num(c.ephemeral_1h_input_tokens) ?? 0,
    e5: num(c.ephemeral_5m_input_tokens) ?? 0,
  };
}

const ISSUE_NUMBER = /#(\d{1,7})\b/;

/** `owner/repo#N` from facts, else from the row's repo + linked issue. */
export function issueKeyOf(
  row: Record<string, unknown>,
  facts: TurnFacts | null
): string | null {
  if (facts?.iss) return `${facts.iss[0]}#${facts.iss[1]}`;
  const repo = str(row.repo);
  const linked = str(row.linked_issue)?.match(ISSUE_NUMBER);
  return repo && linked ? `${repo}#${linked[1]}` : null;
}

/** Resolve one `turns` row (local, or a mirror row's JSON) into priced lines. */
export function resolveRow(
  row: Record<string, unknown>,
  pricer: ThroughputPricer
): ResolvedRow {
  const tin = num(row.tok_in);
  const tout = num(row.tok_out);
  const tcr = num(row.tok_cache_read);
  const tcw = num(row.tok_cache_write);
  const ledgerNull =
    tin === null && tout === null && tcr === null && tcw === null;
  const cw = tcw ?? 0;
  const split = parseExtraSplit(row.tokens_extra);
  const e1 = split ? Math.min(cw, split.e1) : 0;
  const e5 = split ? Math.min(cw - e1, split.e5) : 0;
  const wu = Math.max(0, cw - e1 - e5);

  const parsed = parseTurnFacts(row.throughput_json);
  const facts = parsed && parsed.fp === fingerprintOfRow(row) ? parsed : null;
  const rawModel = str(row.model_id);
  const model = rawModel && rawModel !== SYNTHETIC_MODEL ? rawModel : null;
  const startedAtMs = num(row.started_at_ms) ?? 0;
  const priceLine = (
    stage: string,
    lineModel: string | null,
    src: ThroughputSource,
    calls: number,
    tokens: PriceTokens
  ): ResolvedLine => ({
    stage,
    model: lineModel ?? UNKNOWN_MODEL,
    src,
    calls,
    tokens,
    usd: pricer.price(lineModel, startedAtMs, tokens),
  });

  const lines: ResolvedLine[] = [];
  const entries = facts?.sm
    ? Object.entries(facts.sm).flatMap(([stage, byModel]) =>
        Object.entries(byModel).map(([m, v]) => ({
          stage,
          model: m === UNKNOWN_MODEL || m === SYNTHETIC_MODEL ? model : m,
          v,
        }))
      )
    : [];

  if (!ledgerNull && entries.length > 0) {
    const totals = entries.map(e =>
      e.v.slice(1).reduce((s, x) => s + (x ?? 0), 0)
    );
    const biggest = totals.indexOf(Math.max(...totals));
    const pick = (i: number) => entries.map(e => e.v[i] ?? 0);
    const aIn = allocate(tin ?? 0, pick(1), biggest);
    const aOut = allocate(tout ?? 0, pick(2), biggest);
    const aCr = allocate(tcr ?? 0, pick(3), biggest);
    const aW1 = allocate(e1, pick(4), biggest);
    const aW5 = allocate(e5, pick(5), biggest);
    const aWu = allocate(
      wu,
      entries.map(e => (e.v[4] ?? 0) + (e.v[5] ?? 0)),
      biggest
    );
    entries.forEach((e, i) => {
      lines.push(
        priceLine(e.stage, e.model, "ledger", e.v[0] ?? 0, {
          in: aIn[i]!,
          out: aOut[i]!,
          cr: aCr[i]!,
          w1: aW1[i]!,
          w5: aW5[i]!,
          wu: aWu[i]!,
        })
      );
    });
  } else if (!ledgerNull) {
    lines.push(
      priceLine(STAGE_NONE, model, "ledger", 0, {
        in: tin ?? 0,
        out: tout ?? 0,
        cr: tcr ?? 0,
        w1: e1,
        w5: e5,
        wu,
      })
    );
  } else if (entries.length > 0) {
    for (const e of entries) {
      lines.push(
        priceLine(e.stage, e.model, "recovered", e.v[0] ?? 0, {
          in: e.v[1] ?? 0,
          out: e.v[2] ?? 0,
          cr: e.v[3] ?? 0,
          w1: e.v[4] ?? 0,
          w5: e.v[5] ?? 0,
          wu: 0,
        })
      );
    }
  }
  if (facts?.bg) {
    for (const [m, v] of Object.entries(facts.bg.sm)) {
      lines.push(
        priceLine(
          STAGE_BACKGROUND,
          m === UNKNOWN_MODEL ? null : m,
          "background",
          0,
          {
            in: v[0] ?? 0,
            out: v[1] ?? 0,
            cr: v[2] ?? 0,
            w1: v[3] ?? 0,
            w5: v[4] ?? 0,
            wu: 0,
          }
        )
      );
    }
  }

  return {
    id: String(row.id ?? ""),
    ns: str(row.namespace),
    sessionId: String(row.hapi_session_id ?? ""),
    sessionName: str(row.session_name),
    seq: num(row.seq) ?? 0,
    status: String(row.status ?? ""),
    startedAtMs,
    account: str(row.account_id),
    model,
    issueKey: issueKeyOf(row, facts),
    ccSessionId: str(row.cc_session_id),
    promptMsgUuid: str(row.prompt_msg_uuid),
    ledgerNull,
    facts,
    lines,
  };
}

/** Keep one row per turn across origin incarnations (newest mirror write wins). */
export function dedupeMirrorRows(
  origin: string,
  rows: readonly MirrorSourceRow[]
): Array<Record<string, unknown>> {
  const best = new Map<
    string,
    { row: Record<string, unknown>; src: MirrorSourceRow }
  >();
  for (const src of rows) {
    let row: Record<string, unknown>;
    try {
      const v = JSON.parse(src.rowJson) as unknown;
      if (!v || typeof v !== "object" || Array.isArray(v)) continue;
      row = v as Record<string, unknown>;
    } catch {
      continue;
    }
    const cc = str(row.cc_session_id);
    const pu = str(row.prompt_msg_uuid);
    const key = cc && pu ? `u:${cc}:${pu}` : `t:${origin}:${src.turnId}`;
    const prev = best.get(key);
    if (
      !prev ||
      src.mirroredAtMs > prev.src.mirroredAtMs ||
      (src.mirroredAtMs === prev.src.mirroredAtMs &&
        src.originChangeSeq > prev.src.originChangeSeq)
    ) {
      best.set(key, { row, src });
    }
  }
  return [...best.values()].map(v => v.row);
}

// ─────────────────────────── bucket aggregation ───────────────────────────

/** A context-histogram bin key re-expressed in 10K bins. */
export function ctxBinOf(key: string, binTokens: number): number {
  const idx = Number(key);
  if (binTokens === CONTEXT_BIN_TOKENS) return idx;
  // A coarsened histogram: map each bin to the fine bin of its midpoint.
  return binIndexFor((idx + 0.5) * binTokens, CONTEXT_BIN_TOKENS);
}

/**
 * A turn's starting-context sample, or null: the first call of the turn
 * marked `ctx.st` (its session's first real model call). Facts written before
 * `st` existed fall back to the session's first turn.
 */
export function startContextOf(
  seq: number,
  ctx: NonNullable<TurnFacts["ctx"]>
): number | null {
  const f = typeof ctx.f === "number" && ctx.f > 0 ? ctx.f : null;
  if (f === null) return null;
  if (ctx.st === 1) return f;
  return ctx.st === undefined && seq === 1 ? f : null;
}

/** Fold resolved rows into one bucket's rollup rows. */
export function buildBucket(
  rows: readonly ResolvedRow[],
  pricer: ThroughputPricer
): RollupBucket {
  const cost = new Map<string, CostRollupRow>();
  const effort = new Map<
    string,
    {
      ns: string | null;
      account: string;
      model: string;
      effort: string;
      calls: number;
    }
  >();
  const ctx = new Map<
    string,
    {
      ns: string | null;
      kind: "main" | "sub" | "start";
      bin: number;
      n: number;
    }
  >();
  const idle = new Map<
    string,
    {
      ns: string | null;
      cls: string;
      n: number;
      w1: number;
      w5: number;
      usd: number;
    }
  >();
  const session = new Map<
    string,
    RollupBucket["session"][number] & { lastIssueAt: number }
  >();
  const issue = new Map<
    string,
    RollupBucket["issue"][number] & { seen: Set<string> }
  >();
  const tests = new Map<
    string,
    RollupBucket["tests"][number] & { sessionSet: Set<string> }
  >();
  const cov = new Map<string, CovRollupRow>();
  const k = (...parts: Array<string | number | null>) =>
    parts.map(p => (p === null ? "\u0001" : String(p))).join("\u0000");

  for (const r of rows) {
    const account = r.account ?? UNATTRIBUTED_ACCOUNT;
    const rowModel = r.model ?? UNKNOWN_MODEL;
    let rowUsd = 0;
    let rowFallback = 0;
    let rowCalls = 0;
    const rowTokens = { in: 0, out: 0, cr: 0, w1: 0, w5: 0, wu: 0 };

    for (const line of r.lines) {
      const key = k(r.ns, account, line.model, line.stage, line.src);
      const c =
        cost.get(key) ??
        ({
          ns: r.ns,
          account,
          model: line.model,
          stage: line.stage,
          src: line.src,
          turns: 0,
          calls: 0,
          tokIn: 0,
          tokOut: 0,
          tokCr: 0,
          tokW1: 0,
          tokW5: 0,
          tokWu: 0,
          usdIn: 0,
          usdOut: 0,
          usdCr: 0,
          usdW1: 0,
          usdW5: 0,
          usdWu: 0,
          usdTotal: 0,
          usdFallback: 0,
        } as CostRollupRow);
      c.turns += 1;
      c.calls += line.calls;
      c.tokIn += line.tokens.in;
      c.tokOut += line.tokens.out;
      c.tokCr += line.tokens.cr;
      c.tokW1 += line.tokens.w1;
      c.tokW5 += line.tokens.w5;
      c.tokWu += line.tokens.wu;
      c.usdIn += line.usd.input;
      c.usdOut += line.usd.output;
      c.usdCr += line.usd.cacheRead;
      c.usdW1 += line.usd.write1h;
      c.usdW5 += line.usd.write5m;
      c.usdWu += line.usd.writeUnknown;
      c.usdTotal += line.usd.total;
      c.usdFallback += line.usd.fallback;
      cost.set(key, c);

      rowUsd += line.usd.total;
      rowFallback += line.usd.fallback;
      if (line.src !== "background") rowCalls += line.calls;
      rowTokens.in += line.tokens.in;
      rowTokens.out += line.tokens.out;
      rowTokens.cr += line.tokens.cr;
      rowTokens.w1 += line.tokens.w1;
      rowTokens.w5 += line.tokens.w5;
      rowTokens.wu += line.tokens.wu;

      if (r.issueKey) {
        const ik = k(r.ns, r.issueKey, line.stage);
        const it = issue.get(ik) ?? {
          ns: r.ns,
          issueKey: r.issueKey,
          stage: line.stage,
          turns: 0,
          calls: 0,
          tokIn: 0,
          tokOut: 0,
          tokCr: 0,
          tokW1: 0,
          tokW5: 0,
          tokWu: 0,
          usdTotal: 0,
          seen: new Set<string>(),
        };
        if (!it.seen.has(r.id)) {
          it.seen.add(r.id);
          it.turns += 1;
        }
        if (line.src !== "background") it.calls += line.calls;
        it.tokIn += line.tokens.in;
        it.tokOut += line.tokens.out;
        it.tokCr += line.tokens.cr;
        it.tokW1 += line.tokens.w1;
        it.tokW5 += line.tokens.w5;
        it.tokWu += line.tokens.wu;
        it.usdTotal += line.usd.total;
        issue.set(ik, it);
      }
    }

    const f = r.facts;
    if (f?.eff) {
      for (const [eff, calls] of Object.entries(f.eff)) {
        const ek = k(r.ns, account, rowModel, eff);
        const e = effort.get(ek) ?? {
          ns: r.ns,
          account,
          model: rowModel,
          effort: eff,
          calls: 0,
        };
        e.calls += calls;
        effort.set(ek, e);
      }
    }
    if (f?.ctx) {
      const bin = f.ctx.b ?? CONTEXT_BIN_TOKENS;
      const add = (
        kind: "main" | "sub" | "start",
        hist: Record<string, number> | undefined,
        b: number
      ) => {
        for (const [key, n] of Object.entries(hist ?? {})) {
          const fine = ctxBinOf(key, b);
          const ck = k(r.ns, kind, fine);
          const cell = ctx.get(ck) ?? { ns: r.ns, kind, bin: fine, n: 0 };
          cell.n += n;
          ctx.set(ck, cell);
        }
      };
      add("main", f.ctx.m, bin);
      add("sub", f.ctx.s, CONTEXT_BIN_TOKENS);
      const start = startContextOf(r.seq, f.ctx);
      if (start !== null) {
        add("start", { [String(binIndexFor(start))]: 1 }, CONTEXT_BIN_TOKENS);
      }
    }
    if (f?.idle?.c) {
      for (const [cls, v] of Object.entries(f.idle.c)) {
        const n = v[0] ?? 0;
        const w1 = v[1] ?? 0;
        const w5 = v[2] ?? 0;
        const usd = pricer.price(r.model, r.startedAtMs, {
          in: 0,
          out: 0,
          cr: 0,
          w1,
          w5,
          wu: 0,
        }).total;
        const ik = k(r.ns, cls);
        const cell = idle.get(ik) ?? {
          ns: r.ns,
          cls,
          n: 0,
          w1: 0,
          w5: 0,
          usd: 0,
        };
        cell.n += n;
        cell.w1 += w1;
        cell.w5 += w5;
        cell.usd += usd;
        idle.set(ik, cell);
      }
    }
    if (f?.tests?.units) {
      for (const unit of f.tests.units) {
        const tk = k(r.ns, unit);
        const t = tests.get(tk) ?? {
          ns: r.ns,
          unit,
          failRuns: 0,
          sessions: 0,
          firstMs: r.startedAtMs,
          lastMs: r.startedAtMs,
          sessionSet: new Set<string>(),
        };
        t.failRuns += 1;
        t.sessionSet.add(r.sessionId);
        t.firstMs = Math.min(t.firstMs ?? r.startedAtMs, r.startedAtMs);
        t.lastMs = Math.max(t.lastMs ?? r.startedAtMs, r.startedAtMs);
        tests.set(tk, t);
      }
    }

    const sk = k(r.ns, r.sessionId);
    const s = session.get(sk) ?? {
      ns: r.ns,
      sessionId: r.sessionId,
      label: r.sessionName,
      account,
      issueKey: null,
      turns: 0,
      calls: 0,
      tokIn: 0,
      tokOut: 0,
      tokCr: 0,
      tokW1: 0,
      tokW5: 0,
      tokWu: 0,
      usdTotal: 0,
      firstMs: r.startedAtMs,
      lastMs: r.startedAtMs,
      lastIssueAt: -1,
    };
    s.turns += 1;
    s.calls += rowCalls;
    s.tokIn += rowTokens.in;
    s.tokOut += rowTokens.out;
    s.tokCr += rowTokens.cr;
    s.tokW1 += rowTokens.w1;
    s.tokW5 += rowTokens.w5;
    s.tokWu += rowTokens.wu;
    s.usdTotal += rowUsd;
    s.firstMs = Math.min(s.firstMs ?? r.startedAtMs, r.startedAtMs);
    s.lastMs = Math.max(s.lastMs ?? r.startedAtMs, r.startedAtMs);
    if (r.sessionName) s.label = r.sessionName;
    if (r.account) s.account = r.account;
    if (r.issueKey && r.startedAtMs >= s.lastIssueAt) {
      s.issueKey = r.issueKey;
      s.lastIssueAt = r.startedAtMs;
    }
    session.set(sk, s);

    const vk = k(r.ns);
    const v =
      cov.get(vk) ??
      ({
        ns: r.ns,
        turns: 0,
        withFacts: 0,
        recovered: 0,
        tokNullNoFacts: 0,
        orphaned: 0,
        calls: 0,
        testRuns: 0,
        testFail: 0,
        usdTotal: 0,
        usdUnattributed: 0,
        usdFallback: 0,
        latestMs: null,
      } as CovRollupRow);
    v.turns += 1;
    if (f) v.withFacts += 1;
    if (f && r.ledgerNull) v.recovered += 1;
    if (!f && r.ledgerNull) v.tokNullNoFacts += 1;
    if (r.status === "orphaned") v.orphaned += 1;
    v.calls += rowCalls;
    v.testRuns += f?.tests?.runs ?? 0;
    v.testFail += f?.tests?.fail ?? 0;
    v.usdTotal += rowUsd;
    if (!r.account) v.usdUnattributed += rowUsd;
    v.usdFallback += rowFallback;
    v.latestMs = Math.max(v.latestMs ?? 0, r.startedAtMs);
    cov.set(vk, v);
  }

  return {
    cost: [...cost.values()],
    effort: [...effort.values()],
    ctx: [...ctx.values()],
    idle: [...idle.values()],
    session: [...session.values()].map(({ lastIssueAt: _drop, ...s }) => s),
    issue: [...issue.values()].map(({ seen: _drop, ...i }) => i),
    tests: [...tests.values()].map(({ sessionSet, ...t }) => ({
      ...t,
      sessions: sessionSet.size,
    })),
    cov: [...cov.values()],
  };
}

// ─────────────────────────── the loop ───────────────────────────

export interface RollupOptions {
  rollups: ThroughputRollupStore;
  /** This node's federation id: the origin of its local rows. */
  localOrigin: string;
  defaultModel?: string;
  now?: () => number;
  monotonic?: () => number;
  tickBudgetMs?: number;
}

export interface RollupTickReport {
  bucketsBuilt: number;
  dirtyLeft: number;
  rowsFolded: number;
  tickMs: number;
  maxSyncMs: number;
  busy: boolean;
}

export class ThroughputRollup {
  private busy = true;
  private readonly now: () => number;
  private readonly mono: () => number;

  constructor(private readonly opts: RollupOptions) {
    this.now = opts.now ?? Date.now;
    this.mono = opts.monotonic ?? (() => performance.now());
  }

  get isBusy(): boolean {
    return this.busy;
  }

  async tick(): Promise<RollupTickReport> {
    const r = this.opts.rollups;
    const start = this.mono();
    const deadline = start + (this.opts.tickBudgetMs ?? ROLLUP_TICK_BUDGET_MS);
    const report: RollupTickReport = {
      bucketsBuilt: 0,
      dirtyLeft: 0,
      rowsFolded: 0,
      tickMs: 0,
      maxSyncMs: 0,
      busy: false,
    };
    this.pruneDaily();
    this.checkRateCards();
    let discovered = this.discoverLocal();
    discovered = this.discoverMirror() || discovered;

    const pricer = new ThroughputPricer(r.rateCards(), this.opts.defaultModel);
    while (this.mono() < deadline) {
      const dirty = r.listDirty(DIRTY_BATCH);
      if (dirty.length === 0) break;
      for (const b of dirty) {
        const t0 = performance.now();
        report.rowsFolded += this.rebuild(b.origin, b.day, pricer);
        report.bucketsBuilt += 1;
        report.maxSyncMs = Math.max(report.maxSyncMs, performance.now() - t0);
        await new Promise(resolve => setTimeout(resolve, 0));
        if (this.mono() >= deadline) break;
      }
    }
    report.dirtyLeft = r.countDirty();
    this.busy = discovered || report.dirtyLeft > 0;
    report.busy = this.busy;
    report.tickMs = this.mono() - start;
    return report;
  }

  /** Rebuild one bucket from its source rows; returns the rows folded. */
  rebuild(origin: string, day: string, pricer: ThroughputPricer): number {
    const r = this.opts.rollups;
    const from = Date.parse(`${day}T00:00:00.000Z`);
    const to = from + DAY_MS;
    const raw =
      origin === this.opts.localOrigin
        ? r.localTurnsInRange(from, to)
        : dedupeMirrorRows(origin, r.mirrorRowsInRange(origin, from, to));
    const resolved = raw.map(row => resolveRow(row, pricer));
    r.replaceBucket(origin, day, buildBucket(resolved, pricer));
    return resolved.length;
  }

  private discoverLocal(): boolean {
    const r = this.opts.rollups;
    const origin = this.opts.localOrigin;
    const prevOrigin = r.getState(LOCAL_ORIGIN_KEY);
    if (prevOrigin !== origin) {
      // This node's id changed (e.g. standalone → a federation id): drop the old
      // name's local rollups and re-mark every local day under the new one.
      if (prevOrigin !== null) r.deleteOrigin(prevOrigin);
      r.setState(LOCAL_CURSOR_KEY, "0");
      r.setState(LOCAL_ORIGIN_KEY, origin);
    }
    const cursor = Number(r.getState(LOCAL_CURSOR_KEY) ?? "0");
    const changes = r.localChangesSince(cursor, CHANGE_BATCH);
    if (changes.length === 0) return false;
    const days = new Set(changes.map(c => utcDayOf(c.startedAtMs)));
    r.markDirty([...days].map(day => ({ origin: this.opts.localOrigin, day })));
    r.setState(
      LOCAL_CURSOR_KEY,
      String(changes[changes.length - 1]!.changeSeq)
    );
    return true;
  }

  private discoverMirror(): boolean {
    const r = this.opts.rollups;
    let any = false;
    const targets =
      r.getState(MIRROR_BOOTSTRAP_KEY) === "1"
        ? r.mirrorCursors().map(c => ({ ...c, maxSeq: c.turnCursor }))
        : r.mirrorIncarnations().map(c => ({ ...c, turnCursor: c.maxSeq }));
    for (const t of targets) {
      const key = mirrorCursorKey(t.origin, t.incarnation);
      const cursor = Number(r.getState(key) ?? "0");
      if (t.maxSeq <= cursor) continue;
      const changes = r.mirrorChangesSince(
        t.origin,
        t.incarnation,
        cursor,
        CHANGE_BATCH
      );
      if (changes.length === 0) continue;
      const days = new Set(
        changes
          .filter(c => c.startedAtMs !== null)
          .map(c => utcDayOf(c.startedAtMs as number))
      );
      r.markDirty([...days].map(day => ({ origin: t.origin, day })));
      r.setState(key, String(changes[changes.length - 1]!.seq));
      any = true;
    }
    if (!any) r.setState(MIRROR_BOOTSTRAP_KEY, "1");
    return any;
  }

  /** A rate-card change re-prices every bucket within retention. */
  private checkRateCards(): void {
    const r = this.opts.rollups;
    const gen = r.rateCardsGeneration();
    const prev = r.getState(CARDS_KEY);
    if (prev === gen) return;
    if (prev !== null) {
      r.markAllDirtySince(
        utcDayOf(this.now() - ROLLUP_RETENTION_DAYS * DAY_MS)
      );
    }
    r.setState(CARDS_KEY, gen);
  }

  private pruneDaily(): void {
    const r = this.opts.rollups;
    const today = utcDayOf(this.now());
    if (r.getState(PRUNE_KEY) === today) return;
    r.pruneBefore(utcDayOf(this.now() - ROLLUP_RETENTION_DAYS * DAY_MS));
    r.setState(PRUNE_KEY, today);
  }
}

/** Build the `throughput-rollup` SupervisedLoop (busy 5 s / idle 60 s). */
export function createRollupLoop(opts: {
  rollup: ThroughputRollup;
  node: string;
  enabled: boolean;
  registry?: JobRegistry;
  onEvent?: (event: JobFailureEvent) => void;
}): SupervisedLoop {
  const { rollup, registry } = opts;
  return new SupervisedLoop({
    name: ROLLUP_LOOP_NAME,
    node: opts.node,
    intervalMs: ROLLUP_IDLE_MS,
    getIntervalMs: () => (rollup.isBusy ? ROLLUP_BUSY_MS : ROLLUP_IDLE_MS),
    enabled: opts.enabled,
    immediate: false,
    registry,
    onEvent: opts.onEvent,
    tick: async () => {
      const t = await rollup.tick();
      registry?.update(ROLLUP_LOOP_NAME, {
        throughput: {
          tickMs: Math.round(t.tickMs),
          bucketsBuilt: t.bucketsBuilt,
          dirtyLeft: t.dirtyLeft,
          rowsFolded: t.rowsFolded,
          longestSyncMs: Math.round(t.maxSyncMs),
        },
      });
    },
  });
}

/** Sum of a row's priced lines. */
export function rowTotals(row: ResolvedRow): PricedLine {
  const out = emptyPricedLine();
  for (const l of row.lines) addPricedLine(out, l.usd);
  return out;
}
