// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
  parsePorterManifest,
  toSettingsHooksBlock,
  PORTABLE_SETTINGS_KEYS,
  SECRETS_MEMBER_ENCRYPTED,
  SECRETS_MEMBER_PLAINTEXT,
  McpSecretBundleSchema,
  type PorterManifest,
  type HookEntry,
  type McpSecretBundle,
  type Omission,
  type ConfigEntry,
} from "@hapi/protocol/porter";
import { decryptPorterArchive } from "../config/porterAgeKeys";
import { parseTarGz } from "./tarArchive";
import { planClaudeMd } from "./planClaudeMd";
import {
  buildExecutableScriptReview,
  differingSettingsKeys,
  heldSettingsScripts,
  planSettingsScripts,
  referencedScriptRels,
  settingsKeyLands,
  stageSettingsScripts,
  type ExecutableScriptReview,
} from "./planSettingsScripts";
import { planDimension } from "./planSections";
import {
  assertPlannedDestinations,
  type SectionField,
} from "./plannedDestinations";
import {
  classifyConflict,
  detectFileConflicts,
  detectKeyedConflicts,
  hashContent,
  stableStringify,
  type Conflict,
  type StagedFileItem,
} from "./conflictDetection";
import {
  buildMcpServerConfig,
  assertMcpConfigComplete,
  SecretInjectionError,
  resolveMcpCommand,
  importMcpServers,
  resolveAccountConfigBases,
  enumerateAccountConfigFiles,
  type McpImportResult,
  type McpMergeItem,
} from "./mcpImport";
import {
  canonicalHookCommand,
  type HookRegistrationValidationResult,
} from "./hookRegistrationValidator";
import { withFileLock } from "./fileLock";
import { porterPluginInstallEnabled } from "../config/porterPluginInstallConfig";
import {
  executePluginInstall,
  type ClaudeRunner,
  type PluginInstallResult,
} from "./pluginInstall";
import { resolveTrustAllowlist } from "./pluginTrust";
import {
  ManifestValidationError,
  SecretDecryptionError,
  PlaintextSecretsError,
  SameFilesystemError,
  StagingExpiredError,
  RegistryDriftError,
  CommitRollbackError,
} from "./importArchiveErrors";
import {
  assertSameFilesystem,
  resolveClaudeDir,
  resolveHostConfigPath,
  resolveImportDestination,
} from "./importDestination";
import {
  deriveImportedBridgeDims,
  probeAccountVisibility,
  type AccountVisibility,
} from "./visibilityProbe";
import { resolveCommitExclusions } from "./commitSelection";
import { tolerateMissingSecrets } from "./definitionsOnly";
import { rebuildMcpItemsWithOverlay, type SecretOverlay } from "./mcpRebuild";
import {
  findEntry,
  planHookFiles,
  buildHookEntries,
  claimedHookPaths,
  planRegistryMissing,
} from "./planHooks";
import {
  attributeHookValidation,
  assertRegistryAcknowledged,
  computeParity,
  type ImportParity,
} from "./commitHooks";
import {
  atomicWriteFile,
  captureBackup,
  checkSettingsLink,
  classifySettingsLink,
  importFileMode,
  isRegularFile,
  markTouched,
  restoreBackups,
  settleMcpTouched,
  writeMergedSettings,
  type BackupRecord,
  type RestoreFileOps,
  type SettingsLink,
} from "./commitFs";
import {
  previewModeReconcile,
  reconcileExistingModes,
  restoreModes,
  type AppliedModeFix,
  type ModeCorrection,
  type ModeReconcilePreview,
  type ModeSkip,
} from "./modeReconcile";

/**
 * The two-phase Configuration Porter import core (issue #2343, epic #2339 Sub D).
 *
 * `planImport` parses + validates + decrypts + stages EVERYTHING EXCEPT secret
 * plaintext, writing nothing to `~/.claude` (R1: a validation failure writes zero
 * bytes). `commitImport` performs a backup-then-swap into the live destinations
 * under an instance-wide mutex, restoring on any failure (R6: an interrupted
 * import leaves the pre-import state). Between the two, the route presents a
 * reviewable summary (R4).
 *
 * Security posture: the archive is untrusted, its contents are executable
 * configuration, so validation precedes any write, containment guards every path
 * (R7), decryption failures are explicit and never blank (R2), and existing
 * config is never silently overwritten (R3) — a byte-identical file may only
 * gain the archive's execute bit, previewed and reported (#4129).
 */

/* ── Typed errors — extracted to ./importArchiveErrors (#2563, #2077 max-lines) ── */
// Re-exported so the public API is unchanged (importers of "./importArchive" work).
export {
  ManifestValidationError,
  SecretDecryptionError,
  PlaintextSecretsError,
  SameFilesystemError,
  StagingExpiredError,
  RegistryDriftError,
};
// #2806 isolated-destination errors — never thrown here (they surface in
// ./importDestination), re-exported for public-API parity + test access.
export {
  IsolatedDestConflictError,
  IsolatedDestReapedError,
  IsolatedDestUnsafeError,
} from "./importArchiveErrors";
// #4146 — thrown by ./commitFs checkSettingsLink during runCommit.
export { SymlinkedSettingsError } from "./importArchiveErrors";

/* ── Destination resolution — extracted to ./importDestination (#2806, #2077 max-lines) ── */
// Re-exported so the public API is unchanged (web/routes/porterInstalled.ts +
// the test suite import resolveHostConfigPath from "./importArchive").
export {
  resolveClaudeDir,
  resolveHostConfigPath,
  resolveImportDestination,
  assertSameFilesystem,
};

/* ── Types ── */

export type PlannedItemKind =
  | "skill"
  | "agent"
  | "command"
  | "rule"
  | "output-style"
  | "claude-md"
  | "claude-md-include"
  | "hook-file"
  // #2639 (F9): a shared hook-support module (e.g. `hooks/lib/header_match.py`)
  // that a hook IMPORTS but that carries no registration. Landed PATH-PRESERVED
  // via the manifest `hookSupport` dimension so the imported hook resolves.
  | "hook-lib"
  // #4173: the top-level script an imported statusLine/apiKeyHelper runs
  // (./planSettingsScripts), written only at the exact path the value names.
  | "settings-script";

/** A single file staged for import. `stagedPath` is server-internal (never wired). */
export interface PlannedFileItem {
  kind: PlannedItemKind;
  /** Dimension entry name (skill/agent/... name), or basename for singletons. */
  name: string;
  /** Absolute destination path under the config root. */
  destPath: string;
  /** Absolute staged-content path under the staging dir. */
  stagedPath: string;
  /** SHA-256 of the incoming content. */
  incomingHash: string;
  /** POSIX mode from the archive entry, unmasked; masked at write time by `importFileMode`. */
  mode?: number;
}

/** One MCP server in the plan — reported WITHOUT any secret value. */
export interface PlannedMcpServer {
  name: string;
  /** Whether the server declares secret env/header/url fields (#2638: incl. url). */
  hasSecrets: boolean;
  /** Conflict against the host ~/.claude.json, if any. */
  conflict: Conflict | null;
  /**
   * #2638 (F15, R3/R4): whether EVERY declared secret slot (env / header / url)
   * restored from the decrypted bundle. `false` ⇒ the server is NAMED in the
   * plan/commit summary (key name only) and EXCLUDED from the import success
   * count — the husk F15 fixed (a `{type}`-only entry that can never connect).
   */
  secretRestorable: boolean;
  /**
   * The KEY NAME of the first secret slot that could not be restored — never the
   * VALUE (R2 hygiene). Populated only when `secretRestorable` is `false`.
   */
  secretFailureKey?: string;
  /**
   * #3546 (R3): the server's declared secret SLOT NAMES — never values. Mirrors
   * the heterogeneous {@link McpServerEntry} shapes VERBATIM (`shared/src/porter/
   * manifest.ts`) so the recipient-side re-auth form (ADR-0006 Fork A) can render
   * one input per slot for a `secretRestorable: false` server, keyed by the
   * SYNTHETIC slot name. `argsNames` stays `{index,name}[]` — the `name` is the
   * `__args_<i>__` bundle key; do NOT flatten to `string[]`.
   */
  argsNames?: { index: number; name: string }[];
  /** The `__url__` synthetic slot name when `url` is credential-bearing (#3546). */
  urlName?: string;
  /** Credential-bearing `env` key names (#3546). */
  envNames?: string[];
  /** Credential-bearing `headers` key names (#3546). */
  headerNames?: string[];
  /**
   * #2640 (F13/F14): whether the server's `command` resolves on the destination.
   * `false` ⇒ the server is NAMED in the plan/commit summary and EXCLUDED from
   * the import success count (never silently imported dead-on-arrival).
   */
  resolvable: boolean;
  /** Why the command is unresolvable (missing runtime, or non-portable path). */
  unresolvedReason?: string;
  /** A source-home command path rewritten to the destination home (F14). */
  commandTranslation?: { from: string; to: string };
  /** A `/home/<srcuser>/…` command with no destination-home equivalent (F14). */
  nonPortable?: boolean;
}

/**
 * A manifest MCP server EXCLUDED from the import success set because its command
 * is unresolvable on the destination. Shared exclusion-record contract [1B-7]:
 * issue #2640 OWNS this definition (it lands first in the import wave) and emits
 * `kind: "runtime" | "path"`; #2638 R3 emits `kind: "secret"`. Secret-free by
 * construction — `name` and `detail` carry no credential material.
 */
export interface McpExclusion {
  name: string;
  kind: "secret" | "runtime" | "path";
  detail: string;
}

/** Full internal plan (server-side). Held in a {@link PlanStore} keyed by handle. */
export interface ImportPlan {
  stagingHandle: string;
  stagingDir: string;
  claudeDir: string;
  hostConfigPath: string;
  dataDir: string;
  settingsFile: string;
  accountConfigBases: string[];
  manifest: PorterManifest;
  files: PlannedFileItem[];
  fileConflicts: Conflict[];
  /** #4129: exec-bit reconcile preview for `exists` files; the commit applies only these fixes (it re-decides and skips any mismatch as `changed`). */
  modeReconcile: ModeReconcilePreview;
  /** Denormalised hook registrations to merge into settings.json. */
  hookEntries: HookEntry[];
  hookCommandWarnings: string[];
  unknownHookEvents: string[];
  /**
   * #3590 (K4/D9): registry-referenced hook names absent from BOTH archive and
   * destination — the plan-time fail-loud belt (see `planRegistryMissing`).
   */
  registryMissing: string[];
  /** Allowlisted settings members to merge (already stripped by the schema). */
  settingsToMerge: Record<string, unknown>;
  settingsConflicts: Conflict[];
  /** #4173 (R11): one review row per config-root reference an executable value makes. */
  executableScripts: ExecutableScriptReview[];
  skippedSettingsKeys: string[];
  /** #4146 (R4): a symlinked settings.json, set when the plan merges settings or hooks. */
  settingsLink?: SettingsLink;
  mcpItems: McpMergeItem[];
  mcpServers: PlannedMcpServer[];
  /** Present only when the archive carried an encrypted secrets member. */
  encryptedSecretsStagedPath: string | null;
  omissions: Omission[];
  pluginRemediation: string[];
  pluginDescriptorPresent: boolean;
  createdAt: number;
  ttlMs: number;
}

/* ── ImportPlanSummary + toPlanSummary extracted to ./importPlanSummary
   (#3590, #2077 max-lines) so the summary type sits beside its projection.
   `ImportPlanSummary` is imported (for {@link} doc refs) + re-exported below. ── */

/**
 * A hook registration that was DEDUPED during the settings merge (#2641, F12 /
 * Sub D). `incoming-skip` = an incoming archive registration whose canonical
 * command matched an entry already on the destination (or one appended earlier
 * this import). `preexisting-collapse` = a path-equivalent duplicate PAIR that
 * was already stored on the destination (the MS1 damaged-destination shape) and
 * was collapsed to one. `command` is the canonical (destHome-expanded) command.
 */
export interface MergedHookRegistration {
  event: string;
  command: string;
  source: "incoming-skip" | "preexisting-collapse";
}

export interface ImportResult {
  committedAt: number;
  filesWritten: string[];
  settingsMerged: boolean;
  mcp: McpImportResult;
  hookValidation: HookRegistrationValidationResult;
  /** Conflicts left unresolved (skipped — the pre-existing config was preserved). */
  skippedConflicts: Conflict[];
  /** #4129: byte-identical files given the archive's execute bit (still `alreadyPresent`). */
  modesCorrected: ModeCorrection[];
  /** #4129: byte-identical files whose mode was left alone, with the reason. */
  modesSkipped: ModeSkip[];
  /**
   * #2640 (F13/F14): MCP servers EXCLUDED from the import because their command
   * was unresolvable on the destination (missing runtime / non-portable path).
   * They are NOT in the `mcp` success counts — listed separately so a
   * dead-on-arrival server is never silently reported as imported-functional.
   */
  mcpExclusions: McpExclusion[];
  /**
   * #2639 (F9): hook import-resolvability outcome for THIS import. `imported` is
   * the count of this archive's hooks that landed with EVERY `from lib.X` import
   * resolvable; `excluded` NAMES the imported hooks (basename) + the specific
   * missing `lib` module that kept each out of the count (R2/R3). Mirrors the
   * `mcpExclusions` "named-and-excluded-from-success-count" contract [1B-8]. A
   * hook ALREADY present at the destination (not part of this import) with an
   * unresolved import is reported via `hookValidation.unresolvedImports` but
   * NEVER decrements `imported` — attribution intersects with the plan's hooks.
   */
  hooks: {
    imported: number;
    excluded: { hook: string; module: string }[];
  };
  /**
   * #2641 (F12 / Sub D): path-equivalent hook registrations DEDUPED during the
   * settings merge — an incoming `$HOME`-form command that matched an existing
   * expanded-form entry (`incoming-skip`), or a pre-existing duplicate pair
   * already stored on the destination that was collapsed to one
   * (`preexisting-collapse`, the MS1 damaged-destination heal). Every dedupe
   * decision is reported so a merged registration is never silently dropped
   * (R4/R6). Empty when the merge deduped nothing.
   */
  mergedHookRegistrations: MergedHookRegistration[];
  /**
   * Plugin install-execution outcome (#2465 Sub G). Present ONLY when the
   * install-execution gate ({@link porterPluginInstallEnabled}) is ON AND the
   * archive carried a plugin descriptor. When the gate is OFF the field is
   * ABSENT (not present-empty) — this preserves R6 byte-identity with the
   * #2343-alone result (the deterministic remediation command list is still
   * emitted at plan time via {@link ImportPlanSummary} `plugins.remediation`).
   */
  pluginInstall?: PluginInstallResult;
  /**
   * #3246: resolved destination config root this import wrote to (mirrors
   * {@link ImportPlanSummary} `claudeDir` — plan/result destinations agree, R3).
   */
  claudeDir: string;
  /**
   * #3246: post-commit per-account visibility of the imported bridge dims via the
   * #1562 symlink bridge (see {@link probeAccountVisibility}). `orphaned` = the
   * session falls back to the host dir (isolation degraded), NOT "skills invisible".
   */
  visibility: AccountVisibility[];
  /** #3246: `false` iff any imported dim is `orphaned` for any account (`pending` never demotes). */
  isolationIntact: boolean;
  /**
   * #3590 (K6/D7): per-dimension expected-vs-written parity (see `computeParity`).
   * Surfaced in the UI + on `GET /porter/installed.lastImport` until restart.
   */
  parity: ImportParity;
  /** #4173 (D4): carried scripts not written because every setting that runs them was kept. */
  settingsScriptsHeld: { destPath: string; keys: string[] }[];
}

export interface PlanImportOptions {
  dataDir: string;
  settingsFile: string;
  /** Destination config root. Defaults to `CLAUDE_CONFIG_DIR || ~/.claude`. */
  claudeDir?: string;
  /** Host `~/.claude.json` for MCP servers. Defaults to `~/.claude.json`. */
  hostConfigPath?: string;
  /**
   * Same-machine isolation (#2806, R4): redirect BOTH `claudeDir` and
   * `hostConfigPath` at a throwaway dir on the SAME filesystem as `dataDir`, so a
   * same-machine plan/commit never touches the host `~/.claude` / `~/.claude.json`.
   * Not `/tmp`/tmpfs (denylist, RC-4); not under `dataDir/porter-staging|porter-backup`
   * (reaped, RC-6); mutually exclusive with `claudeDir`/`hostConfigPath` (A7). Off
   * by default — behavior is byte-identical when unset. Resolution + guards live in
   * {@link resolveImportDestination} (./importDestination).
   */
  isolatedDest?: string;
  /** F1 account-config base dirs. Defaults to {@link resolveAccountConfigBases}. */
  accountConfigBases?: string[];
  /** Plan TTL in ms. Default 30 min. */
  ttlMs?: number;
  /** Injected clock for tests. */
  now?: number;
  /**
   * Test/DI seam (#2806): the filesystem device-id reader backing the RC-5
   * same-filesystem assertion. Defaults to `statSync(p).dev`, so prod is
   * byte-identical; tests inject a fake to exercise the cross-fs throw
   * deterministically (a real cross-fs, non-denylisted path is environment-coupled).
   */
  statDev?: (path: string) => number;
  /** #4173 test/DI seam: the destination `$HOME` (defaults to `homedir()`). */
  homeDir?: string;
}

export interface CommitImportOptions {
  /** Dest paths (file items) and MCP server names the user chose to OVERWRITE. */
  overwrite?: ReadonlySet<string>;
  /**
   * #3247: the operator's pre-import DESELECTION. Keys are file destPaths,
   * hook-file destPaths (exclude registration + file together), MCP server names,
   * or `skill:<name>` (cascades to that skill's files + serving hooks). Absent /
   * empty = write everything (byte-compatible with pre-#3247).
   */
  selection?: { excluded?: ReadonlySet<string> };
  /**
   * #3590 (K4/D9): operator acknowledgement of `plan.registryMissing` — a NAME
   * LIST (not a boolean) so a re-plan with a NEW missing name is not auto-acked.
   * Enforced by `assertRegistryAcknowledged` (./commitHooks).
   */
  acknowledgeMissingHooks?: string[];
  /**
   * #4146 (D14): the `readlink` target of a symlinked settings.json the 409
   * refused — replace that link anyway. A different link at commit is refused.
   */
  acknowledgeSymlinkedSettings?: string;
  /**
   * #4129: destPaths whose current mode the operator KEPT in the plan's File
   * modes list — the commit leaves them unchanged (a choice, not a skip).
   */
  keepModes?: ReadonlySet<string>;
  now?: number;
  /**
   * Operator-confirmed marketplace sources to trust IN ADDITION to the default
   * allowlist (#2465 R3, the `extraKnownMarketplaces` analogue). Only consulted
   * when the plugin install-execution gate is ON. An unrecognized marketplace not
   * on the default allowlist and not in this list is reported + skipped, never
   * silently added.
   */
  extraTrustedMarketplaces?: string[];
  /**
   * Test/DI seam (#2465): inject the `claude` command runner + secret-resolution
   * env used by the gated plugin install executor. Production leaves these
   * UNDEFINED so the executor shells out to the real `claude` binary; tests pass a
   * fake runner so a commit never performs a real network install. Mirrors the
   * existing `now` / `claudeDir` / `hostConfigPath` DI seams in this module.
   */
  pluginClaudeRunner?: ClaudeRunner;
  pluginSecretResolutionEnv?: Record<string, string | undefined>;
  /** Test/DI seam (#2563) — see {@link RestoreFileOps}. Undefined in prod. */
  restoreFileOps?: RestoreFileOps;
  /**
   * #3546 (ADR-0006 Fork A): recipient-supplied secrets for `secretRestorable:
   * false` servers, `{ [serverName]: { [synthSlotName]: value } }`. Validated up
   * front by the commit route; merged over the bundle in `rebuildMcpItems`.
   */
  secretOverlay?: SecretOverlay;
}

/* ── RestoreFileOps (the #2563 restore DI seam) lives in ./commitFs (#3553, #2077
   max-lines) — newly exported here so the `restoreFileOps` option is nameable. ── */
export type { RestoreFileOps } from "./commitFs";

/** The plugin-execution slice of {@link CommitImportOptions}, threaded to runCommit. */
interface PluginExecOptions {
  extraTrustedMarketplaces: readonly string[];
  runClaude?: ClaudeRunner;
  secretResolutionEnv?: Record<string, string | undefined>;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;
/* ── Helpers — destination resolvers moved to ./importDestination (#2806, #2077 max-lines) ── */

/** Shell-quote an interpolated field for the F12 remediation command list. */
function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  if (/^[A-Za-z0-9_./:@=-]+$/.test(value)) return value;
  return "'" + value.replace(/'/g, `'\\''`) + "'";
}

/* ── findEntry moved to ./planHooks (#3590, #2077 max-lines) — imported above. ── */

/* ── Plan ── */

export async function planImport(
  archiveBuf: Uint8Array,
  opts: PlanImportOptions
): Promise<ImportPlan> {
  const now = opts.now ?? Date.now();
  // #2806: resolve the effective destination. An `isolatedDest` funnels through
  // the SAME seam after the A7/RC-4/RC-6 guards; unset ⇒ byte-identical legacy path.
  const { claudeDir, hostConfigPath } = resolveImportDestination(opts);
  const accountConfigBases =
    opts.accountConfigBases ?? resolveAccountConfigBases(opts.dataDir);
  // Destination home for source-home command/hook path translation. Hoisted here
  // (#2640) so the MCP plan loop below can resolve each `command` — the hooks
  // section (step 9) reuses the same value.
  const destHome = dirname(claudeDir);

  // 1. Decompress + parse (F9 caps enforced inside parseTarGz). Nothing on disk.
  const entries = parseTarGz(archiveBuf);

  // 2. Manifest: version-before-shape (R1). Zero bytes written on failure.
  const manifestEntry = findEntry(entries, "manifest.json");
  if (!manifestEntry) {
    throw new ManifestValidationError(
      "missing",
      "Archive has no manifest.json."
    );
  }
  let manifestRaw: unknown;
  try {
    manifestRaw = JSON.parse(manifestEntry.data.toString("utf-8"));
  } catch (err) {
    throw new ManifestValidationError(
      "invalid",
      `manifest.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const parsed = parsePorterManifest(manifestRaw);
  if (!parsed.ok) {
    throw new ManifestValidationError(parsed.kind, parsed.error);
  }
  const manifest = parsed.manifest;

  // 3. F4 — refuse plaintext secrets. Only an encrypted secrets.age is allowed.
  if (findEntry(entries, SECRETS_MEMBER_PLAINTEXT)) {
    throw new PlaintextSecretsError(
      `archive contains a plaintext ${SECRETS_MEMBER_PLAINTEXT} member`
    );
  }
  if (manifest.secrets && manifest.secrets.encrypted === false) {
    throw new PlaintextSecretsError(
      "manifest declares an unencrypted secrets member"
    );
  }

  // 4. Decrypt secrets (R2 / Task 3) — validate they decrypt AND that every
  //    declared secret field resolves to a non-blank value, then DISCARD the
  //    plaintext (it is never staged). The encrypted secrets.age is staged so the
  //    commit step re-decrypts in-process (memory-only plaintext).
  const secretsEntry = findEntry(entries, SECRETS_MEMBER_ENCRYPTED);
  const needsSecrets =
    manifest.mcpServers.some(
      s =>
        (s.envNames?.length ?? 0) > 0 ||
        (s.headerNames?.length ?? 0) > 0 ||
        // #2638 [1B-6]: a urlName-only server ALSO needs the secret bundle — else
        // decryption is skipped, secretBundle stays undefined, and its url secret
        // can never restore while a valid secrets.age sits unused in the archive.
        s.urlName != null ||
        // #2809: an argsNames-only server likewise needs the bundle to reconstitute
        // its credential-bearing `args` element(s).
        (s.argsNames?.length ?? 0) > 0
    ) || Boolean(manifest.secrets);
  let secretBundle: McpSecretBundle | undefined;
  if (needsSecrets && !secretsEntry) {
    // #3245 Task 2b: tolerate a definitions-only (secrets-free) archive — see
    // ./definitionsOnly.ts. When tolerated, secretBundle stays undefined and the
    // per-server #2638 guard below soft-excludes each declared-slot server as
    // secretRestorable:false; otherwise this is a genuine missing-secrets error.
    if (!tolerateMissingSecrets(manifest, false)) {
      throw new SecretDecryptionError(
        `manifest declares secrets but the encrypted ${SECRETS_MEMBER_ENCRYPTED} member is absent`
      );
    }
  } else if (needsSecrets && secretsEntry) {
    let plaintext: Uint8Array;
    try {
      plaintext = await decryptPorterArchive(
        opts.settingsFile,
        secretsEntry.data
      );
    } catch (err) {
      // Never re-wrap with secret context — the underlying error carries no key
      // material and we must not add any.
      throw new SecretDecryptionError(
        err instanceof Error ? err.message : "wrong recipient or corrupt member"
      );
    }
    try {
      secretBundle = McpSecretBundleSchema.parse(
        JSON.parse(Buffer.from(plaintext).toString("utf-8"))
      );
    } catch (err) {
      throw new SecretDecryptionError(
        `decrypted secret bundle is malformed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // 5. Build MCP merge items (validates blank-secret refusal via buildMcpServerConfig).
  const mcpItems: McpMergeItem[] = [];
  const plannedMcp: PlannedMcpServer[] = [];
  const hostMcp = await readMcpServers(hostConfigPath);
  for (const server of manifest.mcpServers) {
    const secretsForServer = secretBundle?.[server.name];
    // #2640: resolve the command against the destination (F13 runtime probe /
    // F14 source-home path). The verdict drives the plan flags below; the SAME
    // { destHome } is threaded into buildMcpServerConfig so a translated command
    // is reflected in the plan's conflict hash AND written at commit
    // (rebuildMcpItems), never diverging between plan and commit.
    const resolution = resolveMcpCommand(server, { destHome });
    // #2638 (R2/R3/KD-2): buildMcpServerConfig throws SecretInjectionError when a
    // declared secret slot (env / header / url) is blank/missing — it NEVER writes
    // a blank. Pre-#2638 that throw aborted the WHOLE import; per R3 we CATCH it
    // per-server, mark the server unrestorable (KEY name only, never the value),
    // and EXCLUDE it at commit — the OTHER servers still import. The completeness
    // check (R4) runs in the SAME try, so a config missing a declared slot is
    // treated identically. A non-SecretInjectionError still propagates (genuine
    // fault → the plan's outer catch wipes staging and rethrows).
    let config: Record<string, unknown> | undefined;
    let secretRestorable = true;
    let secretFailureKey: string | undefined;
    try {
      config = buildMcpServerConfig(server, secretsForServer, { destHome });
      assertMcpConfigComplete(server, config);
    } catch (err) {
      if (err instanceof SecretInjectionError) {
        secretRestorable = false;
        secretFailureKey = err.keyName;
        config = undefined;
      } else {
        throw err;
      }
    }
    if (config !== undefined) {
      mcpItems.push({ name: server.name, config });
    }
    const existing = hostMcp[server.name];
    const hasSecrets =
      (server.envNames?.length ?? 0) > 0 ||
      (server.headerNames?.length ?? 0) > 0 ||
      server.urlName != null ||
      // #2809: a credential-bearing `args` slot also makes the server secret-bearing.
      (server.argsNames?.length ?? 0) > 0;
    plannedMcp.push({
      name: server.name,
      hasSecrets,
      // Use the canonical classifier + stableStringify so the plan summary's
      // no-op-vs-conflict verdict matches what mergeIntoConfigFile decides at
      // commit (both key-order-independent) — not a divergent JSON.stringify. A
      // secret-unrestorable server has no built config, so it carries no conflict.
      conflict:
        config === undefined
          ? null
          : classifyConflict(
              server.name,
              hashContent(stableStringify(config)),
              existing === undefined
                ? null
                : hashContent(stableStringify(existing))
            ),
      resolvable: resolution.resolvable,
      unresolvedReason: resolution.reason,
      commandTranslation:
        resolution.translatedCommand !== undefined &&
        server.command !== undefined
          ? { from: server.command, to: resolution.translatedCommand }
          : undefined,
      nonPortable: resolution.nonPortable,
      secretRestorable,
      secretFailureKey,
      // #3546 (R3): carry the declared slot NAMES (never values) so the
      // recipient-side re-auth form can render one input per slot.
      argsNames: server.argsNames,
      urlName: server.urlName,
      envNames: server.envNames,
      headerNames: server.headerNames,
    });
  }

  // 6. D1 same-filesystem assertion (data dir ↔ config root). RC-5 (#2806): this
  //    also guards an isolatedDest — it flows into claudeDir; hostConfigPath is
  //    never passed here (fine, both point into the one isolatedDest).
  assertSameFilesystem(opts.dataDir, claudeDir, opts.statDev);

  // 7. Create the staging dir and materialise the file tree (no writes to ~/.claude).
  const stagingHandle = randomUUID();
  const stagingDir = join(opts.dataDir, "porter-staging", stagingHandle);
  await mkdir(stagingDir, { recursive: true, mode: 0o700 });

  try {
    // Plan + stage every file-tree item, capturing content for conflict detection.
    const files: PlannedFileItem[] = [];
    const stagedItems: StagedFileItem[] = [];
    const dims: Array<[SectionField, readonly ConfigEntry[]]> = [
      ["skills", manifest.skills],
      ["agents", manifest.agents],
      ["commands", manifest.commands],
      ["rules", manifest.rules],
      ["outputStyles", manifest.outputStyles],
      // #2639 (F9) / #3590: hook-support subtrees AND the whole-tree per-file
      // `hookSupport` entries land here — same `planDimension` prefix-matcher, so
      // each `hooks/**` tar member (lib/_shared subtrees + every other file, minus
      // registered hooks) stages PATH-PRESERVED (NOT basename-flattened like hook
      // FILES) and flows through `detectFileConflicts` + the overwrite-none default
      // for free (R4 conflict policy — no bespoke landing block needed).
      ["hookSupport", manifest.hookSupport],
    ];
    // #3590 (K3): archive paths already claimed by a registered `hooks[]` entry
    // are planned by the hook-FILE loop below — skip them in the hookSupport
    // dimension so a non-conforming archive is corrected, not double-planned.
    const claimed = claimedHookPaths(manifest.hooks);
    // #4160: a section entry writes only inside its own folder; the rest is
    // skipped (./planSections) and reported in `omissions`.
    const sectionOmissions: Omission[] = [];
    for (const [dimKey, ces] of dims) {
      const { plans, skipped } = planDimension(
        entries,
        ces,
        dimKey,
        claudeDir,
        stagingDir,
        dimKey === "hookSupport" ? claimed : undefined
      );
      sectionOmissions.push(...skipped);
      for (const { item, content } of plans) {
        await mkdir(dirname(item.stagedPath), { recursive: true });
        await writeFile(item.stagedPath, content);
        files.push(item);
        stagedItems.push({ destPath: item.destPath, content });
      }
    }

    // CLAUDE.md member + its @-includes. A skipped include (#4143) is never
    // staged — only the returned items are — and is reported in `omissions`.
    const claudeMdOmissions: Omission[] = [];
    if (manifest.claudeMd) {
      const { items: claudeMdItems, skipped } = planClaudeMd(
        entries,
        manifest.claudeMd,
        claudeDir,
        stagingDir
      );
      claudeMdOmissions.push(...skipped);
      for (const item of claudeMdItems) {
        const entry = findEntry(entries, item.archivePath);
        if (!entry || entry.kind !== "file") continue;
        await mkdir(dirname(item.file.stagedPath), { recursive: true });
        await writeFile(item.file.stagedPath, entry.data);
        files.push(item.file);
        stagedItems.push({ destPath: item.file.destPath, content: entry.data });
      }
    }

    // Hook FILES (registrations are merged into settings.json below). Staging
    // extracted to ./planHooks (#3590, #2077 max-lines).
    const hookFilePlan = await planHookFiles(
      entries,
      manifest.hooks,
      claudeDir,
      stagingDir
    );
    files.push(...hookFilePlan.files);
    stagedItems.push(...hookFilePlan.staged);
    const settingsToMerge: Record<string, unknown> = {};
    for (const key of PORTABLE_SETTINGS_KEYS) {
      const v = (manifest.settings as Record<string, unknown>)[key];
      if (v !== undefined) settingsToMerge[key] = v;
    }
    // #4173: the scripts the imported executable values run (./planSettingsScripts).
    const homeDir = opts.homeDir ?? homedir();
    const scriptPlan = planSettingsScripts(
      entries,
      manifest,
      settingsToMerge,
      claudeDir,
      homeDir,
      stagingDir
    );
    await stageSettingsScripts(scriptPlan.plans, files, stagedItems);
    // #4160 backstop: every producer's destination, checked once (fail-closed).
    // #4173 (R7): the referenced-script set is recomputed here, not taken from the planner.
    assertPlannedDestinations(claudeDir, files, {
      settingsScriptRels: referencedScriptRels(
        settingsToMerge,
        claudeDir,
        homeDir
      ),
    });

    // Stage the ENCRYPTED secrets member (never the plaintext).
    let encryptedSecretsStagedPath: string | null = null;
    if (secretsEntry) {
      encryptedSecretsStagedPath = join(stagingDir, SECRETS_MEMBER_ENCRYPTED);
      await writeFile(encryptedSecretsStagedPath, secretsEntry.data);
    }

    // 8. Conflict detection for the file tree (R3/R4/D5).
    const fileConflicts = await detectFileConflicts(stagedItems);
    const modeReconcile = await previewModeReconcile(files, fileConflicts); // #4129

    // 9. Hooks → denormalised registrations + advisory command lint + unknown events.
    //    (`destHome` is hoisted above the MCP plan loop — #2640.) Extracted to
    //    ./planHooks (#3590, #2077 max-lines).
    const { hookEntries, hookCommandWarnings, unknownHookEvents } =
      buildHookEntries(manifest.hooks, destHome, claudeDir);

    // #3590 (K4/D9): plan-time fail-loud belt — registry-referenced hook names
    // absent from BOTH the archive and the destination.
    const registryMissing = planRegistryMissing(entries, claudeDir);

    // 10. Settings merge (F5 allowlist — the schema already stripped non-allowlisted
    //     keys; report any raw keys that were dropped as skippedSettingsKeys).
    const rawSettings =
      (manifestRaw as { settings?: Record<string, unknown> } | null)
        ?.settings ?? {};
    const skippedSettingsKeys = Object.keys(rawSettings).filter(
      k => !(PORTABLE_SETTINGS_KEYS as readonly string[]).includes(k)
    );
    const existingSettings = await readJsonObject(
      join(claudeDir, "settings.json")
    );
    const settingsConflicts = detectKeyedConflicts(
      join(claudeDir, "settings.json"),
      settingsToMerge,
      existingSettings
    );
    const executableScripts = buildExecutableScriptReview({
      settings: settingsToMerge,
      claudeDir,
      homeDir,
      files,
      stagedItems,
      fileConflicts,
      settingsConflicts,
    });
    // #4146 (R4): surface a symlinked settings.json the commit writes through or refuses
    // (if the operator's selection still merges settings keys or hooks).
    const settingsLink =
      Object.keys(settingsToMerge).length > 0 || hookEntries.length > 0
        ? await classifySettingsLink(
            claudeDir,
            join(claudeDir, "settings.json")
          )
        : undefined;

    // 11. F12 plugin remediation (import execution is #2465; we only emit commands).
    const pluginRemediation = buildPluginRemediation(manifest);

    const plan: ImportPlan = {
      stagingHandle,
      stagingDir,
      claudeDir,
      hostConfigPath,
      dataDir: opts.dataDir,
      settingsFile: opts.settingsFile,
      accountConfigBases,
      manifest,
      files,
      fileConflicts,
      modeReconcile,
      hookEntries,
      hookCommandWarnings,
      unknownHookEvents,
      registryMissing,
      settingsToMerge,
      settingsConflicts,
      executableScripts,
      skippedSettingsKeys,
      settingsLink,
      mcpItems,
      mcpServers: plannedMcp,
      encryptedSecretsStagedPath,
      omissions: [
        ...manifest.omissions,
        ...sectionOmissions,
        ...claudeMdOmissions,
        ...scriptPlan.skipped,
      ],
      pluginRemediation,
      pluginDescriptorPresent: Boolean(manifest.plugins),
      createdAt: now,
      ttlMs: opts.ttlMs ?? DEFAULT_TTL_MS,
    };
    return plan;
  } catch (err) {
    // Directive Task 1: every planImport failure path removes the staging dir and
    // rethrows — a plan-phase failure leaves zero bytes AND no orphaned staging.
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/** Build the deterministic F12 plugin-remediation command list (shell-quoted). */
function buildPluginRemediation(manifest: PorterManifest): string[] {
  if (!manifest.plugins) return [];
  const cmds: string[] = [];
  for (const m of manifest.plugins.marketplaces) {
    cmds.push(`claude plugin marketplace add ${shellQuote(m.source)}`);
  }
  for (const p of manifest.plugins.plugins) {
    const ref = `${p.name}@${p.marketplace}`;
    cmds.push(`claude plugin install ${shellQuote(ref)}`);
  }
  return cmds;
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  try {
    if (!(await isRegularFile(path))) return {}; // #4146: never open a FIFO (blocks)
    const parsed = JSON.parse(await readFile(path, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// #2564 (F4): strict variant of readJsonObject — a present-yet-unparseable file
// THROWS (mirrors mcpImport) instead of silently {}; used only by mergeSettings.
async function readJsonObjectStrict(
  path: string
): Promise<Record<string, unknown>> {
  // #4146: read only a regular file. An acknowledged link to a directory, FIFO or
  // socket is replaced, not read (reading a FIFO would block under the import lock).
  if (!(await isRegularFile(path))) return {};
  const raw = await readFile(path, "utf-8");
  if (raw.trim() === "") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    throw new Error(
      `Refusing to merge settings: ${path} is not valid JSON ` +
        `(${err instanceof Error ? err.message : String(err)}). ` +
        `Preserving the original.`
    );
  }
}

async function readMcpServers(
  configPath: string
): Promise<Record<string, unknown>> {
  const cfg = await readJsonObject(configPath);
  const mcp = cfg.mcpServers;
  return mcp && typeof mcp === "object" ? (mcp as Record<string, unknown>) : {};
}

/* ── Summary ── */

/*
 * `toPlanSummary` (the read-side ImportPlan → ImportPlanSummary projection) was
 * split out to `./importPlanSummary` (#2565, F5) to keep this module under the
 * #2077 max-lines guardrail. Re-exported here so existing import sites that
 * resolve it from `./importArchive` (the route + tests) are unaffected.
 */
export { toPlanSummary, type ImportPlanSummary } from "./importPlanSummary";

/* ── Commit (backup-then-swap under the import mutex) ── */
/* BackupRecord + the commit fs primitives live in ./commitFs (#3553, #2077 max-lines). */

export async function commitImport(
  plan: ImportPlan,
  opts: CommitImportOptions = {}
): Promise<ImportResult> {
  const overwrite = opts.overwrite ?? new Set<string>();
  const excluded = opts.selection?.excluded ?? new Set<string>();
  if (!existsSync(plan.stagingDir)) {
    throw new StagingExpiredError(plan.stagingDir);
  }

  // F14 — instance-wide import mutex. Serialises the whole plan→commit critical
  // section so two concurrent imports cannot stage/backup/commit over each other.
  // The gated plugin install (#2465) runs INSIDE this mutex too, after the swap.
  const lockPath = join(plan.dataDir, "porter-import.lock");
  const pluginExec: PluginExecOptions = {
    extraTrustedMarketplaces: opts.extraTrustedMarketplaces ?? [],
    runClaude: opts.pluginClaudeRunner,
    secretResolutionEnv: opts.pluginSecretResolutionEnv,
  };
  return await withFileLock({ lockPath }, async () =>
    runCommit(
      plan,
      overwrite,
      excluded,
      pluginExec,
      opts.restoreFileOps,
      opts.secretOverlay,
      opts.acknowledgeMissingHooks ?? [],
      opts.keepModes ?? new Set<string>(),
      opts.acknowledgeSymlinkedSettings
    )
  );
}

async function runCommit(
  plan: ImportPlan,
  overwrite: ReadonlySet<string>,
  excluded: ReadonlySet<string>,
  pluginExec: PluginExecOptions,
  restoreFileOps?: RestoreFileOps,
  secretOverlay?: SecretOverlay,
  acknowledgeMissingHooks: readonly string[] = [],
  keepModes: ReadonlySet<string> = new Set<string>(),
  acknowledgeSymlinkedSettings?: string
): Promise<ImportResult> {
  // #3247: resolve the operator's selection ONCE — drives the writable filter,
  // the settings-backup precondition + merge, the hooks.imported count, validator
  // attribution, and MCP exclusion (folded in from the #2640/#2638 loop).
  // #4173 (D4): a carried script whose every referencing setting is kept is held.
  const held = heldSettingsScripts(plan.executableScripts, overwrite);
  const sel = resolveCommitExclusions(plan, excluded, new Set(held.keys()));
  // #3590 (K4/D9): fail-loud belt — refuse an unacknowledged registry-drift
  // commit BEFORE any write (throws RegistryDriftError → typed 4xx).
  assertRegistryAcknowledged(plan, sel, acknowledgeMissingHooks);
  const settingsPath = join(plan.claudeDir, "settings.json");
  const mergesSettings =
    Object.keys(plan.settingsToMerge).length > 0 ||
    sel.selectedHookEntries.length > 0;
  // #4146 (D14): refuse an unacknowledged settings.json link the merge would replace,
  // BEFORE any write (throws SymlinkedSettingsError → 409). Fires even if the merge is a no-op.
  const settingsLink = mergesSettings
    ? await checkSettingsLink(
        plan.claudeDir,
        settingsPath,
        acknowledgeSymlinkedSettings
      )
    : undefined;
  const backupDir = join(plan.dataDir, "porter-backup", plan.stagingHandle);
  await mkdir(backupDir, { recursive: true, mode: 0o700 });

  const backups: BackupRecord[] = [];
  const appliedModes: AppliedModeFix[] = []; // #4129: the mode-only undo for the rollback
  const filesWritten: string[] = [];
  const skippedConflicts: Conflict[] = [];

  // Which file items to write (skip conflicting differs unless overwrite chosen).
  const conflictByPath = new Map(plan.fileConflicts.map(c => [c.destPath, c]));
  const existing: PlannedFileItem[] = [];
  const writable = plan.files.filter(item => {
    // #3247: user deselection composes BEFORE the conflict branch — a
    // deselected item is not written and is NOT a skipped CONFLICT (choice ≠
    // conflict-skip), so it never lands in `skippedConflicts`.
    if (sel.isItemExcluded(item)) return false;
    const c = conflictByPath.get(item.destPath);
    if (!c) return true;
    if (c.kind === "exists") {
      existing.push(item); // byte-identical: content no-op; exec bits reconciled below (#4129)
      return false;
    }
    if (overwrite.has(item.destPath)) return true;
    skippedConflicts.push(c);
    return false;
  });

  let backupIndex = 0;
  // #4146: link-aware capture (./commitFs); the rollback skips records the commit never wrote.
  const backupOf = async (origPath: string): Promise<BackupRecord> => {
    const b = await captureBackup(
      origPath,
      join(backupDir, String(backupIndex++))
    );
    backups.push(b);
    return b;
  };

  try {
    // Backup every destination we will touch, up front.
    for (const item of writable) await backupOf(item.destPath);
    const settingsBackup = mergesSettings
      ? await backupOf(settingsPath)
      : undefined;
    await backupOf(plan.hostConfigPath);
    const accountFiles = await enumerateAccountConfigFiles(
      plan.accountConfigBases
    );
    for (const f of accountFiles) await backupOf(f);

    // a. Write file-tree items (dest-dir tmp + atomic rename).
    for (const item of writable) {
      const content = await readFile(item.stagedPath);
      markTouched(backups, [item.destPath]);
      await atomicWriteFile(item.destPath, content, importFileMode(item.mode));
      filesWritten.push(item.destPath);
    }
    // a2. #4129: restore the archive's exec bits on byte-identical files (./modeReconcile),
    // applying only previewed fixes and skipping rows the operator kept.
    const modes = await reconcileExistingModes(
      existing.filter(item => !keepModes.has(item.destPath)),
      plan.modeReconcile.fixes,
      appliedModes
    );

    // b. Merge settings.json key-wise (F5 allowlist + additive hooks block).
    let settingsMerged = false;
    let mergedHookRegistrations: MergedHookRegistration[] = [];
    if (mergesSettings) {
      const merge = await mergeSettings(
        settingsPath,
        plan.settingsToMerge,
        sel.selectedHookEntries,
        plan.settingsConflicts,
        overwrite,
        content =>
          writeMergedSettings(
            plan.claudeDir,
            settingsPath,
            content,
            settingsLink,
            settingsBackup
          )
      );
      settingsMerged = merge.changed;
      mergedHookRegistrations = merge.mergedHookRegistrations;
    }

    // c. MCP servers → host + per-account (re-decrypt from staging in-memory).
    //    #3247: `sel` folds the operator's MCP DESELECTION together with the
    //    #2640/#2638 quality exclusions (unresolvable / secret-unrestorable) into
    //    ONE `excludedMcpNames` set — the loop lives in ./commitSelection to keep
    //    this file under the #2077 max-lines cap; behaviour is identical (a user
    //    CHOICE emits NO `mcpExclusions` record; a quality failure still does).
    //    rebuildMcpItems SKIPS the excluded names before buildMcpServerConfig —
    //    load-bearing for the secret case: building a secret-unrestorable server
    //    would re-throw SecretInjectionError and abort the whole commit, defeating
    //    the per-server soft-exclude (R3).
    // #3546 (R6): recompute the MCP set for the recipient `secretOverlay` (logic in
    // ./mcpRebuild to stay under the #2077 max-lines cap) — re-authorised servers
    // leave the exclusion set and their eager kind:"secret" records are dropped.
    const { items: mcpItems, mcpExclusions } = await rebuildMcpItemsWithOverlay(
      plan,
      sel,
      excluded,
      secretOverlay
    );
    // #4146: touched until the merge reports what it wrote (./commitFs settleMcpTouched).
    const mcpPaths = [plan.hostConfigPath, ...accountFiles];
    markTouched(backups, mcpPaths);
    const mcp = await importMcpServers({
      items: mcpItems,
      hostConfigPath: plan.hostConfigPath,
      accountConfigBases: plan.accountConfigBases,
      overwrite: new Set([...overwrite]),
    });
    settleMcpTouched(backups, mcpPaths, mcp);

    // d. Hook validator — presence/registration/import-resolvability (#2639 F9,
    //    the third check). Reports drift; never rolls back. The validator call +
    //    F9 attribution are extracted to ./commitHooks (#3590, #2077 max-lines).
    const { hookValidation, hooks: hooksResult } =
      await attributeHookValidation(plan, sel);

    // #3590 (K6/D7): per-dimension expected-vs-written parity report.
    const parity = computeParity(
      plan,
      sel,
      filesWritten,
      skippedConflicts,
      hookValidation
    );

    // e. #3246 — post-commit visibility verification (READ-ONLY; the imported dims
    //    were written ONCE to `claudeDir`, but per-account visibility rides on the
    //    #1562 symlink bridge). Mirrors the `validateHookRegistration` verify-
    //    without-mutating pattern above; all logic lives in ./visibilityProbe.
    const importedBridgeDims = deriveImportedBridgeDims(filesWritten, {
      claudeDir: plan.claudeDir,
      settingsMerged,
    });
    const visibility = await probeAccountVisibility(plan.accountConfigBases, {
      hostClaudeDir: plan.claudeDir,
      dims: importedBridgeDims,
    });
    const isolationIntact = visibility.every(a => a.orphaned.length === 0);

    // Success — drop staging; leave the backup for the TTL sweep.
    await rm(plan.stagingDir, { recursive: true, force: true }).catch(() => {});

    const result: ImportResult = {
      committedAt: Date.now(),
      filesWritten,
      settingsMerged,
      mcp,
      hookValidation,
      skippedConflicts,
      modesCorrected: modes.corrected,
      modesSkipped: modes.skipped,
      mcpExclusions,
      hooks: hooksResult,
      mergedHookRegistrations,
      claudeDir: plan.claudeDir,
      visibility,
      isolationIntact,
      parity,
      settingsScriptsHeld: [...held].map(([destPath, keys]) => ({
        destPath,
        keys,
      })),
    };

    // #2465 (Sub G) — gated plugin install execution. Runs strictly AFTER commit
    // finalization + staging drop, INSIDE this function's own catch-all so ANY
    // throw here folds into a recorded failure and can NEVER reach the outer
    // catch's restoreBackups (which guards only the file swap, expert finding E8):
    // a post-swap rollback would revert config while plugins stayed installed —
    // an unowned inconsistent state. Still inside the F14 mutex. Non-fatal (R4).
    // Absent from the result when the gate is OFF → byte-identical to #2343 (D-2).
    if (porterPluginInstallEnabled() && plan.manifest.plugins) {
      try {
        result.pluginInstall = await executePluginInstall(
          plan.manifest.plugins,
          {
            trustAllowlist: resolveTrustAllowlist(
              pluginExec.extraTrustedMarketplaces
            ),
            runClaude: pluginExec.runClaude,
            secretResolutionEnv: pluginExec.secretResolutionEnv,
          }
        );
      } catch (pluginErr) {
        // executePluginInstall is designed non-throwing; this belt-and-suspenders
        // fold guarantees an unexpected internal throw still cannot destabilise the
        // finalized commit — it is recorded, never propagated.
        const reason =
          pluginErr instanceof Error ? pluginErr.message : String(pluginErr);
        result.pluginInstall = {
          marketplaces: [],
          installed: [],
          skipped: [],
          failed: [
            {
              kind: "plugin",
              identifier: "(plugin install phase)",
              command: null,
              reason: `plugin install execution threw unexpectedly and was contained: ${reason}`,
            },
          ],
          reAuthRequired: [],
          versionDrift: [],
        };
      }
    }

    return result;
  } catch (err) {
    // R6 — restore every backed-up destination to its pre-import state, COLLECTING
    // any per-file restore failures (#2563) so the thrown message reports the
    // rollback honestly: a clean full rollback vs a PARTIAL one that names the
    // file(s) left inconsistent — never mislabeling a partial rollback as clean.
    const restoreFailures = await restoreBackups(backups, restoreFileOps);
    restoreFailures.push(...(await restoreModes(appliedModes)));
    const reason = err instanceof Error ? err.message : String(err);
    // #4177 (L4) + #4246: typed wrap; `cause` = original failure (or applyOne's chmod error).
    if (restoreFailures.length > 0) {
      throw new CommitRollbackError(
        `Import failed and rollback was PARTIAL — ${restoreFailures.length} file(s) ` +
          `could not be restored and may be in an inconsistent state: ` +
          `${restoreFailures.join(", ")}. Original failure: ${reason}`,
        { cause: err, partial: true }
      );
    }
    throw new CommitRollbackError(
      `Import failed and was rolled back to the pre-import state: ${reason}`,
      { cause: err, partial: false }
    );
  }
}

/** Key-wise settings.json merge — F5 allowlist + additive hooks block. */
async function mergeSettings(
  settingsPath: string,
  settingsToMerge: Record<string, unknown>,
  hookEntries: HookEntry[],
  settingsConflicts: Conflict[],
  overwrite: ReadonlySet<string>,
  write: (content: Buffer) => Promise<void>
): Promise<{
  changed: boolean;
  mergedHookRegistrations: MergedHookRegistration[];
}> {
  // #2564 (F4): strict read — a malformed settings.json throws before any write
  // and is preserved by runCommit's rollback (not parsed as {} and overwritten).
  const existing = await readJsonObjectStrict(settingsPath);
  const conflictKeys = differingSettingsKeys(settingsConflicts);

  let changed = false;
  for (const [key, value] of Object.entries(settingsToMerge)) {
    const lands = settingsKeyLands(key, {
      conflictKeys,
      overwrite,
      settingsPath,
      keyExists: key in existing,
    });
    if (!lands) continue; // differing pre-existing key — preserved (default skip, R3)
    existing[key] = value;
    changed = true;
  }

  // Additive hooks block: append imported matcher entries per event, deduping
  // path-equivalent registrations (#2641 / F12). Two matcher entries are
  // duplicates iff they share an event, a matcher (absent ≡ ""), AND a canonical
  // command set (`$HOME` / `~/.claude` expanded to the destination home). The
  // key deliberately includes event + matcher + canonical command so a same
  // command under a different matcher or event is NEVER merged (R3 / Task 3
  // guardrail). Deduping runs against BOTH pre-existing destination entries and
  // other incoming entries; surviving entries keep their stored textual form —
  // we canonicalize for the compare only, never write the canonical form back
  // (KD-3). The count invariant (one output per unique canonical key) is a
  // REPORTED outcome via `mergedHookRegistrations`, never a runtime throw — a
  // throw here would be caught by runCommit's rollback and revert exactly the
  // damaged destinations this heals (D4 / 1B-9).
  const mergedHookRegistrations: MergedHookRegistration[] = [];
  if (hookEntries.length > 0) {
    // settingsPath = <claudeDir>/settings.json → destHome = dirname(claudeDir).
    // Matches the destHome used to expand incoming commands at import time.
    const destHome = dirname(dirname(settingsPath));
    const commandsOf = (entry: unknown): string[] => {
      const inner = (entry as { hooks?: unknown })?.hooks;
      if (!Array.isArray(inner)) return [];
      return inner
        .map(h => (h as { command?: unknown })?.command)
        .filter((c): c is string => typeof c === "string");
    };
    const matcherOf = (entry: unknown): string => {
      const m = (entry as { matcher?: unknown })?.matcher;
      return typeof m === "string" ? m : "";
    };
    const canonicalCommand = (entry: unknown): string =>
      commandsOf(entry)
        .map(c => canonicalHookCommand(c, destHome))
        .join("; ");
    // event + matcher + canonical command(s) — the full dedupe identity.
    const canonicalKey = (event: string, entry: unknown): string =>
      JSON.stringify([event, matcherOf(entry), canonicalCommand(entry)]);

    const incoming = toSettingsHooksBlock(hookEntries);
    const hooks = (existing.hooks ??= {}) as Record<string, unknown[]>;
    for (const [event, matchers] of Object.entries(incoming)) {
      const arr = Array.isArray(hooks[event])
        ? (hooks[event] as unknown[])
        : [];
      const seen = new Set<string>();
      const kept: unknown[] = [];
      let eventChanged = false;

      // D4: collapse pre-existing canonical-key-equivalent duplicate entries
      // already stored on the destination (the MS1 damaged-destination heal —
      // both the `$HOME` and expanded forms survived a prior no-dedupe import).
      // Keep the first, drop the rest, and report each collapse per-item (R6).
      // Strictly canonical-key-equivalent pairs only (KD-3).
      for (const entry of arr) {
        const key = canonicalKey(event, entry);
        if (seen.has(key)) {
          mergedHookRegistrations.push({
            event,
            command: canonicalCommand(entry),
            source: "preexisting-collapse",
          });
          eventChanged = true;
          continue;
        }
        seen.add(key);
        kept.push(entry);
      }

      // Then append incoming matchers, skipping any whose canonical key already
      // exists (a surviving pre-existing entry OR one appended earlier this run).
      for (const entry of matchers) {
        const key = canonicalKey(event, entry);
        if (seen.has(key)) {
          mergedHookRegistrations.push({
            event,
            command: canonicalCommand(entry),
            source: "incoming-skip",
          });
          continue;
        }
        seen.add(key);
        kept.push(entry);
        eventChanged = true;
      }

      hooks[event] = kept;
      // Dirty flag (D3, honors #2562 R3): a no-op for this event only when
      // nothing was appended AND nothing collapsed.
      if (eventChanged) changed = true;
    }
  }

  // #4130 mode + #4146 link rule live in ./commitFs writeMergedSettings.
  if (changed) await write(Buffer.from(JSON.stringify(existing, null, 2)));
  return { changed, mergedHookRegistrations };
}

/* ── atomicWriteFile + restoreBackups moved to ./commitFs (#3553, #2077 max-lines). ── */

/* ── TTL sweep (Task 6) ── */

/**
 * Remove staging/backup dirs older than `ttlMs`. Called by the plan endpoint so
 * an abandoned plan (never committed) does not accumulate. Best-effort.
 */
export async function sweepExpiredPorterDirs(
  dataDir: string,
  ttlMs: number = DEFAULT_TTL_MS,
  now: number = Date.now()
): Promise<void> {
  const { readdir, stat } = await import("node:fs/promises");
  for (const sub of ["porter-staging", "porter-backup"]) {
    const base = join(dataDir, sub);
    let entries: string[];
    try {
      entries = await readdir(base);
    } catch {
      continue;
    }
    for (const name of entries) {
      const p = join(base, name);
      try {
        const s = await stat(p);
        if (now - s.mtimeMs > ttlMs) {
          await rm(p, { recursive: true, force: true });
        }
      } catch {
        // ignore
      }
    }
  }
}
