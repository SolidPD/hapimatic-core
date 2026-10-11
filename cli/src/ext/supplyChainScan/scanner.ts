// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Supply-chain scanner (issue #3131, Sub Q) — the implementation behind the #3120
 * `ScanBeforeInstall` seam.
 *
 * {@link makeSupplyChainScanner} builds the `ScanBeforeInstall` hook that
 * `cli/src/commands/ext.ts` registers via `setScanBeforeInstall`. It runs against BOTH
 * legs of the pinned {@link StagedInstall} contract:
 *
 *   - `kind: "extension"`  — a staged filesystem extension. Its bytes live in `stagedDir`
 *     (materialized by `installExtension` BEFORE finalize). The scan walks the staged
 *     markdown/text for prompt-injection (KD3 / Task 1) AND runs the secret scan
 *     (gitleaks) over the whole staged tree.
 *   - `kind: "harness-recipe"` — a catalog CLI recipe (local, build-composed data). The
 *     scan re-verifies the recipe's install-script integrity: curl-pipe-bash, unpinned
 *     source, undeclared fetched-artifact hash (Task 2 / R3). This is DEFENSE-IN-DEPTH —
 *     `harnessRecipeDataSchema.superRefine` already rejects these at parse time, but a
 *     code path that constructs a recipe object directly would bypass the schema, so the
 *     gate re-checks.
 *
 * 🔒 FAIL-CLOSED secret leg (KD2 / ruling 1B-18): the compiled `hapi` binary cannot
 * assume `gitleaks` is on PATH (it is provisioned only on the dev host today). When the
 * binary is ABSENT the secret leg does NOT silently skip — it emits a named
 * `secret-scan-unavailable` BLOCKING finding, because a silent skip is a stealth
 * downgrade of a red-impact gate. A gitleaks execution error likewise fails closed.
 *
 * 🔴 HONESTY (R6): a `pass` verdict is defense-in-depth, never a guarantee. The
 * injection {@link INJECTION_KNOWN_GAPS} and the block-threshold are surfaced to the
 * caller / UI so a green result is never read as comprehensive.
 *
 * Shelling to gitleaks uses `spawnSync` (execFile-style, NO shell → no injection, and it
 * works identically under Bun and Node/vitest). The gitleaks resolver + runner are
 * injectable so tests exercise the absent-binary and leaks-found paths without the real
 * tool.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ScanFinding, ScanVerdict, StagedInstall } from "@hapi/protocol";

import { logger } from "@/ui/logger";

import { scanForInjection } from "./injectionHeuristics";

/**
 * The stock 4 (`claude|codex|gemini|opencode`) are baked + pinned at provision (ruling
 * D2) and NEVER traverse the catalog install path — so this exemption (R5) is a
 * DOCUMENTED defense-in-depth assertion, not a load-bearing filter. If one ever reached
 * the scanner it is exempt by id with an `info` (non-blocking) note.
 */
const STOCK_4 = new Set(["claude", "codex", "gemini", "opencode"]);

/** Severities that BLOCK an install. `info`/`low` findings are advisory (recorded, surfaced, non-blocking). */
const BLOCKING_SEVERITIES = new Set<ScanFinding["severity"]>([
  "medium",
  "high",
  "critical",
]);

/** File extensions whose contents are human-readable skill/plugin text (injection surface). */
const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".mdx", ".txt"]);

/** Walk caps — bound the scan so a pathological staged tree cannot hang the install. */
const MAX_FILES = 500;
const MAX_FILE_BYTES = 512 * 1024; // 512 KiB per text file
/** Bound on one gitleaks run. Shared with `hapi security audit` (#3841). */
export const GITLEAKS_TIMEOUT_MS = 30_000;

/**
 * One parsed gitleaks report entry — the NON-SECRET subset. `Secret`, `Match` and
 * `Line` are deliberately absent: they carry the matched value. Shared with
 * `hapi security audit` (#3841), which surfaces only `RuleID` / `File` / `StartLine`.
 */
export interface GitleaksEntry {
  RuleID?: string;
  Description?: string;
  File?: string;
  StartLine?: number;
}

/**
 * Narrow a parsed gitleaks JSON report to {@link GitleaksEntry} values, copying ONLY the
 * non-secret fields so the matched value never survives past the parse. Returns `null`
 * when the report is not an array.
 */
export function narrowGitleaksEntries(raw: unknown): GitleaksEntry[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.map(item => {
    const e = (item ?? {}) as Record<string, unknown>;
    return {
      RuleID: typeof e.RuleID === "string" ? e.RuleID : undefined,
      Description:
        typeof e.Description === "string" ? e.Description : undefined,
      File: typeof e.File === "string" ? e.File : undefined,
      StartLine: typeof e.StartLine === "number" ? e.StartLine : undefined,
    };
  });
}

/** How a finished gitleaks spawn ended (before its report is parsed). */
export type GitleaksExitClass =
  | { kind: "clean" }
  | { kind: "leaks" }
  | { kind: "error"; detail: string };

/**
 * Classify a finished gitleaks spawn: exit 0 = clean, exit 1 = leaks found, a spawn
 * error or any other status = `error` (callers fail closed on it). Shared with
 * `hapi security audit` (#3841).
 */
export function classifyGitleaksExit(r: {
  status: number | null;
  error?: Error;
  stderr?: string | null;
}): GitleaksExitClass {
  if (r.error) return { kind: "error", detail: r.error.message };
  if (r.status === 0) return { kind: "clean" };
  if (r.status === 1) return { kind: "leaks" };
  return {
    kind: "error",
    detail: `gitleaks exited ${r.status ?? "null"}: ${(r.stderr || "").trim().slice(0, 200)}`,
  };
}

/** Outcome of the secret-scan leg — discriminated so callers never confuse clean vs error. */
export type GitleaksOutcome =
  | { kind: "clean" }
  | { kind: "leaks"; entries: GitleaksEntry[] }
  | { kind: "error"; detail: string };

/** Injectable dependencies (tests). Defaults use the real gitleaks binary. */
export interface ScannerDeps {
  /** Resolve the gitleaks binary path, or `null` when it is not on PATH. */
  resolveGitleaks?: () => string | null;
  /** Run gitleaks over a directory and classify the outcome. */
  runGitleaks?: (bin: string, dir: string) => GitleaksOutcome;
}

/** Compute the block/pass verdict from an aggregated finding list (block-on-fail). */
export function computeVerdict(findings: ScanFinding[]): ScanVerdict {
  const verdict = findings.some(f => BLOCKING_SEVERITIES.has(f.severity))
    ? "block"
    : "pass";
  return { verdict, findings };
}

/**
 * Default gitleaks resolver — `Bun.which` under the compiled binary, `which` under Node.
 * Exported for `hapi security audit` (#3841) so there is one resolver, not two.
 */
export function resolveGitleaksBinary(): string | null {
  if (typeof Bun !== "undefined" && typeof Bun.which === "function") {
    return Bun.which("gitleaks");
  }
  const r = spawnSync("which", ["gitleaks"], { encoding: "utf8" });
  const path = (r.stdout || "").trim();
  return r.status === 0 && path ? path : null;
}

/**
 * Default gitleaks runner — `gitleaks dir <dir> --report-format json --report-path <tmp>`.
 * Uses gitleaks' built-in default ruleset (the compiled binary has no repo `.gitleaks.toml`
 * at runtime; depending on it would be fragile — bundling a config is a follow-up). Exit 0
 * = clean, exit 1 = leaks (parse the report), any other status / spawn error = fail-closed
 * `error`.
 */
function defaultRunGitleaks(bin: string, dir: string): GitleaksOutcome {
  const reportPath = join(
    tmpdir(),
    `hapi-gitleaks-${process.pid}-${Date.now()}.json`
  );
  try {
    const r = spawnSync(
      bin,
      [
        "dir",
        dir,
        "--no-banner",
        "--report-format",
        "json",
        "--report-path",
        reportPath,
      ],
      { encoding: "utf8", timeout: GITLEAKS_TIMEOUT_MS }
    );
    // gitleaks: 0 = clean, 1 = leaks found, anything else = internal error.
    const exit = classifyGitleaksExit(r);
    if (exit.kind !== "leaks") return exit;
    let entries: GitleaksEntry[] = [];
    if (existsSync(reportPath)) {
      let narrowed: GitleaksEntry[] | null;
      try {
        narrowed = narrowGitleaksEntries(
          JSON.parse(readFileSync(reportPath, "utf8"))
        );
      } catch {
        return { kind: "error", detail: "gitleaks report was not valid JSON" };
      }
      if (!narrowed) {
        return {
          kind: "error",
          detail: "gitleaks report was not a JSON array",
        };
      }
      entries = narrowed;
    }
    return { kind: "leaks", entries };
  } catch (err) {
    return { kind: "error", detail: (err as Error).message };
  } finally {
    if (existsSync(reportPath)) rmSync(reportPath, { force: true });
  }
}

/** Recursively collect readable text files under `dir`, bounded by MAX_FILES. */
function collectTextFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    if (out.length >= MAX_FILES) return;
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries) {
      if (out.length >= MAX_FILES) return;
      const full = join(d, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (name === ".git" || name === "node_modules") continue;
        walk(full);
      } else if (st.isFile()) {
        const lower = name.toLowerCase();
        const dot = lower.lastIndexOf(".");
        const ext = dot >= 0 ? lower.slice(dot) : "";
        if (TEXT_EXTENSIONS.has(ext) && st.size <= MAX_FILE_BYTES) {
          out.push(full);
        }
      }
    }
  };
  walk(dir);
  return out;
}

/** Scan a staged extension directory: injection over text files + secret scan over the tree. */
function scanExtensionDir(
  stagedDir: string | undefined,
  deps: Required<ScannerDeps>
): ScanFinding[] {
  const findings: ScanFinding[] = [];
  if (!stagedDir || !existsSync(stagedDir)) {
    // No staged bytes to scan — fail closed (we cannot vouch for content we never saw).
    findings.push({
      severity: "high",
      rule: "scan.staged-dir-missing",
      message:
        "staged extension directory is missing — cannot scan its contents (fail-closed)",
    });
    return findings;
  }

  // Injection heuristics over each text file (relative path in the finding message).
  for (const file of collectTextFiles(stagedDir)) {
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const rel = file.startsWith(stagedDir)
      ? file.slice(stagedDir.length).replace(/^[/\\]/, "")
      : file;
    findings.push(...scanForInjection(content, rel));
  }

  // Secret scan (gitleaks) over the whole staged tree — fail closed when absent/errored.
  findings.push(...runSecretScan(stagedDir, deps));
  return findings;
}

/** The secret-scan leg (gitleaks). Absent binary or execution error → BLOCKING finding (KD2). */
function runSecretScan(
  dir: string,
  deps: Required<ScannerDeps>
): ScanFinding[] {
  const bin = deps.resolveGitleaks();
  if (!bin) {
    return [
      {
        severity: "high",
        rule: "scan.secret-scan-unavailable",
        message:
          "gitleaks is not installed on this host, so the secret scan could not run — failing closed (KD2). Install gitleaks or override this artifact explicitly.",
      },
    ];
  }
  const outcome = deps.runGitleaks(bin, dir);
  if (outcome.kind === "clean") return [];
  if (outcome.kind === "error") {
    logger.warn(`[ext:scan] gitleaks execution error: ${outcome.detail}`);
    return [
      {
        severity: "high",
        rule: "scan.secret-scan-error",
        message: `the secret scan could not complete (${outcome.detail}) — failing closed`,
      },
    ];
  }
  // Leaks found — one finding per entry, with the secret value REDACTED (never surfaced).
  return outcome.entries.map(e => ({
    severity: "critical" as const,
    rule: `secret.${e.RuleID ?? "unknown"}`,
    message: `possible secret detected (${e.Description ?? e.RuleID ?? "gitleaks rule"})${
      e.File ? ` in ${e.File}${e.StartLine ? `:${e.StartLine}` : ""}` : ""
    } — value redacted`,
  }));
}

/**
 * Scan a catalog recipe (defense-in-depth over the schema's `superRefine`, KD1/Task 2).
 * `recipe` is typed loosely because a scanner must be robust to a recipe object built
 * outside the schema (that is exactly the case worth catching).
 */
function scanRecipe(recipe: unknown): ScanFinding[] {
  const findings: ScanFinding[] = [];
  const r = (recipe ?? {}) as {
    method?: string;
    spec?: string;
    pinnedVersion?: string;
    sha256?: string;
  };
  const spec = typeof r.spec === "string" ? r.spec : "";
  const pinned = typeof r.pinnedVersion === "string" ? r.pinnedVersion : "";

  // Unpinned source — every method requires an exact pinnedVersion (never `latest`).
  if (!pinned || pinned.toLowerCase() === "latest") {
    findings.push({
      severity: "high",
      rule: "scan.unpinned-source",
      message:
        "recipe has no exact pinnedVersion (or pins `latest`) — an unpinned source can silently change under you",
    });
  }

  if (r.method === "curl") {
    // curl-pipe-bash / shell-metacharacter injection in the fetch spec.
    if (/\|\s*(?:ba|z|k|da)?sh\b/.test(spec) || /[|;&$`\n<>]/.test(spec)) {
      findings.push({
        severity: "critical",
        rule: "scan.curl-pipe-bash",
        message:
          "curl recipe spec contains a pipe-to-shell / shell metacharacters — a curl|bash install runs arbitrary remote code",
      });
    }
    if (!/^https:\/\//.test(spec)) {
      findings.push({
        severity: "high",
        rule: "scan.unpinned-source",
        message:
          "curl recipe spec is not a pinned https:// URL (never http, never a shell pipeline)",
      });
    }
    if (!r.sha256) {
      findings.push({
        severity: "high",
        rule: "scan.undeclared-hash",
        message:
          "curl recipe declares no sha256 — the fetched artifact's integrity cannot be verified",
      });
    }
  } else if (r.method === "npm") {
    if (pinned && !spec.endsWith(`@${pinned}`)) {
      findings.push({
        severity: "high",
        rule: "scan.unpinned-source",
        message: `npm recipe spec '${spec}' does not carry the exact pinnedVersion (@${pinned})`,
      });
    }
  }

  return findings;
}

/**
 * Build the {@link ScanBeforeInstall} hook. `commands/ext.ts` registers the result via
 * `setScanBeforeInstall(makeSupplyChainScanner())`. Tests inject `deps` to exercise the
 * absent-gitleaks and leaks-found paths deterministically.
 */
export function makeSupplyChainScanner(
  deps?: ScannerDeps
): (staged: StagedInstall) => Promise<ScanVerdict> {
  const resolved: Required<ScannerDeps> = {
    resolveGitleaks: deps?.resolveGitleaks ?? resolveGitleaksBinary,
    runGitleaks: deps?.runGitleaks ?? defaultRunGitleaks,
  };

  return async (staged: StagedInstall): Promise<ScanVerdict> => {
    // R5 — stock-4 exemption (documented; they never traverse this path).
    if (STOCK_4.has(staged.id)) {
      return {
        verdict: "pass",
        findings: [
          {
            severity: "info",
            rule: "scan.stock-exempt",
            message: `'${staged.id}' is a stock harness (baked + pinned at provision, ruling D2) — exempt from the catalog scan gate`,
          },
        ],
      };
    }

    const findings =
      staged.kind === "extension"
        ? scanExtensionDir(staged.stagedDir, resolved)
        : scanRecipe(staged.recipe);

    return computeVerdict(findings);
  };
}
