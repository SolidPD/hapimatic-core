// SPDX-License-Identifier: AGPL-3.0-only
import type { CiRunRecord } from "../../store/throughput/githubStore";
import {
  bunFailUnit,
  endsShellSuite,
  isFailMarker,
  shellSuiteStart,
  suiteFailed,
  summaryVerdict,
  type SuiteState,
} from "../testRuns";
import type { GithubClient, StreamResult } from "./client";

/**
 * CI runs, failed-job logs and per-test catches (issue #6164, A1 — R6).
 *
 * {@link CiLogParser} ports the census's `ci-catch-v3.py` (#6182, which
 * replaced v2's shell attribution):
 *   - shell suites, judged by their own summary (the rule `testRuns.ts`
 *     shares): a non-zero failed count fails the suite, and a zero count
 *     passes it whatever `❌` / `FAIL` lines it printed (a suite that tests a
 *     checker prints that checker's failures on purpose). FAIL / ✗ / ❌ /
 *     "not ok" markers count only when the suite printed no summary
 *     → `shell:<suite basename>`;
 *   - vitest `FAIL` / `×` / `✗` + a `.test.ts(x)` path → `test:<path>`;
 *   - bun `(fail) <name>` → `bun:<name>` (the agent-run rule, shared);
 *   - ESLint: a lone file-path line, then `L:C  error` → `eslint:<file>`;
 *   - a repo check that failed in the lint step: bun's
 *     `error: script "check:x" exited with code N` or the check's own
 *     `check-x: ERROR` / `check-x: N violations` line → `lint:check-x`;
 *   - `file.ts(L,C): error TSnnnn` → `tsc:<file>`.
 * Unit ids share the agent-run vocabulary of `testRuns.ts`, and the existing
 * ones stay as they are (board-26 PM ruling, 2026-11-03); v3's `bunfile:` and
 * `prettier:` units are not added.
 *
 * Suites: `scripts/run-shell-tests.sh` prints `== <suite>.sh ==` before it
 * runs one and `== SKIP <suite>.sh — … ==` for one it skips. Only
 * `== test-*.sh ==` starts a suite; `== SKIP …`, the runner's closing
 * `run-shell-tests: ran …` line and a new step (`##[group]Run `) end it.
 * (`ci-catch-v2.py` matched only the SKIP form and credited every shell
 * failure to the last skipped suite.) Step labels inside the log are never
 * read: `gh run view --log-failed` prints most of them as `UNKNOWN STEP`.
 *
 * Families: a whole failed job's log is read, so a unit counts only when a
 * step of its kind failed in that job, by the jobs API's failed steps
 * ({@link familyGates}, v3's `gates`): `shell` for `shell:`, `test` for
 * `test:` / `bun:` / `tsc:`, `lint` for `eslint:` / `lint:`. Every pattern
 * runs on one line capped at {@link MAX_LINE_CHARS} and is linear.
 */

export interface CiRunItem {
  runId: number;
  workflow: string | null;
  event: string | null;
  headBranch: string | null;
  headSha: string | null;
  status: string | null;
  conclusion: string | null;
  createdAtMs: number | null;
  updatedAtMs: number | null;
  prNumbers: number[];
}

/** Job logs stream with this cap (4.6). */
export const LOG_MAX_BYTES = 20 * 1024 * 1024;
const MAX_LINE_CHARS = 4_000;
/** Job conclusions whose logs are parsed. */
const FAILED_JOB_CONCLUSIONS = new Set(["failure", "timed_out"]);

const LOG_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;
const ESLINT_ERROR = /\s\d+:\d+\s+error\s/;
const LINE_COL = /^\d+,\d+$/;
const STEP_START = "##[group]Run ";
const BUN_SCRIPT_FAILED = 'error: script "check:';
const CHECK_NAME = /^[\w:.-]+$/;
const CHECK_TOKEN = /^[\w-]+$/;
const CHECK_VERSION_SUFFIX = /-v\d+$/;
const CHECK_VIOLATIONS = /^[1-9]\d* violation/;
const WORD_CHAR = /\w/;

/**
 * The check a lint-step line names as failed (`ci-catch-v3.py`'s
 * `LINT_CHECK`), with `:` as `-`, or null: bun's
 * `error: script "check:x" exited with code N` (N > 0), or the check's own
 * `check-x[-vN]: ERROR …` / `check-x[-vN]: N violations` line (a check that
 * crashes exits 2 and prints no bun line).
 */
export function lintCheckOf(trimmed: string): string | null {
  if (trimmed.startsWith(BUN_SCRIPT_FAILED)) {
    const from = BUN_SCRIPT_FAILED.length;
    const quote = trimmed.indexOf('"', from);
    if (quote <= from) return null;
    const name = trimmed.slice(from, quote);
    const rest = trimmed.slice(quote + 1);
    const code = rest[" exited with code ".length];
    if (
      CHECK_NAME.test(name) &&
      rest.startsWith(" exited with code ") &&
      code !== undefined &&
      code >= "1" &&
      code <= "9"
    ) {
      return name.replaceAll(":", "-");
    }
    return null;
  }
  if (!trimmed.startsWith("check-")) return null;
  const colon = trimmed.indexOf(": ");
  if (colon <= "check-".length) return null;
  const token = trimmed.slice("check-".length, colon);
  if (!CHECK_TOKEN.test(token)) return null;
  const after = trimmed.slice(colon + 2);
  const error =
    after.startsWith("ERROR") && !WORD_CHAR.test(after["ERROR".length] ?? "");
  if (!error && !CHECK_VIOLATIONS.test(after)) return null;
  const name = token.replace(CHECK_VERSION_SUFFIX, "");
  return (name === "" ? token : name).replaceAll(":", "-");
}

function ms(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** The path relative to the checkout (drop `/home/runner/work/<repo>/<repo>/`). */
function repoRelative(path: string): string {
  const prefix = "/home/runner/work/";
  if (!path.startsWith(prefix)) return path;
  const parts = path.slice(prefix.length).split("/");
  return parts.length > 2 ? parts.slice(2).join("/") : path;
}

/** The census's `\S+\.test\.tsx?` inside one token (its LAST occurrence). */
function testFileOf(token: string): string | null {
  const at = token.lastIndexOf(".test.ts");
  if (at <= 0) return null;
  return token.slice(0, token[at + 8] === "x" ? at + 9 : at + 8);
}

function isPathChar(c: string | undefined): boolean {
  if (c === undefined) return false;
  return (
    (c >= "a" && c <= "z") ||
    (c >= "A" && c <= "Z") ||
    (c >= "0" && c <= "9") ||
    c === "_" ||
    c === "." ||
    c === "/" ||
    c === "-"
  );
}

/** `file.ts(L,C): error TSnnnn` → the file (the census's `[\w./-]+\.tsx?`). */
function tscFileOf(line: string): string | null {
  let from = 0;
  for (;;) {
    const at = line.indexOf("): error TS", from);
    if (at < 0) return null;
    const digit = line[at + "): error TS".length];
    const open = line.lastIndexOf("(", at);
    if (
      open > 0 &&
      digit !== undefined &&
      digit >= "0" &&
      digit <= "9" &&
      LINE_COL.test(line.slice(open + 1, at))
    ) {
      let start = open;
      while (start > 0 && isPathChar(line[start - 1])) start -= 1;
      const file = line.slice(start, open);
      if (file.endsWith(".ts") || file.endsWith(".tsx")) return file;
    }
    from = at + 1;
  }
}

/** Drop colour sequences: a real `ESC[…m`, or its `^[[…m` rendering. */
export function stripAnsi(s: string): string {
  if (!s.includes("\u001b[") && !s.includes("^[[")) return s;
  let out = "";
  let i = 0;
  while (i < s.length) {
    let j = -1;
    if (s[i] === "\u001b" && s[i + 1] === "[") j = i + 2;
    else if (s[i] === "^" && s[i + 1] === "[" && s[i + 2] === "[") j = i + 3;
    if (j >= 0) {
      while (j < s.length && ((s[j]! >= "0" && s[j]! <= "9") || s[j] === ";")) {
        j += 1;
      }
      if (s[j] === "m") {
        i = j + 1;
        continue;
      }
    }
    out += s[i];
    i += 1;
  }
  return out;
}

/** Streaming port of `ci-catch-v3.py`'s units over one job log. */
export class CiLogParser {
  private readonly fails = new Set<string>();
  /** Per-suite evidence; judged in {@link finish} (`suite_verdicts`). */
  private readonly suites = new Map<string, SuiteState>();
  private suite: string | null = null;
  private lastFile: string | null = null;
  private carry = "";
  private first = true;

  /** Feed the next decoded chunk of the log. */
  push(chunk: string): void {
    let text = chunk;
    if (this.first) {
      this.first = false;
      if (text.startsWith("\ufeff")) text = text.slice(1);
    }
    let start = 0;
    let nl = text.indexOf("\n");
    while (nl >= 0) {
      const end = Math.min(nl, start + MAX_LINE_CHARS);
      this.line(this.carry + text.slice(start, end));
      this.carry = "";
      start = nl + 1;
      nl = text.indexOf("\n", start);
    }
    if (this.carry.length < MAX_LINE_CHARS) {
      this.carry += text.slice(
        start,
        start + (MAX_LINE_CHARS - this.carry.length)
      );
    }
  }

  /** The failing units, sorted (call once, after the last chunk). */
  finish(): string[] {
    if (this.carry) this.line(this.carry);
    this.carry = "";
    for (const [name, s] of this.suites) {
      if (suiteFailed(s)) this.fails.add(`shell:${name}`);
    }
    return [...this.fails].sort();
  }

  /** A line inside a suite: its summary first, markers only as a fallback. */
  private suiteEvidence(name: string, line: string): void {
    let s = this.suites.get(name);
    if (!s)
      this.suites.set(name, (s = { fail: false, pass: false, mark: false }));
    const verdict = summaryVerdict(line, { bunLines: false });
    if (verdict === "fail") s.fail = true;
    else if (verdict === "pass") s.pass = true;
    else if (isFailMarker(line)) s.mark = true;
  }

  private line(raw: string): void {
    const capped =
      raw.length > MAX_LINE_CHARS ? raw.slice(0, MAX_LINE_CHARS) : raw;
    let line = stripAnsi(capped.replace(LOG_TIMESTAMP, ""));
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.startsWith(STEP_START)) {
      this.suite = null;
      this.lastFile = null;
      return;
    }
    const trimmed = line.trim();
    const started = shellSuiteStart(trimmed);
    if (started) {
      this.suite = started;
      return;
    }
    if (endsShellSuite(trimmed)) {
      this.suite = null;
      return;
    }
    if (this.suite) this.suiteEvidence(this.suite, line);

    const check = lintCheckOf(trimmed);
    if (check) this.fails.add(`lint:check-${check}`);

    const lead = line.trimStart();
    for (const marker of ["FAIL", "×", "✗"]) {
      if (!lead.startsWith(marker)) continue;
      const after = lead.slice(marker.length);
      if (!/^\s/.test(after)) continue;
      const file = testFileOf(after.trimStart().split(/\s/)[0] ?? "");
      if (file) this.fails.add(`test:${file}`);
      break;
    }

    const bun = bunFailUnit(line);
    if (bun) this.fails.add(bun);

    if (
      trimmed !== "" &&
      !/\s/.test(trimmed) &&
      (trimmed.startsWith("/home/runner/work/") ||
        trimmed.endsWith(".ts") ||
        trimmed.endsWith(".tsx"))
    ) {
      this.lastFile = repoRelative(trimmed);
    }
    if (this.lastFile && ESLINT_ERROR.test(line)) {
      this.fails.add(`eslint:${this.lastFile}`);
    }

    const tsc = tscFileOf(line);
    if (tsc) this.fails.add(`tsc:${tsc}`);
  }
}

/** The census's `units_failed` over a whole log at once (used by the tests). */
export function unitsFailedFromLog(text: string): string[] {
  const parser = new CiLogParser();
  parser.push(text);
  return parser.finish();
}

/**
 * Runs of one workflow created on `day` (`exactDay`), or on or after it
 * (`YYYY-MM-DD`, UTC).
 */
export async function fetchRuns(
  client: GithubClient,
  repo: string,
  workflow: string,
  day: string,
  maxPages = 20,
  opts: { exactDay?: boolean } = {}
): Promise<{ runs: CiRunItem[]; complete: boolean; notFound: boolean }> {
  const created = encodeURIComponent(opts.exactDay ? day : `>=${day}`);
  const r = await client.getAllPages(
    `/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?per_page=100&created=${created}`,
    {
      maxPages,
      extract: body => {
        const runs = (body as { workflow_runs?: unknown } | null)
          ?.workflow_runs;
        return Array.isArray(runs) ? runs : [];
      },
    }
  );
  const runs: CiRunItem[] = [];
  for (const raw of r.items) {
    if (!raw || typeof raw !== "object") continue;
    const w = raw as Record<string, unknown>;
    if (typeof w.id !== "number") continue;
    const prs = Array.isArray(w.pull_requests)
      ? w.pull_requests
          .map(p => (p as { number?: unknown } | null)?.number)
          .filter((n): n is number => typeof n === "number")
      : [];
    runs.push({
      runId: w.id,
      workflow: strOrNull(w.path) ?? strOrNull(w.name),
      event: strOrNull(w.event),
      headBranch: strOrNull(w.head_branch),
      headSha: strOrNull(w.head_sha),
      status: strOrNull(w.status),
      conclusion: strOrNull(w.conclusion),
      createdAtMs: ms(w.created_at),
      updatedAtMs: ms(w.updated_at),
      prNumbers: prs,
    });
  }
  return { runs, complete: r.complete, notFound: r.notFound };
}

/** A failed (or timed-out) job, with the names of its failed steps. */
export interface FailedJob {
  id: number;
  failedSteps: string[];
}

/** The unit families a job's failed steps open (`ci-catch-v3.py`'s `gates`). */
export interface FamilyGates {
  shell: boolean;
  test: boolean;
  lint: boolean;
}

export function familyGates(failedSteps: readonly string[]): FamilyGates {
  const low = failedSteps.map(s => s.toLowerCase());
  return {
    shell: low.some(s => s.includes("shell")),
    test: low.some(s => s.includes("test") && !s.includes("shell")),
    lint: low.some(s => s.includes("lint")), // `eslint` included
  };
}

/** The units whose family a failed step of their job opened. */
export function gateUnits(
  units: readonly string[],
  gates: FamilyGates
): string[] {
  return units.filter(u => {
    if (u.startsWith("shell:")) return gates.shell;
    if (u.startsWith("eslint:") || u.startsWith("lint:")) return gates.lint;
    return gates.test; // test:, bun:, tsc:
  });
}

/**
 * The failed (or timed-out) jobs of one run's latest attempt; null = not read
 * (retry later). "not_found": GitHub answered 404, for a run it no longer has
 * (deleted or expired) or for a repo the token cannot read; the caller tells
 * the two apart.
 */
export async function fetchFailedJobs(
  client: GithubClient,
  repo: string,
  runId: number
): Promise<FailedJob[] | "not_found" | null> {
  const r = await client.getAllPages(
    `/repos/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`,
    {
      maxPages: 3,
      extract: body => {
        const jobs = (body as { jobs?: unknown } | null)?.jobs;
        return Array.isArray(jobs) ? jobs : [];
      },
    }
  );
  if (r.notFound) return "not_found";
  if (!r.complete) return null;
  const jobs: FailedJob[] = [];
  for (const raw of r.items) {
    const j = raw as {
      id?: unknown;
      conclusion?: unknown;
      steps?: unknown;
    } | null;
    if (
      typeof j?.id !== "number" ||
      typeof j.conclusion !== "string" ||
      !FAILED_JOB_CONCLUSIONS.has(j.conclusion)
    ) {
      continue;
    }
    const failedSteps: string[] = [];
    for (const s of Array.isArray(j.steps) ? j.steps : []) {
      const step = s as { name?: unknown; conclusion?: unknown } | null;
      if (step?.conclusion === "failure" && typeof step.name === "string") {
        failedSteps.push(step.name);
      }
    }
    jobs.push({ id: j.id, failedSteps });
  }
  return jobs;
}

/** One failed job's log, streamed through the parser. */
export async function fetchJobUnits(
  client: GithubClient,
  repo: string,
  jobId: number,
  maxBytes = LOG_MAX_BYTES
): Promise<{ result: StreamResult; units: string[] }> {
  const parser = new CiLogParser();
  const result = await client.streamText(
    `/repos/${repo}/actions/jobs/${jobId}/logs`,
    maxBytes,
    chunk => parser.push(chunk)
  );
  return { result, units: result.kind === "ok" ? parser.finish() : [] };
}

/** When a completed run finished (its last update), else its creation. */
function finishedAt(run: CiRunRecord): number | null {
  return run.updatedAtMs ?? run.createdAtMs;
}

/**
 * Milliseconds in `[fromMs, toMs)` during which the trunk branch was red.
 *
 * Push runs on the trunk, in order of completion: a failed run turns the trunk
 * red at its completion, a successful one turns it green; other conclusions
 * (cancelled, skipped) change nothing. `before` is the last completed trunk run
 * created before the window (its state at the window's start).
 */
export function trunkRedMs(
  runs: readonly CiRunRecord[],
  before: CiRunRecord | null,
  fromMs: number,
  toMs: number
): number {
  let red = before?.conclusion === "failure";
  let since = fromMs;
  let total = 0;
  const completed = runs
    .filter(
      r =>
        r.event === "push" &&
        (r.conclusion === "failure" || r.conclusion === "success") &&
        finishedAt(r) !== null
    )
    .sort((a, b) => finishedAt(a)! - finishedAt(b)!);
  for (const run of completed) {
    const at = Math.min(Math.max(finishedAt(run)!, fromMs), toMs);
    const nowRed = run.conclusion === "failure";
    if (nowRed === red) continue;
    if (red) total += at - since;
    red = nowRed;
    since = at;
  }
  if (red) total += toMs - since;
  return Math.max(0, total);
}
