// SPDX-License-Identifier: AGPL-3.0-only
import { scrubThenCap } from "@hapi/protocol";

/**
 * Agent test runs inside a turn (issue #6164, A1 — R2 `tests`, R15).
 *
 * Ports the census's `local-catch-v3.py` (#6201, which replaced #6182's v2,
 * which replaced v1's over-counts): a Bash command that runs a test runner,
 * and the failing units
 * its output names. Unit ids use one vocabulary with the CI parser
 * (`ciLogs.ts`) so E2 (#6174) can join agent catches with CI catches per unit:
 *
 *   `test:<path>.test.ts`  vitest / bun file
 *   `bun:<test name>`      a bun `(fail)` line
 *   `shell:<test-x.sh>`    a shell suite (basename)
 *
 * The census's rules, kept here:
 * - A shell suite is judged by its OWN summary: a non-zero failed count fails
 *   it, and a zero count passes it whatever `FAIL` lines it printed (suites
 *   that test a checker print that checker's FAIL output on purpose). FAIL /
 *   ✗ / ❌ / "not ok" marker lines count only when it printed no summary.
 *   Output belongs to a suite through its `== <name>.sh ==` section of
 *   run-shell-tests output, or through a command that ran that one suite.
 * - A bun test file is credited only for a `(fail)` line in its own section;
 *   bun's closing `N tests failed:` reprint belongs to no file.
 * - A run counts as failing on summary-grade evidence only: a non-zero failed
 *   count, a line containing `(fail)`, or a failing unit. A bare marker line
 *   counts only through a suite verdict (v3; in v2 any marker flagged the
 *   run).
 *
 * Every pattern is applied to ONE line capped at {@link MAX_LINE_CHARS}, and
 * each is linear (no nested or adjacent overlapping quantifiers), so a huge
 * test log can never backtrack badly. Ids pass `scrubThenCap` before they are
 * kept, because test output can echo secrets.
 */

/** A Bash command that runs a test runner (the census's runner pattern). */
const TEST_RUNNER =
  /\b(?:vitest|bun (?:run )?test|test:\w+|run-shell-tests|scripts\/test-[\w.-]+\.sh)\b/;

const MAX_OUTPUT_CHARS = 2_000_000;
const MAX_LINE_CHARS = 2_000;
/** Longest kept unit id (after scrubbing). */
export const UNIT_MAX_CHARS = 120;
/** At most this many failing-unit ids per turn. */
export const MAX_UNITS = 10;

const TEST_FILE_ROOT = "(?:src|tests?|scripts|cli|server|web|shared|gateway)";
// `tsx` before `ts`: the census's `(?:ts|tsx|mjs)` stops at `.test.ts` for a
// `.test.tsx` file (the first alternative already matches).
const VITEST_FAIL = new RegExp(
  `(?:FAIL|×|✗)\\s+(${TEST_FILE_ROOT}/[\\w./-]+\\.test\\.(?:tsx|ts|mjs))`
);
const BUN_FILE_HEADER = new RegExp(
  `^(${TEST_FILE_ROOT}?/?[\\w./-]+\\.test\\.(?:tsx|ts|mjs)):$`
);
/** bun's closing reprint of every failure, which belongs to no file. */
const BUN_CLOSING = /^\d+ tests? failed:/;
const BUN_DURATION_SUFFIX = /\s\[[\d.]+ms\]$/;

/** `== test-x.sh ==`: run-shell-tests.sh starts that suite. */
const SHELL_RUN = /^==\s+(test-[\w.-]+\.sh)\s+==$/;
/** `== SKIP test-x.sh — … ==`: a suite the runner skipped. */
const SHELL_SKIP = /^==\s+SKIP\s+test-[\w.-]+\.sh\b/;
/** The runner's closing line, after its last suite. */
const SHELL_END = /^run-shell-tests: ran \d+ suite/;
const SUITE_NAME = /test-[\w.-]+\.sh/;
const SUITE_NAME_AT_BOUNDARY = /test-[\w.-]+\.sh\b/g;
const COMMAND_SUITE = /scripts\/(test-[\w.-]+\.sh)/g;
const RUNS_EVERY_SUITE = /run-shell-tests|test:shell/;
/** A count token: `<n> pass`, `<n> passed`, `<n> fail(ed|ure|ures)`. */
const COUNT_TOKEN = /\b(\d+) (pass(?:ed)?|fail(?:ed|ures?)?)\b/g;
const NAMED_FAILED_COUNT = /\b(\d+) failed\b/;
const FAIL_EQUALS_NONZERO = /\bFAIL(?:ED|URES?)?\s*[:=]\s*[1-9]/;
const FAIL_EQUALS_ZERO = /\bFAIL(?:ED|URES?)?\s*[:=]\s*0\b/;
const UNITTEST_FAILED = /^FAILED \((?:failures|errors)=[1-9]/;
const UNITTEST_OK = /^OK(?:\s*\(|$)/;
const BUN_FAIL_COUNT_LINE = /^\s*[1-9]\d* fail\s*$/;
const BUN_ZERO_FAIL_LINE = /^\s*0 fail\s*$/;
const NOT_OK = /^not ok\b/;
/** Gap allowed between a pass count and a fail count in one summary. */
const SUMMARY_GAP = 60;

interface CountToken {
  n: string;
  pass: boolean;
  start: number;
  end: number;
}

function countTokens(line: string): CountToken[] {
  const out: CountToken[] = [];
  for (const m of line.matchAll(COUNT_TOKEN)) {
    const start = m.index ?? 0;
    out.push({
      n: m[1]!,
      pass: m[2]!.startsWith("pass"),
      start,
      end: start + m[0].length,
    });
  }
  return out;
}

/** A pass count and a fail count matching `failCount`, within the gap. */
function passAndFail(
  tokens: readonly CountToken[],
  failCount: (n: string) => boolean
): boolean {
  for (const p of tokens) {
    if (!p.pass) continue;
    for (const f of tokens) {
      if (f.pass || !failCount(f.n)) continue;
      const after = f.start - p.end;
      const before = p.start - f.end;
      if (
        (after >= 0 && after <= SUMMARY_GAP) ||
        (before >= 0 && before <= SUMMARY_GAP)
      ) {
        return true;
      }
    }
  }
  return false;
}

/** `[1-9]\d*` (the count is all digits). */
const nonZero = (n: string) => n[0] !== "0";
const zero = (n: string) => n === "0";

/**
 * The verdict a summary line gives: `fail` (a non-zero failed count), `pass`
 * (a zero one, or unittest's `OK`), or null. `bunLines` adds bun's bare
 * `N fail` line, which the agent-run census reads and the CI census does not.
 */
export function summaryVerdict(
  line: string,
  opts: { bunLines: boolean }
): "fail" | "pass" | null {
  const tokens = countTokens(line);
  if (
    passAndFail(tokens, nonZero) ||
    FAIL_EQUALS_NONZERO.test(line) ||
    UNITTEST_FAILED.test(line) ||
    (opts.bunLines && BUN_FAIL_COUNT_LINE.test(line))
  ) {
    return "fail";
  }
  if (
    passAndFail(tokens, zero) ||
    FAIL_EQUALS_ZERO.test(line) ||
    UNITTEST_OK.test(line) ||
    (opts.bunLines && BUN_ZERO_FAIL_LINE.test(line))
  ) {
    return "pass";
  }
  return null;
}

/** A FAIL / FAILED / ✗ / ❌ / "not ok" marker at the start of a line. */
export function isFailMarker(line: string): boolean {
  const lead = line.trimStart();
  const ends = (c: string | undefined) =>
    c === undefined || c === ":" || c === "(" || /\s/.test(c);
  if (lead.startsWith("FAILED") && ends(lead[6])) return true;
  if (lead.startsWith("FAIL") && ends(lead[4])) return true;
  return lead.startsWith("✗") || lead.startsWith("❌") || NOT_OK.test(lead);
}

/** The suite a trimmed `== test-x.sh ==` line starts, or null. */
export function shellSuiteStart(trimmed: string): string | null {
  return trimmed.match(SHELL_RUN)?.[1] ?? null;
}

/** A trimmed line that ends the current suite: a SKIP header, or the runner's close. */
export function endsShellSuite(trimmed: string): boolean {
  return SHELL_SKIP.test(trimmed) || SHELL_END.test(trimmed);
}

/** Per-suite evidence while a log is read. */
export interface SuiteState {
  fail: boolean;
  pass: boolean;
  mark: boolean;
}

/** A suite fails on a failing summary, or on markers alone with no summary. */
export function suiteFailed(s: SuiteState): boolean {
  return s.fail || (s.mark && !s.pass);
}

/**
 * The `bun:<name>` unit of a bun `(fail) <name> [1.23ms]` line, or null.
 * Shared with the CI log parser so agent and CI catches use one id. bun
 * prints the marker at the start of the line, so only such a line names a
 * unit: a `(fail)` further in (source code a command printed, such as
 * `line.includes("(fail)")`) would otherwise name a unit `bun:"));`.
 */
export function bunFailUnit(line: string): string | null {
  const lead = line.trimStart();
  if (!lead.startsWith("(fail)")) return null;
  const name = lead
    .slice("(fail)".length)
    .trim()
    .replace(BUN_DURATION_SUFFIX, "");
  return name ? `bun:${name.slice(0, 80)}` : null;
}

export function isTestCommand(command: string): boolean {
  return TEST_RUNNER.test(command);
}

/** The text of a tool_result content (string, or the text of its blocks). */
export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const text = (block as Record<string, unknown>).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("\n");
}

export interface TestRunResult {
  /** The run reported a failure (summary-grade evidence, or a failing unit). */
  failed: boolean;
  /** Failing unit ids, unscrubbed, in first-seen order. */
  units: string[];
}

/** The one suite a command ran, unless it ran the whole shell runner. */
function singleSuiteOf(command: string): string | null {
  if (RUNS_EVERY_SUITE.test(command)) return null;
  const ran = new Set<string>();
  for (const m of command.matchAll(COMMAND_SUITE)) ran.add(m[1]!);
  return ran.size === 1 ? [...ran][0]! : null;
}

/**
 * `<suite>.sh … N failed` on one line (an aggregate summary): each suite name
 * with the first `N failed` within 80 characters after it.
 */
function namedSummaries(line: string): Array<{ suite: string; n: string }> {
  const out: Array<{ suite: string; n: string }> = [];
  let consumed = 0;
  for (const m of line.matchAll(SUITE_NAME_AT_BOUNDARY)) {
    const start = m.index ?? 0;
    if (start < consumed) continue;
    const end = start + m[0].length;
    const count = line.slice(end, end + 120).match(NAMED_FAILED_COUNT);
    if (count?.index === undefined || count.index > 80) continue;
    out.push({ suite: m[0], n: count[1]! });
    consumed = end + count.index + count[0].length;
  }
  return out;
}

/** `FAIL … <suite>.sh` / `✗ … <suite>.sh` / `❌ … <suite>.sh` at a line's start. */
function namedFailure(line: string): string | null {
  const lead = line.trimStart();
  let skip = 0;
  const sep = (c: string | undefined) =>
    c === ":" || (c !== undefined && /\s/.test(c));
  if (lead.startsWith("FAILED") && sep(lead[6])) skip = 6;
  else if (lead.startsWith("FAIL") && sep(lead[4])) skip = 4;
  else if (lead.startsWith("✗") || lead.startsWith("❌")) skip = 1;
  else return null;
  const m = lead.slice(skip).match(SUITE_NAME);
  return m?.index !== undefined && m.index <= 60 ? m[0] : null;
}

/**
 * Classify one test command's output (`local-catch-v3.py`'s `failures`).
 * `command` is the Bash command that produced it: a command that ran exactly
 * one shell suite owns the whole output for that suite.
 */
export function parseTestOutput(output: string, command = ""): TestRunResult {
  const units: string[] = [];
  const seen = new Set<string>();
  const add = (unit: string) => {
    if (!seen.has(unit)) {
      seen.add(unit);
      units.push(unit);
    }
  };
  const single = singleSuiteOf(command);
  const suites = new Map<string, SuiteState>();
  const state = (name: string): SuiteState => {
    let s = suites.get(name);
    if (!s) suites.set(name, (s = { fail: false, pass: false, mark: false }));
    return s;
  };
  let suite: string | null = null;
  let bunFile: string | null = null;
  let signal = false;
  const text =
    output.length > MAX_OUTPUT_CHARS
      ? output.slice(0, MAX_OUTPUT_CHARS)
      : output;
  for (const rawLine of text.split("\n")) {
    const line =
      rawLine.length > MAX_LINE_CHARS
        ? rawLine.slice(0, MAX_LINE_CHARS)
        : rawLine;
    const trimmed = line.trim();
    const started = shellSuiteStart(trimmed);
    if (started) {
      suite = started;
      continue;
    }
    if (endsShellSuite(trimmed)) {
      suite = null;
      continue;
    }
    const named = namedSummaries(line);
    for (const { suite: name, n } of named) {
      if (nonZero(n)) state(name).fail = true;
      else state(name).pass = true;
    }
    const namedFail = namedFailure(line);
    if (namedFail) state(namedFail).fail = true;
    const verdict = summaryVerdict(line, { bunLines: true });
    const marker = isFailMarker(line);
    const owner = suite ?? single;
    if (owner && named.length === 0) {
      if (verdict === "fail") state(owner).fail = true;
      else if (verdict === "pass") state(owner).pass = true;
      else if (marker) state(owner).mark = true;
    }
    // The run counts as failing on summary-grade evidence only (a non-zero
    // failed count or a line containing `(fail)`) plus the unit verdicts
    // below; a bare marker line decides only through a suite verdict, because
    // checker suites print FAIL on purpose (local-catch-v3, #6201).
    if (verdict === "fail" || line.includes("(fail)")) {
      signal = true;
    }

    const vitest = line.match(VITEST_FAIL);
    if (vitest) add(`test:${vitest[1]}`);
    const header = trimmed.match(BUN_FILE_HEADER);
    if (header) bunFile = header[1]!;
    if (BUN_CLOSING.test(trimmed)) bunFile = null;
    if (line.includes("(fail)")) {
      if (bunFile) add(`test:${bunFile}`);
      const unit = bunFailUnit(line);
      if (unit) add(unit);
    }
  }
  for (const [name, s] of suites) {
    if (suiteFailed(s)) add(`shell:${name}`);
  }
  return { failed: signal || units.length > 0, units };
}

/**
 * The turn's kept failing units: scrubbed, capped at {@link UNIT_MAX_CHARS},
 * most frequent first (ties by id), at most {@link MAX_UNITS}.
 */
export function keepUnits(
  counts: ReadonlyMap<string, number>,
  literals: readonly string[] = []
): string[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, MAX_UNITS)
    .map(([unit]) => scrubThenCap(unit, UNIT_MAX_CHARS, literals));
}
