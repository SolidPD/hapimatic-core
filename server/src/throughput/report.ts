// SPDX-License-Identifier: AGPL-3.0-only
import { dirname, join } from "node:path";
import type { Database } from "bun:sqlite";
import {
  CONTEXT_BIN_TOKENS,
  STARTING_CONTEXT_METHOD_NOTE,
  binIndexFor,
  cacheServedShare,
  histogramCount,
  mergeHistograms,
  percentileFromHistogram,
  type ThroughputTokens,
} from "@hapi/protocol";
import {
  ThroughputFactsStore,
  toFactsTurnRow,
  type FactsTurnRow,
} from "../store/throughput/factsStore";
import { ThroughputRollupStore } from "../store/throughput/rollupStore";
import {
  emptyPricedLine,
  addPricedLine,
  ThroughputPricer,
  type PricedLine,
} from "./pricing";
import {
  ctxBinOf,
  dedupeMirrorRows,
  resolveRow,
  startContextOf,
  UNATTRIBUTED_ACCOUNT,
} from "./rollup";
import type { GithubClient } from "./github/client";
import { countMergedPulls, fetchTimeline } from "./github/timeline";
import { computeSessionFacts } from "./sessionFacts";
import { TranscriptReader } from "./transcriptCalls";

/**
 * The throughput report (issue #6164, A1 — R12, AC1): the summary's metrics
 * for an EXACT window (not day-snapped), computed offline from the raw local
 * and mirrored rows of a database opened READ-ONLY.
 *
 * `facts: "compute"` derives facts in memory, from this node's transcripts,
 * for local rows that lack them, and never writes. The census baseline
 * (`census-2026-11-02`) compares each figure with its own window and method,
 * with the measured value, delta and verdict (directive section 3).
 */

export interface ReportOptions {
  db: Database;
  fromMs: number;
  toMs: number;
  /** null: local rows and every mirror origin; "local": local rows only. */
  origin: string | null;
  facts: "stored" | "compute";
  defaultModel?: string;
  literals?: readonly string[];
}

export interface ThroughputReport {
  window: { fromMs: number; toMs: number; fromIso: string; toIso: string };
  origins: string[];
  turns: number;
  /** Rows with no ledger tokens (orphaned) and no facts: usage nobody can price. */
  unpriced: number;
  withFacts: number;
  computedFacts: number;
  tokens: ThroughputTokens;
  usd: PricedLine;
  bySource: Record<string, number>;
  unattributedUsd: number;
  cacheServedShare: number | null;
  /** Cost shares of the total: cache read, 1-hour write, 5-minute write, output. */
  split: {
    cacheRead: number;
    write1h: number;
    write5m: number;
    output: number;
  } | null;
  context: {
    /** Context per call over the census-comparable all-calls set (main + sub). */
    allCalls: { n: number; p50: number | null };
    mainChain: { n: number; p50: number | null };
    /** Each session's first real main-chain call (its starting context). */
    start: { n: number; p50: number | null };
  };
}

interface Accumulator {
  tokens: ThroughputTokens;
  usd: PricedLine;
  bySource: Record<string, number>;
  unattributedUsd: number;
  ctxMain: Record<string, number>;
  ctxSub: Record<string, number>;
  ctxStart: Record<string, number>;
  withFacts: number;
  unpriced: number;
}

/** Compute every local row's missing facts in memory (`--facts=compute`). */
async function computeMissingFacts(
  db: Database,
  rows: Array<Record<string, unknown>>,
  literals: readonly string[]
): Promise<number> {
  const facts = new ThroughputFactsStore(db);
  const bySession = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows) {
    if (row.throughput_json) continue;
    const cc = typeof row.cc_session_id === "string" ? row.cc_session_id : null;
    if (!cc || typeof row.transcript_path !== "string") continue;
    let list = bySession.get(cc);
    if (!list) bySession.set(cc, (list = []));
    list.push(row);
  }
  let computed = 0;
  for (const [cc, targets] of bySession) {
    const path = String(targets[0]!.transcript_path);
    const reader = new TranscriptReader(path);
    let status = "more";
    try {
      while (status === "more") {
        status = await reader.step(Number.POSITIVE_INFINITY);
      }
    } finally {
      await reader.close();
    }
    if (status !== "done") continue;
    const sessionRows = (
      db
        .prepare(
          "SELECT * FROM turns WHERE cc_session_id = ? ORDER BY started_at_ms, seq"
        )
        .all(cc) as Array<Record<string, unknown>>
    ).map(toFactsTurnRow);
    const results = await computeSessionFacts({
      facts,
      sessionRows,
      targets: targets
        .map(toFactsTurnRow)
        .filter((r: FactsTurnRow) => r.status !== "open"),
      segments: reader.segments(),
      subagentsDir: join(dirname(path), cc, "subagents"),
      literals,
    });
    const byId = new Map(targets.map(r => [String(r.id), r]));
    for (const r of results) {
      if (r.status !== "facts") continue;
      const row = byId.get(r.id);
      if (row) {
        row.throughput_json = r.json; // in memory only
        computed += 1;
      }
    }
  }
  return computed;
}

export async function computeReport(
  opts: ReportOptions
): Promise<ThroughputReport> {
  const rollups = new ThroughputRollupStore(opts.db);
  const rows: Array<Record<string, unknown>> = [];
  const origins: string[] = [];
  let computedFacts = 0;
  if (opts.origin === null || opts.origin === "local") {
    const local = rollups.localTurnsInRange(opts.fromMs, opts.toMs);
    if (opts.facts === "compute") {
      computedFacts = await computeMissingFacts(
        opts.db,
        local,
        opts.literals ?? []
      );
    }
    rows.push(...local);
    origins.push("local");
  }
  if (opts.origin !== "local") {
    const mirrorOrigins =
      opts.origin === null
        ? [...new Set(rollups.mirrorIncarnations().map(m => m.origin))].sort()
        : [opts.origin];
    for (const origin of mirrorOrigins) {
      rows.push(
        ...dedupeMirrorRows(
          origin,
          rollups.mirrorRowsInRange(origin, opts.fromMs, opts.toMs)
        )
      );
      origins.push(origin);
    }
  }

  const pricer = new ThroughputPricer(rollups.rateCards(), opts.defaultModel);
  const acc: Accumulator = {
    tokens: { in: 0, out: 0, cr: 0, w1: 0, w5: 0, wu: 0 },
    usd: emptyPricedLine(),
    bySource: {},
    unattributedUsd: 0,
    ctxMain: {},
    ctxSub: {},
    ctxStart: {},
    withFacts: 0,
    unpriced: 0,
  };
  for (const row of rows) {
    const r = resolveRow(row, pricer);
    if (r.facts) {
      acc.withFacts += 1;
      // The rollup's rules: main-chain bins may be coarse; the start sample is
      // the session's first real model call (`startContextOf`).
      const rebin = (h: Record<string, number> | undefined, width: number) => {
        const out: Record<string, number> = {};
        for (const [key, n] of Object.entries(h ?? {})) {
          const idx = String(ctxBinOf(key, width));
          out[idx] = (out[idx] ?? 0) + n;
        }
        return out;
      };
      const ctx = r.facts.ctx;
      if (ctx) {
        acc.ctxMain = mergeHistograms(
          acc.ctxMain,
          rebin(ctx.m, ctx.b ?? CONTEXT_BIN_TOKENS)
        );
        acc.ctxSub = mergeHistograms(
          acc.ctxSub,
          rebin(ctx.s, CONTEXT_BIN_TOKENS)
        );
        const start = startContextOf(r.seq, ctx);
        if (start !== null) {
          const key = String(binIndexFor(start));
          acc.ctxStart[key] = (acc.ctxStart[key] ?? 0) + 1;
        }
      }
    } else if (r.ledgerNull) {
      acc.unpriced += 1;
    }
    for (const line of r.lines) {
      addPricedLine(acc.usd, line.usd);
      acc.bySource[line.src] = (acc.bySource[line.src] ?? 0) + line.usd.total;
      if ((r.account ?? UNATTRIBUTED_ACCOUNT) === UNATTRIBUTED_ACCOUNT) {
        acc.unattributedUsd += line.usd.total;
      }
      acc.tokens.in += line.tokens.in;
      acc.tokens.out += line.tokens.out;
      acc.tokens.cr += line.tokens.cr;
      acc.tokens.w1 += line.tokens.w1;
      acc.tokens.w5 += line.tokens.w5;
      acc.tokens.wu += line.tokens.wu;
    }
  }
  const total = acc.usd.total;
  const share = (v: number) => (total > 0 ? v / total : 0);
  const all = mergeHistograms(acc.ctxMain, acc.ctxSub);
  return {
    window: {
      fromMs: opts.fromMs,
      toMs: opts.toMs,
      fromIso: new Date(opts.fromMs).toISOString(),
      toIso: new Date(opts.toMs).toISOString(),
    },
    origins,
    turns: rows.length,
    unpriced: acc.unpriced,
    withFacts: acc.withFacts,
    computedFacts,
    tokens: acc.tokens,
    usd: acc.usd,
    bySource: acc.bySource,
    unattributedUsd: acc.unattributedUsd,
    cacheServedShare: cacheServedShare(acc.tokens),
    split:
      total > 0
        ? {
            cacheRead: share(acc.usd.cacheRead),
            write1h: share(acc.usd.write1h),
            write5m: share(acc.usd.write5m + acc.usd.writeUnknown),
            output: share(acc.usd.output),
          }
        : null,
    context: {
      allCalls: {
        n: histogramCount(all),
        p50: percentileFromHistogram(all, 50),
      },
      mainChain: {
        n: histogramCount(acc.ctxMain),
        p50: percentileFromHistogram(acc.ctxMain, 50),
      },
      start: {
        n: histogramCount(acc.ctxStart),
        p50: percentileFromHistogram(acc.ctxStart, 50),
      },
    },
  };
}

// ─────────────────────────── GitHub (read-only) ───────────────────────────

export interface GithubReport {
  /** Merged PRs per repo in the report's own window. */
  window: Record<string, number | null>;
  /** The census figure's pinned window and the strict 7 × 24 h one. */
  census?: {
    pinned: Record<string, number | null>;
    strict7d: Record<string, number | null>;
  };
  /** The long-timeline check (#4172). */
  timeline?: {
    issue: string;
    events: number;
    labelEvents: number;
    pages: number;
  } | null;
  error: string | null;
}

/**
 * Merged-PR counts (search API, read-only) for the report's window and, for
 * the baseline, the census figure's pinned window and the strict 7 × 24 h
 * one; and the long-timeline check. `merged:A..B` is inclusive to the second.
 */
export async function fetchGithubReport(opts: {
  client: GithubClient;
  repos: readonly string[];
  fromMs: number;
  toMs: number;
  baseline: boolean;
}): Promise<GithubReport> {
  const { client } = opts;
  const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
  const out: GithubReport = { window: {}, error: null };
  if (!(await client.checkRateLimit())) {
    out.error = client.stopReason ?? "GitHub is not reachable";
    return out;
  }
  for (const repo of opts.repos) {
    out.window[repo] = await countMergedPulls(
      client,
      repo,
      iso(opts.fromMs),
      iso(opts.toMs)
    );
  }
  if (opts.baseline) {
    const b = CENSUS_BASELINE.prs;
    const pinned: Record<string, number | null> = {};
    const strict: Record<string, number | null> = {};
    for (const repo of CENSUS_BASELINE.repos) {
      pinned[repo] = await countMergedPulls(
        client,
        repo,
        b.windowFrom,
        b.windowTo
      );
      strict[repo] = await countMergedPulls(
        client,
        repo,
        b.strictFrom,
        b.windowTo
      );
    }
    out.census = { pinned, strict7d: strict };
    const [repo, number] = b.timelineIssue.split("#") as [string, string];
    const tl = await fetchTimeline(client, repo, Number(number));
    out.timeline =
      tl.kind === "ok"
        ? {
            issue: b.timelineIssue,
            events: tl.rawCount,
            labelEvents: tl.events.filter(
              e => e.event === "labeled" || e.event === "unlabeled"
            ).length,
            pages: tl.pages,
          }
        : null;
  }
  if (client.stopReason) out.error = client.stopReason;
  return out;
}

// ─────────────────────────── the census baseline ───────────────────────────

/** Directive section 3 (AC1): the census figures, their windows and tolerances. */
export const CENSUS_BASELINE = {
  id: "census-2026-11-02",
  repos: ["MattStarfield/hapimatic-private", "MattStarfield/rp1-home"],
  cost: {
    windowFrom: "2026-10-02T20:00:00Z",
    windowTo: "2026-11-02T20:00:00Z",
    censusUsd: 28_700,
    fixtureUsd: 26_484,
    acceptLow: -0.1,
    acceptHigh: 0.05,
  },
  cacheServed: { census: 0.984, fixture: 0.9856, tolerancePp: 0.5 },
  split: {
    census: { cacheRead: 0.57, write1h: 0.23, write5m: 0.1, output: 0.1 },
    fixture: { cacheRead: 0.57, write1h: 0.246, write5m: 0.08, output: 0.104 },
    tolerancePp: 2.5,
  },
  context: {
    windowFrom: "2026-10-26T00:00:00Z",
    windowTo: "2026-11-02T00:00:00Z",
    census: 421_000,
  },
  start: { census: 173_500, firstTurnMedian: 257_000 },
  prs: {
    windowFrom: "2026-10-26T00:00:00Z",
    windowTo: "2026-11-02T19:30:00Z",
    strictFrom: "2026-10-26T19:30:00Z",
    census: 183,
    byRepo: {
      "MattStarfield/hapimatic-private": 172,
      "MattStarfield/rp1-home": 11,
    },
    strict7d: 150,
    timelineIssue: "MattStarfield/hapimatic-private#4172",
    timelineEvents: 365,
    timelineLabelEvents: 121,
  },
} as const;

/**
 * What every measured figure leaves out, printed under the baseline table (the
 * census counted some of these, which skews per-session figures).
 */
export const BASELINE_EXCLUSIONS: readonly string[] = [
  "Synthetic records: entries Claude Code writes itself (model `<synthetic>`, such as a usage-limit or API error) made no API call. They never count as a model call, as context, effort or model, as a session's first call, or as the end of an idle gap. Their usage, zero in practice, still sums into tokens, as the ledger counts it.",
  "Model-less transcripts: a transcript with no model call, such as the `hello` metadata probe every session start runs and aborts at init, has no ledger turn, so it is never read and adds no session, turn or call.",
  "Turns with no model call (a prompt that hit a usage-limit error, a local command) stay in the turn count as ledger prompts, but add nothing to calls, context, effort or cost.",
];

export interface BaselineRow {
  figure: string;
  window: string;
  measured: string;
  census: string;
  delta: string;
  verdict: "pass" | "fail" | "n/a";
  note: string;
}

const money = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
const pct = (v: number, places = 1) => `${(v * 100).toFixed(places)}%`;
const k = (v: number | null) => (v === null ? "—" : `${Math.round(v / 1000)}K`);

function sameWindow(r: ThroughputReport, from: string, to: string): boolean {
  return (
    r.window.fromMs === Date.parse(from) && r.window.toMs === Date.parse(to)
  );
}

/** The census comparison, each figure against its own window and method. */
export function baselineRows(
  r: ThroughputReport,
  gh: GithubReport | null
): BaselineRow[] {
  const b = CENSUS_BASELINE;
  const rows: BaselineRow[] = [];
  const costWindow = `${b.cost.windowFrom} → ${b.cost.windowTo}`;
  if (sameWindow(r, b.cost.windowFrom, b.cost.windowTo)) {
    const total = r.usd.total;
    const vsCensus = total / b.cost.censusUsd - 1;
    const vsFixture = total / b.cost.fixtureUsd - 1;
    rows.push({
      figure: "API-equivalent cost",
      window: costWindow,
      measured: money(total),
      census: `${money(b.cost.censusUsd)} (fixture ${money(b.cost.fixtureUsd)})`,
      delta: `${pct(vsCensus)} vs census; ${pct(vsFixture, 2)} vs fixture`,
      verdict:
        vsCensus >= b.cost.acceptLow && vsCensus <= b.cost.acceptHigh
          ? "pass"
          : "fail",
      note: "Ledger rows only until RP1 has facts. The census read every transcript: it also counts orphaned turns whose transcripts are purged, background agents and sessions run outside Hapimatic.",
    });
    const cs = r.cacheServedShare;
    rows.push({
      figure: "Cache-served input",
      window: costWindow,
      measured: cs === null ? "—" : pct(cs, 2),
      census: `${pct(b.cacheServed.census)} (fixture ${pct(b.cacheServed.fixture, 2)})`,
      delta:
        cs === null
          ? "—"
          : `${((cs - b.cacheServed.fixture) * 100).toFixed(2)} pp vs fixture`,
      verdict:
        cs !== null &&
        Math.abs(cs - b.cacheServed.fixture) * 100 <= b.cacheServed.tolerancePp
          ? "pass"
          : "fail",
      note: "cr / (in + cache writes + cr)",
    });
    const s = r.split;
    const keys = ["cacheRead", "write1h", "write5m", "output"] as const;
    const ok =
      s !== null &&
      keys.every(
        key =>
          Math.abs(s[key] - b.split.fixture[key]) * 100 <= b.split.tolerancePp
      );
    rows.push({
      figure: "Cost split (cache read / 1h write / 5m write / output)",
      window: costWindow,
      measured: s
        ? keys.map(key => (s[key] * 100).toFixed(1)).join(" / ")
        : "—",
      census: `57 / 23 / 10 / 10 (fixture ${keys.map(key => (b.split.fixture[key] * 100).toFixed(1)).join(" / ")})`,
      delta: s
        ? keys
            .map(key => ((s[key] - b.split.fixture[key]) * 100).toFixed(1))
            .join(" / ") + " pp vs fixture"
        : "—",
      verdict: ok ? "pass" : "fail",
      note: "±2.5 pp each",
    });
  } else {
    rows.push({
      figure: "API-equivalent cost, cache-served share, cost split",
      window: costWindow,
      measured: "—",
      census: `${money(b.cost.censusUsd)}; 98.4%; 57 / 23 / 10 / 10`,
      delta: "—",
      verdict: "n/a",
      note: `Run with --from=${b.cost.windowFrom} --to=${b.cost.windowTo} --origin=rp1-prod to compare.`,
    });
  }

  const ctxWindow = `${b.context.windowFrom} → ${b.context.windowTo}`;
  const all = r.context.allCalls;
  rows.push({
    figure: "Median context per call (all calls)",
    window: ctxWindow,
    measured: all.n > 0 ? `${k(all.p50)} (n ${all.n})` : "—",
    census: k(b.context.census),
    delta:
      all.n > 0 && all.p50 !== null
        ? `${Math.round((all.p50 - b.context.census) / 1000)}K`
        : "—",
    verdict:
      sameWindow(r, b.context.windowFrom, b.context.windowTo) &&
      all.n > 0 &&
      all.p50 !== null
        ? Math.abs(all.p50 - b.context.census) <= CONTEXT_BIN_TOKENS
          ? "pass"
          : "fail"
        : "n/a",
    note:
      all.n > 0
        ? "From facts histograms (10K bins)."
        : "Needs facts for these turns: RP1 facts, or this report in --facts=compute mode on RP1 while its transcripts survive (~2026-11-25).",
  });

  rows.push({
    figure: "Starting context",
    window: "a session's first real model call",
    measured:
      r.context.start.n > 0
        ? `${k(r.context.start.p50)} (n ${r.context.start.n})`
        : "—",
    census: `${k(b.start.census)} (get_context_usage before any prompt); first-turn median ~${k(b.start.firstTurnMedian)}`,
    delta: "—",
    verdict: "n/a",
    note: `Different methods, never equivalent. ${STARTING_CONTEXT_METHOD_NOTE}`,
  });

  const prWindow = `${b.prs.windowFrom} → ${b.prs.windowTo}`;
  if (gh?.census) {
    const pinned = Object.values(gh.census.pinned);
    const strict = Object.values(gh.census.strict7d);
    const sum = (xs: Array<number | null>) =>
      xs.every(x => x !== null)
        ? xs.reduce<number>((t, x) => t + (x ?? 0), 0)
        : null;
    const p = sum(pinned);
    const st = sum(strict);
    const parts = Object.entries(gh.census.pinned)
      .map(([repo, n]) => `${repo.slice(repo.indexOf("/") + 1)} ${n ?? "—"}`)
      .join(" + ");
    rows.push({
      figure: "Merged PRs",
      window: prWindow,
      measured:
        p === null ? "—" : `${p} (${parts}); strict 7 × 24 h: ${st ?? "—"}`,
      census: `${b.prs.census} (172 + 11); strict 7 × 24 h ${b.prs.strict7d}`,
      delta: p === null ? "—" : `${p - b.prs.census}`,
      verdict:
        p === b.prs.census && st === b.prs.strict7d
          ? "pass"
          : p === null
            ? "n/a"
            : "fail",
      note: '"Per week" means a rolling 7 × 24 h going forward; the census window was about 7.8 days.',
    });
    if (gh.timeline) {
      rows.push({
        figure: `Full timeline of ${b.prs.timelineIssue}`,
        window: "the issue's life",
        measured: `${gh.timeline.events} events, ${gh.timeline.labelEvents} label events, ${gh.timeline.pages} pages`,
        census: `${b.prs.timelineEvents} events, ${b.prs.timelineLabelEvents} label events`,
        delta: `${gh.timeline.labelEvents - b.prs.timelineLabelEvents} label events`,
        verdict:
          gh.timeline.labelEvents >= b.prs.timelineLabelEvents &&
          gh.timeline.events >= b.prs.timelineEvents
            ? "pass"
            : "fail",
        note: "The REST first page stops at 100 events; the collector reads every page.",
      });
    }
  } else {
    rows.push({
      figure: "Merged PRs",
      window: prWindow,
      measured: "—",
      census: `${b.prs.census} (172 + 11); strict 7 × 24 h ${b.prs.strict7d}`,
      delta: "—",
      verdict: "n/a",
      note: gh?.error ?? "Run with --github to count them (read-only).",
    });
  }
  return rows;
}

function cell(s: string): string {
  return s.replaceAll("|", "\\|");
}

/** The report as markdown (with the baseline table when asked). */
export function renderReport(
  r: ThroughputReport,
  gh: GithubReport | null,
  baseline: BaselineRow[] | null
): string {
  const out: string[] = [
    `# Throughput report: ${r.window.fromIso} to ${r.window.toIso}`,
    "",
    `Origins: ${r.origins.join(", ") || "none"}. Exact window (not day-snapped). Database opened read-only.`,
    "",
    "| Figure | Value |",
    "|---|---|",
    `| Turns | ${r.turns.toLocaleString("en-US")} (${r.withFacts} with facts${r.computedFacts ? `, ${r.computedFacts} computed in memory` : ""}; ${r.unpriced} with no tokens and no facts) |`,
    `| API-equivalent cost | ${money(r.usd.total)} (${
      Object.entries(r.bySource)
        .map(([s, v]) => `${s} ${money(v)}`)
        .join(", ") || "—"
    }) |`,
    `| Fallback-priced | ${money(r.usd.fallback)} |`,
    `| Unattributed account | ${money(r.unattributedUsd)} |`,
    `| Cache-served input | ${r.cacheServedShare === null ? "—" : pct(r.cacheServedShare, 2)} |`,
    `| Split: cache read / 1h write / 5m+unknown write / output | ${r.split ? `${pct(r.split.cacheRead)} / ${pct(r.split.write1h)} / ${pct(r.split.write5m)} / ${pct(r.split.output)}` : "—"} |`,
    `| Context per call, all calls (median) | ${k(r.context.allCalls.p50)} (n ${r.context.allCalls.n}) |`,
    `| Context per call, main chain (median) | ${k(r.context.mainChain.p50)} (n ${r.context.mainChain.n}) |`,
    `| Starting context (median) | ${k(r.context.start.p50)} (n ${r.context.start.n}) |`,
    "",
  ];
  if (gh) {
    out.push(
      "## GitHub (read-only)",
      "",
      gh.error ? `Error: ${gh.error}` : "",
      ...Object.entries(gh.window).map(
        ([repo, n]) => `- ${repo}: ${n ?? "—"} merged PRs in the window.`
      ),
      ""
    );
  }
  if (baseline) {
    out.push(
      `## Baseline: ${CENSUS_BASELINE.id}`,
      "",
      "| Figure | Window (UTC) | Measured | Census | Delta | Verdict | Note |",
      "|---|---|---|---|---|---|---|",
      ...baseline.map(
        b =>
          `| ${cell(b.figure)} | ${cell(b.window)} | ${cell(b.measured)} | ${cell(b.census)} | ${cell(b.delta)} | ${b.verdict} | ${cell(b.note)} |`
      ),
      "",
      "Exclusions applied:",
      "",
      ...BASELINE_EXCLUSIONS.map(e => `- ${e}`),
      ""
    );
  }
  return `${out
    .filter((l, i, a) => !(l === "" && a[i - 1] === ""))
    .join("\n")
    .trimEnd()}\n`;
}
