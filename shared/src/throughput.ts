// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

/**
 * Throughput telemetry contract (issue #6164, epic #6163 Sub-Issue A1).
 *
 * Two kinds of shape live here:
 *
 *  1. The per-turn FACTS record stored in `turns.throughput_json` and replicated
 *     to every peer by the #4614 turn-ledger mirror. Collectors on different
 *     binaries meet through the mirror, so every reader parses it with
 *     `safeParse` against a `.passthrough()` schema whose fields are all
 *     optional (except `v`), and tolerates an unknown `v`.
 *  2. The REST response shapes of `/api/telemetry/throughput/*`, read by the web
 *     Throughput tab, the weekly digest and the report CLI.
 *
 * PURE and web-safe: no Node built-ins (the web bundle imports this module
 * through `@hapi/protocol`), so `canonicalJson` is implemented here rather than
 * reusing `deterministicJson.ts`, which imports `node:crypto`.
 */

// ───────────────────────────── constants ─────────────────────────────

/** Facts record schema version (`turns.throughput_json` → `v`). */
export const TURN_FACTS_VERSION = 1;
/** Hard cap on a canonical facts record, in UTF-8 bytes. */
export const FACTS_MAX_BYTES = 2048;
/** Context histogram bin width (tokens). */
export const CONTEXT_BIN_TOKENS = 10_000;
/** The coarser bin the size cap falls back to for the main-chain histogram. */
export const CONTEXT_COARSE_BIN_TOKENS = 50_000;
/** A gap between two API calls longer than this expires the 1-hour cache. */
export const IDLE_GAP_MS = 3_600_000;
/** A reopen or regression follow-up within this window of a close is an escape. */
export const ESCAPE_WINDOW_MS = 14 * 24 * 3_600_000;
/** Facts are collected only for turns that started inside this window. */
export const RETENTION_WINDOW_DAYS = 35;
/** Default and maximum summary windows (whole UTC days). */
export const SUMMARY_DEFAULT_WINDOW_DAYS = 7;
export const SUMMARY_MAX_WINDOW_DAYS = 92;
/** Page size cap for identity-bearing lists. */
export const THROUGHPUT_PAGE_LIMIT = 200;

/**
 * What woke a session after a post-idle cache rewrite (R4). Evidence-based:
 * `unknown` is explicit, and nothing defaults to `person`.
 */
export const WAIT_CLASSES = [
  "person",
  "pm_peer",
  "background_task",
  "scheduled_tick",
  "tool_wait",
  "unknown",
] as const;
export type WaitClass = (typeof WAIT_CLASSES)[number];

/** Story points per delivered issue, by lane (configurable per instance). */
export const DEFAULT_LANE_POINTS: Readonly<Record<string, number>> = {
  fast: 1,
  normal: 3,
  hard: 8,
};

/** Where a priced token line came from. */
export const THROUGHPUT_SOURCES = [
  "ledger",
  "recovered",
  "background",
] as const;
export type ThroughputSource = (typeof THROUGHPUT_SOURCES)[number];

/** Stage keys outside the `attributionSkill` vocabulary. */
export const STAGE_NONE = "none";
export const STAGE_SUBAGENT = "subagent";
export const STAGE_BACKGROUND = "background_agent";
/** Effort key for a call that recorded none. */
export const EFFORT_UNKNOWN = "unknown";

/** The fixed coverage line for sessions no node can see. */
export const CLOUD_SESSIONS_NOT_COLLECTED =
  "Claude Code cloud sessions: not collected — their transcripts are not on any node";
/** Label on every quota-weight surface. */
export const QUOTA_ESTIMATE_LABEL = "estimated (Tier 3)";
/** Why the starting-context figure differs from `get_context_usage`. */
export const STARTING_CONTEXT_METHOD_NOTE =
  "First real main-chain API call of a session, normally in its first turn (includes the first prompt and the tools loaded at that call). A usage-limit error or a turn with no model call is skipped. `get_context_usage` before any prompt is a different method and reads lower.";

// ───────────────────────────── facts record ─────────────────────────────

/** Token categories: input, output, cache read, 1-hour write, 5-minute write. */
export const FactsTokensSchema = z
  .object({
    in: z.number(),
    out: z.number(),
    cr: z.number(),
    w1: z.number(),
    w5: z.number(),
  })
  .passthrough();
export type FactsTokens = z.infer<typeof FactsTokensSchema>;

/** `[calls, in, out, cr, w1, w5]` per model. */
const StageModelTupleRecord = z.record(z.string(), z.array(z.number()));

/**
 * Facts record v1 (`turns.throughput_json`). Short keys keep it under
 * {@link FACTS_MAX_BYTES}:
 *
 * - `fp`    fingerprint of the ledger columns the facts were computed from
 * - `calls` main-chain API calls (one per `message.id`; `<synthetic>` and
 *           zero-usage calls excluded)
 * - `tok`   the turn's tokens incl. foreground sub-agents (the parser's rule)
 * - `sm`    stage → model → `[calls, in, out, cr, w1, w5]`
 * - `eff`   effort → main-chain calls; `pte` perTurnEffort; `ep` entrypoint
 * - `ctx`   first (`f`) and max (`x`) occupancy; sparse histograms keyed by
 *           bin index for main-chain (`m`) and sub-agent (`s`) calls, bin
 *           width `b` (default {@link CONTEXT_BIN_TOKENS}); `st: 1` on the turn
 *           that holds its session's first real model call, whose `f` is the
 *           session's starting context
 * - `idle`  gaps over {@link IDLE_GAP_MS}: count `n`, per-class totals
 *           `c: { cls: [n, w1, w5, warmN, warmCr] }` (warmN / warmCr since
 *           #6169: gaps whose opening call read >= 90% of its prefix from the
 *           cache, and their cache-read tokens; absent on older rows → 0), and
 *           the top 3 by rewrite size
 *           `top: [[atMs, gapMs, cls, w1, w5, model], …]`
 * - `tests` agent test runs, failing runs, ≤ 10 scrubbed failing-unit ids
 * - `bg`    background agents launched in the turn: count, per-model
 *           `[in, out, cr, w1, w5]` from the agents' own files
 * - `iss`   `[owner/repo, number, source]` with source `session` / `linked` /
 *           `skill-args`
 * - `tr`    sections the size cap dropped
 */
export const TurnFactsSchema = z
  .object({
    v: z.number(),
    fp: z.string().optional(),
    calls: z.number().optional(),
    tok: FactsTokensSchema.optional(),
    sm: z.record(z.string(), StageModelTupleRecord).optional(),
    eff: z.record(z.string(), z.number()).optional(),
    pte: z.string().nullable().optional(),
    ep: z.string().nullable().optional(),
    ctx: z
      .object({
        f: z.number().nullable().optional(),
        x: z.number().nullable().optional(),
        b: z.number().optional(),
        m: z.record(z.string(), z.number()).optional(),
        s: z.record(z.string(), z.number()).optional(),
        st: z.number().optional(),
      })
      .passthrough()
      .optional(),
    idle: z
      .object({
        n: z.number(),
        c: z.record(z.string(), z.array(z.number())).optional(),
        top: z
          .array(z.array(z.union([z.number(), z.string(), z.null()])))
          .optional(),
      })
      .passthrough()
      .optional(),
    tests: z
      .object({
        runs: z.number(),
        fail: z.number(),
        units: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
    bg: z
      .object({
        n: z.number(),
        sm: z.record(z.string(), z.array(z.number())),
      })
      .passthrough()
      .nullable()
      .optional(),
    iss: z.tuple([z.string(), z.number(), z.string()]).nullable().optional(),
    tr: z.array(z.string()).optional(),
  })
  .passthrough();
export type TurnFacts = z.infer<typeof TurnFactsSchema>;

/** Parse a stored facts record; null on absent, malformed or non-object JSON. */
export function parseTurnFacts(raw: unknown): TurnFacts | null {
  if (typeof raw !== "string" || raw === "") return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = TurnFactsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// ───────────────────────────── REST shapes ─────────────────────────────

/** Tokens in a priced line; `wu` = cache writes with no TTL split. */
export const ThroughputTokensSchema = z
  .object({
    in: z.number(),
    out: z.number(),
    cr: z.number(),
    w1: z.number(),
    w5: z.number(),
    wu: z.number(),
  })
  .passthrough();
export type ThroughputTokens = z.infer<typeof ThroughputTokensSchema>;

/** API-equivalent USD by category; `fallback` = the part priced by a fallback. */
export const ThroughputCostSchema = z
  .object({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    write1h: z.number(),
    write5m: z.number(),
    writeUnknown: z.number(),
    total: z.number(),
    fallback: z.number(),
  })
  .passthrough();
export type ThroughputCost = z.infer<typeof ThroughputCostSchema>;

/** One priced line of a breakdown (stage, model, node, day, source …). */
export const ThroughputLineSchema = z
  .object({
    key: z.string(),
    calls: z.number(),
    turns: z.number().optional(),
    tokens: ThroughputTokensSchema,
    usd: ThroughputCostSchema,
  })
  .passthrough();
export type ThroughputLine = z.infer<typeof ThroughputLineSchema>;

/** Percentiles of a context histogram (tokens; bin midpoints). */
export const ThroughputPercentilesSchema = z
  .object({
    n: z.number(),
    p50: z.number().nullable(),
    p90: z.number().nullable(),
    p99: z.number().nullable(),
  })
  .passthrough();
export type ThroughputPercentiles = z.infer<typeof ThroughputPercentilesSchema>;

export const ThroughputWindowSchema = z
  .object({ fromMs: z.number(), toMs: z.number(), days: z.number() })
  .passthrough();
export type ThroughputWindow = z.infer<typeof ThroughputWindowSchema>;

/** One contributing node (an origin of local or mirrored rows). */
export const ThroughputCoverageNodeSchema = z
  .object({
    origin: z.string(),
    local: z.boolean(),
    /** Mirror: the last successful pull; local: null. */
    lastSyncMs: z.number().nullable(),
    turns: z.number(),
    withFacts: z.number(),
    recovered: z.number(),
    orphaned: z.number(),
    /** Turns with NULL `tok_*` and no facts: usage nobody can price. */
    tokNullNoFacts: z.number(),
  })
  .passthrough();
export type ThroughputCoverageNode = z.infer<
  typeof ThroughputCoverageNodeSchema
>;

/** One data source and whether it contributed (`ok`, `off`, `stale`, …). */
export const ThroughputSourceStatusSchema = z
  .object({
    source: z.string(),
    status: z.string(),
    detail: z.string().nullable(),
  })
  .passthrough();
export type ThroughputSourceStatus = z.infer<
  typeof ThroughputSourceStatusSchema
>;

/** Which nodes and sources contributed, and what is known to be missing. */
export const ThroughputCoverageSchema = z
  .object({
    nodes: z.array(ThroughputCoverageNodeSchema),
    /** Registry nodes that contributed no rows to the window. */
    missingNodes: z.array(
      z
        .object({
          nodeId: z.string(),
          label: z.string().nullable(),
          reason: z.string(),
        })
        .passthrough()
    ),
    /** False when this node's mirror pull is disabled; null when standalone. */
    mirrorEnabled: z.boolean().nullable(),
    /** Origins whose recent rows carry no facts (older binaries). */
    nodesWithoutFacts: z.array(z.string()),
    notCollected: z.array(z.string()),
    sources: z.array(ThroughputSourceStatusSchema),
    turns: z.number(),
    rowsWithoutFacts: z.number(),
    recoveredRows: z.number(),
    unattributedAccountShare: z.number().nullable(),
    fallbackPricedShare: z.number().nullable(),
  })
  .passthrough();
export type ThroughputCoverage = z.infer<typeof ThroughputCoverageSchema>;

/** Aggregate GitHub-derived delivery and quality figures (no issue ids). */
export const ThroughputGithubSummarySchema = z
  .object({
    available: z.boolean(),
    reason: z.string().nullable(),
    repos: z.array(z.string()),
    lastRunMs: z.number().nullable(),
    mergedPrs: z.number().nullable(),
    closedIssues: z.number(),
    leadTimeHours: ThroughputPercentilesSchema,
    stageHours: z.array(
      z
        .object({
          stage: z.string(),
          n: z.number(),
          p50: z.number().nullable(),
          p90: z.number().nullable(),
        })
        .passthrough()
    ),
    reopens: z.number(),
    escapes: z.number(),
    escapeRate: z.number().nullable(),
    ciFailedRuns: z.number(),
    ciFailuresPerPr: z.number().nullable(),
    trunkRedHours: z.number().nullable(),
    points: z
      .object({
        available: z.boolean(),
        reason: z.string().nullable(),
        total: z.number(),
        costPerPoint: z.number().nullable(),
        byLane: z.array(
          z
            .object({
              lane: z.string(),
              issues: z.number(),
              points: z.number(),
            })
            .passthrough()
        ),
      })
      .passthrough(),
  })
  .passthrough();
export type ThroughputGithubSummary = z.infer<
  typeof ThroughputGithubSummarySchema
>;

/** Runway for one account on its weekly window (identity-bearing). */
export const QuotaAccountSchema = z
  .object({
    accountId: z.string(),
    label: z.string().nullable(),
    utilization: z.number().nullable(),
    resetsAtMs: z.number().nullable(),
    slopePpPerHour: z.number().nullable(),
    runwayHours: z.number().nullable(),
    exhaustsBeforeReset: z.boolean().nullable(),
  })
  .passthrough();
export type QuotaAccount = z.infer<typeof QuotaAccountSchema>;

/** Estimated quota-meter percentage points per million tokens, by category. */
export const QuotaWeightsSchema = z
  .object({
    status: z.enum(["ok", "insufficient"]),
    n: z.number(),
    r2: z.number().nullable(),
    ppPerMTok: z
      .object({
        in: z.number(),
        out: z.number(),
        cr: z.number(),
        w1: z.number(),
        w5: z.number(),
        wu: z.number(),
      })
      .passthrough()
      .nullable(),
  })
  .passthrough();
export type QuotaWeights = z.infer<typeof QuotaWeightsSchema>;

/** Fleet runway + weights (aggregate; per-account rows ride the account breakdown). */
export const QuotaModelSchema = z
  .object({
    available: z.boolean(),
    reason: z.string().nullable(),
    label: z.string(),
    window: z.literal("seven_day"),
    fleet: z
      .object({
        accounts: z.number(),
        accountsWithHeadroom: z.number(),
        headroomPp: z.number(),
        slopePpPerHour: z.number().nullable(),
        runwayHours: z.number().nullable(),
      })
      .passthrough(),
    weights: QuotaWeightsSchema.nullable(),
  })
  .passthrough();
export type QuotaModel = z.infer<typeof QuotaModelSchema>;

/**
 * Issue #6169: prompt-cache keep-alives on THIS node (the ledger is node-local),
 * set against the kept-warm reopenings of this node's own turns, so both sides
 * count the same sessions. Every figure is an estimate.
 */
export const ThroughputKeepaliveSummarySchema = z
  .object({
    scope: z.literal("node"),
    byOutcome: z
      .object({ sent: z.number(), refused: z.number(), failed: z.number() })
      .passthrough(),
    /** The `sent` keep-alives priced: cache read, input and output. */
    costUsd: z.number(),
    keptWarmN: z.number(),
    avoidedUsd: z.number(),
    /** `avoidedUsd - costUsd`. */
    netUsd: z.number(),
  })
  .passthrough();
export type ThroughputKeepaliveSummary = z.infer<
  typeof ThroughputKeepaliveSummarySchema
>;

/** The readonly aggregate summary (no account, session, issue or test identities). */
export const ThroughputSummarySchema = z
  .object({
    window: ThroughputWindowSchema,
    generatedAtMs: z.number(),
    generation: z.number(),
    totals: z
      .object({
        turns: z.number(),
        calls: z.number(),
        tokens: ThroughputTokensSchema,
        usd: ThroughputCostSchema,
        cacheServedShare: z.number().nullable(),
      })
      .passthrough(),
    bySource: z.array(ThroughputLineSchema),
    byStage: z.array(ThroughputLineSchema),
    byModel: z.array(ThroughputLineSchema),
    byNode: z.array(ThroughputLineSchema),
    byDay: z.array(ThroughputLineSchema),
    effort: z.array(
      z
        .object({ effort: z.string(), model: z.string(), calls: z.number() })
        .passthrough()
    ),
    context: z
      .object({
        binTokens: z.number(),
        main: ThroughputPercentilesSchema,
        all: ThroughputPercentilesSchema,
        start: ThroughputPercentilesSchema,
        startMethodNote: z.string(),
      })
      .passthrough(),
    idle: z.array(
      z
        .object({
          cls: z.string(),
          n: z.number(),
          w1: z.number(),
          w5: z.number(),
          usd: z.number(),
          /** #6169: reopenings that read >= 90% of their prefix from the cache. */
          warmN: z.number().optional(),
          /** #6169: the rewrite cost those reopenings avoided (estimate). */
          avoidedUsd: z.number().optional(),
        })
        .passthrough()
    ),
    /** #6169: this node's prompt-cache keep-alives against what they saved. */
    keepalive: ThroughputKeepaliveSummarySchema.optional(),
    coverage: ThroughputCoverageSchema,
    github: ThroughputGithubSummarySchema,
    quota: QuotaModelSchema,
    notes: z.array(z.string()),
  })
  .passthrough();
export type ThroughputSummary = z.infer<typeof ThroughputSummarySchema>;

export const THROUGHPUT_BREAKDOWN_DIMS = [
  "account",
  "session",
  "issue",
] as const;
export type ThroughputBreakdownDim = (typeof THROUGHPUT_BREAKDOWN_DIMS)[number];

/** One identity-bearing breakdown row (mutating-tier route only). */
export const ThroughputBreakdownRowSchema = z
  .object({
    key: z.string(),
    label: z.string().nullable(),
    turns: z.number(),
    calls: z.number(),
    tokens: ThroughputTokensSchema,
    usd: ThroughputCostSchema,
    quota: QuotaAccountSchema.nullable().optional(),
  })
  .passthrough();
export type ThroughputBreakdownRow = z.infer<
  typeof ThroughputBreakdownRowSchema
>;

export const ThroughputBreakdownSchema = z
  .object({
    dim: z.enum(THROUGHPUT_BREAKDOWN_DIMS),
    window: ThroughputWindowSchema,
    rows: z.array(ThroughputBreakdownRowSchema),
    total: z.number(),
    nextCursor: z.string().nullable(),
    /** Share of the window's cost with no attributed key (`unattributed`). */
    unattributedShare: z.number().nullable(),
  })
  .passthrough();
export type ThroughputBreakdown = z.infer<typeof ThroughputBreakdownSchema>;

/** Per-issue delivery facts (GitHub collector + cost by issue). */
export const IssueFactsRowSchema = z
  .object({
    repo: z.string(),
    number: z.number(),
    /** `<repo name>#N` — the lane-backtest dataset's key form. */
    key: z.string(),
    title: z.string(),
    /** The title's first word, lower-cased (the backtest's `type` rule). */
    type: z.string().nullable(),
    state: z.string(),
    stateReason: z.string().nullable(),
    createdAtMs: z.number().nullable(),
    closedAtMs: z.number().nullable(),
    complexity: z.string().nullable(),
    /** Checkpoint stage → first time its label was added. */
    milestones: z.record(z.string(), z.number()),
    leadHours: z.number().nullable(),
    expertHours: z.number().nullable(),
    reopens: z.number(),
    escapes: z.number(),
    escapeRefs: z.array(z.string()),
    expert: z.boolean(),
    prs: z.array(z.number()),
    ciFailures: z.number(),
    codeLines: z.number().nullable(),
    testLines: z.number().nullable(),
    docLines: z.number().nullable(),
    codeFiles: z.number().nullable(),
    dangerFiles: z.number().nullable(),
    lane: z.string().nullable(),
    laneFirst: z.string().nullable(),
    points: z.number().nullable(),
    costUsd: z.number().nullable(),
    turns: z.number().nullable(),
  })
  .passthrough();
export type IssueFactsRow = z.infer<typeof IssueFactsRowSchema>;

/**
 * The lane-backtest dataset's 28 columns, in order (B2 rp1-home#2879 reads
 * them). Extra columns follow; a column A1 cannot compute is left EMPTY.
 */
export const ISSUE_CSV_COLUMNS = [
  "key",
  "title",
  "type",
  "lane_post",
  "lane_post_loose",
  "lane_pre",
  "complexity",
  "confidence",
  "task_count",
  "planned_files",
  "planned_danger",
  "code_lines",
  "test_lines",
  "doc_lines",
  "code_files",
  "danger_files",
  "prs",
  "ci_fail",
  "reopens",
  "regress",
  "sinks",
  "expert",
  "refresh",
  "directives",
  "lead_h",
  "expert_h",
  "total_usd",
  "worker_effort",
] as const;
export const ISSUE_CSV_EXTRA_COLUMNS = [
  "repo",
  "number",
  "closed_at",
  "lane_label_first",
  "points",
  "turns",
] as const;

export const ThroughputIssuesPageSchema = z
  .object({
    window: ThroughputWindowSchema,
    rows: z.array(IssueFactsRowSchema),
    total: z.number(),
    nextCursor: z.string().nullable(),
  })
  .passthrough();
export type ThroughputIssuesPage = z.infer<typeof ThroughputIssuesPageSchema>;

/** Per-test catches from CI logs and agents' own runs (E2 #6174, B5 #6168). */
export const TestCatchRowSchema = z
  .object({
    unit: z.string(),
    ciCatches: z.number(),
    agentCatches: z.number(),
    sessions: z.number(),
    firstSeenMs: z.number().nullable(),
    lastSeenMs: z.number().nullable(),
  })
  .passthrough();
export type TestCatchRow = z.infer<typeof TestCatchRowSchema>;

export const ThroughputTestsPageSchema = z
  .object({
    window: ThroughputWindowSchema,
    rows: z.array(TestCatchRowSchema),
    total: z.number(),
    nextCursor: z.string().nullable(),
  })
  .passthrough();
export type ThroughputTestsPage = z.infer<typeof ThroughputTestsPageSchema>;

/** A stored weekly digest (list row). */
export const DigestMetaSchema = z
  .object({
    id: z.string(),
    createdAtMs: z.number(),
    windowFromMs: z.number(),
    windowToMs: z.number(),
    headline: z.string(),
    reportPath: z.string().nullable(),
    notified: z.boolean(),
    collector: z.string(),
  })
  .passthrough();
export type DigestMeta = z.infer<typeof DigestMetaSchema>;

/** A stored digest with its markdown and full results. */
export const DigestDetailSchema = DigestMetaSchema.extend({
  markdown: z.string(),
  summary: z.unknown(),
}).passthrough();
export type DigestDetail = z.infer<typeof DigestDetailSchema>;

export const DigestListSchema = z
  .object({ digests: z.array(DigestMetaSchema) })
  .passthrough();
export type DigestList = z.infer<typeof DigestListSchema>;

// ───────────────────────── release health (D3 #6173) ─────────────────────────

/** Source classes the release-health metric counts separately (#6173 R2). */
export const RELEASE_HEALTH_SOURCE_CLASSES = [
  "server",
  "cli",
  "client",
] as const;
export type ReleaseHealthSourceClass =
  (typeof RELEASE_HEALTH_SOURCE_CLASSES)[number];

/**
 * Error-log categories that never count against a release (#6173 R2): failures
 * a session reports from outside the app (`api-error`, `tool-error`,
 * `prompt-blocked`) and an operational watchdog.
 */
export const RELEASE_HEALTH_EXCLUDED_CATEGORIES = [
  "api-error",
  "tool-error",
  "prompt-blocked",
  "slice-pressure-watchdog",
] as const;

/** A version the route accepts: a release or a local test build (`-AA`). */
export const RELEASE_HEALTH_VERSION_PATTERN = /^\d+\.\d+\.\d+(-[A-Z]{1,2})?$/;

/**
 * Matt's M5 ruling (2026-11-07) and the uptime floor. An error-minute rise in a
 * source class needs a rate above `riseFactor` times the baseline's AND at
 * least `minExcessErrorMinutes` more error-minutes over the candidate's uptime;
 * unclean restarts or flood events per day above the baseline's are a rise with
 * no factor or excess. Either side under `minUptimeHours` is
 * `insufficient-data`.
 */
export const RELEASE_HEALTH_THRESHOLDS = {
  minUptimeHours: 24,
  riseFactor: 1.5,
  minExcessErrorMinutes: 10,
} as const;
export type ReleaseHealthThresholds = {
  minUptimeHours: number;
  riseFactor: number;
  minExcessErrorMinutes: number;
};

/**
 * Default and maximum look-back (whole days). The maximum is `error_logs`'s
 * retention (`ERROR_LOG_RETENTION_DAYS`, 30), not the segments' 35 days: past
 * it a version's uptime would count while its error rows were already deleted,
 * which would understate an old baseline's rate. A server test pins the two.
 */
export const RELEASE_HEALTH_DEFAULT_SINCE_DAYS = 30;
export const RELEASE_HEALTH_MAX_SINCE_DAYS = 30;

export const RELEASE_HEALTH_VERDICTS = [
  "rise",
  "no-rise",
  "insufficient-data",
] as const;
export type ReleaseHealthVerdict = (typeof RELEASE_HEALTH_VERDICTS)[number];

const ReleaseHealthByClassSchema = z
  .object({ server: z.number(), cli: z.number(), client: z.number() })
  .passthrough();

/** One app version's health on this node over the window. */
export const ReleaseHealthVersionSchema = z
  .object({
    version: z.string(),
    /** This server process is running the version now. */
    live: z.boolean(),
    segments: z.number(),
    /** Start of its earliest recorded segment (epoch ms). */
    firstStartedMs: z.number(),
    lastSeenMs: z.number(),
    uptimeHours: z.number(),
    /** Segments of this version left open and followed by the same version. */
    uncleanRestarts: z.number(),
    uncleanRestartsPerDay: z.number(),
    /** Rate-limit summary rows among its counted `error`/`fatal` rows. */
    floodEvents: z.number(),
    floodEventsPerDay: z.number(),
    /** Distinct minutes holding at least one counted row, per source class. */
    errorMinutes: ReleaseHealthByClassSchema,
    errorMinutesPerHour: ReleaseHealthByClassSchema,
  })
  .passthrough();
export type ReleaseHealthVersion = z.infer<typeof ReleaseHealthVersionSchema>;

/** The candidate-vs-baseline verdict (#6173 R3). */
export const ReleaseHealthComparisonSchema = z
  .object({
    candidate: z.string(),
    baseline: z.string(),
    verdict: z.enum(RELEASE_HEALTH_VERDICTS),
    /** Which side is under the uptime floor, when the verdict is insufficient-data. */
    insufficient: z.enum(["candidate", "baseline", "both"]).nullable(),
    reasons: z.array(z.string()),
  })
  .passthrough();
export type ReleaseHealthComparison = z.infer<
  typeof ReleaseHealthComparisonSchema
>;

/** `GET /api/telemetry/throughput/release-health` (#6173 R2, R3). */
export const ThroughputReleaseHealthResponseSchema = z
  .object({
    generatedAtMs: z.number(),
    sinceMs: z.number(),
    /** The version this server is running. */
    nodeVersion: z.string(),
    versions: z.array(ReleaseHealthVersionSchema),
    /** Counted error-minutes that fall in no recorded segment. */
    unattributedErrorMinutes: z.number(),
    thresholds: z
      .object({
        minUptimeHours: z.number(),
        riseFactor: z.number(),
        minExcessErrorMinutes: z.number(),
      })
      .passthrough(),
    comparison: ReleaseHealthComparisonSchema.nullable(),
  })
  .passthrough();
export type ThroughputReleaseHealthResponse = z.infer<
  typeof ThroughputReleaseHealthResponseSchema
>;

// ───────────────────────────── pure helpers ─────────────────────────────

/**
 * Canonical JSON: object keys sorted, no whitespace, `undefined` members
 * omitted, non-finite numbers as `null`. Two equal values always serialize
 * to the same string, so `throughput_json IS NOT @json` detects real changes.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value)) ?? "null";
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) return null;
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(v => (v === undefined ? null : sortValue(v)));
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v !== undefined) out[key] = sortValue(v);
  }
  return out;
}

/** UTF-8 byte length of a string (web-safe; no `Buffer`). */
export function utf8ByteLength(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1; // the low surrogate is part of this code point
    } else bytes += 3;
  }
  return bytes;
}

/** Histogram bin index for an occupancy (`floor(tokens / bin)`, never negative). */
export function binIndexFor(
  tokens: number,
  bin: number = CONTEXT_BIN_TOKENS
): number {
  if (!Number.isFinite(tokens) || tokens <= 0 || bin <= 0) return 0;
  return Math.floor(tokens / bin);
}

/** Sum two sparse histograms (`{ binIndex: count }`) into a new one. */
export function mergeHistograms(
  a: Readonly<Record<string, number>> | null | undefined,
  b: Readonly<Record<string, number>> | null | undefined
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const src of [a, b]) {
    if (!src) continue;
    for (const [key, n] of Object.entries(src)) {
      if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) continue;
      out[key] = (out[key] ?? 0) + n;
    }
  }
  return out;
}

/**
 * The value at percentile `p` (0–100) of a sparse histogram, as the midpoint of
 * the bin it falls in (tokens), or null when the histogram is empty. Exact to
 * within one bin of the value a sorted list would give.
 */
export function percentileFromHistogram(
  hist: Readonly<Record<string, number>> | null | undefined,
  p: number,
  bin: number = CONTEXT_BIN_TOKENS
): number | null {
  if (!hist) return null;
  const bins = Object.entries(hist)
    .map(([k, n]) => [Number(k), n] as const)
    .filter(([k, n]) => Number.isFinite(k) && n > 0)
    .sort((x, y) => x[0] - y[0]);
  const total = bins.reduce((sum, [, n]) => sum + n, 0);
  if (total === 0) return null;
  const clamped = Math.min(100, Math.max(0, p));
  // Nearest-rank: the smallest bin whose cumulative count reaches the rank.
  const rank = Math.max(1, Math.ceil((clamped / 100) * total));
  let seen = 0;
  for (const [k, n] of bins) {
    seen += n;
    if (seen >= rank) return (k + 0.5) * bin;
  }
  const last = bins[bins.length - 1]!;
  return (last[0] + 0.5) * bin;
}

/** Histogram count. */
export function histogramCount(
  hist: Readonly<Record<string, number>> | null | undefined
): number {
  if (!hist) return 0;
  let n = 0;
  for (const v of Object.values(hist)) if (v > 0) n += v;
  return n;
}

/** Percentiles (p50 / p90 / p99) of a sparse histogram. */
export function histogramPercentiles(
  hist: Readonly<Record<string, number>> | null | undefined,
  bin: number = CONTEXT_BIN_TOKENS
): ThroughputPercentiles {
  return {
    n: histogramCount(hist),
    p50: percentileFromHistogram(hist, 50, bin),
    p90: percentileFromHistogram(hist, 90, bin),
    p99: percentileFromHistogram(hist, 99, bin),
  };
}

/** Re-bin a histogram from bin width `from` to a coarser width `to`. */
export function rebinHistogram(
  hist: Readonly<Record<string, number>>,
  from: number,
  to: number
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, n] of Object.entries(hist)) {
    const idx = Math.floor((Number(key) * from) / to);
    out[String(idx)] = (out[String(idx)] ?? 0) + n;
  }
  return out;
}

/** An all-zero token line. */
export function emptyThroughputTokens(): ThroughputTokens {
  return { in: 0, out: 0, cr: 0, w1: 0, w5: 0, wu: 0 };
}

/** An all-zero cost line. */
export function emptyThroughputCost(): ThroughputCost {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    write1h: 0,
    write5m: 0,
    writeUnknown: 0,
    total: 0,
    fallback: 0,
  };
}

/** Cache-served share of input: `cr / (in + w1 + w5 + wu + cr)`; null on zero. */
export function cacheServedShare(t: ThroughputTokens): number | null {
  const denom = t.in + t.w1 + t.w5 + t.wu + t.cr;
  return denom > 0 ? t.cr / denom : null;
}

/** Whole-UTC-day window: `[floor(from), ceil(to))`, at most `maxDays` long. */
export function snapToUtcDays(
  fromMs: number,
  toMs: number,
  maxDays: number = SUMMARY_MAX_WINDOW_DAYS
): ThroughputWindow {
  const DAY = 86_400_000;
  const to = Math.ceil(toMs / DAY) * DAY;
  let from = Math.floor(Math.min(fromMs, toMs) / DAY) * DAY;
  if (to - from > maxDays * DAY) from = to - maxDays * DAY;
  if (to === from) from = to - DAY;
  return { fromMs: from, toMs: to, days: Math.round((to - from) / DAY) };
}

/** `YYYY-MM-DD` of a ms timestamp in UTC. */
export function utcDayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
