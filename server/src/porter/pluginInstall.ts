// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Configuration Porter — plugin install executor (issue #2465, epic #2339 Sub G,
 * Tasks 3 + 4 / R1, R2, R4, R5, R7, R8).
 *
 * Given a recorded {@link PluginDescriptor} (marketplaces + plugin identifiers,
 * read straight from the imported archive — never re-derived on the destination,
 * R7), reconstitute the marketplaces (`claude plugin marketplace add`) and install
 * the plugins (`claude plugin install <name>@<marketplace> --scope user`) on the
 * destination. This is the porter's ONLY network-install-execution surface, so it
 * runs behind a default-OFF gate ({@link ../config/porterPluginInstallConfig}) and
 * a marketplace trust allowlist ({@link ./pluginTrust}).
 *
 * Trust + safety controls (all enforced here):
 *  - **Allowlist (R3)**: only marketplaces on the trust allowlist are added; an
 *    unrecognized source is reported + skipped, never silently added, and its
 *    plugins are marked not-installed with a reason.
 *  - **argv-only shell-out**: every `claude` invocation goes through
 *    {@link https://nodejs.org/api/child_process.html execFile} with an ARGUMENT
 *    ARRAY (never a shell string) — no shell-injection surface. The descriptor's
 *    name/source fields are ALSO schema-validated (kebab / valid source) at parse
 *    time; this executor re-validates pre-exec as defense in depth (imports the
 *    single-owner {@link PLUGIN_NAME_PATTERN} / {@link isValidMarketplaceSource}
 *    rather than re-deriving them) because argument-array spawning stops shell
 *    injection but NOT flag confusion (a leading-dash positional parses as a flag).
 *  - **State-verified success (E3/E7)**: install/add success is confirmed via
 *    `claude plugin {list,marketplace list} --json` state, NOT the exit code —
 *    a help-triggering token can exit 0 without installing, and an already-added
 *    marketplace / already-installed plugin (idempotent re-import) is a success
 *    even if the add/install command returns non-zero.
 *  - **Non-fatal (R4)**: a marketplace-add or plugin-install failure is recorded
 *    and execution CONTINUES; nothing thrown out of the per-item loop.
 *  - **Per-command timeout (F6)**: every network `claude` call has a timeout; a
 *    timed-out command is recorded as a failure. Captured stdout/stderr is
 *    truncated before it enters the result.
 *  - **Secret coherence (R5, Task 4)**: the executor NEVER writes a secret value
 *    anywhere (structural guarantee — there is no secret-write code path). After
 *    a successful install it inventories the plugin's bundled MCP servers (from
 *    `claude plugin list --json` `mcpServers`) and flags a plugin `reAuthRequired`
 *    when a bundled server has a secret-bearing field that is empty or references
 *    an unresolved `${VAR}` — with a carve-out so a server whose secret resolves
 *    via `${VAR}` expansion from the ported env is NOT false-flagged.
 *  - **Version drift (R8)**: `claude plugin install` has no version-pin flag
 *    (CC #62446). The executor installs the marketplace-resolved version and
 *    records recorded-vs-installed drift — it never claims a pin it did not make.
 *
 * The child-process pattern mirrors `server/src/utils/mcpPoller.ts`
 * (`execFile`, `findClaudePath`), the repo's server-side convention. It targets
 * the HOST config root (no `HOME`/`CLAUDE_CONFIG_DIR` override — OR-4 settled:
 * `plugins`/`settings.json` are host-symlinked for isolated accounts, so a
 * host-root install propagates to bound accounts).
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import {
  PLUGIN_NAME_PATTERN,
  isValidMarketplaceSource,
  type PluginDescriptor,
} from "@hapi/protocol/porter";
import { isMarketplaceTrusted, stripMarketplaceRef } from "./pluginTrust";
import type { PluginInstallResult } from "@hapi/protocol/porter";
// #5601: the wire shapes live in @hapi/protocol/porter (importWire.ts).
export type {
  MarketplaceStatus,
  MarketplaceOutcome,
  InstalledPluginRecord,
  SkippedPluginRecord,
  FailedItemKind,
  FailedRecord,
  ReAuthRecord,
  VersionDriftRecord,
  PluginInstallResult,
} from "@hapi/protocol/porter";

/* ── Result shapes ── */

/* ── Injectable command runner (mocked in tests) ── */

/** Raw outcome of one `claude` invocation. */
export interface CommandOutcome {
  /** True when the process exited 0. NOT the sole success signal (see E3/E7). */
  ok: boolean;
  /** Exit code, or null when the process was killed / failed to spawn. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** The secret-free command string, for reporting. */
  command: string;
}

/**
 * Runs a single `claude` subcommand. Injected in tests to mock the binary; the
 * default ({@link defaultClaudeRunner}) shells out via `execFile`.
 */
export type ClaudeRunner = (args: string[]) => Promise<CommandOutcome>;

export interface ExecutePluginInstallOptions {
  /** Resolved trust allowlist (defaults + operator-confirmed extras). */
  trustAllowlist: readonly string[];
  /** Command runner; default shells out to `claude` via `execFile`. */
  runClaude?: ClaudeRunner;
  /**
   * Env used to resolve `${VAR}` references in bundled MCP-server secret fields
   * (Task 4). Defaults to `process.env`. A `${VAR}` present here counts as
   * resolved (NOT flagged for re-auth).
   */
  secretResolutionEnv?: Record<string, string | undefined>;
  /** Per-command timeout in ms (default {@link DEFAULT_COMMAND_TIMEOUT_MS}). */
  timeoutMs?: number;
  /** Explicit `claude` binary path; default resolves via {@link findClaudeBinary}. */
  claudePath?: string;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const MAX_CAPTURED_OUTPUT = 4_000;

/* ── Default runner (execFile) ── */

/** Truncate captured stdout/stderr so it never bloats the ImportResult (F6). */
function truncateOutput(s: string): string {
  if (s.length <= MAX_CAPTURED_OUTPUT) return s;
  return s.slice(0, MAX_CAPTURED_OUTPUT) + "\n…[truncated]";
}

/**
 * Locate the `claude` binary. Mirrors `mcpPoller.ts` `findClaudePath`: explicit
 * `HAPI_CLAUDE_PATH`, then Bun's PATH resolution, then well-known install dirs
 * (systemd daemons have a minimal PATH).
 */
export function findClaudeBinary(): string | null {
  const envPath = process.env.HAPI_CLAUDE_PATH;
  if (envPath && envPath.startsWith("/") && existsSync(envPath)) return envPath;
  // Bun.which is available in the server runtime (Bun) and bun:test.
  const fromPath =
    typeof Bun !== "undefined" && typeof Bun.which === "function"
      ? Bun.which("claude")
      : null;
  if (fromPath) return fromPath;
  const home = homedir();
  for (const p of [
    `${home}/.local/bin/claude`,
    `${home}/.npm-global/bin/claude`,
    "/usr/local/bin/claude",
  ]) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Build the default `execFile`-based runner. Targets the host config root (no
 * `HOME`/`CLAUDE_CONFIG_DIR` override — OR-4). Args are passed as an ARRAY (no
 * shell), so a marketplace/plugin identifier can never inject a shell command.
 */
export function defaultClaudeRunner(
  claudePath: string,
  timeoutMs: number
): ClaudeRunner {
  return (args: string[]) =>
    new Promise<CommandOutcome>(resolve => {
      const command = `claude ${args.join(" ")}`;
      execFile(
        claudePath,
        args,
        { timeout: timeoutMs, encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) => {
          // execFile's callback error is an ExecFileException; on a timeout it
          // sets `killed: true` (the process was SIGTERM'd at the timeout).
          const timedOut = Boolean(
            error && (error as { killed?: boolean }).killed
          );
          const rawCode = error
            ? (error as unknown as { code?: unknown }).code
            : 0;
          const code = typeof rawCode === "number" ? rawCode : null;
          resolve({
            ok: !error,
            code,
            stdout: truncateOutput(stdout ?? ""),
            stderr: truncateOutput(
              (stderr ?? "") ||
                (error && !timedOut ? String((error as Error).message) : "")
            ),
            timedOut,
            command,
          });
        }
      );
    });
}

/* ── JSON state parsers (real `claude plugin … --json` shapes) ── */

interface MarketplaceListEntry {
  name: string;
  repo?: string;
  path?: string;
}

interface PluginListEntry {
  /** `<name>@<marketplace>`. */
  id: string;
  name: string;
  marketplace: string;
  version: string | null;
  mcpServers: Record<string, unknown> | null;
}

/** Parse `claude plugin marketplace list --json`; tolerant, returns [] on garbage. */
export function parseMarketplaceListJson(
  stdout: string
): MarketplaceListEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: MarketplaceListEntry[] = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") continue;
    const obj = raw as Record<string, unknown>;
    if (typeof obj.name !== "string") continue;
    out.push({
      name: obj.name,
      repo: typeof obj.repo === "string" ? obj.repo : undefined,
      path: typeof obj.path === "string" ? obj.path : undefined,
    });
  }
  return out;
}

/**
 * Parse `claude plugin list --json`. Splits the `id` (`name@marketplace`) on the
 * LAST `@` so a name never absorbs the marketplace. Tolerant: [] on garbage,
 * skips malformed entries.
 */
export function parsePluginListJson(stdout: string): PluginListEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: PluginListEntry[] = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") continue;
    const obj = raw as Record<string, unknown>;
    if (typeof obj.id !== "string") continue;
    const at = obj.id.lastIndexOf("@");
    if (at <= 0 || at === obj.id.length - 1) continue;
    out.push({
      id: obj.id,
      name: obj.id.slice(0, at),
      marketplace: obj.id.slice(at + 1),
      version: typeof obj.version === "string" ? obj.version : null,
      mcpServers:
        obj.mcpServers && typeof obj.mcpServers === "object"
          ? (obj.mcpServers as Record<string, unknown>)
          : null,
    });
  }
  return out;
}

/* ── Task 4 — bundled-MCP-server secret classification (pure) ── */

/** Every `${VAR}` reference in a string (VAR = the captured name). */
function envRefs(value: string): string[] {
  const out: string[] = [];
  const re = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) out.push(m[1]);
  return out;
}

/** True when `value` has a `${VAR}` whose VAR is absent from `env` (unresolved). */
function hasUnresolvedRef(
  value: string,
  env: Record<string, string | undefined>
): boolean {
  return envRefs(value).some(name => env[name] === undefined);
}

/**
 * Classify ONE plugin's bundled MCP servers, returning the servers whose
 * secret-bearing fields are unresolved (empty, or an unresolved `${VAR}`). A
 * field that resolves via `${VAR}` expansion from `env` is NOT flagged (the
 * directive's explicit no-false-flag carve-out). Pure + fully unit-testable.
 *
 * Secret-bearing fields scanned: every `env` and `headers` value (the standard
 * secret carriers), plus `url` and each `args[]` string (F8: tokens hide there).
 */
export function classifyPluginMcpSecrets(
  mcpServers: Record<string, unknown> | null | undefined,
  env: Record<string, string | undefined>
): { server: string; missingFields: string[] }[] {
  if (!mcpServers || typeof mcpServers !== "object") return [];
  const out: { server: string; missingFields: string[] }[] = [];
  for (const [server, rawCfg] of Object.entries(mcpServers)) {
    if (!rawCfg || typeof rawCfg !== "object") continue;
    const cfg = rawCfg as Record<string, unknown>;
    const missing: string[] = [];

    // env / headers: empty value OR unresolved ${VAR} → missing secret.
    for (const bag of ["env", "headers"] as const) {
      const map = cfg[bag];
      if (!map || typeof map !== "object") continue;
      for (const [key, val] of Object.entries(map as Record<string, unknown>)) {
        if (typeof val !== "string") continue;
        if (val.trim() === "" || hasUnresolvedRef(val, env)) {
          missing.push(`${bag}.${key}`);
        }
      }
    }
    // url: only an UNRESOLVED ${VAR} counts (a plain literal URL is not a secret).
    if (typeof cfg.url === "string" && hasUnresolvedRef(cfg.url, env)) {
      missing.push("url");
    }
    // args[i]: an unresolved ${VAR} in a positional arg.
    if (Array.isArray(cfg.args)) {
      cfg.args.forEach((a, i) => {
        if (typeof a === "string" && hasUnresolvedRef(a, env)) {
          missing.push(`args[${i}]`);
        }
      });
    }

    if (missing.length > 0) out.push({ server, missingFields: missing });
  }
  return out;
}

/* ── Executor ── */

/**
 * Execute the plugin descriptor's marketplace-adds + installs on the destination.
 * NEVER throws out of the per-item loops (R4); a per-item failure is recorded. The
 * caller (`commitImport`) still wraps the whole call in a catch-all so even an
 * unexpected internal throw folds into a failure rather than reaching #2343's
 * backup-restore.
 */
export async function executePluginInstall(
  descriptor: PluginDescriptor,
  opts: ExecutePluginInstallOptions
): Promise<PluginInstallResult> {
  const result: PluginInstallResult = {
    marketplaces: [],
    installed: [],
    skipped: [],
    failed: [],
    reAuthRequired: [],
    versionDrift: [],
  };
  const env = opts.secretResolutionEnv ?? process.env;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;

  // Resolve the runner. If no binary is found, every item fails (non-fatal).
  let runClaude = opts.runClaude;
  if (!runClaude) {
    const claudePath = opts.claudePath ?? findClaudeBinary();
    if (!claudePath) {
      const reason = "`claude` binary not found on the server PATH";
      for (const m of descriptor.marketplaces) {
        result.marketplaces.push({
          name: m.name,
          source: m.source,
          status: "failed",
          pinnedRef: stripMarketplaceRef(m.source).ref,
          reason,
        });
      }
      for (const p of descriptor.plugins) {
        result.failed.push({
          kind: "plugin",
          identifier: `${p.name}@${p.marketplace}`,
          command: null,
          reason,
        });
      }
      return result;
    }
    runClaude = defaultClaudeRunner(claudePath, timeoutMs);
  }

  // Marketplace names that are present ON THE DESTINATION now (pre-existing /
  // auto-added). Lowercased for case-insensitive membership.
  const present = await queryPresentMarketplaces(runClaude);

  // Track marketplace name → disposition for the plugin phase.
  const untrusted = new Set<string>(); // marketplace names we refused to add
  const addFailed = new Set<string>(); // marketplace names whose add failed

  // ── Marketplace phase ──
  for (const m of descriptor.marketplaces) {
    const { ref } = stripMarketplaceRef(m.source);
    const nameKey = m.name.toLowerCase();

    // Pre-exec validation (defense in depth; schema already enforced these).
    if (
      !PLUGIN_NAME_PATTERN.test(m.name) ||
      !isValidMarketplaceSource(m.source)
    ) {
      result.marketplaces.push({
        name: m.name,
        source: m.source,
        status: "failed",
        pinnedRef: ref,
        reason: "invalid marketplace name or source shape (rejected pre-exec)",
      });
      addFailed.add(nameKey);
      continue;
    }

    // Trust gate (R3): only allowlisted sources may be ADDED.
    if (!isMarketplaceTrusted(m.source, opts.trustAllowlist)) {
      result.marketplaces.push({
        name: m.name,
        source: m.source,
        status: "skipped-untrusted",
        pinnedRef: ref,
        reason: "source is not on the marketplace trust allowlist",
      });
      untrusted.add(nameKey);
      continue;
    }

    // Idempotent: already present ⇒ success without re-adding (E7).
    if (present.has(nameKey) || present.has(marketplaceRepoKey(m.source))) {
      result.marketplaces.push({
        name: m.name,
        source: m.source,
        status: "already-present",
        pinnedRef: ref,
      });
      present.add(nameKey);
      continue;
    }

    // Add the marketplace (with the ref, so the pin lands), then verify via state.
    const outcome = await runClaude(["plugin", "marketplace", "add", m.source]);
    const nowPresent = await queryPresentMarketplaces(runClaude);
    const added =
      nowPresent.has(nameKey) || nowPresent.has(marketplaceRepoKey(m.source));
    if (added) {
      result.marketplaces.push({
        name: m.name,
        source: m.source,
        status: "added",
        pinnedRef: ref,
      });
      nowPresent.forEach(n => present.add(n));
      present.add(nameKey);
    } else {
      const addFailReason = failureReason(outcome, "marketplace add");
      result.marketplaces.push({
        name: m.name,
        source: m.source,
        status: "failed",
        pinnedRef: ref,
        reason: addFailReason,
      });
      result.failed.push({
        kind: "marketplace",
        identifier: m.source,
        command: outcome.command,
        reason: addFailReason,
      });
      addFailed.add(nameKey);
    }
  }

  // ── Plugin phase ──
  for (const p of descriptor.plugins) {
    const id = `${p.name}@${p.marketplace}`;
    const mkKey = p.marketplace.toLowerCase();

    // Pre-exec validation of BOTH identifiers (defense in depth).
    if (
      !PLUGIN_NAME_PATTERN.test(p.name) ||
      !PLUGIN_NAME_PATTERN.test(p.marketplace)
    ) {
      result.failed.push({
        kind: "plugin",
        identifier: id,
        command: null,
        reason: "invalid plugin or marketplace name shape (rejected pre-exec)",
      });
      continue;
    }

    // Marketplace disposition gates the install.
    if (untrusted.has(mkKey)) {
      result.skipped.push({
        name: p.name,
        marketplace: p.marketplace,
        reason: `marketplace '${p.marketplace}' is not on the trust allowlist (skipped, so its plugins are not installed)`,
      });
      continue;
    }
    if (!present.has(mkKey)) {
      result.failed.push({
        kind: "plugin",
        identifier: id,
        command: null,
        reason: addFailed.has(mkKey)
          ? `marketplace '${p.marketplace}' add failed, so its plugins could not be installed`
          : `marketplace '${p.marketplace}' is not available on the destination (not recorded and not pre-existing)`,
      });
      continue;
    }

    // Install, then CONFIRM via `plugin list --json` state (not exit code, E3).
    const outcome = await runClaude([
      "plugin",
      "install",
      id,
      "--scope",
      "user",
    ]);
    const entry = await findInstalledPlugin(runClaude, p.name, p.marketplace);
    if (!entry) {
      result.failed.push({
        kind: "plugin",
        identifier: id,
        command: outcome.command,
        reason: failureReason(outcome, "plugin install"),
      });
      continue;
    }

    result.installed.push({
      name: p.name,
      marketplace: p.marketplace,
      installedVersion: entry.version,
      recordedVersion: p.version ?? null,
    });

    // R8 — recorded-vs-installed drift (no version-pin flag exists, CC #62446).
    if (p.version && entry.version && p.version !== entry.version) {
      result.versionDrift.push({
        plugin: p.name,
        marketplace: p.marketplace,
        recorded: p.version,
        installed: entry.version,
      });
    }

    // Task 4 — flag bundled MCP servers whose secrets are unresolved (never write).
    for (const { server, missingFields } of classifyPluginMcpSecrets(
      entry.mcpServers,
      env
    )) {
      result.reAuthRequired.push({
        plugin: p.name,
        marketplace: p.marketplace,
        server,
        missingFields,
      });
    }
  }

  return result;
}

/* ── Internal helpers ── */

/** The lowercased `owner/repo` base of a marketplace source (ref stripped). */
function marketplaceRepoKey(source: string): string {
  return stripMarketplaceRef(source).base.trim().toLowerCase();
}

/**
 * Query the marketplaces present on the destination as a case-insensitive set of
 * BOTH names and `owner/repo` bases, so a descriptor source (owner/repo) and a
 * descriptor name both resolve against `claude plugin marketplace list --json`.
 */
async function queryPresentMarketplaces(
  runClaude: ClaudeRunner
): Promise<Set<string>> {
  const out = new Set<string>();
  const res = await runClaude(["plugin", "marketplace", "list", "--json"]);
  for (const e of parseMarketplaceListJson(res.stdout)) {
    out.add(e.name.toLowerCase());
    if (e.repo) out.add(e.repo.trim().toLowerCase());
  }
  return out;
}

/** Find an installed plugin by `name@marketplace` (case-insensitive id match). */
async function findInstalledPlugin(
  runClaude: ClaudeRunner,
  name: string,
  marketplace: string
): Promise<PluginListEntry | null> {
  const res = await runClaude(["plugin", "list", "--json"]);
  const wanted = `${name}@${marketplace}`.toLowerCase();
  return (
    parsePluginListJson(res.stdout).find(e => e.id.toLowerCase() === wanted) ??
    null
  );
}

/** A concise human-readable failure reason from a command outcome. */
function failureReason(outcome: CommandOutcome, phase: string): string {
  if (outcome.timedOut) return `${phase} timed out`;
  const detail =
    outcome.stderr.trim() ||
    outcome.stdout.trim() ||
    `exit ${outcome.code ?? "unknown"}`;
  return `${phase} did not take effect (${detail})`;
}
