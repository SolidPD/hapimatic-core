// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Reads for `hapi security audit` that never fail silently (issues #3841, #4886).
 *
 * A check that cannot read its input must say so, because an error swallowed into
 * "nothing found" makes the report look clean. Only a path that genuinely does not exist
 * is silent; any other error becomes a `high` finding, the same fail-closed rule the
 * token scan follows for `gitleaks-error`.
 */
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { validateAnyStoredAccount } from "@hapi/protocol/accounts";

import { UUID_REGEX } from "@/accounts/accountStore";

import type { AuditPaths, Finding, SpawnResult } from "./security";
import {
  accountConfigBases,
  type CredentialBase,
} from "./securityCredentialBases";

/**
 * An error's code (EACCES, SQLITE_CANTOPEN…), else its name — never its message, which can
 * quote the input that failed (#4886).
 */
export function errnoCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === "string" && code !== "") return code;
  return err instanceof Error ? err.name : "unknown error";
}

/** ENOENT, or ENOTDIR from a parent component: the path does not exist. */
export function isAbsentError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** A path the audit could not read, so the checks that depend on it did not run. */
export function unreadableFinding(
  path: string,
  label: string,
  err: unknown,
  unchecked: string
): Finding {
  return {
    id: "path-unreadable",
    severity: "high",
    message: `${label} could not be read (${errnoCode(err)}), so ${unchecked} went unchecked — failing closed`,
    fixHint: `run the audit as the instance owner, or repair the ownership and mode of ${path}`,
    fixable: null,
    path,
  };
}

/**
 * A JSON file that exists but does not parse. The message is fixed text and never the
 * parser's own message: Bun and Node both quote the offending input in a `JSON.parse`
 * error, and a corrupt `settings.json` would then put part of its token in the report.
 */
export function corruptFinding(
  path: string,
  label: string,
  unchecked: string
): Finding {
  return {
    id: "path-unreadable",
    severity: "high",
    message: `${label} is not valid JSON, so ${unchecked} went unchecked — failing closed`,
    fixHint: `repair or restore ${path}; the instance cannot use it in this state either`,
    fixable: null,
    path,
  };
}

/**
 * The outcome of reading a JSON file the audit depends on. `corrupt` deliberately carries
 * no error object, so no caller can print the parser's message (see {@link corruptFinding}).
 */
export type JsonRead =
  | { kind: "absent" }
  | { kind: "unreadable"; err: unknown }
  | { kind: "corrupt" }
  | { kind: "ok"; value: unknown };

/** Read and parse a JSON file. Absent is ENOENT/ENOTDIR only; anything else is reported. */
export function readJsonFile(path: string): JsonRead {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    return isAbsentError(err)
      ? { kind: "absent" }
      : { kind: "unreadable", err };
  }
  try {
    return { kind: "ok", value: JSON.parse(text) as unknown };
  } catch {
    return { kind: "corrupt" };
  }
}

/** A parsed JSON value as an object record, or `undefined` for anything else (incl. arrays). */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The object a successful read holds, or `undefined` when it is not a JSON object. */
export function readRecord(
  read: JsonRead
): Record<string, unknown> | undefined {
  return read.kind === "ok" ? asRecord(read.value) : undefined;
}

/**
 * The one high finding for a JSON input that exists but cannot be read or parsed (#4886
 * N1), else null — absent is the caller's call. Every input goes through this, so the
 * fail-closed rule is written once.
 */
export function readProblem(
  read: JsonRead,
  path: string,
  label: string,
  unchecked: string
): Finding | null {
  if (read.kind === "unreadable")
    return unreadableFinding(path, label, read.err, unchecked);
  if (read.kind === "corrupt") return corruptFinding(path, label, unchecked);
  return null;
}

/**
 * A JSON input that must be an object: its record, or the one high finding for why it
 * cannot be used ({@link readProblem}, or JSON that is not an object). An absent file
 * yields neither.
 */
export function objectInput(
  read: JsonRead,
  path: string,
  label: string,
  unchecked: string
): { record?: Record<string, unknown>; problem: Finding | null } {
  const problem = readProblem(read, path, label, unchecked);
  if (problem) return { problem };
  const record = readRecord(read);
  if (read.kind === "ok" && !record) {
    return { problem: corruptFinding(path, label, unchecked) };
  }
  return { record, problem: null };
}

/**
 * What the audit reads once per run (#4886 N1): each JSON input through one three-way
 * reader, and the credential bases computed once from the daemon's recorded base, so
 * every check sees the same snapshot and a read problem is reported once.
 */
export interface AuditInputs {
  settings: JsonRead;
  daemonPid: number | null;
  bases: CredentialBase[];
  /** Read problems found while building the snapshot (an unreadable daemon state file). */
  problems: Finding[];
}

const DAEMON_STATE_UNCHECKED =
  "the daemon's recorded credential base and its sandbox state";

export function readInputs(paths: AuditPaths): AuditInputs {
  const problems: Finding[] = [];
  const { record: daemon, problem } = objectInput(
    readJsonFile(paths.daemonStateFile),
    paths.daemonStateFile,
    "daemon.state.json",
    DAEMON_STATE_UNCHECKED
  );
  if (problem) problems.push(problem);
  const recordedDir =
    typeof daemon?.accountConfigsDir === "string" &&
    daemon.accountConfigsDir !== ""
      ? daemon.accountConfigsDir
      : null;
  return {
    settings: readJsonFile(paths.settingsFile),
    daemonPid:
      typeof daemon?.pid === "number" && daemon.pid > 0 ? daemon.pid : null,
    bases: accountConfigBases({ ...paths, daemonRecordedDir: recordedDir }),
    problems,
  };
}

export interface AccountRead {
  records: Array<Record<string, unknown>>;
  invalid: string[];
  /** Records that exist but could not be read or parsed (#4886 N1). */
  problems: Finding[];
}

/**
 * The valid account records in the store. Each record is read as a file and checked with
 * the store's own validator (`AccountStore.getAny` does the same) — never `list()`, which
 * migrates. A record that cannot be read or parsed is a high finding, because its
 * unrefreshable flag goes unchecked; one that parses but fails validation stays low.
 */
export function readAccounts(paths: AuditPaths): AccountRead {
  const out: AccountRead = { records: [], invalid: [], problems: [] };
  let names: string[];
  try {
    names = readdirSync(paths.accountsDir);
  } catch {
    return out; // absent is silent; anything else is reported by the mode check
  }
  const unchecked = "its unrefreshable flag";
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    const uuid = name.slice(0, -".json".length);
    if (!UUID_REGEX.test(uuid)) continue;
    const path = join(paths.accountsDir, name);
    const read = readJsonFile(path);
    // Not objectInput: a record that parses but is not an object is schema-invalid (low).
    const problem = readProblem(read, path, `accounts/${name}`, unchecked);
    if (problem) {
      out.problems.push(problem);
    } else if (read.kind === "ok") {
      const result = validateAnyStoredAccount(read.value);
      if (result.ok) {
        out.records.push(result.account as unknown as Record<string, unknown>);
      } else {
        out.invalid.push(uuid);
      }
    }
  }
  return out;
}

/**
 * List a directory (only its subdirectories with `dirsOnly`). A missing directory lists
 * as empty; any other error (EACCES, or ENOTDIR because the path is a file) is pushed to
 * `out` as a finding.
 */
export function listOrReport(
  dir: string,
  label: string,
  unchecked: string,
  out: Finding[],
  dirsOnly = false
): string[] {
  try {
    return dirsOnly
      ? readdirSync(dir, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name)
      : readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      out.push(unreadableFinding(dir, label, err, unchecked));
    }
    return [];
  }
}

/**
 * Whether `path` exists. Absent (ENOENT/ENOTDIR) is a silent `false`; any other error
 * (an untraversable parent) is pushed to `out` as a finding, and is also `false`.
 */
export function existsOrReport(
  path: string,
  label: string,
  unchecked: string,
  out: Finding[]
): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (err) {
    if (!isAbsentError(err))
      out.push(unreadableFinding(path, label, err, unchecked));
    return false;
  }
}

/**
 * Inherited variables that would make a scan read something other than the repo it was
 * given (`GIT_DIR` beats `git -C`), override the config pins below
 * (`GIT_CONFIG_PARAMETERS`, set by `git -c`, beats `GIT_CONFIG_COUNT`), or replace
 * gitleaks's ruleset when the repo has no `.gitleaks.toml` (`GITLEAKS_CONFIG` /
 * `GITLEAKS_CONFIG_TOML` beat the repo's own config). All verified #4886.
 */
const SCAN_ENV_DROPPED = [
  "GIT_CONFIG_PARAMETERS",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GITLEAKS_CONFIG",
  "GITLEAKS_CONFIG_TOML",
] as const;

/**
 * Git config the scan pins (#3841, #4886). gitleaks parses `git log -p`, so any setting that
 * changes that output can make a healthy range read as uncovered, or hide content:
 * colour codes parse as nothing; `format.pretty` drops the `commit <sha>` header gitleaks
 * counts by; `log.showSignature` runs signature verification and prints its errors;
 * `diff.submodule=log` turns a submodule bump into prose with no hunk; `diff.noprefix`
 * drops the `a/` `b/` path prefixes; `diff.relative`, read from a subdirectory, hides every
 * change outside it from gitleaks and the count alike, so the totals still match.
 */
const SCAN_CONFIG_PINS: ReadonlyArray<readonly [string, string]> = [
  ["color.ui", "never"],
  ["color.diff", "never"],
  ["format.pretty", "medium"],
  ["diff.submodule", "short"],
  ["log.showSignature", "false"],
  ["diff.noprefix", "false"],
  ["diff.relative", "false"],
];

/**
 * The environment for gitleaks and for every git the coverage check runs: `env` without
 * {@link SCAN_ENV_DROPPED}, with replace refs ignored, and with the config pins appended
 * after any entries the caller already passes through `GIT_CONFIG_COUNT` (so those survive;
 * later entries win).
 */
export function gitScanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const key of SCAN_ENV_DROPPED) delete out[key];
  out.GIT_NO_REPLACE_OBJECTS = "1";
  // Decimal digits only, as the pre-flight reads it; anything else puts the pins at 0.
  const given = env.GIT_CONFIG_COUNT ?? "";
  const n = /^\d{1,9}$/.test(given) ? Number.parseInt(given, 10) : 0;
  out.GIT_CONFIG_COUNT = String(n + SCAN_CONFIG_PINS.length);
  SCAN_CONFIG_PINS.forEach(([key, value], i) => {
    out[`GIT_CONFIG_KEY_${n + i}`] = key;
    out[`GIT_CONFIG_VALUE_${n + i}`] = value;
  });
  return out;
}

/**
 * The `git log` options gitleaks (`--log-opts`) and the coverage count both use, so the
 * two read the same diffs (#4886):
 * - `--diff-merges=remerge` scans what a two-parent merge changed beyond an automatic
 *   merge (a conflict resolution, an evil-merge edit). `first-parent` and `-m` re-read the
 *   whole merged-in side; on this repo's history that re-surfaces 109 (110) findings
 *   already on the prod base. Needs git 2.36+, and writes a temporary object directory
 *   inside the scanned repo; octopus merges are not remerged, so they fail closed.
 * - `--text` and `--no-textconv` read every path as its stored bytes, whatever
 *   `.gitattributes` says (`-diff`, `binary`, a textconv driver) or a NUL byte suggests.
 * - `--no-ext-diff` keeps an external diff driver out; `--root` keeps a root commit's
 *   content visible under `log.showRoot=false`.
 * - `--no-renames` reads a rename as a delete and an add. A pure rename otherwise shows no
 *   content, so a file moved out of an allowlisted path (`.github/issue-assets/`) would never
 *   be read at its new one. A renamed file whose finding is already on the prod base is
 *   reported again: a loud false block, accepted over a silent pass (#4886).
 */
export const SCAN_LOG_OPTS = [
  "--diff-merges=remerge",
  "--text",
  "--no-textconv",
  "--no-ext-diff",
  "--root",
  "--no-renames",
] as const;

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const ERR_LINE = /^(?:\S+\s+)?ERR\s/;
/** gitleaks ≥8.24 logs this when it cannot parse the remote URL; it only drops finding links. */
const BENIGN_ERR_LINE = /^(?:\S+\s+)?ERR\s+skipping finding links:/;
const COUNT_LINE = /(\d+) commits scanned/g;
const NUMSTAT_ROW = /^(\d+)\t(\d+)\t/;
const RAW_ROW = /^:\d+ \d+ ([0-9a-f]+) ([0-9a-f]+) ([A-Z])/;
const NULL_OID = /^0+$/;
/** The empty blob (SHA-1, SHA-256): adding an empty file gives neither side a hunk. */
const EMPTY_BLOBS = new Set([
  "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
  "473a0f4c3be8a93681a267e3b1e9a7dcda1185436fe141f7749120a303721813",
]);

/**
 * The first `ERR`-level line gitleaks logged, or null. gitleaks (8.19–8.30) logs every git
 * stderr line it does not know to be harmless as `ERR [git] …` and stops reading the
 * range, yet exits 0 (#4886 F1). The one harmless `ERR` is the remote-link message,
 * matched only at the start of the message so a `[git]` line can never pass as it.
 */
export function gitleaksErrorLine(stderr: string): string | null {
  for (const line of stderr.replace(ANSI, "").split("\n")) {
    if (ERR_LINE.test(line) && !BENIGN_ERR_LINE.test(line)) return line.trim();
  }
  return null;
}

/**
 * The number of commits gitleaks counts in a `git log --raw --numstat --format=COMMIT %H`
 * listing: those with a numeric numstat row that changes lines, or a non-delete raw entry
 * whose blob changed. The raw clause is needed because numstat ignores `--text` and prints
 * `-\t-` for a binary, while gitleaks with `--text` reads it; it leaves out mode changes,
 * which keep the same blob, and an added empty file, which has no hunk. (A file emptied in
 * place does have one — its removed lines — so it counts; under `--no-renames` a rename is
 * a delete and an add, and its added side counts.)
 */
export function countContentCommits(log: string): number {
  let expected = 0;
  let counted = true;
  for (const line of log.split("\n")) {
    if (line.startsWith("COMMIT ")) {
      counted = false;
      continue;
    }
    if (counted) continue;
    const row = line.match(NUMSTAT_ROW);
    const raw = line.match(RAW_ROW);
    if (
      (row && Number(row[1]) + Number(row[2]) > 0) ||
      (raw &&
        raw[3] !== "D" &&
        raw[1] !== raw[2] &&
        !(NULL_OID.test(raw[1]) && EMPTY_BLOBS.has(raw[2])))
    ) {
      expected++;
      counted = true;
    }
  }
  return expected;
}

/** One line of git or gitleaks output, with any `user:token@` in a URL redacted. */
function oneLine(text: string): string {
  return text
    .replace(/:\/\/[^/@\s]+@/g, "://<redacted>@")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function gitFailure(r: SpawnResult): string {
  const why = r.stderr || r.error?.message || `exit ${String(r.status)}`;
  return why.includes("--diff-merges")
    ? "this git cannot scan merges with --diff-merges=remerge (git 2.36 or later is required)"
    : `git could not read the range, so gitleaks could not either: ${oneLine(why)}`;
}

/**
 * Whether a "clean" gitleaks run read the whole range, or why it cannot be trusted. Two
 * layers, checked in order:
 *
 * 1. What gitleaks logged: an `ERR` line means it stopped reading (see
 *    {@link gitleaksErrorLine}); this also covers a deleted file's unreadable old blob,
 *    which gitleaks reads and the count below (`--diff-filter=d`) does not. No commit count
 *    at all means the run cannot be checked. #3841 round 2 did not parse ERR lines, on the
 *    assumption that harmless git stderr produces them on large deltas; #4886 measured 0
 *    ERR lines on healthy ranges of up to 13 443 commits (gitleaks logs the harmless git
 *    warnings as WRN), so any ERR line now fails closed.
 * 2. Git's own reading of the range: a shallow checkout or an octopus merge cannot be
 *    scanned; the count `git log` reads both sides of every non-deleted diff with the same
 *    options as gitleaks, so an object gitleaks could not read fails it too; and the
 *    commits gitleaks counted must EQUAL the commits with content changes. This compares
 *    commit totals, so it cannot prove every file in a commit was read — layer 1 covers that.
 *
 * Returns why the scan cannot be trusted, or null.
 */
export function scanCoverage(
  runGit: (repo: string, args: string[]) => SpawnResult,
  repo: string,
  baseSha: string,
  headSha: string,
  gitleaksStderr: string
): string | null {
  const errLine = gitleaksErrorLine(gitleaksStderr);
  if (errLine)
    return `gitleaks stopped on an error it logged (${oneLine(errLine)})`;
  const counts = [...gitleaksStderr.replace(ANSI, "").matchAll(COUNT_LINE)];
  if (counts.length === 0) {
    return "gitleaks printed no commit count, so its coverage cannot be checked";
  }
  const scanned = Number(counts[counts.length - 1][1]);
  const range = `${baseSha}..${headSha}`;

  const shallow = runGit(repo, ["rev-parse", "--is-shallow-repository"]);
  if (shallow.status !== 0) return gitFailure(shallow);
  if (shallow.stdout.trim() === "true") {
    return "the checkout is shallow; commits past its boundary are invisible to the scan";
  }
  const octopus = runGit(repo, [
    "rev-list",
    "--min-parents=3",
    "--count",
    range,
  ]);
  if (octopus.status !== 0) return gitFailure(octopus);
  // Digits only: `Number("")` is 0, which would read an empty answer as "no octopus merge".
  const octopusText = octopus.stdout.trim();
  if (!/^\d+$/.test(octopusText)) {
    return `git could not count the merges in the range (${oneLine(octopusText)})`;
  }
  const octopusCount = Number(octopusText);
  if (octopusCount > 0) {
    return `the range has ${octopusCount} octopus merge(s), whose merge content cannot be scanned`;
  }

  const r = runGit(repo, [
    "log",
    "--no-color",
    ...SCAN_LOG_OPTS,
    "--diff-filter=d",
    "--raw",
    "--no-abbrev",
    "--numstat",
    "--format=COMMIT %H",
    range,
  ]);
  if (r.status !== 0) return gitFailure(r);
  const expected = countContentCommits(r.stdout);
  if (scanned < expected) {
    return `gitleaks scanned ${scanned} of the ${expected} commit(s) with content changes`;
  }
  if (scanned > expected) {
    return `gitleaks counted ${scanned} commits but the range has ${expected} with content changes — its view of the range differs from git's`;
  }
  return null;
}
