// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `hapi security audit [--deep] [--fix] [--json] [--repo <path> [--range <base>..<head>]]`
 * — the instance posture audit (issue #3841, epic #3019), the security sibling of
 * `hapi launcher doctor`.
 *
 * Structure mirrors `launcher.ts` `runDoctor`: run the checks → collect findings →
 * print `--json` or a human report → exit with a code a caller can key on:
 *
 *   0 — no `high` finding
 *   1 — at least one `high` finding
 *   2 — the audit could not run (bad arguments, an unreadable data dir or one that is
 *       not an instance data dir, bad --repo/--range)
 *
 * `scripts/preflight-security-audit-v2.sh` (the merge-dev-to-prod pre-flight) keys on
 * these codes and on the {@link AUDIT_SCHEMA} marker, which it also greps for in the
 * deployed binary to decide whether that binary knows this verb at all.
 *
 * 🔒 Load-bearing invariants (expert review 2026-09-19):
 *   - NO SECRET IN ANY OUTPUT (R6). Mode-bit checks read metadata only (`lstat`, plus
 *     `stat` of a symlink's target to report its mode), never file contents; the settings
 *     and account checks parse their files in memory and surface lengths, flags, emails
 *     and uuids — never a token. gitleaks runs with `--redact`, its JSON is read from
 *     stdout (never a report file) and narrowed to its non-secret fields
 *     (`narrowGitleaksEntries`); only `RuleID` / `File` / `StartLine` are surfaced.
 *   - THE CREDENTIAL CHECKS AND THE TOKEN SCAN FAIL CLOSED (`securityFailClosed.ts`): a
 *     credential dir or path, a JSON input (settings, daemon state, an account record, and
 *     under `--deep` an isolated credential file), the account store, the extensions dir or
 *     `hapi.db` that exists but cannot be read or parsed is a `high` finding, never
 *     "nothing found"; only a missing path is silent. The token scan fails closed when
 *     gitleaks logged an error, printed no commit count, or counted a different number of
 *     commits than git finds with content changes, and on a shallow checkout or an octopus
 *     merge — it compares commit totals, not every file (see `scanCoverage`). Merges are
 *     scanned with `--diff-merges=remerge`, every path as text, and a rename as a delete
 *     plus an add (`SCAN_LOG_OPTS`).
 *   - THE DATA DIR IS NEVER A GITLEAKS TARGET. It IS the credential store; scanning it
 *     would report every healthy instance's own tokens. The repo leg scans a COMMIT
 *     RANGE of a checkout passed with `--repo`, never a working tree, never full history.
 *   - `--fix` IS chmod-TIGHTEN + rotate-PROMPT ONLY. It removes group/world bits, keeps
 *     (and if needed restores) owner read/write, refuses symlinks and anything whose
 *     realpath leaves the instance data dir or the account-config dir, and never rotates,
 *     deletes or rewrites anything.
 *   - THE DEFAULT RUN IS READ-ONLY. Each account record is read as a file and checked with
 *     `validateAnyStoredAccount` (what `AccountStore.getAny` does) — never
 *     `AccountStore.list()`, which runs the initial-population migration (a write). Each
 *     JSON input is read once per run (`readJsonFile`).
 *
 * Severities form the ladder `info | low | medium | high`. `info` entries are reported
 * as NOTES, separate from findings: they record what the audit did not or could not
 * evaluate (env drift, the repo leg without `--repo`, a daemon that is down), so a clean
 * instance reports `findings: []` while still saying what it skipped.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";

import { UUID_REGEX } from "@/accounts/accountStore";
import {
  probeAccessToken,
  type ProbeFetchLike,
} from "@/accounts/isolatedSnapshotRecovery";
import { configuration } from "@/configuration";
import {
  classifyGitleaksExit,
  narrowGitleaksEntries,
  resolveGitleaksBinary,
} from "@/ext/supplyChainScan/scanner";
import { resolveDbPath } from "@/ext/sqlite";
import { listScanVerdicts } from "@/ext/supplyChainScan/verdictStore";
import {
  type CredentialBase,
  defaultXdgAccountConfigsDir,
  fixRootDirs,
} from "./securityCredentialBases";
import {
  asRecord,
  errnoCode,
  existsOrReport,
  isAbsentError,
  type JsonRead,
  listOrReport,
  objectInput,
  readAccounts,
  readInputs,
  readJsonFile,
  readRecord,
  SCAN_LOG_OPTS,
  scanCoverage,
  unreadableFinding,
} from "./securityFailClosed";
import {
  defaultGetUid,
  defaultIsPidAlive,
  defaultListInterfaceAddresses,
  defaultReadDaemonEnv,
  defaultRunGit,
  defaultRunGitleaks,
} from "./securitySeams";
import type { CommandDefinition } from "./types";

export { parseEnvBlock } from "./securitySeams";

/**
 * Schema marker carried in every `--json` report. The pre-flight wrapper greps the
 * deployed binary for this exact string to tell a binary that knows `security audit`
 * from one that predates it — an older binary routes the unknown verb to the `claude`
 * default command, so the verb must never be invoked to find out.
 */
export const AUDIT_SCHEMA = "hapi-security-audit:v1";

/** Server default listen port when settings.json carries none (`server/src/configuration.ts`). */
const DEFAULT_WEBAPP_PORT = 3006;
/** Bound on each `--deep` HTTP probe (mirrors `PROBE_TIMEOUT_MS`). */
const DEEP_PROBE_TIMEOUT_MS = 4_000;
/** Default `--range` when `--repo` is given without one: the remote default branch. */
const DEFAULT_RANGE = "origin/HEAD..HEAD";

export type Severity = "info" | "low" | "medium" | "high";
export type FixKind = "chmod" | "rotate-prompt";

export interface Finding {
  /** Stable check id, e.g. `mode-bits`, `token-in-repo`, `gitleaks-unavailable`. */
  id: string;
  severity: Severity;
  /** What is wrong. Never carries a token, a secret match or file contents. */
  message: string;
  /** How to fix it. Same no-secret rule as `message`. */
  fixHint: string;
  /** What `--fix` does about it: `chmod` tightens a mode, `rotate-prompt` only prints guidance. */
  fixable: FixKind | null;
  /** The filesystem path a `mode-bits` finding is about (a path, never its contents). */
  path?: string;
  /** Whether {@link path} is a file or a directory (decides the `--fix` target mode). */
  pathKind?: "file" | "dir";
}

export interface FixResult {
  path: string;
  /** Octal mode before, e.g. `0644`. */
  from: string;
  /** Octal mode after (or the mode `--fix` would have set when refused). */
  to: string;
  status: "fixed" | "refused" | "failed";
  reason?: string;
}

export interface RotatePrompt {
  findingId: string;
  guidance: string;
}

export interface AuditReport {
  schema: typeof AUDIT_SCHEMA;
  instance: { home: string };
  deep: boolean;
  fix: boolean;
  /** Severity `low` and above — what makes an instance not clean. */
  findings: Finding[];
  /** Severity `info` — what was not or could not be evaluated. */
  notes: Finding[];
  fixes: FixResult[];
  prompts: RotatePrompt[];
  summary: Record<Severity, number>;
  exitCode: 0 | 1;
}

/** The instance paths the audit reads. The command fills them from `configuration`. */
export interface AuditPaths {
  happyHomeDir: string;
  settingsFile: string;
  privateKeyFile: string;
  daemonStateFile: string;
  accountsDir: string;
  accountConfigsDir: string;
  /** The server's XDG credential base; the server reads it whatever SHARED says. */
  xdgAccountConfigsDir: string;
  /** `~/.config/hapimatic/account-configs`, the XDG base of a reader with no XDG_CONFIG_HOME. */
  homeAccountConfigsDir: string;
  dbPath: string;
  extensionsDir: string;
}

export interface AuditOptions {
  deep: boolean;
  fix: boolean;
  /** A repo checkout whose `range` the token-in-repo leg scans. Omitted ⇒ leg not evaluated. */
  repo?: string;
  /** `<base>..<head>`; defaults to {@link DEFAULT_RANGE} when `repo` is set. */
  range?: string;
}

/** Result of a finished child process (the shape both seams below return). */
export interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

/** Injectable seams — tests replace these; the defaults touch the real host. */
export interface AuditDeps {
  /** Resolve the gitleaks binary, or `null` when it is not on PATH. */
  resolveGitleaks?: () => string | null;
  /** Run gitleaks with `args`. */
  runGitleaks?: (bin: string, args: string[]) => SpawnResult;
  /** Run `git -C <repo> <args>`. */
  runGit?: (repo: string, args: string[]) => SpawnResult;
  /** True when a process with this pid exists. */
  isPidAlive?: (pid: number) => boolean;
  /** The daemon process's environment, or `null` when it cannot be read. */
  readDaemonEnv?: (pid: number) => Record<string, string> | null;
  /** Non-loopback interface addresses of this host (for the `--deep` exposure probe). */
  listInterfaceAddresses?: () => string[];
  /** fetch for the `--deep` probes. */
  fetchImpl?: ProbeFetchLike;
  /** Clock. */
  now?: () => number;
  /** Real uid of the invoking user (`--fix` refuses paths it does not own). */
  getUid?: () => number | null;
}

/** Thrown when the audit cannot run at all — the command maps it to exit 2. */
export class AuditCannotRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditCannotRunError";
  }
}

// ─────────────────────────────── default seams ───────────────────────────────

function resolveDeps(deps: AuditDeps): Required<AuditDeps> {
  return {
    resolveGitleaks: deps.resolveGitleaks ?? resolveGitleaksBinary,
    runGitleaks: deps.runGitleaks ?? defaultRunGitleaks,
    runGit: deps.runGit ?? defaultRunGit,
    isPidAlive: deps.isPidAlive ?? defaultIsPidAlive,
    readDaemonEnv: deps.readDaemonEnv ?? defaultReadDaemonEnv,
    listInterfaceAddresses:
      deps.listInterfaceAddresses ?? defaultListInterfaceAddresses,
    fetchImpl: deps.fetchImpl ?? fetch,
    now: deps.now ?? Date.now,
    getUid: deps.getUid ?? defaultGetUid,
  };
}

// ─────────────────────────────── helpers ───────────────────────────────

function octal(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, "0")}`;
}

function isUnder(child: string, parent: string): boolean {
  return (
    child === parent ||
    child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
  );
}

/**
 * The server's own weak-token rule (`server/src/config/cliApiToken.ts` `isWeakToken`),
 * mirrored here because `cli/` cannot import the server package.
 */
export function isWeakCliApiToken(token: string): boolean {
  if (token.length < 16) return true;
  return [/^[0-9]+$/, /^(.)\1+$/, /^(abc|123|password|secret|token)/i].some(p =>
    p.test(token)
  );
}

/** Classify an interface address for the exposure probe. */
export function classifyAddress(address: string): "private" | "public" {
  const v4 = address.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 10 || a === 127) return "private";
    if (a === 172 && b >= 16 && b <= 31) return "private";
    if (a === 192 && b === 168) return "private";
    if (a === 100 && b >= 64 && b <= 127) return "private"; // CGNAT, incl. Tailscale
    if (a === 169 && b === 254) return "private";
    return "public";
  }
  const lower = address.toLowerCase();
  if (
    lower === "::1" ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") || // ULA, incl. Tailscale fd7a:115c:a1e0::/48
    lower.startsWith("fe80")
  ) {
    return "private";
  }
  return "public";
}

/** A git ref end of `--range`: no whitespace, no leading `-` (it reaches git argv). */
const REF_RE = /^[A-Za-z0-9._/@{}^~+-]+$/;

/** Split `<base>..<head>`. `null` for anything else (incl. the `...` form). */
export function parseRange(
  range: string
): { base: string; head: string } | null {
  if (range.includes("...")) return null;
  const parts = range.split("..");
  if (parts.length !== 2) return null;
  const [base, head] = parts;
  for (const ref of [base, head]) {
    if (!ref || ref.startsWith("-") || !REF_RE.test(ref)) return null;
  }
  return { base, head };
}

/**
 * The gitleaks argv for a commit-range scan with JSON on stdout. `--log-level info` keeps
 * the `N commits scanned` line the coverage check needs; the log options are the ones the
 * check's own `git log` uses (`SCAN_LOG_OPTS`), so both read the same diffs.
 */
export function buildGitleaksRepoArgs(
  repo: string,
  baseSha: string,
  headSha: string,
  configPath: string | null
): string[] {
  return [
    "git",
    repo,
    "--no-banner",
    "--redact",
    "--log-level",
    "info",
    `--log-opts=${[...SCAN_LOG_OPTS, `${baseSha}..${headSha}`].join(" ")}`,
    "--report-format",
    "json",
    "--report-path",
    "-",
    ...(configPath ? ["--config", configPath] : []),
  ];
}

// ─────────────────────────────── checks ───────────────────────────────

interface ModeTarget {
  path: string;
  kind: "file" | "dir";
  label: string;
}

/** The CHECK set: every secret-bearing path of the instance (expert review 3841-8). */
function modeTargets(
  paths: AuditPaths,
  bases: CredentialBase[],
  unreadable: Finding[]
): ModeTarget[] {
  const targets: ModeTarget[] = [
    {
      path: paths.settingsFile,
      kind: "file",
      label: "settings.json (holds cliApiToken)",
    },
    { path: paths.privateKeyFile, kind: "file", label: "access.key" },
    {
      path: paths.daemonStateFile,
      kind: "file",
      label: "daemon.state.json (holds the daemon controlToken)",
    },
    {
      // The server's JWT signing key (`server/src/config/jwtSecret.ts`): whoever can
      // read it can mint a JWT for this instance.
      path: join(paths.happyHomeDir, "jwt-secret.json"),
      kind: "file",
      label: "jwt-secret.json (the server's JWT signing key)",
    },
    {
      path: paths.accountsDir,
      kind: "dir",
      label: "accounts/ (the credential store)",
    },
  ];
  if (
    existsOrReport(
      paths.accountsDir,
      "accounts/ (the credential store)",
      "its account records",
      unreadable
    )
  ) {
    const names = listOrReport(
      paths.accountsDir,
      "accounts/ (the credential store)",
      "its account records",
      unreadable
    );
    for (const name of names.sort()) {
      if (name.endsWith(".json")) {
        targets.push({
          path: join(paths.accountsDir, name),
          kind: "file",
          label: `accounts/${name}`,
        });
      }
    }
  }
  for (const base of bases) {
    const where = `${base.label}/`;
    if (
      !existsOrReport(base.dir, where, "the credential files in it", unreadable)
    ) {
      continue;
    }
    const names = listOrReport(
      base.dir,
      where,
      "the credential files in it",
      unreadable
    );
    for (const name of names.sort()) {
      if (!UUID_REGEX.test(name)) continue;
      const dir = join(base.dir, name);
      targets.push({
        path: dir,
        kind: "dir",
        label: `${base.label}/${name}/`,
      });
      targets.push({
        path: join(dir, ".credentials.json"),
        kind: "file",
        label: `${base.label}/${name}/.credentials.json`,
      });
    }
  }
  return targets;
}

function checkModeBits(paths: AuditPaths, bases: CredentialBase[]): Finding[] {
  const findings: Finding[] = [];
  for (const t of modeTargets(paths, bases, findings)) {
    let st;
    try {
      st = lstatSync(t.path);
    } catch (err) {
      // Absent: nothing to protect. Anything else: the mode went unchecked.
      if (!isAbsentError(err)) {
        findings.push(unreadableFinding(t.path, t.label, err, "its mode"));
      }
      continue;
    }
    const want = t.kind === "dir" ? "0700" : "0600";
    if (st.isSymbolicLink()) {
      let targetMode = "";
      try {
        targetMode = ` (target mode ${octal(statSync(t.path).mode)})`;
      } catch {
        targetMode = " (dangling)";
      }
      findings.push({
        id: "credential-path-symlink",
        severity: "medium",
        message: `${t.label} is a symlink${targetMode}; the audit does not read or modify credential paths through a link`,
        fixHint: `replace ${t.path} with a regular ${t.kind === "dir" ? "directory" : "file"} at mode ${want} (--fix never follows symlinks)`,
        fixable: null,
        path: t.path,
      });
      continue;
    }
    if ((st.mode & 0o077) !== 0) {
      findings.push({
        id: "mode-bits",
        severity: "high",
        message: `${t.label} is mode ${octal(st.mode)} — group/other can ${t.kind === "dir" ? "reach" : "read"} credential material`,
        fixHint: `chmod ${want.slice(1)} ${t.path} (or run: hapi security audit --fix)`,
        fixable: "chmod",
        path: t.path,
        pathKind: t.kind,
      });
    }
  }
  return findings;
}

const SETTINGS_UNCHECKED = "the cliApiToken strength and CORS checks";

function checkSettings(paths: AuditPaths, read: JsonRead): Finding[] {
  // Not JSON, or JSON that is not an object: the server refuses to start on it.
  const { record: raw, problem } = objectInput(
    read,
    paths.settingsFile,
    "settings.json",
    SETTINGS_UNCHECKED
  );
  if (problem) return [problem];
  if (!raw) {
    return [
      {
        id: "settings-absent",
        severity: "info",
        message:
          "settings.json does not exist yet; the auth and listener checks were not evaluated",
        fixHint:
          "start the instance once so it writes settings.json, then re-run the audit",
        fixable: null,
      },
    ];
  }
  const settings = raw as {
    cliApiToken?: unknown;
    corsOrigins?: unknown;
    webappPort?: unknown;
  };
  const findings: Finding[] = [];
  const port =
    typeof settings.webappPort === "number"
      ? settings.webappPort
      : DEFAULT_WEBAPP_PORT;

  findings.push({
    id: "listener-all-interfaces",
    severity: "info",
    message: `the server listens on every interface on port ${port} (no bind hostname); exposure is decided by the firewall / Tailscale`,
    fixHint: "run with --deep to probe this host's non-loopback addresses",
    fixable: null,
  });

  if (typeof settings.cliApiToken !== "string" || settings.cliApiToken === "") {
    findings.push({
      id: "cli-api-token-absent",
      severity: "info",
      message:
        "settings.json has no cliApiToken; the server takes CLI_API_TOKEN from its environment or generates one at start",
      fixHint:
        "no action unless the server's environment sets a short CLI_API_TOKEN",
      fixable: null,
    });
  } else if (isWeakCliApiToken(settings.cliApiToken)) {
    findings.push({
      id: "cli-api-token-weak",
      severity: "high",
      message: `cliApiToken fails the server's strength rule (length ${settings.cliApiToken.length}, or a trivial pattern) on a listener bound to every interface`,
      fixHint:
        "rotate it: remove cliApiToken from settings.json (and any CLI_API_TOKEN env), restart the server so it generates a 32-byte token, then sign clients in again",
      fixable: "rotate-prompt",
    });
  }

  if (
    Array.isArray(settings.corsOrigins) &&
    settings.corsOrigins.includes("*")
  ) {
    findings.push({
      id: "cors-wildcard",
      severity: "medium",
      message:
        'corsOrigins is "*" — any web origin may call this instance\'s API with a token it holds',
      fixHint:
        "set corsOrigins in settings.json (or CORS_ORIGINS) to the instance's own origins",
      fixable: null,
    });
  }
  return findings;
}

function checkSandbox(
  pid: number | null,
  deps: Required<AuditDeps>
): Finding[] {
  if (pid === null || !deps.isPidAlive(pid)) {
    return [
      {
        id: "sandbox-unknown",
        severity: "info",
        message:
          "the daemon is not running, so the OmniBox sandbox state is unknown",
        fixHint: "start the daemon and re-run the audit",
        fixable: null,
      },
    ];
  }
  const env = deps.readDaemonEnv(pid);
  if (env === null) {
    return [
      {
        id: "sandbox-unknown",
        severity: "info",
        message: `the daemon's environment (pid ${pid}) could not be read, so the OmniBox sandbox state is unknown`,
        fixHint: "run the audit as the user that owns the daemon",
        fixable: null,
      },
    ];
  }
  const on = ["1", "true", "yes"].includes(
    (env.HAPI_OMNIBOX_SANDBOX ?? "").toLowerCase()
  );
  if (on) return [];
  return [
    {
      id: "sandbox-disabled",
      severity: "low",
      message:
        "the OmniBox sandbox is off on the daemon — agents keep the env secrets and unrestricted egress",
      fixHint:
        "after the V1–V7 validation in claudedocs/omnibox-sandbox-runbook.md, set Environment=HAPI_OMNIBOX_SANDBOX=1 on the daemon unit and restart it",
      fixable: null,
    },
  ];
}

function accountLabel(account: Record<string, unknown>): string {
  const email =
    typeof account.emailAddress === "string"
      ? account.emailAddress
      : "(no email)";
  return `${email} (${String(account.accountUuid)})`;
}

function checkAccounts(accounts: {
  records: Array<Record<string, unknown>>;
  invalid: string[];
}): Finding[] {
  const findings: Finding[] = [];
  for (const account of accounts.records) {
    // #3392: `unrefreshable === true` is the authoritative signal. The cached
    // `expiresAt` / `lastRefreshedAt` lag by up to ~24 h and are never a finding.
    if (account.unrefreshable === true) {
      findings.push({
        id: "account-unrefreshable",
        severity: "medium",
        message: `account ${accountLabel(account)} is marked unrefreshable — new sessions cannot bind it`,
        fixHint:
          "sign that account in again (claude /login as that account); Hapimatic re-captures the credentials and clears the flag",
        fixable: null,
      });
    }
  }
  for (const uuid of accounts.invalid) {
    findings.push({
      id: "account-record-invalid",
      severity: "low",
      message: `account record ${uuid} failed validation and is ignored by the store`,
      fixHint: "remove the account in Settings → Accounts and add it again",
      fixable: null,
    });
  }
  return findings;
}

function checkSupplyChain(paths: AuditPaths): Finding[] {
  const findings: Finding[] = [];
  const installed = new Set(
    listOrReport(
      paths.extensionsDir,
      "extensions/",
      "the installed extensions' stored block verdicts",
      findings,
      true
    )
  );
  let verdicts;
  try {
    // Fails closed (#4886 N3): an unreadable or corrupt hapi.db, a failed query or an unknown
    // verdict throws instead of reading as "no verdicts".
    verdicts = listScanVerdicts({ dbPath: paths.dbPath });
  } catch (err) {
    findings.push(
      unreadableFinding(
        paths.dbPath,
        "hapi.db (the extension verdict store)",
        err,
        "the installed extensions' stored block verdicts"
      )
    );
    return findings;
  }
  for (const v of verdicts) {
    if (v.override) {
      findings.push({
        id: "supply-chain-override",
        severity: "info",
        message: `extension '${v.artifactId}' carries a scan override by ${v.override.by} at ${new Date(v.override.at).toISOString()}: ${v.override.reason.slice(0, 200)}`,
        fixHint:
          "review the override; remove the extension if the reason no longer holds",
        fixable: null,
      });
    } else if (v.verdict === "block" && installed.has(v.artifactId)) {
      findings.push({
        id: "supply-chain-blocked",
        severity: "high",
        message: `installed extension '${v.artifactId}' has a stored supply-chain verdict of block (scanned ${new Date(v.scannedAt).toISOString()})`,
        fixHint: `uninstall it (hapi ext uninstall ${v.artifactId}) or review the findings and record an explicit override`,
        fixable: null,
      });
    }
  }
  return findings;
}

function envDriftNote(): Finding {
  return {
    id: "env-drift",
    severity: "info",
    message:
      "env-drift: not-evaluated-on-instance (operator-side: vm-parity-check)",
    fixHint:
      "run infrastructure/cloud-vm/vm-parity-check.sh (or scripts/reconcile-vm.sh) from the operator host",
    fixable: null,
  };
}

function gitleaksUnavailable(): Finding {
  return {
    id: "gitleaks-unavailable",
    severity: "high",
    message:
      "gitleaks is not on PATH, but infrastructure/cloud-vm/vm-parity-manifest.json declares it present on every operator host — the token-in-repo scan cannot run",
    fixHint:
      "install gitleaks (see the parity manifest's gitleaks entry) and re-run the audit",
    fixable: null,
  };
}

/** Resolve a ref end to a commit sha, or throw {@link AuditCannotRunError}. */
function resolveCommit(
  repo: string,
  ref: string,
  deps: Required<AuditDeps>
): string {
  const r = deps.runGit(repo, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${ref}^{commit}`,
  ]);
  const sha = r.stdout.trim();
  if (r.status !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) {
    throw new AuditCannotRunError(
      `--range: '${ref}' does not resolve to a commit in ${repo}`
    );
  }
  return sha;
}

function checkRepo(
  options: AuditOptions,
  gitleaksBin: string | null,
  deps: Required<AuditDeps>
): Finding[] {
  if (options.repo === undefined) {
    return [
      {
        id: "repo-leg-not-evaluated",
        severity: "info",
        message:
          "repo leg not evaluated: no --repo was given, so no commit range was scanned for committed tokens",
        fixHint:
          "pass --repo <checkout> [--range <base>..<head>] to scan a commit range",
        fixable: null,
      },
    ];
  }
  // The repository ROOT, not the --repo argument: a subdirectory is a valid git path, but
  // the allowlist (.gitleaks.toml) lives at the root and gitleaks scans the whole repo.
  const top = deps.runGit(options.repo, ["rev-parse", "--show-toplevel"]);
  const repo = top.status === 0 ? top.stdout.trim() : "";
  if (!repo) {
    throw new AuditCannotRunError(
      `--repo: ${options.repo} is not a git checkout`
    );
  }
  const rangeText = options.range ?? DEFAULT_RANGE;
  const range = parseRange(rangeText);
  if (!range) {
    throw new AuditCannotRunError(
      `--range: '${rangeText}' is not of the form <base>..<head>`
    );
  }
  const baseSha = resolveCommit(repo, range.base, deps);
  const headSha = resolveCommit(repo, range.head, deps);
  // gitleaks-unavailable is reported once by the caller; nothing more to do here.
  if (!gitleaksBin) return [];

  const shortRange = `${baseSha.slice(0, 8)}..${headSha.slice(0, 8)}`;
  const scanError = (detail: string): Finding[] => [
    {
      id: "gitleaks-error",
      severity: "high",
      message: `the token-in-repo scan of ${shortRange} could not complete (${detail.replace(/\s+/g, " ").slice(0, 160)}) — failing closed`,
      fixHint:
        "re-run the audit; if it persists, run gitleaks by hand against the same range",
      fixable: null,
    },
  ];
  const configPath = join(repo, ".gitleaks.toml");
  const r = deps.runGitleaks(
    gitleaksBin,
    buildGitleaksRepoArgs(
      repo,
      baseSha,
      headSha,
      existsSync(configPath) ? configPath : null
    )
  );
  const exit = classifyGitleaksExit(r);
  if (exit.kind === "error") return scanError(exit.detail);
  if (exit.kind === "clean") {
    const why = scanCoverage(deps.runGit, repo, baseSha, headSha, r.stderr);
    return why ? scanError(why) : [];
  }
  let entries;
  try {
    entries = narrowGitleaksEntries(JSON.parse(r.stdout) as unknown);
  } catch {
    entries = null;
  }
  // Exit 1 with no parseable entries is gitleaks failing, not finding nothing.
  if (!entries || entries.length === 0) {
    return scanError("it exited 1 without a parseable leak report");
  }
  return entries.map(e => {
    const where = `${e.File ?? "(unknown file)"}${e.StartLine ? `:${e.StartLine}` : ""}`;
    return {
      id: "token-in-repo",
      severity: "high" as const,
      message: `possible secret (rule ${e.RuleID ?? "unknown"}) committed at ${where} in ${shortRange} — value redacted`,
      fixHint: `rotate the credential matched by rule ${e.RuleID ?? "unknown"} at ${where} with its issuer, then remove it from the branch before merging`,
      fixable: "rotate-prompt" as const,
    };
  });
}

/** `--deep` (a): unauthenticated GET /api/version on every non-loopback address. */
async function probeExposure(
  settingsRead: JsonRead,
  deps: Required<AuditDeps>
): Promise<Finding[]> {
  const settings = readRecord(settingsRead);
  if (settingsRead.kind !== "absent" && !settings) {
    // Never probe the default port in place of an unknown one; the settings check
    // already reported the file as high.
    return [
      {
        id: "exposure-unknown",
        severity: "info",
        message:
          "settings.json could not be read, so the listen port is unknown and the exposure probe was skipped",
        fixHint:
          "repair settings.json (reported above), then re-run with --deep",
        fixable: null,
      },
    ];
  }
  const port =
    typeof settings?.webappPort === "number"
      ? settings.webappPort
      : DEFAULT_WEBAPP_PORT;
  const findings: Finding[] = [];
  let reachable = 0;
  const addresses = deps.listInterfaceAddresses();
  for (const address of addresses) {
    const host = address.includes(":") ? `[${address}]` : address;
    let answered = false;
    try {
      // No credentials of any kind: this probe must never send a token.
      await deps.fetchImpl(`http://${host}:${port}/api/version`, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(DEEP_PROBE_TIMEOUT_MS),
      });
      answered = true;
    } catch {
      answered = false;
    }
    if (!answered) continue;
    reachable++;
    if (classifyAddress(address) === "public") {
      findings.push({
        id: "exposure-public",
        severity: "medium",
        message: `the instance answers unauthenticated requests on public address ${address}:${port}`,
        fixHint:
          "firewall the port to the tailnet / LAN, or confirm the exposure is intended (every data route still requires the token)",
        fixable: null,
      });
    } else {
      findings.push({
        id: "exposure-private",
        severity: "info",
        message: `the instance answers on private address ${address}:${port} (LAN / tailnet)`,
        fixHint: "no action if this network is trusted",
        fixable: null,
      });
    }
  }
  if (reachable === 0) {
    findings.push({
      id: "exposure-none",
      severity: "info",
      message: `no non-loopback address of this host answered on port ${port} (${addresses.length} probed)`,
      fixHint: "no action",
      fixable: null,
    });
  }
  return findings;
}

/** `--deep` (b): probe each Anthropic account's live access token against PROBE_URL only. */
async function probeAccountTokens(
  bases: CredentialBase[],
  accounts: { records: Array<Record<string, unknown>> },
  deps: Required<AuditDeps>
): Promise<Finding[]> {
  const findings: Finding[] = [];
  // Per-outcome tally for the summary note, so a --deep run shows the probe RAN even
  // when every account is healthy (a healthy account otherwise yields no entry).
  const tally = {
    healthy: 0,
    expired: 0,
    rejected: 0,
    inconclusive: 0,
    skipped: 0,
  };
  for (const account of accounts.records) {
    const provider = account.provider;
    if (provider !== undefined && provider !== "anthropic") continue;
    const uuid = String(account.accountUuid);
    // Token source per the #3392 rule: each isolated .credentials.json, then the record.
    let token: string | null = null;
    let expiresAt = 0;
    for (const base of bases) {
      const path = join(base.dir, uuid, ".credentials.json");
      const { record: creds, problem } = objectInput(
        readJsonFile(path),
        path,
        `${base.label}/${uuid}/.credentials.json`,
        "the live probe of its token"
      );
      if (problem) {
        findings.push(problem);
        continue;
      }
      const oauth = asRecord(creds?.claudeAiOauth);
      if (oauth && typeof oauth.accessToken === "string" && oauth.accessToken) {
        token = oauth.accessToken;
        expiresAt = typeof oauth.expiresAt === "number" ? oauth.expiresAt : 0;
        break;
      }
    }
    if (
      !token &&
      typeof account.accessToken === "string" &&
      account.accessToken
    ) {
      token = account.accessToken;
      expiresAt = typeof account.expiresAt === "number" ? account.expiresAt : 0;
    }
    if (!token) {
      tally.skipped++;
      findings.push({
        id: "account-probe-skipped",
        severity: "info",
        message: `account ${accountLabel(account)} has no access token to probe`,
        fixHint: "no action",
        fixable: null,
      });
      continue;
    }
    const outcome = await probeAccessToken(token, {
      fetchImpl: deps.fetchImpl,
      probeTimeoutMs: DEEP_PROBE_TIMEOUT_MS,
    });
    // expiresAt 0 is the env-token "no known expiry" sentinel (#2268), not a timestamp.
    const pastExpiry = expiresAt > 0 && expiresAt <= deps.now();
    if (outcome === "healthy") {
      tally.healthy++;
      continue;
    }
    if (outcome === "revoked" && pastExpiry) {
      tally.expired++;
      findings.push({
        id: "account-token-expired",
        severity: "info",
        message: `account ${accountLabel(account)}'s access token is past its expiry; it refreshes on next use`,
        fixHint: "no action unless the account is also marked unrefreshable",
        fixable: null,
      });
    } else if (outcome === "revoked") {
      tally.rejected++;
      findings.push({
        id: "account-token-revoked",
        severity: "medium",
        message: `the live probe rejected account ${accountLabel(account)}'s access token before its expiry`,
        fixHint: "sign that account in again (claude /login as that account)",
        fixable: null,
      });
    } else {
      tally.inconclusive++;
      findings.push({
        id: "account-probe-inconclusive",
        severity: "info",
        message: `the live probe for account ${accountLabel(account)} was inconclusive (network error, timeout or a non-auth status)`,
        fixHint: "re-run with --deep when the network is up",
        fixable: null,
      });
    }
  }
  const probed =
    tally.healthy + tally.expired + tally.rejected + tally.inconclusive;
  findings.push({
    id: "account-probe-summary",
    severity: "info",
    message: `live account-token probe: ${probed} account(s) probed — ${tally.healthy} healthy, ${tally.expired} past expiry, ${tally.rejected} rejected, ${tally.inconclusive} inconclusive${tally.skipped ? `, ${tally.skipped} without a token` : ""}`,
    fixHint: "see the per-account entries for anything not healthy",
    fixable: null,
  });
  return findings;
}

// ─────────────────────────────── --fix ───────────────────────────────

/**
 * Tighten one path's mode. Removes every group/other bit, keeps every owner bit and
 * guarantees owner read/write (files) or read/write/search (dirs) so the instance can
 * still use its own store. Refuses symlinks, paths whose realpath leaves `roots`, paths
 * under `~/.claude`, and paths the invoking user does not own.
 */
export function applyChmodFix(
  path: string,
  kind: "file" | "dir",
  roots: string[],
  getUid: () => number | null
): FixResult {
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    return {
      path,
      from: "?",
      to: "?",
      status: "failed",
      reason: (err as Error).message,
    };
  }
  const from = octal(st.mode);
  const ownerBits = st.mode & 0o700;
  const targetMode = ownerBits | (kind === "dir" ? 0o700 : 0o600);
  const to = octal(targetMode);
  const refuse = (reason: string): FixResult => ({
    path,
    from,
    to,
    status: "refused",
    reason,
  });

  if (st.isSymbolicLink())
    return refuse("is a symlink — --fix never chmods through a link");
  let real: string;
  try {
    real = realpathSync(path);
  } catch (err) {
    return { path, from, to, status: "failed", reason: (err as Error).message };
  }
  const realRoots = roots.filter(r => existsSync(r)).map(r => realpathSync(r));
  if (!realRoots.some(r => isUnder(real, r))) {
    return refuse(
      `resolves to ${real}, outside the instance data dir and the account-config dir`
    );
  }
  const claudeDir = join(homedir(), ".claude");
  const realClaude = existsSync(claudeDir)
    ? realpathSync(claudeDir)
    : claudeDir;
  if (isUnder(real, realClaude))
    return refuse("is under ~/.claude, which this audit never modifies");
  const uid = getUid();
  if (uid !== null && st.uid !== uid)
    return refuse(`is owned by uid ${st.uid}, not the invoking user`);
  // Invariant: the new mode grants nothing to group/other and drops no owner bit.
  if ((targetMode & 0o077) !== 0 || (targetMode & ownerBits) !== ownerBits) {
    return refuse("internal invariant violated — refusing");
  }
  try {
    chmodSync(path, targetMode);
    const after = lstatSync(path).mode & 0o777;
    if (after !== targetMode) {
      return {
        path,
        from,
        to,
        status: "failed",
        reason: `mode is ${octal(after)} after chmod`,
      };
    }
  } catch (err) {
    return { path, from, to, status: "failed", reason: (err as Error).message };
  }
  return { path, from, to, status: "fixed" };
}

function rotateGuidance(f: Finding): string {
  return `${f.message.replace(/ — value redacted$/, "")}. ${f.fixHint}. This audit never rotates, deletes or rewrites history on its own.`;
}

// ─────────────────────────────── the audit ───────────────────────────────

/** Run every check and (with `fix`) the safe fixes. Throws {@link AuditCannotRunError}. */
export async function runSecurityAudit(
  options: AuditOptions,
  paths: AuditPaths,
  depsIn: AuditDeps = {}
): Promise<AuditReport> {
  const deps = resolveDeps(depsIn);

  let homeStat;
  try {
    homeStat = statSync(paths.happyHomeDir);
    readdirSync(paths.happyHomeDir);
  } catch (err) {
    throw new AuditCannotRunError(
      `the instance data dir ${paths.happyHomeDir} cannot be read (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})`
    );
  }
  if (!homeStat.isDirectory()) {
    throw new AuditCannotRunError(
      `the instance data dir ${paths.happyHomeDir} is not a directory`
    );
  }
  // The CLI's `configuration` singleton creates a missing HAPI_HOME (and its logs/) before
  // any command runs, so a mistyped home arrives here holding only logs/. Refuse one
  // that holds none of an instance's own files instead of auditing it as clean.
  if (
    ![paths.settingsFile, paths.daemonStateFile, paths.accountsDir].some(p =>
      existsSync(p)
    )
  ) {
    throw new AuditCannotRunError(
      `${paths.happyHomeDir} is not a Hapimatic instance data dir (no settings.json, daemon.state.json or accounts/) — check HAPI_HOME`
    );
  }

  const gitleaksBin = deps.resolveGitleaks();
  const inputs = readInputs(paths);
  const accounts = readAccounts(paths);

  const checked: Finding[] = [
    ...inputs.problems,
    ...checkModeBits(paths, inputs.bases),
    ...checkSettings(paths, inputs.settings),
    ...checkSandbox(inputs.daemonPid, deps),
    ...accounts.problems,
    ...checkAccounts(accounts),
    ...checkSupplyChain(paths),
    envDriftNote(),
    ...(gitleaksBin ? [] : [gitleaksUnavailable()]),
    ...checkRepo(options, gitleaksBin, deps),
  ];
  if (options.deep) {
    checked.push(...(await probeExposure(inputs.settings, deps)));
    checked.push(...(await probeAccountTokens(inputs.bases, accounts, deps)));
  }
  // A path two checks could not read (the mode check's lstat and a JSON read) is reported once.
  const unreadablePaths = new Set<string>();
  const all = checked.filter(f => {
    if (f.id !== "path-unreadable" || !f.path) return true;
    if (unreadablePaths.has(f.path)) return false;
    unreadablePaths.add(f.path);
    return true;
  });

  const fixes: FixResult[] = [];
  const prompts: RotatePrompt[] = [];
  let remaining = all;
  if (options.fix) {
    const roots = [paths.happyHomeDir, ...fixRootDirs(inputs.bases)];
    const fixed = new Set<string>();
    for (const f of all) {
      if (f.fixable === "chmod" && f.path && f.pathKind) {
        const result = applyChmodFix(f.path, f.pathKind, roots, deps.getUid);
        fixes.push(result);
        if (result.status === "fixed") fixed.add(f.path);
      } else if (f.fixable === "rotate-prompt") {
        prompts.push({ findingId: f.id, guidance: rotateGuidance(f) });
      }
    }
    remaining = all.filter(
      f => !(f.fixable === "chmod" && f.path && fixed.has(f.path))
    );
  }

  const order: Record<Severity, number> = {
    high: 0,
    medium: 1,
    low: 2,
    info: 3,
  };
  remaining.sort((a, b) => order[a.severity] - order[b.severity]);
  const findings = remaining.filter(f => f.severity !== "info");
  const notes = remaining.filter(f => f.severity === "info");
  const summary: Record<Severity, number> = {
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  for (const f of remaining) summary[f.severity]++;

  return {
    schema: AUDIT_SCHEMA,
    instance: { home: paths.happyHomeDir },
    deep: options.deep,
    fix: options.fix,
    findings,
    notes,
    fixes,
    prompts,
    summary,
    exitCode: summary.high > 0 ? 1 : 0,
  };
}

// ─────────────────────────────── output ───────────────────────────────

const LABEL: Record<Severity, string> = {
  high: "HIGH",
  medium: "MEDIUM",
  low: "LOW",
  info: "INFO",
};

export function renderHuman(report: AuditReport): string[] {
  const lines: string[] = [];
  lines.push(
    `hapi security audit — instance ${report.instance.home}${report.deep ? " (--deep)" : ""}`
  );
  lines.push("");
  if (report.findings.length === 0) {
    lines.push("No findings.");
  }
  for (const severity of ["high", "medium", "low"] as const) {
    const group = report.findings.filter(f => f.severity === severity);
    if (group.length === 0) continue;
    lines.push(`${LABEL[severity]} (${group.length})`);
    for (const f of group) {
      lines.push(`  [${f.id}] ${f.message}`);
      lines.push(`      fix: ${f.fixHint}`);
    }
    lines.push("");
  }
  if (report.notes.length > 0) {
    if (report.findings.length === 0) lines.push("");
    lines.push(`Notes (${report.notes.length})`);
    for (const n of report.notes) {
      lines.push(`  [${n.id}] ${n.message}`);
    }
    lines.push("");
  }
  if (report.fixes.length > 0) {
    lines.push("Fixes (--fix: chmod only)");
    for (const x of report.fixes) {
      const detail = x.reason ? ` — ${x.reason}` : "";
      lines.push(
        `  ${x.status.toUpperCase()} ${x.from} → ${x.to}  ${x.path}${detail}`
      );
    }
    lines.push("");
  }
  if (report.prompts.length > 0) {
    lines.push("Rotation needed (NOT performed — act on these yourself)");
    for (const p of report.prompts) {
      lines.push(`  [${p.findingId}] ${p.guidance}`);
    }
    lines.push("");
  }
  const s = report.summary;
  lines.push(
    `Result: ${s.high} high, ${s.medium} medium, ${s.low} low, ${s.info} notes — exit ${report.exitCode}`
  );
  return lines;
}

// ─────────────────────────────── command ───────────────────────────────

interface ParsedAuditArgs {
  json: boolean;
  options: AuditOptions;
  help: boolean;
}

export function parseAuditArgs(args: string[]): ParsedAuditArgs {
  const parsed: ParsedAuditArgs = {
    json: false,
    help: false,
    options: { deep: false, fix: false },
  };
  const takeValue = (flag: string, i: number): [string, number] => {
    const arg = args[i];
    const [value, at] = arg.startsWith(`${flag}=`)
      ? [arg.slice(flag.length + 1), i]
      : [args[i + 1], i + 1];
    // An empty value (an unset shell variable) must not silently skip the leg.
    if (value === undefined || value === "" || value.startsWith("-")) {
      throw new AuditCannotRunError(`${flag} needs a value`);
    }
    return [value, at];
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json" || arg === "-j") parsed.json = true;
    else if (arg === "--deep") parsed.options.deep = true;
    else if (arg === "--fix") parsed.options.fix = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--repo" || arg.startsWith("--repo=")) {
      const [v, j] = takeValue("--repo", i);
      parsed.options.repo = v;
      i = j;
    } else if (arg === "--range" || arg.startsWith("--range=")) {
      const [v, j] = takeValue("--range", i);
      parsed.options.range = v;
      i = j;
    } else {
      throw new AuditCannotRunError(`unknown argument '${arg}'`);
    }
  }
  if (parsed.options.range !== undefined && parsed.options.repo === undefined) {
    throw new AuditCannotRunError("--range needs --repo");
  }
  return parsed;
}

function printHelp(isError: boolean): number {
  const out = isError ? console.error : console.log;
  out(
    "Usage: hapi security audit [--deep] [--fix] [--json] [--repo <path> [--range <base>..<head>]]"
  );
  out("");
  out("Instance posture audit (beside `hapi launcher doctor`). Checks:");
  out(
    "  mode bits on settings.json, access.key, daemon.state.json, jwt-secret.json, accounts/ and the"
  );
  out(
    "  isolated account-config dirs; cliApiToken strength and CORS; the daemon's OmniBox"
  );
  out(
    "  sandbox; unrefreshable accounts; installed extensions with a stored block verdict;"
  );
  out(
    "  gitleaks availability; and, with --repo, committed tokens in a commit range."
  );
  out("");
  out(
    "  --deep              Also probe this host's non-loopback addresses (no credentials)"
  );
  out("                      and each account's live access token.");
  out(
    "  --fix               Tighten bad mode bits (chmod only) and print rotation guidance"
  );
  out(
    "                      for leaked tokens. Never rotates, deletes or rewrites anything."
  );
  out("  --json              Machine-readable report.");
  out(
    `  --repo <path>       Scan a commit range of this checkout (default ${DEFAULT_RANGE}).`
  );
  out(
    "  --range <a>..<b>    The commit range for --repo. Never a working tree or full history."
  );
  out("");
  out(
    "Exit codes: 0 no high finding · 1 at least one high finding · 2 the audit could not run"
  );
  return isError ? 2 : 0;
}

function defaultPaths(): AuditPaths {
  return {
    happyHomeDir: configuration.happyHomeDir,
    settingsFile: configuration.settingsFile,
    privateKeyFile: configuration.privateKeyFile,
    daemonStateFile: configuration.daemonStateFile,
    accountsDir: configuration.accountsDir,
    accountConfigsDir: configuration.accountConfigsDir,
    xdgAccountConfigsDir: defaultXdgAccountConfigsDir(),
    homeAccountConfigsDir: join(
      homedir(),
      ".config",
      "hapimatic",
      "account-configs"
    ),
    dbPath: resolveDbPath(),
    extensionsDir: join(configuration.happyHomeDir, "extensions"),
  };
}

/**
 * The `security audit` command. Exits only 0 / 1 / 2 (#4886 N3): an error other than
 * {@link AuditCannotRunError} is reported as one the audit could not run, by its name and
 * code only — never its message, which the pre-flight would copy into the merge log.
 * `run` is a test seam.
 */
export async function runAuditCommand(
  args: string[],
  run: typeof runSecurityAudit = runSecurityAudit
): Promise<number> {
  let parsed: ParsedAuditArgs;
  try {
    parsed = parseAuditArgs(args);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    console.error("");
    return printHelp(true);
  }
  if (parsed.help) return printHelp(false);
  try {
    const report = await run(parsed.options, defaultPaths());
    if (parsed.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      for (const line of renderHuman(report)) console.log(line);
    }
    return report.exitCode;
  } catch (err) {
    const message =
      err instanceof AuditCannotRunError
        ? err.message
        : `unexpected error (${errnoCode(err)})`;
    if (parsed.json) {
      console.log(
        JSON.stringify(
          { schema: AUDIT_SCHEMA, error: message, exitCode: 2 },
          null,
          2
        )
      );
    } else {
      console.error(`hapi security audit could not run: ${message}`);
    }
    return 2;
  }
}

export const securityCommand: CommandDefinition = {
  name: "security",
  requiresRuntimeAssets: false,
  run: async ({ commandArgs }) => {
    const sub = commandArgs[0];
    const rest = commandArgs.slice(1);
    let exit: number;
    if (sub === "audit") {
      exit = await runAuditCommand(rest);
    } else if (
      sub === undefined ||
      sub === "--help" ||
      sub === "-h" ||
      sub === "help"
    ) {
      exit = printHelp(false);
    } else {
      console.error(`Error: unknown subcommand '${sub}'`);
      console.error("");
      exit = printHelp(true);
    }
    process.exit(exit);
  },
};
