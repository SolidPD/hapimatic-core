// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";
import {
  CLOUD_SESSIONS_NOT_COLLECTED,
  CONTEXT_BIN_TOKENS,
  STARTING_CONTEXT_METHOD_NOTE,
  SUMMARY_DEFAULT_WINDOW_DAYS,
  THROUGHPUT_PAGE_LIMIT,
  cacheServedShare,
  histogramPercentiles,
  mergeHistograms,
  snapToUtcDays,
  utcDayOf,
  type AccountUsage,
  type DigestDetail,
  type DigestList,
  type QuotaWeights,
  type ThroughputBreakdown,
  type ThroughputBreakdownDim,
  type ThroughputBreakdownRow,
  type ThroughputCost,
  type ThroughputCoverage,
  type ThroughputGithubSummary,
  type ThroughputIssuesPage,
  type ThroughputLine,
  type ThroughputPercentiles,
  type ThroughputSummary,
  type ThroughputTestsPage,
  type ThroughputTokens,
  type ThroughputWindow,
  type TurnMirrorOriginStatus,
} from "@hapi/protocol";
import type { ThroughputDigestStore } from "../store/throughput/digestStore";
import type {
  IssueFactsRecord,
  ThroughputGithubStore,
} from "../store/throughput/githubStore";
import type {
  CostGroupColumn,
  CostGroupRow,
  RollupScope,
  ThroughputRollupStore,
  TokenSumsRow,
} from "../store/throughput/rollupStore";
import type { UsageSnapshotRow } from "../store/usageHistoryStore";
import { trunkRedMs } from "./github/ciLogs";
import type { GithubRepoConfig } from "./github/collector";
import {
  STAGE_SPANS,
  ciFailuresByIssue,
  deriveIssueRow,
  escapesOf,
  ledgerIssueKey,
  stageHours,
  type IssueVocabulary,
} from "./github/issueFacts";
import { buildQuotaModel, quotaAccounts } from "./quota";
import { UNATTRIBUTED_ACCOUNT } from "./rollup";

/**
 * The throughput summary and its identity-bearing reads (issue #6164, A1 —
 * R5, R10, R14).
 *
 * The summary reads ROLLUPS only (never the ledger or transcripts), adds
 * coverage — which nodes and sources contributed and what is known to be
 * missing — and the GitHub delivery facts and quota model. It is an AGGREGATE
 * (no account, session, issue or test identities) and is memoized per
 * (window, scope, rollup generation, GitHub run, quota day); its ETag lets a
 * client revalidate with a 304.
 *
 * Every rollup read applies the caller's namespace scope. GitHub facts and
 * digests are repository- and fleet-level, not per namespace, so only the
 * node's owning namespace sees them.
 */

const DAY_MS = 86_400_000;
/** A mirror origin not pulled for this long is "stale". */
const MIRROR_STALE_MS = 15 * 60_000;
/** Quota runway uses live usage: the memo turns over at least this often. */
const LIVE_BUCKET_MS = 5 * 60_000;
const MEMO_MAX = 16;
const DIGEST_LIST_LIMIT = 104;

export interface ThroughputSummaryDeps {
  rollups: ThroughputRollupStore;
  github: ThroughputGithubStore;
  digests: ThroughputDigestStore;
  /** This node's origin id (the local rollups' origin). */
  localOrigin: () => string;
  /** The mirror pull: `enabled` is null when this node is standalone. */
  mirror: () => {
    enabled: boolean | null;
    origins: readonly TurnMirrorOriginStatus[];
  };
  /** The federation registry's nodes (hub only), else null. */
  registryNodes: () => ReadonlyArray<{
    nodeId: string;
    nodeLabel: string;
    status: string;
  }> | null;
  usage: () => readonly AccountUsage[] | null;
  usageSeries: (accountUuid: string, sinceMs: number) => UsageSnapshotRow[];
  quotaWeights: () => QuotaWeights | null;
  vocab: () => IssueVocabulary;
  /** The repos this node's GitHub job is configured for. */
  githubRepos: () => readonly GithubRepoConfig[];
  /** True when this node runs the fleet jobs. */
  fleetJobs: () => boolean;
  now?: () => number;
}

export type IssueRow = ReturnType<typeof deriveIssueRow>;

function round(v: number, places = 4): number {
  const f = 10 ** places;
  return Math.round(v * f) / f;
}

function tokensOf(r: TokenSumsRow): ThroughputTokens {
  return {
    in: r.tokIn,
    out: r.tokOut,
    cr: r.tokCr,
    w1: r.tokW1,
    w5: r.tokW5,
    wu: r.tokWu,
  };
}

function costOf(r: CostGroupRow): ThroughputCost {
  return {
    input: round(r.usdIn),
    output: round(r.usdOut),
    cacheRead: round(r.usdCr),
    write1h: round(r.usdW1),
    write5m: round(r.usdW5),
    writeUnknown: round(r.usdWu),
    total: round(r.usdTotal),
    fallback: round(r.usdFallback),
  };
}

/** A cost known only as a total (session / issue rollups keep no split). */
function totalOnly(usd: number): ThroughputCost {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    write1h: 0,
    write5m: 0,
    writeUnknown: 0,
    total: round(usd),
    fallback: 0,
  };
}

function lineOf(key: string, r: CostGroupRow): ThroughputLine {
  return {
    key,
    calls: r.calls,
    turns: r.turns,
    tokens: tokensOf(r),
    usd: costOf(r),
  };
}

/** Nearest-rank percentiles of exact values. */
export function percentilesOf(
  values: readonly number[]
): ThroughputPercentiles {
  const v = values.filter(x => Number.isFinite(x)).sort((a, b) => a - b);
  const at = (p: number): number | null =>
    v.length
      ? round(v[Math.max(0, Math.ceil((p / 100) * v.length) - 1)]!, 2)
      : null;
  return { n: v.length, p50: at(50), p90: at(90), p99: at(99) };
}

/**
 * The request window: `from` / `to` as epoch ms or ISO dates (default: the
 * last 7 × 24 h), snapped out to whole UTC days, at most 92 — so the default
 * covers 8 days unless `to` falls on midnight. Null when unparseable.
 */
export function resolveWindow(
  fromRaw: string | undefined,
  toRaw: string | undefined,
  nowMs: number
): ThroughputWindow | null {
  const parse = (v: string | undefined): number | null | undefined => {
    if (v === undefined || v === "") return undefined;
    const t = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
    return Number.isFinite(t) ? t : null;
  };
  const to = parse(toRaw);
  const from = parse(fromRaw);
  if (to === null || from === null) return null;
  const toMs = to ?? nowMs;
  const fromMs = from ?? toMs - SUMMARY_DEFAULT_WINDOW_DAYS * DAY_MS;
  return snapToUtcDays(fromMs, toMs);
}

/** A page cursor (an offset); null when malformed. */
export function parseCursor(cursor: string | undefined): number | null {
  if (cursor === undefined || cursor === "") return 0;
  return /^\d+$/.test(cursor) ? Number(cursor) : null;
}

function nextCursor(
  offset: number,
  count: number,
  total: number
): string | null {
  return offset + count < total ? String(offset + count) : null;
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function daysOf(w: ThroughputWindow): { fromDay: string; toDay: string } {
  return { fromDay: utcDayOf(w.fromMs), toDay: utcDayOf(w.toMs - 1) };
}

function isCompleted(rec: IssueFactsRecord): boolean {
  return rec.stateReason === null || rec.stateReason === "COMPLETED";
}

interface LastGithubRun {
  atMs: number;
  available: boolean;
  reason: string | null;
  /** The client's stop (`reason: detail`), or null when it ran to the end. */
  stopped?: string | null;
  /** Configuration errors (a repo or workflow that answered 404). */
  problems?: string[];
  repos?: string[];
}

/**
 * What went wrong in a run that had a credential, or null (#6164 round 1,
 * IR2/IR3): its configuration errors, then an error stop. A budget or
 * rate-limit stop is routine (the job resumes from its watermarks) and is not
 * an error.
 */
export function githubRunErrorOf(lastRun: LastGithubRun | null): string | null {
  if (!lastRun) return null;
  const parts = [...(lastRun.problems ?? [])];
  if (lastRun.stopped?.startsWith("error")) {
    parts.push(`Stopped: ${lastRun.stopped}`);
  }
  return parts.length > 0 ? parts.join("; ") : null;
}

export class ThroughputSummaryService {
  private readonly memo = new Map<
    string,
    { body: ThroughputSummary; json: string; etag: string }
  >();
  private readonly now: () => number;

  constructor(private readonly deps: ThroughputSummaryDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** The aggregate summary (memoized), its JSON and ETag. */
  summary(
    window: ThroughputWindow,
    scope: RollupScope
  ): { body: ThroughputSummary; json: string; etag: string } {
    const { rollups, github } = this.deps;
    const key = [
      window.fromMs,
      window.toMs,
      scope.namespace,
      scope.isOwner ? 1 : 0,
      rollups.generation(),
      parseJson<LastGithubRun>(github.getState("github.last_run"))?.atMs ?? 0,
      rollups.getState("quota.day") ?? "",
      Math.floor(this.now() / LIVE_BUCKET_MS),
    ].join("|");
    const hit = this.memo.get(key);
    if (hit) return hit;
    const body = this.compute(window, scope);
    const json = JSON.stringify(body);
    const etag = `"${createHash("sha256").update(json).digest("hex").slice(0, 20)}"`;
    if (this.memo.size >= MEMO_MAX) this.memo.clear();
    const entry = { body, json, etag };
    this.memo.set(key, entry);
    return entry;
  }

  private compute(
    window: ThroughputWindow,
    scope: RollupScope
  ): ThroughputSummary {
    const { rollups } = this.deps;
    const { fromDay, toDay } = daysOf(window);
    const group = (cols: readonly CostGroupColumn[]) =>
      rollups.sumCost(fromDay, toDay, scope, cols);
    const byKey = (col: CostGroupColumn) =>
      group([col])
        .map(r => lineOf(r.keys[col] ?? "", r))
        .sort((a, b) => b.usd.total - a.usd.total || (a.key < b.key ? -1 : 1));

    const total = group([])[0];
    const totals = total
      ? {
          turns: total.turns,
          calls: total.calls,
          tokens: tokensOf(total),
          usd: costOf(total),
          cacheServedShare: cacheServedShare(tokensOf(total)),
        }
      : {
          turns: 0,
          calls: 0,
          tokens: tokensOf({
            tokIn: 0,
            tokOut: 0,
            tokCr: 0,
            tokW1: 0,
            tokW5: 0,
            tokWu: 0,
          }),
          usd: totalOnly(0),
          cacheServedShare: null,
        };
    const byDay = byKey("day").sort((a, b) => (a.key < b.key ? -1 : 1));
    const ctx = rollups.ctxHistograms(fromDay, toDay, scope);
    const coverage = this.coverage(window, scope, totals.usd.total);
    // Cost rows count a turn once per priced line (rollup.ts buildBucket), so a
    // turn with several stage × model lines is counted more than once there;
    // coverage counts one per row, priced or not. Max keeps the larger, which
    // over-counts multi-line turns: #6355 item 1 tracks the fix.
    totals.turns = Math.max(totals.turns, coverage.turns);
    const github = this.githubSummary(window, scope);
    const quota = this.quota(coverage.unattributedAccountShare);

    const notes = [
      "Costs are API-equivalent, priced per model from the stored rate cards; 1-hour cache writes use the 1-hour rate.",
      "Headline figures are the ledger's; facts add the stage, model and context breakdowns, recovered turns and background agents.",
      "The window is whole UTC days.",
    ];

    return {
      window,
      generatedAtMs: this.now(),
      generation: rollups.generation(),
      totals,
      bySource: byKey("src"),
      byStage: byKey("stage"),
      byModel: byKey("model"),
      byNode: byKey("origin"),
      byDay,
      effort: rollups
        .sumEffort(fromDay, toDay, scope)
        .sort((a, b) => b.calls - a.calls),
      context: {
        binTokens: CONTEXT_BIN_TOKENS,
        main: histogramPercentiles(ctx.main),
        all: histogramPercentiles(mergeHistograms(ctx.main, ctx.sub)),
        start: histogramPercentiles(ctx.start),
        startMethodNote: STARTING_CONTEXT_METHOD_NOTE,
      },
      idle: rollups
        .idleByClass(fromDay, toDay, scope)
        .map(i => ({ ...i, usd: round(i.usd) })),
      coverage,
      github,
      quota,
      notes,
    };
  }

  private coverage(
    window: ThroughputWindow,
    scope: RollupScope,
    usdTotal: number
  ): ThroughputCoverage {
    const { rollups } = this.deps;
    const { fromDay, toDay } = daysOf(window);
    const recentFrom = utcDayOf(window.toMs - 2 * DAY_MS);
    const rows = rollups.coverage(fromDay, toDay, recentFrom, scope);
    const local = this.deps.localOrigin();
    const mirror = this.deps.mirror();
    const lastSync = new Map<string, number | null>();
    for (const o of mirror.origins) {
      const prev = lastSync.get(o.originNodeId) ?? null;
      const at = o.lastSyncAtMs ?? null;
      lastSync.set(
        o.originNodeId,
        prev === null ? at : at === null ? prev : Math.max(prev, at)
      );
    }
    const nodes = rows.map(r => ({
      origin: r.origin,
      local: r.origin === local,
      lastSyncMs: r.origin === local ? null : (lastSync.get(r.origin) ?? null),
      turns: r.turns,
      withFacts: r.withFacts,
      recovered: r.recovered,
      orphaned: r.orphaned,
      tokNullNoFacts: r.tokNullNoFacts,
    }));
    const present = new Set(rows.map(r => r.origin));
    const missingNodes = (this.deps.registryNodes() ?? [])
      .filter(n => !present.has(n.nodeId) && n.nodeId !== local)
      .map(n => ({
        nodeId: n.nodeId,
        label: n.nodeLabel || null,
        reason:
          n.status === "online"
            ? mirror.enabled === false
              ? "The mirror pull is off on this node."
              : "No turns from this node in the window."
            : `Node ${n.status}.`,
      }));
    const sum = (f: (r: (typeof rows)[number]) => number) =>
      rows.reduce((s, r) => s + f(r), 0);
    const turns = sum(r => r.turns);
    const withFacts = sum(r => r.withFacts);
    const usdUnattributed = sum(r => r.usdUnattributed);
    const usdFallback = sum(r => r.usdFallback);
    const now = this.now();
    const staleOrigins = [...lastSync.entries()].filter(
      ([, at]) => at === null || now - at > MIRROR_STALE_MS
    );
    const lastRun = parseJson<LastGithubRun>(
      this.deps.github.getState("github.last_run")
    );
    const githubError = githubRunErrorOf(lastRun);
    return {
      nodes,
      missingNodes,
      mirrorEnabled: mirror.enabled,
      nodesWithoutFacts: rows
        .filter(r => r.recentTurns > 0 && r.recentWithFacts === 0)
        .map(r => r.origin),
      notCollected: [CLOUD_SESSIONS_NOT_COLLECTED],
      sources: [
        { source: "ledger", status: "ok", detail: `${turns} turns` },
        {
          source: "facts",
          status: withFacts > 0 ? "ok" : turns > 0 ? "none" : "empty",
          detail: `${withFacts} of ${turns} turns have facts`,
        },
        {
          source: "mirror",
          status:
            mirror.enabled === null
              ? "standalone"
              : mirror.enabled === false
                ? "off"
                : staleOrigins.length > 0
                  ? "stale"
                  : "ok",
          detail:
            mirror.enabled && staleOrigins.length > 0
              ? `Not pulled for over 15 minutes: ${staleOrigins.map(([o]) => o).join(", ")}`
              : null,
        },
        {
          source: "github",
          status: lastRun
            ? lastRun.available
              ? githubError
                ? "error"
                : "ok"
              : "unavailable"
            : this.deps.fleetJobs()
              ? "not-run"
              : "other-node",
          detail: githubError ?? lastRun?.reason ?? null,
        },
        {
          source: "quota",
          status: this.deps.usage() ? "ok" : "unavailable",
          detail: null,
        },
      ],
      turns,
      rowsWithoutFacts: Math.max(0, turns - withFacts),
      recoveredRows: sum(r => r.recovered),
      unattributedAccountShare:
        usdTotal > 0 ? round(usdUnattributed / usdTotal) : null,
      fallbackPricedShare: usdTotal > 0 ? round(usdFallback / usdTotal) : null,
    };
  }

  private quota(unattributedShare: number | null) {
    const latest = this.deps.usage();
    const accounts = latest
      ? quotaAccounts(latest, this.deps.usageSeries, this.now())
      : null;
    return buildQuotaModel({
      accounts,
      weights: this.deps.quotaWeights(),
      unattributedShare,
    });
  }

  private githubSummary(
    window: ThroughputWindow,
    scope: RollupScope
  ): ThroughputGithubSummary {
    const { github } = this.deps;
    const lastRun = parseJson<LastGithubRun>(
      github.getState("github.last_run")
    );
    const empty = (reason: string): ThroughputGithubSummary => ({
      available: false,
      reason,
      repos: lastRun?.repos ?? [],
      lastRunMs: lastRun?.atMs ?? null,
      mergedPrs: null,
      closedIssues: 0,
      leadTimeHours: percentilesOf([]),
      stageHours: [],
      reopens: 0,
      escapes: 0,
      escapeRate: null,
      ciFailedRuns: 0,
      ciFailuresPerPr: null,
      trunkRedHours: null,
      points: {
        available: false,
        reason,
        total: 0,
        costPerPoint: null,
        byLane: [],
      },
    });
    if (!scope.isOwner) {
      return empty("GitHub facts are shown to this node's owner only.");
    }
    if (!lastRun) {
      return empty(
        this.deps.fleetJobs()
          ? this.deps.githubRepos().length > 0
            ? "The GitHub job has not run yet."
            : "GitHub: no repositories configured."
          : "GitHub facts are collected on the fleet-jobs node."
      );
    }

    const closed = github.listClosedIssues(window.fromMs, window.toMs).rows;
    const completed = closed.filter(isCompleted);
    const spans = completed.map(stageHours);
    const stage = STAGE_SPANS.filter(([name]) => name !== "lead").map(
      ([name]) => {
        const p = percentilesOf(
          spans
            .map(s => s[name])
            .filter((v): v is number => v !== null && v >= 0)
        );
        return { stage: name, n: p.n, p50: p.p50, p90: p.p90 };
      }
    );
    const escaped = completed.filter(r => escapesOf(r).count > 0).length;

    let ciFailedRuns = 0;
    let prFailedRuns = 0;
    let trunkRed = 0;
    let trunkKnown = false;
    const repos = this.deps.githubRepos();
    for (const cfg of repos) {
      if (!cfg.ciWorkflow) continue;
      const runs = github.listRuns(cfg.repo, window.fromMs, window.toMs);
      for (const run of runs) {
        if (run.conclusion !== "failure") continue;
        ciFailedRuns += 1;
        if (run.event === "pull_request") prFailedRuns += 1;
      }
      const trunk = parseJson<{ branch: string }>(
        github.getState(`github.${cfg.repo}.trunk`)
      )?.branch;
      if (trunk) {
        trunkKnown = true;
        trunkRed += trunkRedMs(
          runs.filter(r => r.headBranch === trunk),
          github.lastRunBefore(cfg.repo, trunk, window.fromMs),
          window.fromMs,
          Math.min(window.toMs, this.now())
        );
      }
    }
    let mergedPrs = 0;
    for (const n of github
      .countMergedPrs(window.fromMs, window.toMs)
      .values()) {
      mergedPrs += n;
    }

    const vocab = this.deps.vocab();
    const pointed = completed.filter(
      r => r.lane !== null && vocab.points[r.lane] !== undefined
    );
    const byLane = new Map<string, { issues: number; points: number }>();
    let points = 0;
    for (const r of pointed) {
      const p = vocab.points[r.lane!]!;
      points += p;
      const cell = byLane.get(r.lane!) ?? { issues: 0, points: 0 };
      cell.issues += 1;
      cell.points += p;
      byLane.set(r.lane!, cell);
    }
    const costs = this.deps.rollups.issueTotals(
      pointed.map(r => ledgerIssueKey(r.repo, r.number)),
      scope
    );
    let pointedUsd = 0;
    for (const c of costs.values()) pointedUsd += c.usd;

    return {
      available: true,
      reason: lastRun.available ? githubRunErrorOf(lastRun) : lastRun.reason,
      repos: lastRun.repos ?? repos.map(r => r.repo),
      lastRunMs: lastRun.atMs,
      mergedPrs,
      closedIssues: closed.length,
      leadTimeHours: percentilesOf(
        spans.map(s => s.lead).filter((v): v is number => v !== null && v >= 0)
      ),
      stageHours: stage,
      reopens: completed.reduce((s, r) => s + r.reopens, 0),
      escapes: escaped,
      escapeRate:
        completed.length > 0 ? round(escaped / completed.length) : null,
      ciFailedRuns,
      ciFailuresPerPr: mergedPrs > 0 ? round(prFailedRuns / mergedPrs) : null,
      trunkRedHours: trunkKnown ? round(trunkRed / 3_600_000, 2) : null,
      points: {
        available: pointed.length > 0,
        reason: pointed.length > 0 ? null : "No lane labels yet.",
        total: points,
        costPerPoint: points > 0 ? round(pointedUsd / points, 2) : null,
        byLane: [...byLane.entries()]
          .map(([lane, v]) => ({ lane, ...v }))
          .sort((a, b) => (a.lane < b.lane ? -1 : 1)),
      },
    };
  }

  // ─────────────────────────── identity-bearing reads ───────────────────────────

  /** Per-account / session / issue cost rows, paged (mutating tier). */
  breakdown(
    dim: ThroughputBreakdownDim,
    window: ThroughputWindow,
    scope: RollupScope,
    offset: number
  ): ThroughputBreakdown {
    const { rollups } = this.deps;
    const { fromDay, toDay } = daysOf(window);
    const limit = THROUGHPUT_PAGE_LIMIT;
    const windowTotal =
      rollups.sumCost(fromDay, toDay, scope, [])[0]?.usdTotal ?? 0;
    if (dim === "account") {
      const all = rollups
        .sumCost(fromDay, toDay, scope, ["account"])
        .sort((a, b) => b.usdTotal - a.usdTotal);
      const latest = this.deps.usage() ?? [];
      const labels = new Map(
        latest.map(a => [a.accountUuid, a.nickname ?? a.displayLabel ?? null])
      );
      const quota = new Map(
        quotaAccounts(latest, this.deps.usageSeries, this.now()).map(q => [
          q.accountId,
          q,
        ])
      );
      const page = all.slice(offset, offset + limit);
      const unattributed =
        all.find(r => r.keys.account === UNATTRIBUTED_ACCOUNT)?.usdTotal ?? 0;
      return {
        dim,
        window,
        rows: page.map(r => {
          const key = r.keys.account ?? "";
          return {
            key,
            label: labels.get(key) ?? null,
            turns: r.turns,
            calls: r.calls,
            tokens: tokensOf(r),
            usd: costOf(r),
            quota: quota.get(key) ?? null,
          };
        }),
        total: all.length,
        nextCursor: nextCursor(offset, page.length, all.length),
        unattributedShare:
          windowTotal > 0 ? round(unattributed / windowTotal) : null,
      };
    }
    if (dim === "session") {
      const { rows, total } = rollups.sessions(
        fromDay,
        toDay,
        scope,
        offset,
        limit
      );
      return {
        dim,
        window,
        rows: rows.map(
          (r): ThroughputBreakdownRow => ({
            key: r.sessionId,
            label: r.label,
            turns: r.turns,
            calls: r.calls,
            tokens: tokensOf(r),
            usd: totalOnly(r.usdTotal),
            account: r.account,
            issueKey: r.issueKey,
            firstMs: r.firstMs,
            lastMs: r.lastMs,
          })
        ),
        total,
        nextCursor: nextCursor(offset, rows.length, total),
        unattributedShare: null,
      };
    }
    const all = rollups.issues(
      fromDay,
      toDay,
      scope,
      0,
      Number.MAX_SAFE_INTEGER
    );
    const page = all.rows.slice(offset, offset + limit);
    const attributed = all.rows.reduce((s, r) => s + r.usdTotal, 0);
    return {
      dim,
      window,
      rows: page.map(r => ({
        key: r.issueKey,
        label: null,
        turns: r.turns,
        calls: r.calls,
        tokens: tokensOf(r),
        usd: totalOnly(r.usdTotal),
      })),
      total: all.total,
      nextCursor: nextCursor(offset, page.length, all.total),
      unattributedShare:
        windowTotal > 0
          ? round(Math.max(0, windowTotal - attributed) / windowTotal)
          : null,
    };
  }

  /** Issues closed in the window with their delivery facts, paged (mutating tier). */
  issues(
    window: ThroughputWindow,
    scope: RollupScope,
    offset: number
  ): { page: ThroughputIssuesPage; rows: IssueRow[] } {
    const { github, rollups } = this.deps;
    if (!scope.isOwner) {
      return {
        page: { window, rows: [], total: 0, nextCursor: null },
        rows: [],
      };
    }
    const { rows: recs, total } = github.listClosedIssues(
      window.fromMs,
      window.toMs,
      offset,
      THROUGHPUT_PAGE_LIMIT
    );
    const prs = recs.map(r => github.prsOfIssue(r.repo, r.number));
    const ciByKey = new Map<string, number>();
    const repos = [...new Set(recs.map(r => r.repo))];
    for (const repo of repos) {
      const mine = recs.filter(r => r.repo === repo);
      const start = Math.min(...mine.map(r => r.createdAtMs ?? window.fromMs));
      const end = Math.max(...mine.map(r => r.closedAtMs ?? window.toMs));
      const runs = github.listRuns(repo, start - DAY_MS, end + DAY_MS);
      const prsByIssue = new Map<number, number[]>();
      recs.forEach((r, i) => {
        if (r.repo === repo)
          prsByIssue.set(
            r.number,
            prs[i]!.map(p => p.number)
          );
      });
      for (const [n, count] of ciFailuresByIssue(runs, prsByIssue)) {
        ciByKey.set(`${repo}#${n}`, count);
      }
    }
    const costs = rollups.issueTotals(
      recs.map(r => ledgerIssueKey(r.repo, r.number)),
      scope
    );
    const vocab = this.deps.vocab();
    const rows = recs.map((rec, i) =>
      deriveIssueRow({
        rec,
        prs: prs[i]!,
        ciFailures: ciByKey.get(`${rec.repo}#${rec.number}`) ?? 0,
        vocab,
        cost: costs.get(ledgerIssueKey(rec.repo, rec.number)) ?? null,
      })
    );
    return {
      page: {
        window,
        rows,
        total,
        nextCursor: nextCursor(offset, rows.length, total),
      },
      rows,
    };
  }

  /** Failing units from CI and from agents' own runs, paged (mutating tier). */
  tests(
    window: ThroughputWindow,
    scope: RollupScope,
    offset: number
  ): ThroughputTestsPage {
    const { fromDay, toDay } = daysOf(window);
    const byUnit = new Map<
      string,
      {
        unit: string;
        ciCatches: number;
        agentCatches: number;
        sessions: number;
        firstSeenMs: number | null;
        lastSeenMs: number | null;
      }
    >();
    const cell = (unit: string) => {
      let c = byUnit.get(unit);
      if (!c) {
        c = {
          unit,
          ciCatches: 0,
          agentCatches: 0,
          sessions: 0,
          firstSeenMs: null,
          lastSeenMs: null,
        };
        byUnit.set(unit, c);
      }
      return c;
    };
    const seen = (
      c: { firstSeenMs: number | null; lastSeenMs: number | null },
      first: number | null,
      last: number | null
    ) => {
      if (first !== null) {
        c.firstSeenMs =
          c.firstSeenMs === null ? first : Math.min(c.firstSeenMs, first);
      }
      if (last !== null) {
        c.lastSeenMs =
          c.lastSeenMs === null ? last : Math.max(c.lastSeenMs, last);
      }
    };
    for (const a of this.deps.rollups.tests(fromDay, toDay, scope)) {
      const c = cell(a.unit);
      c.agentCatches += a.failRuns;
      c.sessions += a.sessions;
      seen(c, a.firstMs, a.lastMs);
    }
    if (scope.isOwner) {
      for (const k of this.deps.github.ciCatches(window.fromMs, window.toMs)) {
        const c = cell(k.unit);
        c.ciCatches += k.catches;
        seen(c, k.firstMs, k.lastMs);
      }
    }
    const all = [...byUnit.values()].sort(
      (a, b) =>
        b.ciCatches + b.agentCatches - (a.ciCatches + a.agentCatches) ||
        (a.unit < b.unit ? -1 : 1)
    );
    const rows = all.slice(offset, offset + THROUGHPUT_PAGE_LIMIT);
    return {
      window,
      rows,
      total: all.length,
      nextCursor: nextCursor(offset, rows.length, all.length),
    };
  }

  /** The stored weekly digests (owner only; mutating tier). */
  digestList(scope: RollupScope): DigestList {
    return {
      digests: scope.isOwner ? this.deps.digests.list(DIGEST_LIST_LIMIT) : [],
    };
  }

  /** One stored digest, or null (owner only). */
  digest(id: string, scope: RollupScope): DigestDetail | null {
    return scope.isOwner ? this.deps.digests.get(id) : null;
  }
}
