// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
  parsePorterManifest,
  PORTABLE_SETTINGS_KEYS,
  SECRETS_MEMBER_ENCRYPTED,
  SECRETS_MEMBER_PLAINTEXT,
  type PorterManifest,
  type HookEntry,
  type McpSecretBundle,
  type Omission,
  type ConfigEntry,
} from "@hapi/protocol/porter";
import { decryptPorterArchive } from "../config/porterAgeKeys";
import { parseTarGzAsync } from "./tarArchive";
import { assertNoLinkMembers } from "./archiveContainment";
import {
  claudeMdCommitBytes,
  claudeMdUnreferencedNotices,
  planClaudeMd,
} from "./planClaudeMd";
import { mergeSettings } from "./mergeSettings";
import {
  buildExecutableScriptReview,
  heldSettingsScripts,
  holdUncarriedSettings,
  planSettingsScripts,
  referencedScriptRels,
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
  type McpMergeItem,
} from "./mcpImport";
import { withFileLock } from "./fileLock";
import { porterPluginInstallEnabled } from "../config/porterPluginInstallConfig";
import { executePluginInstall, type ClaudeRunner } from "./pluginInstall";
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
} from "./visibilityProbe";
import { resolveCommitExclusions } from "./commitSelection";
import { tolerateMissingSecrets } from "./definitionsOnly";
import { decryptFailureReason, parseSecretBundle } from "./secretBundle";
import { buildPluginRemediation, planTenant } from "./planTenant";
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
} from "./commitHooks";
import {
  atomicWriteFile,
  captureBackup,
  checkSettingsLink,
  classifySettingsLink,
  commitFailureText,
  importFileMode,
  isLinkWithoutSettingsFile,
  isRegularFile,
  markTouched,
  onSettingsResolution,
  restoreBackups,
  settingsResolutionNotice,
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
  type ModeReconcilePreview,
} from "./modeReconcile";
import type {
  ImportResult,
  MergedHookRegistration,
  PlannedItemKind,
  PlannedMcpServer,
} from "@hapi/protocol/porter";
// #5601: the wire shapes live in @hapi/protocol/porter (importWire.ts).
export type {
  PlannedItemKind,
  PlannedMcpServer,
  McpExclusion,
  MergedHookRegistration,
  ImportResult,
} from "@hapi/protocol/porter";

/**
 * #5601 (D4): what this server's commit returns. The wire type keeps `notices`
 * optional because a server that predates #5202 omitted it; this one always
 * sends it.
 */
export type EmittedImportResult = ImportResult & { notices: Omission[] };

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

/**
 * #5202 (U19): a staging-dir removal that fails leaves bytes on disk until the
 * staging sweeper runs; warn (the porter modules have no logger) rather than
 * swallow it.
 */
function warnStagingCleanup(stagingDir: string): (err: unknown) => void {
  return err =>
    console.warn(
      `[porter-import] staging cleanup failed: ${stagingDir} (${err instanceof Error ? err.message : String(err)})`
    );
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
  /** Every omission: the exporter's, then the importer's (`commitHooks` reads all). */
  omissions: Omission[];
  /** #4156 (K-A): the importer's policy refusals, the SAME objects as in `omissions`. */
  policySkips: Omission[];
  /**
   * #5202 (U10): the importer's notices — an item imported or reported with a
   * note, not a refusal — the SAME objects as in `omissions`. Rendered as their
   * own group ("Imported with a note").
   */
  notices: Omission[];
  /** #4156: lets the commit keep an excluded include's original CLAUDE.md reference. */
  claudeMdRewrite?: ReturnType<typeof planClaudeMd>["rewrite"];
  pluginRemediation: string[];
  pluginDescriptorPresent: boolean;
  createdAt: number;
  ttlMs: number;
}

/* ── ImportPlanSummary + toPlanSummary extracted to ./importPlanSummary
   (#3590, #2077 max-lines) so the summary type sits beside its projection.
   `ImportPlanSummary` is imported (for {@link} doc refs) + re-exported below. ── */

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

export const PORTER_STAGING_TTL_MS = 30 * 60 * 1000; // an uncommitted plan's lifetime
/* ── Helpers — destination resolvers moved to ./importDestination (#2806, #2077 max-lines) ── */

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

  // 1. Decompress + parse (F9 caps enforced inside parseTarGzAsync, inflated
  //    off the event loop one archive at a time, #5228). Nothing on disk.
  const entries = await parseTarGzAsync(archiveBuf);

  // 2. Manifest: version-before-shape (R1). Zero bytes written on failure.
  const manifestEntry = findEntry(entries, "manifest.json");
  if (!manifestEntry) {
    throw new ManifestValidationError(
      "missing",
      "Archive has no manifest.json."
    );
  }
  // #4294: a linked manifest.json has no bytes to parse; name it as a link.
  assertNoLinkMembers(claudeDir, [manifestEntry]);
  let manifestRaw: unknown;
  try {
    manifestRaw = JSON.parse(manifestEntry.data.toString("utf-8"));
  } catch {
    // #5676: a fixed reason, never the parser's text — Bun's JSON.parse names
    // an unquoted value verbatim, and the manifest is foreign input.
    throw new ManifestValidationError(
      "invalid",
      "manifest.json is not valid JSON."
    );
  }
  const parsed = parsePorterManifest(manifestRaw);
  if (!parsed.ok) {
    throw new ManifestValidationError(parsed.kind, parsed.error);
  }
  const manifest = parsed.manifest;
  // #4294 (ruling A): any link member refuses the archive, referenced or not —
  // after manifest validation, so a version or shape error is reported first
  // (R1), and before any planning or staging.
  assertNoLinkMembers(claudeDir, entries);

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
      // #5543: a fixed reason, never the decrypter's message — a member that is
      // not age-encrypted fails with `invalid version <its first line>`.
      throw new SecretDecryptionError(decryptFailureReason(err));
    }
    // #5543: a fixed reason — the parser's own text can echo bundle content.
    const parsed = parseSecretBundle(plaintext);
    if (!parsed.ok) throw new SecretDecryptionError(parsed.reason);
    secretBundle = parsed.bundle;
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
    // is reflected in the plan's conflict hash, and the commit writes exactly
    // the command this plan reviewed, or excludes the server when the command
    // it would build differs (#5192, ./mcpRebuild commandDriftExclusion).
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
      // registered hooks) stages PATH-PRESERVED (as hook FILES do since #4331)
      // and flows through `detectFileConflicts` + the overwrite-none default
      // for free (R4 conflict policy — no bespoke landing block needed).
      ["hookSupport", manifest.hookSupport],
    ];
    // #3590 (K3): destinations a registered `hooks[]` entry stages (#4331) are
    // planned by the hook-FILE loop below — skip them in the hookSupport
    // dimension so a non-conforming archive is corrected, not double-planned.
    const claimed = claimedHookPaths(entries, manifest.hooks, claudeDir);
    // #4160: a section entry writes only inside its own folder; the rest is
    // skipped (./planSections) and reported in `omissions`. #4185: an entry
    // that matches no file is reported too, in its own (non-policy) array.
    const sectionOmissions: Omission[] = [];
    const sectionUnmatched: Omission[] = [];
    for (const [dimKey, ces] of dims) {
      const { plans, skipped, unmatched } = planDimension(
        entries,
        ces,
        dimKey,
        claudeDir,
        stagingDir,
        dimKey === "hookSupport" ? claimed : undefined
      );
      sectionOmissions.push(...skipped);
      sectionUnmatched.push(...unmatched);
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
    let claudeMdPlan: ReturnType<typeof planClaudeMd> | undefined;
    if (manifest.claudeMd) {
      claudeMdPlan = planClaudeMd(
        entries,
        manifest.claudeMd,
        claudeDir,
        stagingDir
      );
      claudeMdOmissions.push(...claudeMdPlan.skipped);
      for (const item of claudeMdPlan.items) {
        const entry = findEntry(entries, item.archivePath);
        if (!entry || entry.kind !== "file") {
          // #5202 (U19): planClaudeMd returns only regular-file members, so
          // this is a planner/stager mismatch — say so instead of dropping it.
          console.warn(
            `[porter-import] CLAUDE.md item ${item.archivePath} has no regular-file member to stage; skipped`
          );
          continue;
        }
        // #4156: CLAUDE.md with its nested include references rewritten.
        const content = item.content ?? entry.data;
        await mkdir(dirname(item.file.stagedPath), { recursive: true });
        await writeFile(item.file.stagedPath, content);
        files.push(item.file);
        stagedItems.push({ destPath: item.file.destPath, content });
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
    // #4173: the scripts the values run; #5178 holds a value whose file is unwritten.
    const homeDir = opts.homeDir ?? homedir();
    const scriptPlan = planSettingsScripts(
      entries,
      manifest,
      settingsToMerge,
      claudeDir,
      homeDir,
      stagingDir
    );
    const scriptPlans = holdUncarriedSettings(settingsToMerge, scriptPlan, {
      claudeDir,
      homeDir,
      files,
    });
    await stageSettingsScripts(scriptPlans, files, stagedItems);
    // #4373: the memory section and the premium refusal (./planTenant).
    const tenant = await planTenant(entries, manifest, files, stagedItems, {
      claudeDir,
      stagingDir,
      homeDir,
    });
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
    // #4331: every producer has planned by now, so a registration whose file
    // this plan does not write is held, and one whose script is neither planned
    // nor at the destination is reported (R5).
    const { hookEntries, hookHolds, hookCommandWarnings, unknownHookEvents } =
      buildHookEntries(
        manifest.hooks,
        destHome,
        claudeDir,
        new Set(files.map(f => f.destPath))
      );

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
    const pluginRemediation = buildPluginRemediation(tenant.manifest);

    const plan: ImportPlan = {
      stagingHandle,
      stagingDir,
      claudeDir,
      hostConfigPath,
      dataDir: opts.dataDir,
      settingsFile: opts.settingsFile,
      accountConfigBases,
      manifest: tenant.manifest,
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
        ...sectionUnmatched,
        ...claudeMdOmissions,
        ...(claudeMdPlan?.notices ?? []),
        ...scriptPlan.skipped,
        ...scriptPlan.notices,
        ...hookHolds,
        ...tenant.notices,
        ...tenant.skipped,
      ],
      // A #5178 / #4331 hold is a refusal; a missing carried script is a
      // notice (#5202 U13: planSettingsScripts returns the two apart).
      policySkips: [
        ...sectionOmissions,
        ...claudeMdOmissions,
        ...scriptPlan.skipped,
        ...hookHolds,
        ...tenant.skipped,
      ],
      notices: [...(claudeMdPlan?.notices ?? []), ...scriptPlan.notices],
      claudeMdRewrite: claudeMdPlan?.rewrite,
      pluginRemediation,
      pluginDescriptorPresent: Boolean(tenant.manifest.plugins),
      createdAt: now,
      ttlMs: opts.ttlMs ?? PORTER_STAGING_TTL_MS,
    };
    return plan;
  } catch (err) {
    // Directive Task 1: every planImport failure path removes the staging dir and
    // rethrows — a plan-phase failure leaves zero bytes AND no orphaned staging.
    await rm(stagingDir, { recursive: true, force: true }).catch(
      warnStagingCleanup(stagingDir)
    );
    throw err;
  }
}

/* ── buildPluginRemediation moved to ./planTenant (#4373, #2077 max-lines). ── */

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  try {
    if (!(await isRegularFile(path))) return {}; // #4146: never open a FIFO (blocks)
    const parsed = JSON.parse(await readFile(path, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
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
export {
  toPlanSummary,
  type EmittedPlanSummary,
  type ImportPlanSummary,
} from "./importPlanSummary";

/* ── Commit (backup-then-swap under the import mutex) ── */
/* BackupRecord + the commit fs primitives live in ./commitFs (#3553, #2077 max-lines). */

export async function commitImport(
  plan: ImportPlan,
  opts: CommitImportOptions = {}
): Promise<EmittedImportResult> {
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
): Promise<EmittedImportResult> {
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
  // #5760: a file item at a path an inside/outside settings.json link resolves
  // through would replace the settings the merge reads (./commitFs). Hold it.
  const heldBySettings = await onSettingsResolution(
    settingsPath,
    settingsLink,
    plan.files.map(item => item.destPath)
  );
  const heldNotices: Omission[] = [];
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
    if (heldBySettings.has(item.destPath)) {
      if (c && c.kind !== "exists") skippedConflicts.push(c);
      if (!c || c.kind === "exists" || overwrite.has(item.destPath)) {
        heldNotices.push(
          settingsResolutionNotice(plan.claudeDir, item.destPath)
        );
      }
      return false;
    }
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
      const content =
        claudeMdCommitBytes(plan.claudeMdRewrite, item, sel.isItemExcluded) ??
        (await readFile(item.stagedPath));
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
            settingsBackup,
            filesWritten // #5759: what this import wrote, for the race guard
          ),
        isLinkWithoutSettingsFile(settingsLink) // #4281, #5534: an empty base
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
    await rm(plan.stagingDir, { recursive: true, force: true }).catch(
      warnStagingCleanup(plan.stagingDir)
    );

    const result: EmittedImportResult = {
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
      notices: [
        ...claudeMdUnreferencedNotices(
          plan.claudeMdRewrite,
          p => filesWritten.includes(p),
          p => conflictByPath.get(p)?.kind === "exists"
        ),
        ...heldNotices,
      ],
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
    // file(s) left inconsistent and why (#3022) — never mislabeling a partial
    // rollback as clean.
    const restoreFailures = await restoreBackups(backups, restoreFileOps);
    restoreFailures.push(...(await restoreModes(appliedModes)));
    // #5787: an errno failure is its code + syscall (`<dest> (…)` when a
    // destination resolves), never a backup/staged path.
    const reason = commitFailureText(err, plan);
    // #4177 (L4) + #4246: typed wrap; `cause` = original failure (or applyOne's chmod error).
    if (restoreFailures.length > 0) {
      throw new CommitRollbackError(
        `Import failed and rollback was PARTIAL — ${restoreFailures.length} file(s) ` +
          `could not be restored and may be in an inconsistent state: ` +
          `${restoreFailures.map(f => `${f.path} (${f.cause})`).join(", ")}. ` +
          `Original failure: ${reason}`,
        { cause: err, partial: true }
      );
    }
    throw new CommitRollbackError(
      `Import failed and was rolled back to the pre-import state: ${reason}`,
      { cause: err, partial: false }
    );
  }
}

/* ── mergeSettings + readJsonObjectStrict moved to ./mergeSettings (#4281, #2077 max-lines). ── */

/* ── atomicWriteFile + restoreBackups moved to ./commitFs (#3553, #2077 max-lines). ── */

/* ── TTL sweep (Task 6) ── */

/**
 * Remove staging/backup dirs older than `ttlMs`. Called by the staging sweeper
 * (`./porterStagingSweeper`) so an abandoned plan does not accumulate. Best-effort.
 * Names in `keep` (live plans' staging handles, #5170) are never removed.
 */
export async function sweepExpiredPorterDirs(
  dataDir: string,
  ttlMs: number = PORTER_STAGING_TTL_MS,
  now: number = Date.now(),
  keep: ReadonlySet<string> = new Set()
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
      if (keep.has(name)) continue;
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
