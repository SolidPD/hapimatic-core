// SPDX-License-Identifier: AGPL-3.0-only
import {
  DEFAULT_LANE_POINTS,
  ESCAPE_WINDOW_MS,
  ISSUE_CSV_COLUMNS,
  ISSUE_CSV_EXTRA_COLUMNS,
  type IssueFactsRow,
} from "@hapi/protocol";
import type {
  CiRunRecord,
  FollowUpRef,
  IssueFactsRecord,
  PrRecord,
} from "../../store/throughput/githubStore";
import type {
  IssueListItem,
  PullFile,
  PullListItem,
  TimelineEvent,
} from "./timeline";

/**
 * Per-issue delivery facts (issue #6164, A1 — R6).
 *
 * Collection side: {@link buildIssueRecord} turns an issue and its COMPLETE
 * timeline into the stored record — checkpoint milestones (first time each
 * checkpoint label was added), every close and reopen, lane history from a
 * configurable label pattern, complexity, and the follow-up issues that
 * cross-reference it. {@link issuesOfPull} and {@link summarizePullFiles} map
 * a merged PR to its issues and its code / test / doc lines.
 *
 * Read side: {@link deriveIssueRow} computes lead and stage hours, escapes
 * (a reopen, or an escape-pattern follow-up created, within 14 days of a
 * close), lanes, points and the lane-backtest columns, so a change to one of
 * those rules needs no re-collection. The checkpoint stages, the lane pattern
 * and the escape pattern are applied at collection: a change to them does.
 *
 * Ports the census (`lanes-github-v1.py`, `lanes-backtest-v1.py`): checkpoint
 * labels match when the label ends with the stage suffix and contains
 * "checkpoint"; files classify with the backtest's TEST / DOC / GEN rules; a
 * danger file is a code file containing a danger path. Deviation: an issue's
 * CI failures are DISTINCT failed runs (by PR, or by an `issue-N` branch); the
 * census summed both and counted a PR run twice.
 */

export interface CheckpointStage {
  stage: string;
  /** The label ends with this (variation selectors ignored). */
  suffix: string;
}

/** The canonical checkpoint labels (`✅ checkpoint: <suffix>`). */
export const DEFAULT_CHECKPOINTS: readonly CheckpointStage[] = [
  { stage: "created", suffix: "✨ created" },
  { stage: "formatted", suffix: "📊 formatted" },
  { stage: "researched", suffix: "📝 researched" },
  { stage: "expert", suffix: "🧠 expert-reviewed" },
  { stage: "worked", suffix: "🔨 worked" },
  { stage: "tested", suffix: "🧪 tested" },
  { stage: "reflected", suffix: "👁️ refactor-reflected" },
];

/** Lane labels (rp1-home#2878 has not fixed the wording yet). */
export const DEFAULT_LANE_PATTERN = "lane:\\s*\\S*\\s*(fast|normal|hard)\\s*$";

/**
 * The census's danger paths (2026-11-02): the paths in
 * `claudedocs/init-project/danger-map.md` plus the census's own additions. A
 * code file is a danger file when its path contains one of them.
 */
export const DEFAULT_DANGER_PATHS: readonly string[] = [
  ".claude/hooks/check-approval-sentinel.sh",
  ".github/workflows/",
  "cli/src/claude/accountTokenInjection",
  "cli/src/daemon/",
  "gateway/",
  "scripts/deploy-federation-nodes.sh",
  "scripts/deploy-local.sh",
  "scripts/deprovision",
  "scripts/provision",
  "server/src/federation/",
  "server/src/store/",
  "server/src/sync/",
  "server/src/web/routes/auth",
  "server/src/web/routes/federation.ts",
  "shared/src/",
];

/** Escape follow-ups: the title/body names a regression or a follow-up. */
export const ESCAPE_PATTERN =
  /regress|introduced by|broke|caused by|follow-?up/i;
const REGRESSION_PATTERN = /regress|introduced by|broke|caused by/i;
const SINK_PATTERN = /sink|review/i;
const CLOSING_KEYWORD =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi;
const BRANCH_ISSUE = /(?:^|\/)issue-(\d+)(?:-|$)/;
const ISSUE_IN_BRANCH = /issue-(\d+)/;
const TITLE_TYPE = /^\w+/;
const MAX_LABEL_CHARS = 100;
const MAX_CODE_PATHS = 300;

export interface IssueVocabulary {
  checkpoints: readonly CheckpointStage[];
  lanePattern: RegExp;
  dangerPaths: readonly string[];
  points: Readonly<Record<string, number>>;
}

/** Compile a configured lane pattern (case-insensitive); null if invalid. */
export function compileLanePattern(source: string): RegExp | null {
  try {
    return new RegExp(source, "i");
  } catch {
    return null;
  }
}

export function defaultVocabulary(): IssueVocabulary {
  return {
    checkpoints: DEFAULT_CHECKPOINTS,
    lanePattern: compileLanePattern(DEFAULT_LANE_PATTERN)!,
    dangerPaths: DEFAULT_DANGER_PATHS,
    points: DEFAULT_LANE_POINTS,
  };
}

function normalizeLabel(label: string): string {
  return label.replaceAll("\ufe0f", "").trim();
}

/** The checkpoint stage a label marks, or null. */
export function checkpointStageOf(
  label: string,
  checkpoints: readonly CheckpointStage[]
): string | null {
  const name = normalizeLabel(label);
  if (!name.includes("checkpoint")) return null;
  for (const c of checkpoints) {
    if (name.endsWith(normalizeLabel(c.suffix))) return c.stage;
  }
  return null;
}

/** The lane a label names (lower-cased), or null. */
export function laneOfLabel(label: string, pattern: RegExp): string | null {
  if (label.length > MAX_LABEL_CHARS) return null;
  const m = normalizeLabel(label).match(pattern);
  return m?.[1] ? m[1].toLowerCase() : null;
}

/** `🧩 complexity: 🟨 medium` → `medium`. */
export function complexityOfLabels(labels: readonly string[]): string | null {
  for (const label of labels) {
    const at = label.indexOf("complexity:");
    if (at < 0) continue;
    const words = label
      .slice(at + "complexity:".length)
      .trim()
      .split(/\s+/);
    const last = words[words.length - 1]?.toLowerCase();
    if (last) return last;
  }
  return null;
}

/** The lane in force at `atMs` (history is `[atMs, lane]`, oldest first). */
export function laneAt(
  history: ReadonlyArray<readonly [number, string | null]>,
  atMs: number | null
): string | null {
  let lane: string | null = null;
  for (const [t, l] of history) {
    if (atMs !== null && t > atMs) break;
    lane = l;
  }
  return lane;
}

/**
 * The stored record for one issue from its list entry and COMPLETE timeline.
 * `etag` is kept only for a one-page timeline (a later page can change while
 * page 1's ETag stays the same).
 */
export function buildIssueRecord(input: {
  repo: string;
  item: IssueListItem;
  events: readonly TimelineEvent[];
  etag: string | null;
  vocab: IssueVocabulary;
  nowMs: number;
}): IssueFactsRecord {
  const { repo, item, vocab } = input;
  const events = [...input.events].sort(
    (a, b) => (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0)
  );
  const milestones: Record<string, number> = {};
  const reopenTimes: number[] = [];
  const closeTimes: number[] = [];
  const laneHistory: Array<[number, string | null]> = [];
  // Lane labels currently applied, oldest application first.
  const applied: Array<{ label: string; lane: string }> = [];
  let current: string | null = null;
  const followUps = new Map<string, FollowUpRef>();

  for (const e of events) {
    const t = e.createdAtMs;
    if (e.event === "labeled" && e.label !== undefined) {
      const stage = checkpointStageOf(e.label, vocab.checkpoints);
      if (stage && t !== null && !(milestones[stage]! <= t)) {
        milestones[stage] = t;
      }
      const lane = laneOfLabel(e.label, vocab.lanePattern);
      if (lane !== null) {
        const i = applied.findIndex(a => a.label === e.label);
        if (i >= 0) applied.splice(i, 1);
        applied.push({ label: e.label, lane });
      }
    } else if (e.event === "unlabeled" && e.label !== undefined) {
      const i = applied.findIndex(a => a.label === e.label);
      if (i >= 0) applied.splice(i, 1);
    } else if (e.event === "reopened" && t !== null) {
      reopenTimes.push(t);
    } else if (e.event === "closed" && t !== null) {
      closeTimes.push(t);
    } else if (e.event === "cross-referenced" && e.source) {
      const src = e.source;
      const self = src.repo === repo && src.number === item.number;
      if (!src.isPullRequest && !self) {
        const text = `${src.title}\n${src.body}`;
        const ref: FollowUpRef = {
          repo: src.repo,
          number: src.number,
          createdAtMs: src.createdAtMs,
          regression: REGRESSION_PATTERN.test(text),
          escape: ESCAPE_PATTERN.test(text),
          sink: SINK_PATTERN.test(src.title),
        };
        if (ref.escape || ref.sink)
          followUps.set(`${src.repo}#${src.number}`, ref);
      }
    }
    const effective = applied.length ? applied[applied.length - 1]!.lane : null;
    if (effective !== current && t !== null) {
      laneHistory.push([t, effective]);
      current = effective;
    }
  }

  let lane = laneAt(
    laneHistory,
    item.state === "CLOSED" ? item.closedAtMs : null
  );
  let laneFirst = laneHistory.find(([, l]) => l !== null)?.[1] ?? null;
  if (laneHistory.length === 0) {
    // No lane events: fall back to a lane label on the issue now.
    for (const label of item.labels) {
      const l = laneOfLabel(label, vocab.lanePattern);
      if (l) {
        lane = l;
        laneFirst = l;
      }
    }
  }
  if (closeTimes.length === 0 && item.closedAtMs !== null) {
    closeTimes.push(item.closedAtMs);
  }

  return {
    repo,
    number: item.number,
    title: item.title,
    state: item.state,
    stateReason: item.stateReason,
    createdAtMs: item.createdAtMs,
    closedAtMs: item.closedAtMs,
    updatedAtMs: item.updatedAtMs,
    labels: item.labels,
    milestones,
    lane,
    laneFirst,
    laneHistory,
    complexity: complexityOfLabels(item.labels),
    reopens: reopenTimes.length,
    reopenTimes,
    closeTimes,
    followUps: [...followUps.values()],
    timelineEtag: input.etag,
    events: events.length,
    fetchedAtMs: input.nowMs,
  };
}

// ─────────────────────────── pull requests ───────────────────────────

/** The issues a merged PR delivers: an `issue-N-…` head branch, or a closing keyword. */
export function issuesOfPull(
  pull: Pick<PullListItem, "headRef" | "title" | "body">
): number[] {
  const out = new Set<number>();
  const branch = pull.headRef?.match(BRANCH_ISSUE);
  if (branch) out.add(Number(branch[1]));
  for (const m of `${pull.title}\n${pull.body}`.matchAll(CLOSING_KEYWORD)) {
    out.add(Number(m[1]));
  }
  return [...out].sort((a, b) => a - b);
}

function basename(path: string): string {
  const at = path.lastIndexOf("/");
  return at >= 0 ? path.slice(at + 1) : path;
}

/** The backtest's TEST rule. */
export function isTestPath(p: string): boolean {
  const base = basename(p);
  return (
    p.endsWith(".test.ts") ||
    p.endsWith(".test.tsx") ||
    p.endsWith(".test.js") ||
    p.includes("/test/") ||
    p.includes("/tests/") ||
    p.includes("__tests__") ||
    (p.includes("/") && base.startsWith("test-") && base.endsWith(".sh")) ||
    (base.startsWith("test_") && base.endsWith(".py")) ||
    p.endsWith("_test.py")
  );
}

/** The backtest's DOC rule. */
export function isDocPath(p: string): boolean {
  return (
    p.startsWith("docs/") ||
    p.startsWith("claudedocs/") ||
    p.endsWith(".md") ||
    p.startsWith("sbom/") ||
    p.includes("THIRD-PARTY") ||
    p.endsWith(".html")
  );
}

/** The backtest's GEN rule. */
export function isGeneratedPath(p: string): boolean {
  return (
    p.endsWith(".generated.ts") ||
    p.endsWith("bun.lock") ||
    p === "package.json"
  );
}

export function isDangerPath(
  p: string,
  dangerPaths: readonly string[]
): boolean {
  return dangerPaths.some(d => {
    let end = d.length;
    while (end > 0 && d[end - 1] === "*") end -= 1; // the census's rstrip('*')
    return end > 0 && p.includes(d.slice(0, end));
  });
}

/** Line and file counts of one PR (issue assets skipped, as in the census). */
export function summarizePullFiles(files: readonly PullFile[]): {
  codeLines: number;
  testLines: number;
  docLines: number;
  codeFiles: number;
  codePaths: string[];
} {
  let codeLines = 0;
  let testLines = 0;
  let docLines = 0;
  const codePaths = new Set<string>();
  for (const f of files) {
    if (f.filename.startsWith(".github/issue-assets/")) continue;
    const test = isTestPath(f.filename);
    const doc = isDocPath(f.filename);
    if (test) testLines += f.changes;
    if (doc) docLines += f.changes;
    if (!test && !doc && !isGeneratedPath(f.filename)) {
      codeLines += f.changes;
      codePaths.add(f.filename);
    }
  }
  return {
    codeLines,
    testLines,
    docLines,
    codeFiles: codePaths.size,
    codePaths: [...codePaths].sort().slice(0, MAX_CODE_PATHS),
  };
}

// ─────────────────────────── read side ───────────────────────────

const HOUR_MS = 3_600_000;

function hours(
  from: number | undefined | null,
  to: number | undefined | null
): number | null {
  return typeof from === "number" && typeof to === "number"
    ? (to - from) / HOUR_MS
    : null;
}

/** Stage spans: [name, from, to] over milestones plus `opened` / `closed`. */
export const STAGE_SPANS: ReadonlyArray<readonly [string, string, string]> = [
  ["lead", "opened", "closed"],
  ["to_research", "opened", "researched"],
  ["research_to_work", "researched", "worked"],
  ["expert", "researched", "expert"],
  ["work_to_test", "worked", "tested"],
  ["test_to_reflect", "tested", "reflected"],
  ["reflect_to_close", "reflected", "closed"],
];

/** Hours per stage span (null where a milestone is missing). */
export function stageHours(
  rec: IssueFactsRecord
): Record<string, number | null> {
  const at = (key: string): number | null =>
    key === "opened"
      ? rec.createdAtMs
      : key === "closed"
        ? rec.closedAtMs
        : (rec.milestones[key] ?? null);
  const out: Record<string, number | null> = {};
  for (const [name, from, to] of STAGE_SPANS) {
    out[name] = hours(at(from), at(to));
  }
  return out;
}

/** The close in force at `atMs`: the latest close at or before it. */
function closeBefore(closes: readonly number[], atMs: number): number | null {
  let found: number | null = null;
  for (const c of closes)
    if (c <= atMs && (found === null || c > found)) found = c;
  return found;
}

/**
 * Escapes: a reopen within `windowMs` of the close before it, and escape-pattern
 * follow-up issues created within `windowMs` after a close.
 */
export function escapesOf(
  rec: IssueFactsRecord,
  windowMs = ESCAPE_WINDOW_MS
): { count: number; reopens: number; refs: string[] } {
  const closes = rec.closeTimes.length
    ? rec.closeTimes
    : rec.closedAtMs !== null
      ? [rec.closedAtMs]
      : [];
  let reopens = 0;
  for (const r of rec.reopenTimes) {
    const c = closeBefore(closes, r);
    if (c !== null && r - c <= windowMs) reopens += 1;
  }
  const refs: string[] = [];
  for (const f of rec.followUps) {
    if (!f.escape || f.createdAtMs === null) continue;
    const c = closeBefore(closes, f.createdAtMs);
    if (c !== null && f.createdAtMs - c <= windowMs) {
      refs.push(`${f.repo}#${f.number}`);
    }
  }
  return { count: reopens + refs.length, reopens, refs };
}

/** `owner/repo#N` → the backtest key `repo#N`. */
export function backtestKey(repo: string, number: number): string {
  return `${repo.slice(repo.lastIndexOf("/") + 1)}#${number}`;
}

/** The ledger's issue key (`owner/repo#N`, as the rollups store it). */
export function ledgerIssueKey(repo: string, number: number): string {
  return `${repo}#${number}`;
}

/** The title's first word, lower-cased (the backtest's `type`). */
export function issueTypeOf(title: string): string | null {
  return title.match(TITLE_TYPE)?.[0].toLowerCase() ?? null;
}

/** Distinct failed runs per issue: by its PRs, or by an `issue-N` branch. */
export function ciFailuresByIssue(
  runs: readonly CiRunRecord[],
  prsByIssue: ReadonlyMap<number, readonly number[]>
): Map<number, number> {
  const failedByPr = new Map<number, Set<number>>();
  const failedByBranch = new Map<number, Set<number>>();
  for (const run of runs) {
    if (run.conclusion !== "failure") continue;
    for (const pr of run.prNumbers) {
      let s = failedByPr.get(pr);
      if (!s) failedByPr.set(pr, (s = new Set()));
      s.add(run.runId);
    }
    const m = run.headBranch?.match(ISSUE_IN_BRANCH);
    if (m) {
      const n = Number(m[1]);
      let s = failedByBranch.get(n);
      if (!s) failedByBranch.set(n, (s = new Set()));
      s.add(run.runId);
    }
  }
  const out = new Map<number, number>();
  for (const [issue, prs] of prsByIssue) {
    const ids = new Set<number>(failedByBranch.get(issue) ?? []);
    for (const pr of prs)
      for (const id of failedByPr.get(pr) ?? []) ids.add(id);
    out.set(issue, ids.size);
  }
  return out;
}

export interface IssueRowInputs {
  rec: IssueFactsRecord;
  prs: readonly PrRecord[];
  ciFailures: number;
  vocab: IssueVocabulary;
  cost: { usd: number; turns: number } | null;
  /** The worker stage's dominant effort, when the facts know it. */
  workerEffort?: string | null;
}

/** The backtest's ex-post lane (`lane_post`; loose = 300 lines / 6 files). */
export function lanePost(
  row: {
    prs: number;
    codeLines: number | null;
    codeFiles: number | null;
    dangerFiles: number | null;
    ciFailures: number;
    reopens: number;
    regress: number;
  },
  fastLines = 150,
  fastFiles = 4
): string | null {
  if (row.prs === 0) return "no-code";
  if (
    row.codeLines === null ||
    row.codeFiles === null ||
    row.dangerFiles === null
  ) {
    return null; // file stats not fetched yet
  }
  const problems =
    row.ciFailures > 0 || row.reopens > 0 || row.regress > 0 || row.prs > 1;
  if (
    row.dangerFiles === 0 &&
    row.codeLines <= fastLines &&
    row.codeFiles <= fastFiles &&
    !problems
  ) {
    return "fast";
  }
  if (
    (row.dangerFiles > 0 && row.codeLines > 300) ||
    row.codeLines > 1200 ||
    row.prs >= 3 ||
    row.regress > 0 ||
    row.reopens > 0
  ) {
    return "hard";
  }
  return "normal";
}

/** The per-issue row (JSON route, CSV, digest and report CLI). */
export function deriveIssueRow(input: IssueRowInputs): IssueFactsRow & {
  regress: number;
  sinks: number;
  lanePost: string | null;
  lanePostLoose: string | null;
  workerEffort: string | null;
} {
  const { rec, prs, vocab } = input;
  const merged = prs.filter(p => p.mergedAtMs !== null);
  const fetched = merged.every(p => p.filesFetched);
  const codePaths = new Set<string>();
  let codeLines = 0;
  let testLines = 0;
  let docLines = 0;
  for (const p of merged) {
    codeLines += p.codeLines ?? 0;
    testLines += p.testLines ?? 0;
    docLines += p.docLines ?? 0;
    for (const path of p.codePaths ?? []) codePaths.add(path);
  }
  const danger = [...codePaths].filter(p => isDangerPath(p, vocab.dangerPaths));
  const spans = stageHours(rec);
  const escapes = escapesOf(rec);
  const regress = rec.followUps.filter(f => f.regression).length;
  const sinks = rec.followUps.filter(f => f.sink).length;
  const lane = rec.lane;
  const points =
    lane !== null && rec.stateReason === "COMPLETED"
      ? (vocab.points[lane] ?? null)
      : null;
  const facts = {
    prs: merged.length,
    codeLines: fetched ? codeLines : null,
    codeFiles: fetched ? codePaths.size : null,
    dangerFiles: fetched ? danger.length : null,
    ciFailures: input.ciFailures,
    reopens: rec.reopens,
    regress,
  };
  return {
    repo: rec.repo,
    number: rec.number,
    key: backtestKey(rec.repo, rec.number),
    title: rec.title,
    type: issueTypeOf(rec.title),
    state: rec.state,
    stateReason: rec.stateReason,
    createdAtMs: rec.createdAtMs,
    closedAtMs: rec.closedAtMs,
    complexity: rec.complexity,
    milestones: rec.milestones,
    leadHours: spans.lead ?? null,
    expertHours: spans.expert ?? null,
    reopens: rec.reopens,
    escapes: escapes.count,
    escapeRefs: escapes.refs,
    expert: rec.milestones.expert !== undefined,
    prs: merged.map(p => p.number),
    ciFailures: input.ciFailures,
    codeLines: facts.codeLines,
    testLines: fetched ? testLines : null,
    docLines: fetched ? docLines : null,
    codeFiles: facts.codeFiles,
    dangerFiles: facts.dangerFiles,
    lane,
    laneFirst: rec.laneFirst,
    points,
    costUsd: input.cost ? input.cost.usd : null,
    turns: input.cost ? input.cost.turns : null,
    regress,
    sinks,
    lanePost: lanePost(facts),
    lanePostLoose: lanePost(facts, 300, 6),
    workerEffort: input.workerEffort ?? null,
  };
}

/** A number as the census wrote it: integers bare, else up to 2 decimals. */
function num(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "";
  return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(2)));
}

function csvCell(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;
}

/** The first 90 code points (the census's `title[:90]`). */
function title90(title: string): string {
  return Array.from(title).slice(0, 90).join("");
}

/**
 * One CSV line: the backtest's 28 columns in order, then the extras. Columns
 * A1 cannot compute (directive metadata: `lane_pre`, `confidence`,
 * `task_count`, `planned_files`, `planned_danger`, `refresh`, `directives`)
 * are left empty, never invented.
 */
export function issueCsvLine(row: ReturnType<typeof deriveIssueRow>): string {
  const values: Record<string, string> = {
    key: row.key,
    title: title90(row.title),
    type: row.type ?? "",
    lane_post: row.lanePost ?? "",
    lane_post_loose: row.lanePostLoose ?? "",
    lane_pre: "",
    complexity: row.complexity ?? "",
    confidence: "",
    task_count: "",
    planned_files: "",
    planned_danger: "",
    code_lines: num(row.codeLines),
    test_lines: num(row.testLines),
    doc_lines: num(row.docLines),
    code_files: num(row.codeFiles),
    danger_files: num(row.dangerFiles),
    prs: String(row.prs.length),
    ci_fail: String(row.ciFailures),
    reopens: String(row.reopens),
    regress: String(row.regress),
    sinks: String(row.sinks),
    expert: row.expert ? "True" : "False",
    refresh: "",
    directives: "",
    lead_h: num(row.leadHours),
    expert_h: num(row.expertHours),
    total_usd: num(row.costUsd),
    worker_effort: row.workerEffort ?? "",
    repo: row.repo,
    number: String(row.number),
    closed_at:
      row.closedAtMs !== null ? new Date(row.closedAtMs).toISOString() : "",
    lane_label_first: row.laneFirst ?? "",
    points: num(row.points),
    turns: num(row.turns),
  };
  return [...ISSUE_CSV_COLUMNS, ...ISSUE_CSV_EXTRA_COLUMNS]
    .map(c => csvCell(values[c] ?? ""))
    .join(",");
}

/** The CSV header line. */
export function issueCsvHeader(): string {
  return [...ISSUE_CSV_COLUMNS, ...ISSUE_CSV_EXTRA_COLUMNS].join(",");
}
