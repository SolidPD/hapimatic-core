// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Cron } from "croner";
import {
  SupervisedLoop,
  utcDayOf,
  type JobFailureEvent,
  type JobRegistry,
  type ThroughputBreakdown,
  type ThroughputPercentiles,
  type ThroughputSummary,
  type ThroughputTestsPage,
  type ThroughputWindow,
} from "@hapi/protocol";
import type { Notifier } from "../notifications/notifier";
import type { ThroughputDigestStore } from "../store/throughput/digestStore";
import type { ThroughputRollupStore } from "../store/throughput/rollupStore";
import { DEFAULT_PROVIDER, ThroughputPricer } from "./pricing";
import type { ThroughputSummaryService } from "./summary";

/**
 * The weekly throughput digest (issue #6164, A1 — R8). Fleet job, one node.
 *
 * On its cron schedule (default `0 6 * * 1`, Monday 06:00 in the server's
 * zone) and with no session involved, it computes the 7 whole UTC days before
 * the scheduled time ONCE: the summary, per-account and top-issue cost, and
 * test catches. It stores all of it (markdown, the full results, the
 * collector node and the rate cards in force), writes a dated report to
 * `<dataDir>/reports/throughput/throughput-digest-<YYYY-MM-DD>.md`, and
 * notifies the PM through `notify-pm.sh` only when that script exists (the
 * notifier warns on every call otherwise): a headline and the report path,
 * at most 4,000 characters, fail-open.
 *
 * A missed run (the node was down) is caught up on the next tick: the latest
 * scheduled window without a stored digest is computed. Rows are kept 104
 * weeks and report files 26 weeks.
 */

export const DIGEST_LOOP_NAME = "throughput-digest";
export const DEFAULT_DIGEST_CRON = "0 6 * * 1";
export const NOTIFY_MAX_CHARS = 4_000;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const ROW_RETENTION_WEEKS = 104;
const FILE_RETENTION_WEEKS = 26;
const MIN_DELAY_MS = 60_000;
const MAX_DELAY_MS = 6 * 3_600_000;
/** Retry delay while the rollups still have dirty buckets to rebuild. */
const DEFERRED_DELAY_MS = 5 * 60_000;
const TOP_ROWS = 10;
const REPORT_PREFIX = "throughput-digest-";

/** The next scheduled fire strictly after `afterMs`, or null. */
export function nextFireMs(
  cron: string,
  timezone: string | undefined,
  afterMs: number
): number | null {
  try {
    return (
      new Cron(cron, { timezone }).nextRun(new Date(afterMs))?.getTime() ?? null
    );
  } catch {
    return null;
  }
}

/** The latest scheduled fire at or before `nowMs` (looking back 8 days). */
export function lastFireMs(
  cron: string,
  timezone: string | undefined,
  nowMs: number
): number | null {
  let t = nextFireMs(cron, timezone, nowMs - 8 * DAY_MS);
  let last: number | null = null;
  for (let i = 0; t !== null && t <= nowMs && i < 10_000; i++) {
    last = t;
    t = nextFireMs(cron, timezone, t);
  }
  return last;
}

/** The 7 whole UTC days before `fireMs`. */
export function digestWindow(fireMs: number): ThroughputWindow {
  const toMs = Math.floor(fireMs / DAY_MS) * DAY_MS;
  return { fromMs: toMs - WEEK_MS, toMs, days: 7 };
}

const usd = (v: number | null | undefined): string =>
  v === null || v === undefined ? "—" : `$${v.toFixed(2)}`;
const pct = (v: number | null | undefined, places = 1): string =>
  v === null || v === undefined ? "—" : `${(v * 100).toFixed(places)}%`;
const num = (v: number | null | undefined, places = 0): string =>
  v === null || v === undefined
    ? "—"
    : v.toLocaleString("en-US", { maximumFractionDigits: places });
const kTok = (v: number | null | undefined): string =>
  v === null || v === undefined ? "—" : `${Math.round(v / 1000)}K`;

/** Escape a table cell (pipes and newlines). */
function cell(s: string): string {
  return s.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function table(head: string[], rows: string[][]): string[] {
  if (rows.length === 0) return ["_None in this window._", ""];
  return [
    `| ${head.join(" | ")} |`,
    `|${head.map(() => "---").join("|")}|`,
    ...rows.map(r => `| ${r.map(cell).join(" | ")} |`),
    "",
  ];
}

export interface DigestInputs {
  window: ThroughputWindow;
  summary: ThroughputSummary;
  accounts: ThroughputBreakdown;
  issues: ThroughputBreakdown;
  tests: ThroughputTestsPage;
  collector: string;
}

/** The one-line headline (also the notification's first line). */
export function digestHeadline(d: DigestInputs): string {
  const s = d.summary;
  const gh = s.github;
  const parts = [
    `${usd(s.totals.usd.total)} API-equivalent over ${num(s.totals.turns)} turns`,
    `${pct(s.totals.cacheServedShare)} of input served from cache`,
  ];
  if (gh.available) {
    parts.push(
      `${gh.closedIssues} issues closed (median lead ${num(gh.leadTimeHours.p50, 1)} h)`
    );
    if (gh.mergedPrs !== null) parts.push(`${gh.mergedPrs} PRs merged`);
  }
  return `${parts.join("; ")}.`;
}

/** The digest's markdown report. */
export function renderDigest(d: DigestInputs): string {
  const s = d.summary;
  const cov = s.coverage;
  const gh = s.github;
  const q = s.quota;
  const from = utcDayOf(d.window.fromMs);
  const to = utcDayOf(d.window.toMs - 1);
  const t = s.totals;
  const share = (v: number) => (t.usd.total > 0 ? v / t.usd.total : null);
  const out: string[] = [
    `# Hapimatic weekly throughput digest: ${from} to ${to}`,
    "",
    digestHeadline(d),
    "",
    `Window: the 7 whole UTC days ${from} 00:00 to ${utcDayOf(d.window.toMs)} 00:00. Collected on node \`${d.collector}\`.`,
    "",
    "## Coverage",
    "",
    ...table(
      ["Node", "Turns", "With facts", "Recovered", "Last mirror sync"],
      cov.nodes.map(n => [
        n.local ? `${n.origin} (this node)` : n.origin,
        num(n.turns),
        num(n.withFacts),
        num(n.recovered),
        n.local
          ? "local"
          : n.lastSyncMs
            ? new Date(n.lastSyncMs).toISOString()
            : "never",
      ])
    ),
    `- Mirror: ${cov.mirrorEnabled === null ? "standalone node" : cov.mirrorEnabled ? "on" : "off on this node"}.`,
    ...cov.missingNodes.map(
      m => `- Missing: ${m.label ?? m.nodeId}: ${m.reason}`
    ),
    ...(cov.nodesWithoutFacts.length
      ? [
          `- No facts in recent rows (older binary): ${cov.nodesWithoutFacts.join(", ")}.`,
        ]
      : []),
    ...cov.notCollected.map(n => `- ${n}.`),
    `- Rows without facts: ${num(cov.rowsWithoutFacts)}; recovered rows: ${num(cov.recoveredRows)}; unattributed-account share: ${pct(cov.unattributedAccountShare)}; fallback-priced share: ${pct(cov.fallbackPricedShare)}.`,
    "",
    "## Cost and split",
    "",
    ...table(
      ["Category", "USD", "Share"],
      [
        ["Cache read", usd(t.usd.cacheRead), pct(share(t.usd.cacheRead))],
        ["1-hour cache write", usd(t.usd.write1h), pct(share(t.usd.write1h))],
        ["5-minute cache write", usd(t.usd.write5m), pct(share(t.usd.write5m))],
        [
          "Cache write, TTL unknown",
          usd(t.usd.writeUnknown),
          pct(share(t.usd.writeUnknown)),
        ],
        ["Output", usd(t.usd.output), pct(share(t.usd.output))],
        ["Uncached input", usd(t.usd.input), pct(share(t.usd.input))],
        ["Total", usd(t.usd.total), ""],
      ]
    ),
    ...table(
      ["Source", "Turns", "USD"],
      s.bySource.map(l => [l.key, num(l.turns), usd(l.usd.total)])
    ),
    "## Stages",
    "",
    ...table(
      ["Stage", "Turns", "Calls", "USD"],
      s.byStage.map(l => [l.key, num(l.turns), num(l.calls), usd(l.usd.total)])
    ),
    "## Accounts",
    "",
    ...table(
      ["Account", "Turns", "USD", "Weekly use", "Runway"],
      d.accounts.rows
        .slice(0, TOP_ROWS)
        .map(r => [
          r.label ?? r.key,
          num(r.turns),
          usd(r.usd.total),
          r.quota?.utilization !== null && r.quota?.utilization !== undefined
            ? `${num(r.quota.utilization)}%`
            : "—",
          r.quota?.runwayHours !== null && r.quota?.runwayHours !== undefined
            ? `${num(r.quota.runwayHours, 1)} h`
            : "—",
        ])
    ),
    `Unattributed share of cost: ${pct(d.accounts.unattributedShare)}.`,
    "",
    "## Top issues",
    "",
    ...table(
      ["Issue", "Turns", "USD"],
      d.issues.rows
        .slice(0, TOP_ROWS)
        .map(r => [r.key, num(r.turns), usd(r.usd.total)])
    ),
    "## Context",
    "",
    ...table(
      ["Calls", "n", "p50", "p90", "p99"],
      (
        [
          ["Main chain", s.context.main],
          ["All calls", s.context.all],
          ["Starting context", s.context.start],
        ] as Array<[string, ThroughputPercentiles]>
      ).map(([label, p]) => [
        label,
        num(p.n),
        kTok(p.p50),
        kTok(p.p90),
        kTok(p.p99),
      ])
    ),
    "## Waits",
    "",
    ...table(
      ["After an idle gap, started by", "Rewrites", "USD"],
      s.idle.map(i => [i.cls, num(i.n), usd(i.usd)])
    ),
    "## Effort and model",
    "",
    ...table(
      ["Effort", "Model", "Calls"],
      s.effort.slice(0, TOP_ROWS).map(e => [e.effort, e.model, num(e.calls)])
    ),
    "## Lead time",
    "",
  ];
  if (gh.available) {
    out.push(
      `Issues closed: ${gh.closedIssues}; lead time p50 ${num(gh.leadTimeHours.p50, 1)} h, p90 ${num(gh.leadTimeHours.p90, 1)} h.`,
      "",
      ...table(
        ["Stage", "n", "p50 h", "p90 h"],
        gh.stageHours.map(st => [
          st.stage,
          num(st.n),
          num(st.p50, 1),
          num(st.p90, 1),
        ])
      ),
      "## Quality",
      "",
      `- Reopens: ${gh.reopens}; escaped defects: ${gh.escapes} (${pct(gh.escapeRate)} of delivered issues).`,
      `- Failed CI runs: ${gh.ciFailedRuns}; per merged PR: ${num(gh.ciFailuresPerPr, 2)}; trunk red: ${num(gh.trunkRedHours, 1)} h.`,
      `- Merged PRs: ${gh.mergedPrs ?? "—"}.`,
      ""
    );
  } else {
    out.push(
      `_${gh.reason ?? "GitHub facts are not available."}_`,
      "",
      "## Quality",
      "",
      `_${gh.reason ?? "Not available."}_`,
      ""
    );
  }
  out.push(
    "## Tests",
    "",
    ...table(
      ["Unit", "CI catches", "Agent catches", "Sessions"],
      d.tests.rows
        .slice(0, TOP_ROWS)
        .map(r => [
          r.unit,
          num(r.ciCatches),
          num(r.agentCatches),
          num(r.sessions),
        ])
    ),
    `## Quota (${q.label})`,
    ""
  );
  if (q.available) {
    out.push(
      `- Fleet: ${q.fleet.accounts} ${q.fleet.accounts === 1 ? "account" : "accounts"}, ${q.fleet.accountsWithHeadroom} with headroom; ${num(q.fleet.headroomPp)} percentage points left; burning ${num(q.fleet.slopePpPerHour, 2)} pp/h; runway ${num(q.fleet.runwayHours, 1)} h.`
    );
  } else {
    out.push(`- ${q.reason ?? "Not available."}`);
  }
  if (q.weights?.status === "ok" && q.weights.ppPerMTok) {
    const w = q.weights.ppPerMTok;
    out.push(
      `- Weights, pp per million tokens (R² ${num(q.weights.r2, 2)}, n ${q.weights.n}): input ${w.in.toFixed(3)}, output ${w.out.toFixed(3)}, cache read ${w.cr.toFixed(4)}, 1-hour write ${w.w1.toFixed(3)}, 5-minute write ${w.w5.toFixed(3)}, unknown-TTL write ${w.wu.toFixed(3)}.`
    );
  } else if (q.weights) {
    out.push(
      `- Weights: insufficient data (${q.weights.n} usable days; 10 needed).`
    );
  }
  out.push("", "## Points", "");
  if (gh.points.available) {
    out.push(
      `${gh.points.total} points delivered; ${usd(gh.points.costPerPoint)} per point.`,
      "",
      ...table(
        ["Lane", "Issues", "Points"],
        gh.points.byLane.map(l => [l.lane, num(l.issues), num(l.points)])
      )
    );
  } else {
    out.push(`_${gh.points.reason ?? "No lane labels yet."}_`, "");
  }
  return `${out.join("\n").trimEnd()}\n`;
}

export interface DigestRunReport {
  id: string;
  window: ThroughputWindow;
  reportPath: string | null;
  notified: boolean;
  skipped: boolean;
}

export interface ThroughputDigestOptions {
  service: ThroughputSummaryService;
  digests: ThroughputDigestStore;
  rollups: ThroughputRollupStore;
  /** `<dataDir>/reports/throughput` */
  reportsDir: string;
  /** This node's id (recorded on every digest). */
  collector: string;
  /** The owning namespace the digest is computed for. */
  ownerNamespace: string;
  /** Null: never notify. */
  notifier: Notifier | null;
  /** True when the notify-pm script exists (checked before every call). */
  canNotify: () => boolean;
  cron?: string;
  timezone?: string;
  now?: () => number;
}

export class ThroughputDigest {
  private readonly cron: string;
  private readonly now: () => number;
  private deferred = false;

  constructor(private readonly opts: ThroughputDigestOptions) {
    this.cron = opts.cron ?? DEFAULT_DIGEST_CRON;
    this.now = opts.now ?? Date.now;
  }

  /** Time to the next scheduled fire (bounded so a clock change is noticed). */
  nextDelayMs(): number {
    if (this.deferred) return DEFERRED_DELAY_MS;
    const now = this.now();
    const next = nextFireMs(this.cron, this.opts.timezone, now);
    if (next === null) return MAX_DELAY_MS;
    return Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, next - now + 1_000));
  }

  /**
   * Run the latest scheduled window if it has no digest yet. A digest is
   * computed once, so it waits while the rollups still have buckets to rebuild.
   */
  async tick(): Promise<DigestRunReport | null> {
    const fire = lastFireMs(this.cron, this.opts.timezone, this.now());
    if (fire === null) return null;
    const window = digestWindow(fire);
    if (this.opts.digests.findByWindow(window.fromMs, window.toMs)) {
      this.deferred = false;
      return null;
    }
    if (this.opts.rollups.countDirty() > 0) {
      this.deferred = true;
      return null;
    }
    this.deferred = false;
    return this.runFor(fire);
  }

  /** Compute, store, write and announce the digest for the week before `fireMs`. */
  async runFor(fireMs: number): Promise<DigestRunReport> {
    const { digests, service } = this.opts;
    const window = digestWindow(fireMs);
    const id = utcDayOf(window.toMs);
    const existing = digests.findByWindow(window.fromMs, window.toMs);
    if (existing) {
      return {
        id: existing.id,
        window,
        reportPath: existing.reportPath,
        notified: existing.notified,
        skipped: true,
      };
    }
    const scope = { namespace: this.opts.ownerNamespace, isOwner: true };
    const inputs: DigestInputs = {
      window,
      summary: service.summary(window, scope).body,
      accounts: service.breakdown("account", window, scope, 0),
      issues: service.breakdown("issue", window, scope, 0),
      tests: service.tests(window, scope, 0),
      collector: this.opts.collector,
    };
    const markdown = renderDigest(inputs);
    const headline = digestHeadline(inputs);
    let reportPath: string | null = join(
      this.opts.reportsDir,
      `${REPORT_PREFIX}${id}.md`
    );
    try {
      mkdirSync(this.opts.reportsDir, { recursive: true });
      writeFileSync(reportPath, markdown, { mode: 0o600 });
    } catch {
      reportPath = null; // the row still carries the markdown
    }
    digests.insert({
      id,
      createdAtMs: this.now(),
      windowFromMs: window.fromMs,
      windowToMs: window.toMs,
      headline,
      reportPath,
      notified: false,
      collector: this.opts.collector,
      markdown,
      summaryJson: JSON.stringify({
        summary: inputs.summary,
        accounts: inputs.accounts,
        issues: inputs.issues,
        tests: inputs.tests,
      }),
      rateCardIds: this.rateCardIds(inputs.summary, window),
    });
    let notified = false;
    if (this.opts.notifier && this.opts.canNotify()) {
      const body = `${headline}\n\nReport: ${reportPath ?? "stored in the Throughput tab (the file could not be written)"}`;
      const r = await this.opts.notifier.notify(
        "Hapimatic weekly throughput digest",
        body.slice(0, NOTIFY_MAX_CHARS)
      );
      if (r.delivered) {
        digests.markNotified(id);
        notified = true;
      }
    }
    this.prune();
    return { id, window, reportPath, notified, skipped: false };
  }

  /** The rate cards in force at the window's end for its models. */
  private rateCardIds(
    summary: ThroughputSummary,
    window: ThroughputWindow
  ): string[] {
    const pricer = new ThroughputPricer(this.opts.rollups.rateCards());
    const zero = { in: 0, out: 0, cr: 0, w1: 0, w5: 0, wu: 0 };
    for (const m of summary.byModel) {
      pricer.price(m.key, window.toMs - 1, zero, DEFAULT_PROVIDER);
    }
    return pricer.cardIds();
  }

  private prune(): void {
    const now = this.now();
    this.opts.digests.pruneBefore(now - ROW_RETENTION_WEEKS * WEEK_MS);
    const cutoff = utcDayOf(now - FILE_RETENTION_WEEKS * WEEK_MS);
    try {
      for (const name of readdirSync(this.opts.reportsDir)) {
        if (!name.startsWith(REPORT_PREFIX) || !name.endsWith(".md")) continue;
        const day = name.slice(REPORT_PREFIX.length, -".md".length);
        if (day < cutoff)
          rmSync(join(this.opts.reportsDir, name), { force: true });
      }
    } catch {
      // no reports directory yet
    }
  }
}

/** Build the `throughput-digest` SupervisedLoop (wakes at the cron time). */
export function createDigestLoop(opts: {
  digest: ThroughputDigest;
  node: string;
  enabled: boolean;
  registry?: JobRegistry;
  onEvent?: (event: JobFailureEvent) => void;
  monotonic?: () => number;
}): SupervisedLoop {
  const monotonic = opts.monotonic ?? (() => performance.now());
  return new SupervisedLoop({
    name: DIGEST_LOOP_NAME,
    node: opts.node,
    intervalMs: MAX_DELAY_MS,
    getIntervalMs: () => opts.digest.nextDelayMs(),
    enabled: opts.enabled,
    immediate: false,
    registry: opts.registry,
    onEvent: opts.onEvent,
    tick: async () => {
      const t0 = monotonic();
      const r = await opts.digest.tick();
      const ms = Math.round(monotonic() - t0);
      opts.registry?.update(DIGEST_LOOP_NAME, {
        throughput: {
          tickMs: ms,
          mbRead: 0,
          rowsWritten: r && !r.skipped ? 1 : 0,
          longestSyncMs: ms,
          lastDigest: r?.id ?? null,
          notified: r?.notified ?? false,
        },
      });
    },
  });
}
