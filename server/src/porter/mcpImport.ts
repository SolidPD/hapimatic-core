// SPDX-License-Identifier: AGPL-3.0-only
import {
  chmod,
  readFile,
  rename,
  writeFile,
  readdir,
  mkdir,
} from "node:fs/promises";
import { existsSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { McpServerEntry } from "@hapi/protocol/porter";
import { withFileLock, FileLockTimeoutError } from "./fileLock";
import {
  classifyConflict,
  hashContent,
  stableStringify,
} from "./conflictDetection";
import type { Conflict } from "./conflictDetection";

/**
 * MCP-server import for the Configuration Porter (issue #2343, epic #2339 Sub D,
 * R2 / R3, Task 10 + F1).
 *
 * 🔴 MCP servers are NOT a `~/.claude/<dimension>` directory — they live INSIDE
 * `~/.claude.json` (the one file #2340 says must never be ported wholesale
 * because it also carries `oauthAccount`, project state, and everything else
 * Claude Code owns). No rename from staging can produce a merge into that live
 * file, so this is the dedicated writer: locked read → merge `mcpServers` entries
 * by server name → atomic write back, NEVER whole-file-replacing unrelated keys.
 *
 * F1 (directive Task 12): a host-only write does not reach account-bound
 * sessions — Hapimatic binds an account per session and each bound account reads
 * its OWN isolated `.claude.json` under `<accountConfigsDir>/<uuid>/`. So after
 * the host merge, the SAME locked key-wise merge is applied to every seeded
 * account config, per account, reporting per-account results.
 *
 * R2 / F4: decrypted secret values are injected ONLY here, at the write point —
 * never staged to disk, never earlier. A missing or blank secret can NEVER be
 * written as an empty/placeholder value: {@link buildMcpServerConfig} throws
 * rather than emit a blank.
 */

/**
 * Thrown when a server declares a secret env/header key name but the decrypted
 * bundle carries no non-empty value for it. Enforces R2/AC-2: an MCP server that
 * appears configured but holds an empty credential is worse than a failed import.
 */
export class SecretInjectionError extends Error {
  readonly serverName: string;
  readonly keyName: string;
  constructor(serverName: string, keyName: string) {
    super(
      `Refusing to import MCP server ${JSON.stringify(serverName)}: secret ` +
        `${JSON.stringify(keyName)} decrypted to an empty/missing value. No ` +
        `secret is imported as a blank or placeholder (R2).`
    );
    this.name = "SecretInjectionError";
    this.serverName = serverName;
    this.keyName = keyName;
  }
}

/**
 * Resolve one secret VALUE from the decrypted bundle, enforcing the blank-injection
 * guard (R2 / F4). Returns the non-empty string value for `keyName`, or throws
 * {@link SecretInjectionError} when the bundle is missing that key or holds an empty
 * string — never emitting a blank or placeholder.
 *
 * This is the single shared shape the env, header, and url secret-value sites in
 * {@link buildMcpServerConfig} all use (issue #2811, OOS-1 from #2638): the exact
 * pre-existing predicate (`typeof value !== "string" || value.length === 0`) lifted
 * VERBATIM so resolution stays byte-identical across every path. Exported so it is
 * directly unit-testable and reusable by a future fourth site (#2809, args).
 */
export function resolveSecretValue(
  secrets: Record<string, string> | undefined,
  serverName: string,
  keyName: string
): string {
  const value = secrets?.[keyName];
  if (typeof value !== "string" || value.length === 0) {
    throw new SecretInjectionError(serverName, keyName);
  }
  return value;
}

/** One server to merge: its Claude-Code `~/.claude.json` name and its config value. */
export interface McpMergeItem {
  name: string;
  config: Record<string, unknown>;
}

/** Per-config-file merge outcome. */
export interface McpFileMergeResult {
  configPath: string;
  imported: string[];
  /** Same-name collisions that were skipped (differs → default skip). */
  skipped: Conflict[];
}

export interface McpImportResult {
  host: McpFileMergeResult;
  perAccount: McpFileMergeResult[];
}

/**
 * Destination-resolution verdict for an MCP server's stdio `command` (issue
 * #2640, F13 + F14). DETECTION-ONLY: no runtime is provisioned and no path is
 * created — an unresolvable command is NAMED loudly, never silently counted as
 * imported-functional.
 */
export interface McpCommandResolution {
  /** The command resolves on the destination (or the server has no command). */
  resolvable: boolean;
  /** Human-readable cause when `resolvable` is false (the missing runtime/path). */
  reason?: string;
  /**
   * A source-home absolute path rewritten to the destination home, present ONLY
   * when the rewritten path EXISTS. Callers write THIS instead of the original.
   */
  translatedCommand?: string;
  /** A `/home/<srcuser>/…` path with no destination-home equivalent (F14). */
  nonPortable?: boolean;
}

/** Options for {@link resolveMcpCommand}. */
export interface ResolveMcpCommandOptions {
  /** Destination home — `dirname(claudeDir)`; the source-home rewrite target. */
  destHome: string;
  /** PATH used for the runtime probe. Defaults to the import process's PATH. */
  pathEnv?: string;
  /** Injected PATH probe (tests). Defaults to `Bun.which` + a PATH-scan fallback. */
  which?: (cmd: string, pathEnv?: string) => string | null;
}

/** Matches a leading `/home/<user>` source-home prefix; null when absent. */
function sourceHomePrefix(command: string): string | null {
  const m = command.match(/^(\/home\/[^/]+)(?:\/|$)/);
  return m ? m[1] : null;
}

/**
 * Default PATH probe (KD-2): `Bun.which` in the Bun runtime — the same
 * `typeof Bun !== "undefined"` guard used by the metrics probe in `aboutInfo.ts`
 * — falling back to a manual PATH scan so the resolver also works under plain
 * Node (tests / tooling) where `Bun` is undefined.
 */
function defaultWhich(cmd: string, pathEnv?: string): string | null {
  if (typeof Bun !== "undefined" && typeof Bun.which === "function") {
    return Bun.which(cmd, pathEnv ? { PATH: pathEnv } : undefined);
  }
  const dirs = (pathEnv ?? process.env.PATH ?? "").split(":").filter(Boolean);
  for (const dir of dirs) {
    if (existsSync(join(dir, cmd))) return join(dir, cmd);
  }
  return null;
}

/**
 * Resolve an MCP server's stdio `command` against the destination (issue #2640):
 *  - no command (url/http/sse server) → resolvable by definition;
 *  - a BARE binary name (`node`, `uvx`) → PATH probe (F13) — unresolvable when
 *    the runtime is absent (the runtime is only NAMED, never provisioned — R4);
 *  - a `/home/<srcuser>/…` absolute path → PREFIX-REPLACE `/home/<srcuser>` →
 *    `destHome` (F14): translated when the rewritten path EXISTS, otherwise
 *    flagged `nonPortable` (never written verbatim without a flag — R3);
 *  - any other path → existence check (a source-home path is the only rewrite).
 *
 * Operates on `command` ONLY — never inspects or mutates a secret value.
 */
export function resolveMcpCommand(
  entry: McpServerEntry,
  opts: ResolveMcpCommandOptions
): McpCommandResolution {
  const command = entry.command;
  if (command === undefined) return { resolvable: true };

  const which = opts.which ?? defaultWhich;

  // (a) Bare binary name — resolve on the destination PATH (F13 runtime probe).
  if (!command.includes("/")) {
    return which(command, opts.pathEnv) !== null
      ? { resolvable: true }
      : {
          resolvable: false,
          reason: `runtime "${command}" not found on the destination PATH`,
        };
  }

  // (b) Source-home absolute path — prefix-replace to destHome (F14).
  const srcHome = sourceHomePrefix(command);
  if (srcHome) {
    const rest = command.slice(srcHome.length).replace(/^\/+/, "");
    const translated = join(opts.destHome, rest);
    if (existsSync(translated)) {
      return { resolvable: true, translatedCommand: translated };
    }
    return {
      resolvable: false,
      nonPortable: true,
      reason: `source-home command path is not portable to this destination: "${command}"`,
    };
  }

  // (c) Any other absolute/relative path — existence check, no rewrite.
  return existsSync(command)
    ? { resolvable: true }
    : {
        resolvable: false,
        reason: `command path not found on the destination: "${command}"`,
      };
}

/**
 * Build the `~/.claude.json` `mcpServers[name]` config from a manifest
 * {@link McpServerEntry} plus its decrypted secret map (`keyName → value`).
 *
 * Non-secret fields come from the manifest; secret env/header VALUES are injected
 * from `secrets`. A declared secret key whose value is missing or empty throws
 * {@link SecretInjectionError} — the blank-injection guard (R2 / F4).
 *
 * When `opts` is supplied (issue #2640), a source-home `command` is TRANSLATED to
 * the destination home ({@link resolveMcpCommand}). Landing the translation HERE —
 * the one builder BOTH the plan loop and the commit-time rebuild
 * (`rebuildMcpItems`) call — is load-bearing: a plan-only rewrite would be lost
 * when commit rebuilds configs from the raw manifest, re-writing the broken path
 * (F14) while the plan summary showed it fixed. With no `opts` (legacy callers),
 * the command is copied verbatim — byte-identical to the pre-#2640 behavior.
 */
export function buildMcpServerConfig(
  entry: McpServerEntry,
  secrets: Record<string, string> | undefined,
  opts?: ResolveMcpCommandOptions
): Record<string, unknown> {
  const cfg: Record<string, unknown> = {};
  if (entry.command !== undefined) {
    cfg.command = opts
      ? (resolveMcpCommand(entry, opts).translatedCommand ?? entry.command)
      : entry.command;
  }
  // Args reconstitution (#2809, R2/R3/R5). The args-side sibling of the url slot
  // below: when the manifest names one or more `args` elements as secret slots
  // (`argsNames`, canonically ARGS_SECRET_SLOT_PREFIX → `__args_<i>__`), the
  // plaintext element was replaced at extraction with an empty-string placeholder
  // and the credential lives in the decrypted bundle under that slot key — so
  // restore each element at its recorded index from `secrets[name]`, reusing the
  // exact blank-guard the env/header/url slots use (resolveSecretValue THROWS
  // SecretInjectionError on a missing/empty value rather than writing a blank husk).
  // A server with no `argsNames` keeps its plain `args` verbatim (byte-identical to
  // pre-#2809). The defense-in-depth in-range check keeps a hostile manifest (an
  // out-of-range index — negative OR >= args.length — already rejected at parse by
  // the Task-1 .superRefine `.nonnegative()`, but this builder is called directly by
  // tests/other callers that bypass parsePorterManifest) from a silent husk: a
  // NEGATIVE index would set `args[-1]` (a non-index property JSON.stringify drops)
  // while the real position keeps its "" placeholder, and completeness would still
  // read the dropped property as present — so BOTH bounds must throw the SAME
  // SecretInjectionError shape (server + KEY name only) the completeness assertion
  // treats as a blank refusal.
  if (entry.argsNames?.length) {
    const args = [...(entry.args ?? [])];
    for (const { index, name } of entry.argsNames) {
      if (index < 0 || index >= args.length) {
        throw new SecretInjectionError(entry.name, name);
      }
      args[index] = resolveSecretValue(secrets, entry.name, name);
    }
    cfg.args = args;
  } else if (entry.args !== undefined) {
    cfg.args = entry.args;
  }
  // URL reconstitution (#2638, F15, R1/R2). When the manifest names the `url` as
  // a secret slot (`urlName`, canonically URL_SECRET_SLOT), the plaintext `url`
  // was omitted at extraction (#2793) and the credential-bearing value lives in
  // the decrypted bundle under that key — so restore `url` from
  // `secrets[urlName]`, reusing the exact blank-guard the env/header slots use
  // below: a missing/empty value THROWS rather than writing a blank/placeholder
  // (the `{type}`-only husk F15 fixed — a server that can never connect, still
  // counted as imported). A server with no `urlName` keeps its plain `url`
  // verbatim (unchanged, byte-identical to the pre-#2638 behaviour).
  if (entry.urlName !== undefined) {
    cfg.url = resolveSecretValue(secrets, entry.name, entry.urlName);
  } else if (entry.url !== undefined) {
    cfg.url = entry.url;
  }
  // Claude Code uses `type` for non-stdio transports; stdio is command-based and
  // carries no explicit type field.
  if (entry.transport && entry.transport !== "stdio")
    cfg.type = entry.transport;
  if (entry.disabled !== undefined) cfg.disabled = entry.disabled;

  const envNames = entry.envNames ?? [];
  if (envNames.length > 0) {
    const env: Record<string, string> = {};
    for (const name of envNames) {
      env[name] = resolveSecretValue(secrets, entry.name, name);
    }
    cfg.env = env;
  }

  const headerNames = entry.headerNames ?? [];
  if (headerNames.length > 0) {
    const headers: Record<string, string> = {};
    for (const name of headerNames) {
      headers[name] = resolveSecretValue(secrets, entry.name, name);
    }
    cfg.headers = headers;
  }

  return cfg;
}

/**
 * Post-build secret-slot completeness assertion (#2638, F15, R4). Verifies — by
 * KEY PRESENCE only, never by value — that every secret slot NAMED in the manifest
 * entry survived into the built `config`: every `envNames` key under `config.env`,
 * every `headerNames` key under `config.headers`, and (when `urlName` is set) a
 * non-empty `config.url`. The union of names checked is exactly what
 * {@link collectSecretFieldNames} (manifest.ts, #2793) enumerates for this server,
 * so this is the import-side authority for "every declared slot is restored."
 *
 * Throws {@link SecretInjectionError} (server + KEY name only, never a value) on
 * the first gap, so a caller's per-server try/catch treats a completeness failure
 * identically to a blank-secret refusal (R3: exclude + name). This is an
 * INDEPENDENT invariant guard, not a tautology: {@link buildMcpServerConfig}
 * already throws on a blank value, so a config that reaches here successfully has
 * every slot present — but this check does not TRUST the builder's internals, so a
 * future change that silently drops a slot cannot pass this gate.
 */
export function assertMcpConfigComplete(
  entry: McpServerEntry,
  config: Record<string, unknown>
): void {
  const env = (config.env ?? {}) as Record<string, unknown>;
  for (const name of entry.envNames ?? []) {
    if (!(name in env)) throw new SecretInjectionError(entry.name, name);
  }
  const headers = (config.headers ?? {}) as Record<string, unknown>;
  for (const name of entry.headerNames ?? []) {
    if (!(name in headers)) throw new SecretInjectionError(entry.name, name);
  }
  if (entry.urlName !== undefined) {
    if (typeof config.url !== "string" || config.url.length === 0) {
      throw new SecretInjectionError(entry.name, entry.urlName);
    }
  }
  // #2809 (R3): every named args slot must have resolved to a non-empty `args`
  // element at its index. Verified by index PRESENCE only, never by value — a gap
  // is treated identically to a blank-secret refusal (server + KEY name only).
  for (const { index, name } of entry.argsNames ?? []) {
    if (
      !Array.isArray(config.args) ||
      typeof config.args[index] !== "string" ||
      (config.args[index] as string).length === 0
    ) {
      throw new SecretInjectionError(entry.name, name);
    }
  }
}

/**
 * Locked, key-wise merge of `items` into a single `.claude.json` at `configPath`.
 * Preserves every unrelated key. A same-name server that is byte-identical is a
 * no-op (`kind: "exists"`, silently skipped); a same-name server that DIFFERS is
 * skipped by default (`kind: "differs"`) unless its name is in `overwrite`.
 *
 * `createIfMissing` governs the absent-file case: the host file is created from
 * `{}` if absent; account config files are merge-only (skipped if unseeded).
 */
async function mergeIntoConfigFile(
  configPath: string,
  items: readonly McpMergeItem[],
  overwrite: ReadonlySet<string>,
  createIfMissing: boolean
): Promise<McpFileMergeResult | null> {
  if (!createIfMissing && !existsSync(configPath)) return null;

  // #3530: a `createIfMissing` host-config merge must materialize the config
  // root before withFileLock opens `${configPath}.lock` — an MCP-servers-only
  // archive under an isolatedDest has no file item to create `<iso>/.claude`
  // first, so the lockfile open would ENOENT and roll back the whole commit.
  // No-op when the dir already exists (live `~/.claude` and file-bearing
  // archives), so those paths stay byte-identical.
  if (createIfMissing) {
    await mkdir(dirname(configPath), { recursive: true });
  }

  const lockPath = `${configPath}.lock`;
  try {
    return await withFileLock({ lockPath }, async () => {
      let raw = "";
      let config: Record<string, unknown> = {};
      if (existsSync(configPath)) {
        raw = await readFile(configPath, "utf-8");
        try {
          config = JSON.parse(raw) as Record<string, unknown>;
        } catch (err) {
          throw new Error(
            `Refusing to merge MCP servers: ${configPath} is not valid JSON ` +
              `(${err instanceof Error ? err.message : String(err)}).`
          );
        }
      }

      const mcpServers = (config.mcpServers ??= {}) as Record<string, unknown>;
      const imported: string[] = [];
      const skipped: Conflict[] = [];

      for (const item of items) {
        const existing = mcpServers[item.name];
        if (existing !== undefined) {
          const conflict = classifyConflict(
            item.name,
            hashContent(stableStringify(item.config)),
            hashContent(stableStringify(existing))
          );
          // conflict is non-null here (existing !== undefined).
          if (
            conflict &&
            conflict.kind === "differs" &&
            !overwrite.has(item.name)
          ) {
            skipped.push(conflict);
            continue;
          }
          if (conflict && conflict.kind === "exists") {
            // Byte-identical — idempotent no-op, nothing to write for this server.
            continue;
          }
          // differs + explicit overwrite → fall through and replace.
        }
        mcpServers[item.name] = item.config;
        imported.push(item.name);
      }

      if (imported.length > 0) {
        const serialized = JSON.stringify(config, null, 2);
        // Corruption guard (mirrors applyDisabledServerToggle #1347): a merge only
        // ADDS keys, so the output can never legitimately shrink below half.
        if (raw.length > 0) {
          const originalSize = Buffer.byteLength(raw, "utf-8");
          const newSize = Buffer.byteLength(serialized, "utf-8");
          if (newSize < originalSize / 2) {
            throw new Error(
              `Refusing to overwrite ${configPath}: post-merge size ${newSize} ` +
                `is < 50% of original ${originalSize}. Preserving the original.`
            );
          }
        }
        const tmpPath = `${configPath}.tmp.${process.pid}.${randomUUID()}`;
        // #3546 (R9 / ADR-0006 §Security): the config file holds MCP secrets
        // (env / headers / url), so write it owner-only. The 0600 mode on the tmp
        // file is preserved by rename; the chmod after is umask-defense (mirrors
        // writeSettings, #1955). This TIGHTENS a pre-existing config from whatever
        // mode it had — deliberate, per the ADR file-mode decision.
        await writeFile(tmpPath, serialized, { mode: 0o600 });
        await rename(tmpPath, configPath);
        await chmod(configPath, 0o600).catch(() => {});
      }

      return { configPath, imported, skipped };
    });
  } catch (err) {
    if (err instanceof FileLockTimeoutError) {
      throw new Error(
        `Could not acquire lock on ${configPath} to merge MCP servers ` +
          `(another process is mutating it). Retry the import.`
      );
    }
    throw err;
  }
}

/**
 * Enumerate the isolated per-account config DIRECTORIES that currently hold a
 * `.claude.json`, across the candidate account-config base dirs. Each returned
 * path is `<base>/<uuid>/.claude.json` and is known to exist. Malformed bases are
 * skipped silently — F1 is best-effort propagation, never fatal.
 */
export async function enumerateAccountConfigFiles(
  bases: readonly string[]
): Promise<string[]> {
  const out: string[] = [];
  for (const base of bases) {
    let entries: Dirent<string>[];
    try {
      entries = await readdir(base, { withFileTypes: true });
    } catch {
      continue; // base absent — no isolated accounts here
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const cfg = join(base, e.name, ".claude.json");
      if (existsSync(cfg)) out.push(cfg);
    }
  }
  return out;
}

/**
 * Candidate account-config BASE directories to scan for F1 propagation. Covers
 * the machine-global shared dir (`${XDG_CONFIG_HOME:-~/.config}/hapimatic/
 * account-configs`, #1643) and the per-instance kill-switch layout
 * (`<dataDir>/account-configs`, `HAPI_ACCOUNT_CONFIG_SHARED=0`). Deduplicated.
 */
export function resolveAccountConfigBases(dataDir: string): string[] {
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const shared = join(xdg, "hapimatic", "account-configs");
  const perInstance = join(dataDir, "account-configs");
  return [...new Set([shared, perInstance])];
}

/**
 * Merge imported MCP servers into the host `~/.claude.json` AND every seeded
 * account config (F1). The host is created if absent; account configs are
 * merge-only. All writes are locked and key-wise.
 */
export async function importMcpServers(opts: {
  items: readonly McpMergeItem[];
  hostConfigPath?: string;
  accountConfigBases?: readonly string[];
  overwrite?: ReadonlySet<string>;
}): Promise<McpImportResult> {
  const hostConfigPath = opts.hostConfigPath ?? join(homedir(), ".claude.json");
  const overwrite = opts.overwrite ?? new Set<string>();

  const host =
    (await mergeIntoConfigFile(hostConfigPath, opts.items, overwrite, true)) ??
    ({
      configPath: hostConfigPath,
      imported: [],
      skipped: [],
    } as McpFileMergeResult);

  const perAccount: McpFileMergeResult[] = [];
  if (opts.accountConfigBases && opts.accountConfigBases.length > 0) {
    const accountFiles = await enumerateAccountConfigFiles(
      opts.accountConfigBases
    );
    for (const configPath of accountFiles) {
      const result = await mergeIntoConfigFile(
        configPath,
        opts.items,
        overwrite,
        false
      );
      if (result) perAccount.push(result);
    }
  }

  return { host, perAccount };
}
