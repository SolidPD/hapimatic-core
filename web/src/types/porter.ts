// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Client-facing Configuration Porter response types (issue #2344, epic #2339
 * Sub E). Backs the Admin → Configuration page's four data surfaces.
 *
 * :warning: MONOREPO-BOUNDARY MIRROR. `web/` may import only from
 * `@hapi/protocol` (shared), never from `server/`. `Omission` is genuinely
 * shared, so it is IMPORTED below. The remaining shapes are the server's
 * client-facing response types, which live in `server/` and cannot be imported;
 * they are MIRRORED here field-for-field. When a server shape changes, this file
 * MUST change in lockstep. Source-of-truth anchors:
 *
 *   - `InstalledConfigResponse` → `server/src/web/routes/porterInstalled.ts`
 *   - `ImportPlanSummary`, `ImportResult`, `PlannedMcpServer`, `PlannedItemKind`
 *       → `server/src/porter/importArchive.ts`
 *   - `ImportGroups`, `SkillGroup`, `IndependentHook`
 *       → `server/src/porter/commitSelection.ts`
 *   - `Conflict` → `server/src/porter/conflictDetection.ts`
 *   - `ModeCorrection`, `ModeSkip`, `ModePreviewFix`, `ModePreviewSkip`,
 *     `ModeReconcilePreview` → `server/src/porter/modeReconcile.ts`
 *   - `McpImportResult`, `McpFileMergeResult` → `server/src/porter/mcpImport.ts`
 *   - `RegisteredHook`, `HookRegistrationValidationResult`
 *       → `server/src/porter/hookRegistrationValidator.ts`
 *   - `SymlinkedSettingsRefusal` → the commit route's 409 echo in
 *       `server/src/web/routes/porterImport.ts`
 *   - `PorterImportPlanOptions` — request-side, no server mirror; consumed by
 *       `client.planPorterImport`
 *   - `ExecutableScriptReview`, `ScriptPreview`
 *       → `server/src/porter/planSettingsScripts.ts` (#4173)
 */
import type {
  ExecutableSettingsKey,
  Omission,
  PorterTokenResponse,
  PorterTokenState,
  PorterTokenStatus as PorterTokenStatusBase,
  PorterSourceId,
  SettingsScriptNameVerdict,
  SourceRecord,
} from "@hapi/protocol/porter";

/**
 * #3446 (K1) — the tokenized one-liner export contract. `PorterTokenResponse`
 * and `PorterTokenState` are genuinely shared (no server-only shapes), so they
 * are IMPORTED from `@hapi/protocol/porter` and re-exported rather than mirrored.
 * `PorterTokenStatus` carries the staged plan summary, whose type is server-only
 * (mirrored below as {@link ImportPlanSummary}); the shared base is generic over
 * that payload, so the web narrows it here. B (#3447) fills `fetchUrlPowerShell`.
 */
export type { PorterTokenResponse, PorterTokenState };
export type PorterTokenStatus = PorterTokenStatusBase<ImportPlanSummary>;

/**
 * #3299: per-request options for the import PLAN call — the request-side companion
 * to {@link ImportPlanSummary} (which mirrors the server RESPONSE). Unlike every
 * other shape in this file it has NO server mirror; it is consumed by
 * `client.planPorterImport` and threaded through `usePorterImport`.
 */
export interface PorterImportPlanOptions {
  /**
   * Same-machine isolation (#2806/#3299): redirect the import under
   * `<isolatedDest>/.claude` instead of the live `~/.claude`. Absolute path;
   * denylisted subtrees (`/tmp`, `~/.config`, porter-staging/backup) are rejected
   * by the server (RC-4/RC-6). Omit for the default (live) destination.
   */
  isolatedDest?: string;
}

/**
 * #3546 (ADR-0006 Fork A): recipient-supplied secrets carried ONCE in the commit
 * body for `secretRestorable: false` servers — `{ [serverName]: { [slotName]:
 * value } }`. Inner keys are the SYNTHETIC slot names (`__args_<i>__`, `__url__`,
 * an env key, a header key) — never the human display label. Request-side only;
 * mirrors the server `SecretOverlay` (`server/src/porter/mcpRebuild.ts`). Held in
 * memory only; never persisted client-side.
 */
export type SecretOverlay = Record<string, Record<string, string>>;

/** `GET /api/porter/recipient` — the instance's public recipient + export affordances. */
export interface PorterRecipientResponse {
  /** Public age recipient (`age1…`). Never the secret identity. */
  recipient: string;
  schemaVersion: number;
  /**
   * #3245: the script-driven, secrets-free export — a self-contained shell
   * script the user runs DIRECTLY on the source machine (no Claude/LLM step, no
   * recipient, no secrets). Built server-side (`buildExportScript`, #3245); the
   * DEFAULT export affordance. Displayed verbatim; NEVER rebuilt client-side.
   */
  script: string;
  /**
   * Server-derived versioned download filename for `script` (e.g.
   * `hapimatic-config-export-v1.0.1049.sh`). Set unconditionally by the server
   * (`porterKey.ts:137`) and consumed by the client verbatim — never rebuilt
   * client-side. Single-sourced server-side so the filename always matches the
   * version stamped in the script's own banner. Because the web bundle is served
   * by the same server build, the only way this is absent on the wire is a dev
   * vite-against-an-older-server session; the client treats that as a no-op
   * Download rather than saving under an unversioned name (issue #3381).
   */
  scriptFilename: string;
  /**
   * Fully-rendered extraction prompt, built server-side (`buildExtractionPrompt`,
   * #2342). Displayed verbatim; NEVER rebuilt client-side (directive D3). #3245
   * DEMOTED this to the advanced/opt-in "include secrets (LLM-assisted)" path —
   * preserved (not deleted) so the deferred credential-custody work (#2339) has a
   * base and no capability is lost.
   */
  prompt: string;
}

/** One registered hook, flattened to (event, command, matcher?). */
export interface RegisteredHook {
  event: string;
  command: string;
  matcher?: string;
}

/** `GET /api/porter/installed` — the currently-installed config read surface. */
export interface InstalledConfigResponse {
  claudeDir: string;
  skills: string[];
  agents: string[];
  hooks: {
    /** Hook script files present on disk. */
    files: string[];
    /** Hook registrations declared in settings.json. */
    registrations: RegisteredHook[];
    /** Files on disk with no matching registration (dead code). */
    orphanFiles: string[];
    /** Registrations whose referenced script does not exist (dead hook). */
    orphanRegistrations: string[];
  };
  plugins: {
    marketplaces: { name: string; source: string }[];
    plugins: { name: string; marketplace?: string; version?: string }[];
  };
  /**
   * #3590 (K6/D7): the last import's {@link ImportResult} (incl. `parity`) — the
   * JSON "CLI equivalent" of the commit response. In-memory server-side: `null`
   * on a fresh server and after any restart.
   */
  lastImport?: ImportResult | null;
}

/**
 * `GET /api/porter/content?dimension&name` — one installed file's text plus its
 * exact absolute host path (issue #3116). MIRROR of the server's inline response
 * in `server/src/web/routes/porterInstalled.ts`; keep in lockstep.
 */
export interface PorterContentResponse {
  /** Absolute host path of the resolved file (the copyable path, R2). */
  path: string;
  /** File text, or "" when `truncated`/`binary`. */
  content: string;
  /** Set when the file exceeded the ~1 MB preview cap (content is ""). */
  truncated?: boolean;
  /** Set when the file is binary (NUL byte detected; content is ""). */
  binary?: boolean;
  /** Byte size, present when `truncated`. */
  size?: number;
}

export type PlannedItemKind =
  | "skill"
  | "agent"
  | "command"
  | "rule"
  | "output-style"
  | "claude-md"
  | "claude-md-include"
  | "hook-file"
  // #2639 (F9): a shared hook-support module carried PATH-PRESERVED via the
  // manifest `hookSupport` dimension (mirror drift-fix, #3590).
  | "hook-lib"
  // #4173: the top-level script an imported statusLine/apiKeyHelper runs.
  | "settings-script";

/** #4173 (D5): a carried script's content preview — inert text, never executed. */
export interface ScriptPreview {
  text: string;
  truncated: boolean;
  binary: boolean;
  size: number;
}

/**
 * #4173 (R11): one review row per config-root reference an executable value
 * makes. `gatedBy` (a `settings-script` only): empty when a referencing key
 * lands as it stands, else the `<settings.json>#<key>` keys whose overwrite
 * would let the script be written (D4).
 */
export interface ExecutableScriptReview {
  key: ExecutableSettingsKey;
  reference: string;
  verdict: SettingsScriptNameVerdict;
  status: "carried" | "on-destination" | "missing" | "not-carried";
  reason?: string;
  destPath?: string;
  kind?: PlannedItemKind;
  sha256?: string;
  conflict?: "exists" | "differs";
  gatedBy?: string[];
  preview?: ScriptPreview;
}

/** One detected collision against an existing destination file/key. */
export interface Conflict {
  /** Absolute dest path, or `"<file>#<key>"` for a keyed collision. */
  destPath: string;
  /**
   * `"exists"` = byte-identical (the content is an idempotent no-op; the commit
   * may still add the archive's execute bit, #4129); `"differs"` = a real conflict.
   */
  kind: "exists" | "differs";
  incomingHash: string;
  existingHash: string;
}

/**
 * #4129: one byte-identical file given the archive's execute bit. Modes are
 * `& 0o7777`. MIRROR of `ModeCorrection` in `server/src/porter/modeReconcile.ts`.
 */
export interface ModeCorrection {
  destPath: string;
  from: number;
  to: number;
}

/**
 * #4129: a byte-identical file whose mode was left alone, and why. MIRROR of
 * `ModeSkip` in `server/src/porter/modeReconcile.ts`.
 */
export interface ModeSkip {
  destPath: string;
  reason: "symlink" | "not-a-file" | "not-owner" | "unreadable" | "changed";
}

/**
 * #4129: a preview row carries its item `kind` so the client applies the
 * commit's selection rule: a `hook-lib` row is excluded only when every hook
 * is, any other row when its own destPath is. MIRRORS of `ModePreviewFix` /
 * `ModePreviewSkip` in `server/src/porter/modeReconcile.ts`.
 */
export interface ModePreviewFix extends ModeCorrection {
  kind: PlannedItemKind;
}
export interface ModePreviewSkip extends ModeSkip {
  kind: PlannedItemKind;
}

/**
 * #4129: the plan-time preview of the exec-bit reconcile — the changes the
 * commit may apply (it applies no others) and the files it expects to leave
 * alone.
 * MIRROR of `ModeReconcilePreview` in `server/src/porter/modeReconcile.ts`.
 */
export interface ModeReconcilePreview {
  fixes: ModePreviewFix[];
  skipped: ModePreviewSkip[];
}

/** One MCP server in the plan — reported WITHOUT any secret value. */
export interface PlannedMcpServer {
  name: string;
  hasSecrets: boolean;
  conflict: Conflict | null;
  /**
   * #2638 (F15): whether EVERY declared secret slot restored from the bundle.
   * `false` ⇒ NAMED (key name only) + EXCLUDED from the success count. Mirror of
   * the server-side `PlannedMcpServer.secretRestorable` (`importArchive.ts`).
   */
  secretRestorable: boolean;
  /** KEY NAME of the first unrestorable secret slot — never the VALUE (#2638). */
  secretFailureKey?: string;
  /**
   * #3546 (R3): the server's declared secret SLOT NAMES — never values. Drives the
   * recipient-side re-auth form (ADR-0006 Fork A). Mirrors the heterogeneous
   * server/manifest shapes VERBATIM — `argsNames` is `{index,name}[]` (the `name`
   * is the `__args_<i>__` bundle key), NOT `string[]`.
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
   * `false` ⇒ NAMED in the plan/commit summary + EXCLUDED from the success count.
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
 * is unresolvable on the destination (#2640). Secret-free: `name`/`detail` carry
 * no credential material.
 */
export interface McpExclusion {
  name: string;
  kind: "secret" | "runtime" | "path";
  detail: string;
}

/** One skill and its EXACT membership (files) + the hooks that serve it (#3247). */
export interface SkillGroup {
  skill: string;
  /** destPaths of this skill's file items. */
  files: string[];
  /** hook-file destPaths of hooks whose command references `skills/<skill>/`. */
  servingHooks: string[];
}

/** A hook that serves no skill — its own top-level selection unit (#3247). */
export interface IndependentHook {
  /** The hook-file destPath — the exclusion key (registration + file as one). */
  id: string;
  command: string;
  events: string[];
}

/**
 * #3247: hierarchical grouping of ALL plan dimensions for the pre-import
 * selection UI. Every value is the item's EXCLUSION KEY (file/hook destPaths,
 * MCP server names). MIRROR of `ImportGroups` in
 * `server/src/porter/commitSelection.ts`; keep in lockstep.
 */
export interface ImportGroups {
  skills: SkillGroup[];
  independentHooks: IndependentHook[];
  mcpServers: string[];
  agents: string[];
  commands: string[];
  rules: string[];
  outputStyles: string[];
  claudeMd: string[];
  /**
   * #3448 (Sub C): per-source grouping for the archive-received review cards.
   * MIRROR of `ImportGroups.bySource` in `server/src/porter/commitSelection.ts`;
   * keep in lockstep. `found` is the source's discovery metadata (true even for
   * found-but-empty); `keys` are that source's EXCLUSION keys (claude-code owns
   * every file/hook dimension plus its MCP names; Cursor / Claude Desktop carry
   * MCP server names only) — a card is a whole-source toggle over the ONE set.
   */
  bySource: Record<PorterSourceId, { found: boolean; keys: string[] }>;
}

/**
 * Client-facing plan summary. Ships resolved destination paths
 * (`claudeDir`/`hostConfigPath`) — consistent with `items[].destPath`, which
 * already carries absolute dest paths (#2620 / F6).
 *
 * #2600: imported VALUES (hook command strings, `env` values, `permissions`
 * values) are surfaced DELIBERATELY for review scrutiny — potentially including
 * secrets from a hostile archive. That visibility IS the control, so this
 * summary is intentionally NOT value-free.
 */
export interface ImportPlanSummary {
  stagingHandle: string;
  /**
   * #2620 (F6): resolved destination paths this commit will write to, surfaced
   * so the operator sees the target BEFORE committing. A same-machine instance
   * resolves these to the host `~/.claude` (+ `~/.claude.json`) UNLESS
   * `CLAUDE_CONFIG_DIR`/`claudeDir` redirects the config root.
   */
  claudeDir: string;
  hostConfigPath: string;
  items: { kind: PlannedItemKind; name: string; destPath: string }[];
  /** #3247: hierarchical grouping of items/hooks/MCP for the pre-import selection UI. */
  groups: ImportGroups;
  /** #3448 (Sub C): per-source discovery metadata for the review cards (absent on a legacy archive). */
  sources?: SourceRecord[];
  conflicts: Conflict[];
  /** #4129: byte-identical files the commit may give the archive's execute bit (and skips). */
  modeReconcile: ModeReconcilePreview;
  /**
   * F6: `keys` are the allowlisted `settings.json` members that WOULD be written.
   * F7: `skippedKeys` are non-allowlisted keys dropped from the import.
   * #2600: `envValues`/`permissionsValues` surface the imported VALUES for review.
   */
  settings: {
    keys: string[];
    conflicts: Conflict[];
    skippedKeys: string[];
    /** #2600: env key→value pairs, surfaced for review (NODE_OPTIONS/ANTHROPIC_BASE_URL etc.). */
    envValues: { key: string; value: string }[];
    /** #2600: permissions key→value pairs, surfaced for review (e.g. defaultMode overrides). */
    permissionsValues: { key: string; value: unknown }[];
    /** #2565 (F5): full VALUES of executable settings keys (apiKeyHelper/statusLine) — the
     * subset Claude Code runs as shell commands — surfaced so the review is not
     * values-blind to an injected command. */
    executableValues: { key: string; value: unknown }[];
    /** #4173 (R11): the files those values run — path, sha256, status and a preview. */
    executableScripts: ExecutableScriptReview[];
  };
  /**
   * #4146 (R4): the destination settings.json is a symlink and the plan merges
   * settings or hooks. `inside` = written through (link kept); any other state
   * is refused with a 409 unless `acknowledgeSymlinkedSettings` equals `target`
   * (both only if the commit's selection still merges settings keys or hooks).
   * MIRROR of `ImportPlanSummary.settingsLink` in
   * `server/src/porter/importPlanSummary.ts`. #4277: the review's Destination
   * section renders it (`ImportSettingsLink.tsx`).
   */
  settingsLink?: {
    target: string;
    state: "inside" | "outside" | "dangling" | "loop" | "not-regular";
  };
  hooks: {
    count: number;
    unknownEvents: string[];
    commandWarnings: string[];
    /** #2600: per-entry hook command strings, surfaced verbatim for review scrutiny. */
    commands: { events: string[]; matcher?: string; command: string }[];
    /** #3590 (K4/D9): registry-referenced hook names absent from archive + dest. */
    registryMissing: string[];
  };
  mcpServers: PlannedMcpServer[];
  plugins: { descriptorPresent: boolean; remediation: string[] };
  omissions: Omission[];
  expiresAt: number;
}

/**
 * #4146 (D14) / #4277: the `symlinkedSettings` echo of a commit refused with 409
 * because the destination settings.json is a link the merge must not write
 * through. Re-committing with `acknowledgeSymlinkedSettings` set to `target`,
 * byte-exact, replaces the link, provided the link still reads `target` and the
 * selection still merges settings.json. MIRROR of the echo built in
 * `server/src/web/routes/porterImport.ts` from `SymlinkedSettingsError`;
 * `reason` mirrors `SymlinkedSettingsReason` in
 * `server/src/porter/importArchiveErrors.ts`.
 */
export interface SymlinkedSettingsRefusal {
  linkPath: string;
  target: string;
  reason: "outside-root" | "dangling" | "loop" | "not-regular";
}

/** Per-config-file MCP merge outcome. */
export interface McpFileMergeResult {
  configPath: string;
  imported: string[];
  skipped: Conflict[];
}

/**
 * F1: host result reflects `~/.claude.json`; `perAccount` reflects each
 * account-bound config — the same server is only truly present in a session
 * whose account received the merge.
 */
export interface McpImportResult {
  host: McpFileMergeResult;
  perAccount: McpFileMergeResult[];
}

/** Post-commit bidirectional hook-registration validator output (directive D5). */
export interface HookRegistrationValidationResult {
  orphanFiles: string[];
  orphanRegistrations: string[];
  /**
   * #2639 (F9): hooks whose `from lib.X` import does NOT resolve against the
   * landed `hooks/lib/` — `hook` is the dest script path, `module` the missing
   * lib module. Mirror drift-fix (#3590; the field existed server-side).
   */
  unresolvedImports: { hook: string; module: string }[];
  /**
   * #3590 (K5, rule 4): DESTINATION registry names resolving to no hook file —
   * the post-commit half of the fail-loud belt.
   */
  registryMissing: string[];
}

/**
 * #3246: per-account post-import visibility of the imported bridge dims. MIRROR
 * of `AccountVisibility` in `server/src/porter/visibilityProbe.ts`; keep in
 * lockstep. `orphaned` = the account's sessions fall back to the host dir
 * (isolation degraded), NOT "skills invisible"; `pending` is the normal
 * first-import state (bridge links on the next spawn).
 */
export interface AccountVisibility {
  account: string;
  base: string;
  visible: string[];
  pending: string[];
  orphaned: string[];
  absent: string[];
}

/**
 * #3590 (K6/D7): per-dimension parity — the selected plan vs what the commit did.
 * MIRROR of `DimensionParity` in `server/src/porter/commitHooks.ts`.
 */
export interface DimensionParity {
  expected: number;
  written: number;
  alreadyPresent: number;
  skippedConflicts: number;
  /** hooks: post-commit registry drift; hookSupport: truncated per-file entries. */
  missing: string[];
}

/** #3590 (K6/D7): the per-dimension parity report carried on {@link ImportResult}. */
export type ImportParity = Record<string, DimensionParity>;

/**
 * #2641 (F12): a hook registration DEDUPED during the settings merge. MIRROR of
 * `MergedHookRegistration` (`server/src/porter/importArchive.ts`; #3590 drift-fix).
 */
export interface MergedHookRegistration {
  event: string;
  command: string;
  source: "incoming-skip" | "preexisting-collapse";
}

/* ── Plugin install-execution result (#2465). MIRROR of the shapes in
   `server/src/porter/pluginInstall.ts`; #3590 drift-fix (never rendered today,
   carried for mirror honesty). ── */
export interface MarketplaceOutcome {
  name: string;
  source: string;
  status: "added" | "already-present" | "skipped-untrusted" | "failed";
  pinnedRef: string | null;
  reason?: string;
}
export interface InstalledPluginRecord {
  name: string;
  marketplace: string;
  installedVersion: string | null;
  recordedVersion: string | null;
}
export interface SkippedPluginRecord {
  name: string;
  marketplace: string;
  reason: string;
}
export interface FailedRecord {
  kind: "marketplace" | "plugin";
  identifier: string;
  command: string | null;
  reason: string;
}
export interface ReAuthRecord {
  plugin: string;
  marketplace: string;
  server: string;
  missingFields: string[];
}
export interface VersionDriftRecord {
  plugin: string;
  marketplace: string;
  recorded: string;
  installed: string;
}
export interface PluginInstallResult {
  marketplaces: MarketplaceOutcome[];
  installed: InstalledPluginRecord[];
  skipped: SkippedPluginRecord[];
  failed: FailedRecord[];
  reAuthRequired: ReAuthRecord[];
  versionDrift: VersionDriftRecord[];
}

/** `POST /api/porter/import/commit` — the committed-import result. */
export interface ImportResult {
  committedAt: number;
  filesWritten: string[];
  settingsMerged: boolean;
  mcp: McpImportResult;
  hookValidation: HookRegistrationValidationResult;
  /** Conflicts left unresolved (skipped — the pre-existing config was kept). */
  skippedConflicts: Conflict[];
  /** #4129: byte-identical files given the archive's execute bit (still `alreadyPresent`). */
  modesCorrected: ModeCorrection[];
  /** #4129: byte-identical files whose mode was left alone, with the reason. */
  modesSkipped: ModeSkip[];
  /**
   * #2640 (F13/F14): MCP servers excluded from the import because their command
   * was unresolvable on the destination — listed separately, never counted as
   * imported-functional.
   */
  mcpExclusions: McpExclusion[];
  /**
   * #2639 (F9): hook import-resolvability outcome — `imported` count + `excluded`
   * (basename + missing lib module). Mirror drift-fix (#3590).
   */
  hooks: { imported: number; excluded: { hook: string; module: string }[] };
  /** #2641 (F12): hook registrations deduped during the merge. Mirror drift-fix (#3590). */
  mergedHookRegistrations: MergedHookRegistration[];
  /** #2465: plugin install outcome (present only when the gate is ON). Mirror drift-fix (#3590). */
  pluginInstall?: PluginInstallResult;
  /** #3246: resolved destination config root this import wrote to (R3). */
  claudeDir: string;
  /** #3246: per-account visibility of the imported bridge dims via the #1562 bridge. */
  visibility: AccountVisibility[];
  /** #3246: `false` iff any imported dim is `orphaned` for any account (isolation degraded). */
  isolationIntact: boolean;
  /** #3590 (K6/D7): per-dimension expected-vs-written parity. */
  parity: ImportParity;
  /** #4173 (D4): carried scripts not written because every setting that runs them was kept. */
  settingsScriptsHeld: { destPath: string; keys: string[] }[];
}
