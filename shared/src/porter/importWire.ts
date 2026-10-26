// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The Configuration Porter import-review wire contract (issue #5601): the plan
 * summary `POST /api/porter/import/plan` returns ({@link ImportPlanSummary}),
 * the commit result `POST /api/porter/import/commit` returns
 * ({@link ImportResult}), and every shape they reference.
 *
 * Declared ONCE here so the server (which produces these shapes) and the web
 * (which renders them) cannot drift. Before #5601 the web kept a field-for-field
 * hand copy in `web/src/types/porter.ts`, and every wire change was made twice.
 * The server modules that produce each shape re-export it from their old path
 * (e.g. `server/src/porter/conflictDetection.ts` re-exports {@link Conflict}),
 * so server importers are unchanged.
 *
 * Older servers: a field an older server does not send stays OPTIONAL here
 * (`ImportGroups.memory`, `ImportPlanSummary.policySkips` / `notices`,
 * `ImportResult.notices`), because the web must still render that server's
 * payload. The current server always sends them; its producers declare that by
 * narrowing these fields to required in their own return types (#5601 D4) —
 * never by making the wire field required.
 *
 * Type-only module: no runtime exports.
 */
import type { ExecutableSettingsKey, Omission } from "./manifest";
import type { McpReviewDefinition } from "./mcpReview";
import type { SettingsLinkState } from "./settingsLink";
import type { SettingsScriptNameVerdict } from "./settingsScripts";
import type { PorterSourceId, SourceRecord } from "./sources";

/* ── Planned items ── */

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
  // #4173: the top-level script an imported statusLine/apiKeyHelper runs,
  // written only at the exact path the value names.
  | "settings-script"
  // #4373: a tenant archive's auto-memory file, remapped into an existing
  // project's `projects/<key>/memory/` folder.
  | "memory";

/* ── Conflicts ── */

export type ConflictKind = "exists" | "differs";

/**
 * One detected collision. `destPath` is the absolute destination file path, or
 * `"<file>#<key>"` for a keyed (settings / MCP-server) collision.
 *  - `kind: "exists"`  → destination present AND byte-identical (the content is an
 *    idempotent no-op; the commit may still add the archive's execute bit —
 *    #4129).
 *  - `kind: "differs"` → destination present with DIFFERENT content (a real
 *    conflict; default resolution skip preserves the user's version).
 */
export interface Conflict {
  destPath: string;
  kind: ConflictKind;
  incomingHash: string;
  /**
   * SHA-256 hex, or the server's `SPECIAL_FILE_HASH` (`"special-file"`) for a
   * FIFO, socket or device, which is never read (#5759).
   */
  existingHash: string;
}

/* ── Execute-bit reconcile (#4129) ── */

/** One byte-identical file whose execute bits were restored. Modes are `& 0o7777`. */
export interface ModeCorrection {
  destPath: string;
  from: number;
  to: number;
}

/**
 * Why a byte-identical file's mode was left alone:
 *  - `symlink`: the path is a symlink (never followed); reported only when its
 *    target would have needed a correction.
 *  - `not-a-file`: the path is no longer a regular file.
 *  - `not-owner`: another user owns it (the server is not root).
 *  - `unreadable`: its mode or content could not be read.
 *  - `changed`: the commit's decision differs from the preview (the mode moved
 *    since the preview, or a change is now needed that was never previewed), or
 *    the file changed between the decision and the chmod (different inode,
 *    device, mode or content, it became a symlink, it was removed, or it is no
 *    longer a regular file).
 */
export type ModeSkipReason =
  | "symlink"
  | "not-a-file"
  | "not-owner"
  | "unreadable"
  | "changed";

export interface ModeSkip {
  destPath: string;
  reason: ModeSkipReason;
}

/**
 * A preview row carries its item `kind` so the client can apply the commit's
 * selection rule (`server/src/porter/commitSelection.ts`): a `hook-lib` row is
 * excluded only when every hook is, any other row when its own destPath is.
 */
export interface ModePreviewFix extends ModeCorrection {
  kind: PlannedItemKind;
}
export interface ModePreviewSkip extends ModeSkip {
  kind: PlannedItemKind;
}

/**
 * The plan-time preview: the changes the commit may apply (it applies no
 * others) and the files it expects to leave alone, with the reason.
 */
export interface ModeReconcilePreview {
  fixes: ModePreviewFix[];
  skipped: ModePreviewSkip[];
}

/* ── Executable settings scripts (#4173) ── */

/** A content preview for the review (D5): inert text, never executed. */
export interface ScriptPreview {
  text: string;
  truncated: boolean;
  binary: boolean;
  size: number;
}

/**
 * One review row per config-root reference an imported executable value makes
 * (R11). `carried`: a planned item of any kind writes `destPath` (a `hook-lib`
 * for a `hooks/` reference included); `on-destination`: nothing writes it but
 * the file exists; `missing`: neither; `not-carried`: the reference cannot be
 * carried (`reason`). `gatedBy` is set for a `settings-script` item: empty when
 * a referencing key lands as it stands, else every `<settings.json>#<key>`
 * whose overwrite would let it land (D4). Values are surfaced deliberately,
 * like the executable values themselves (#2600), and never logged. Since
 * #5178 `planImport` builds the rows after the hold, so a plan's rows are all
 * `carried`; the other statuses describe the pre-hold settings.
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
  conflict?: ConflictKind;
  gatedBy?: string[];
  preview?: ScriptPreview;
}

/* ── MCP servers ── */

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
   * the heterogeneous `McpServerEntry` shapes VERBATIM (`./manifest.ts`) so the
   * recipient-side re-auth form (ADR-0006 Fork A) can render one input per slot
   * for a `secretRestorable: false` server, keyed by the SYNTHETIC slot name.
   * `argsNames` stays `{index,name}[]` — the `name` is the `__args_<i>__` bundle
   * key; do NOT flatten to `string[]`.
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
 * #5172: a planned server with the definition the commit writes — transport,
 * command (after the translation above), args, url, and `disabled` — with a
 * credential-bearing element shown by its secret slot name, never its value.
 * This is the row the plan summary sends.
 */
export interface PlannedMcpServerReview extends PlannedMcpServer {
  definition: McpReviewDefinition;
}

/**
 * A manifest MCP server EXCLUDED from the import success set. Shared
 * exclusion-record contract [1B-7]: #2640 emits `kind: "runtime" | "path"`;
 * #2638 R3 emits `kind: "secret"`; #5192 emits a commit-time `kind: "path"`
 * when a reviewed command changed. Secret-free by construction — `name` and
 * `detail` carry no credential material.
 */
export interface McpExclusion {
  name: string;
  kind: "secret" | "runtime" | "path";
  detail: string;
}

/* ── Selection groups (#3247) ── */

/** One skill and its EXACT membership (files) + the hooks that serve it. */
export interface SkillGroup {
  /** The owning skill's dimension-entry name. */
  skill: string;
  /** destPaths of this skill's file items (`kind === "skill"`, exact `name` match). */
  files: string[];
  /** hook-file destPaths of hooks whose command references `skills/<skill>/`. */
  servingHooks: string[];
}

/** A hook that serves no skill — its own top-level selection unit. */
export interface IndependentHook {
  /** The hook-file destPath — the exclusion key (registration + file travel as one). */
  id: string;
  command: string;
  events: string[];
}

/**
 * Hierarchical grouping of ALL plan dimensions for the pre-import selection UI
 * (#3247 R1/D3a). Every value is the item's EXCLUSION KEY: file destPaths for
 * file dimensions, hook-file destPaths for hooks, server names for MCP. `hook-lib`
 * support files carry NO group of their own — they follow the hooks (written iff
 * any hook survives). #4173: `settings-script` files carry no group either, and
 * are no exclusion key: a script's fate follows the setting that runs it (D4,
 * the commit's `held` set), and settings keys are not selectable (#3247).
 */
export interface ImportGroups {
  skills: SkillGroup[];
  independentHooks: IndependentHook[];
  mcpServers: string[];
  agents: string[];
  commands: string[];
  rules: string[];
  outputStyles: string[];
  /** `claude-md` + `claude-md-include` file destPaths. */
  claudeMd: string[];
  /**
   * #4373: a tenant archive's memory file destPaths (`projects/<key>/memory/…`).
   * Absent from a server that predates #4373.
   */
  memory?: string[];
  /**
   * #3448 (Sub C, R3/D3(a)): per-source grouping for the archive-received review
   * cards. Each source id maps to `found` (manifest `sources[]` metadata — TRUE
   * even for a found-but-empty source) and its EXCLUSION keys, so a card is an
   * honest whole-source toggle. claude-code owns every file + hook dimension
   * it brought (from `~/.claude`) plus its MCP names; Cursor / Claude Desktop
   * carry MCP server names only; Codex (#5169) carries its MCP names plus the
   * files of its tagged skill and instructions-rule entries, and the hooks that
   * serve a Codex skill. A card cascades over its keys inside the ONE existing
   * `excluded` set — no parallel selection path.
   */
  bySource: Record<PorterSourceId, { found: boolean; keys: string[] }>;
}

/* ── The plan summary ── */

/**
 * Client-facing plan summary. Ships resolved destination paths
 * (`claudeDir`/`hostConfigPath`) — consistent with `items[].destPath`, which
 * already carries absolute dest paths (#2620 / F6).
 *
 * #2600: imported VALUES (hook command strings, `env` values, `permissions`
 * values, and — #5172 — each MCP server's command, args, and url) are surfaced
 * DELIBERATELY for review scrutiny — potentially including plain-text
 * credentials from a hostile archive; a declared secret slot stays a slot name.
 * That visibility IS the control, so this summary is intentionally NOT
 * value-free.
 */
export interface ImportPlanSummary {
  stagingHandle: string;
  /**
   * #2620 (F6): resolved destination paths this commit will write to, surfaced
   * so the operator sees the target BEFORE committing. A same-machine instance
   * resolves these to the host `~/.claude` (+ `~/.claude.json`) UNLESS
   * `CLAUDE_CONFIG_DIR`/`claudeDir` redirects the config root (both then follow
   * it, with `hostConfigPath` INSIDE the resolved root).
   */
  claudeDir: string;
  hostConfigPath: string;
  items: { kind: PlannedItemKind; name: string; destPath: string }[];
  /**
   * #3247: hierarchical grouping of items/hooks/MCP for the pre-import selection
   * UI. ADDITIVE beside flat `items`/`hooks`/`mcpServers`; computed by the SAME
   * `commitSelection.computeGroups` the commit cascades from (no plan/commit drift).
   */
  groups: ImportGroups;
  /** #3448 (Sub C): per-source discovery metadata for the review cards (absent on a legacy archive). */
  sources?: SourceRecord[];
  conflicts: Conflict[];
  /**
   * #4129: the fixes the commit may apply (it applies no others) and the files
   * it expects to skip.
   */
  modeReconcile: ModeReconcilePreview;
  settings: {
    keys: string[];
    conflicts: Conflict[];
    skippedKeys: string[];
    /** #2600: env key→value pairs, surfaced for review (NODE_OPTIONS/ANTHROPIC_BASE_URL etc.). */
    envValues: { key: string; value: string }[];
    /** #2600: permissions key→value pairs, surfaced for review (e.g. defaultMode overrides). */
    permissionsValues: { key: string; value: unknown }[];
    /** #2565 (F5): full VALUES of executable settings keys (apiKeyHelper/statusLine) — the
     * subset Claude Code runs as shell commands — surfaced so a values-blind review cannot
     * miss an injected command. Non-executable keys remain name-only (in `keys`). */
    executableValues: { key: string; value: unknown }[];
    /** #4173 (R11): the files those values run — path, sha256, status and a preview. */
    executableScripts: ExecutableScriptReview[];
  };
  /**
   * #4146 (R4): present when the destination settings.json is a symlink and the
   * plan merges settings or hooks. `inside` = the merge writes through it (the
   * link is kept); any other state = the commit refuses (409) unless the request
   * acknowledges `target` (`acknowledgeSymlinkedSettings`), which replaces the link.
   * Both apply only if the commit's selection still merges settings keys or
   * hooks; with every hook deselected and no settings keys, nothing is merged.
   */
  settingsLink?: { target: string; state: SettingsLinkState };
  hooks: {
    count: number;
    unknownEvents: string[];
    commandWarnings: string[];
    /** #2600: per-entry hook command strings, surfaced verbatim for review scrutiny. */
    commands: { events: string[]; matcher?: string; command: string }[];
    /** #3590 (K4/D9): registry-referenced hook names absent from archive + dest. */
    registryMissing: string[];
  };
  /** #5172: each server with the definition the commit writes (slots by name). */
  mcpServers: PlannedMcpServerReview[];
  plugins: { descriptorPresent: boolean; remediation: string[] };
  /**
   * #5202 (U8): everything the plan recorded, refusals included —
   * `policySkips` is the refusal subset. Kept complete so a client that
   * renders only `omissions` (one that predates #4156) still shows every
   * refusal; the current panel subtracts `policySkips` before rendering it.
   * A server between #4156 and #5202 sent only the non-refusal part.
   */
  omissions: Omission[];
  /**
   * #4156: the importer's policy refusals ("Refused by import policy"). Absent
   * from a server that predates #4156.
   */
  policySkips?: Omission[];
  /**
   * #5202 (U10): the importer's notices ("Imported with a note"), also in
   * `omissions`; the panel subtracts them from "Deliberately omitted". Absent
   * from a server that predates #5202.
   */
  notices?: Omission[];
  expiresAt: number;
}

/* ── The commit result ── */

/** Per-config-file MCP merge outcome. */
export interface McpFileMergeResult {
  configPath: string;
  imported: string[];
  /** Same-name collisions that were skipped (differs → default skip). */
  skipped: Conflict[];
}

/**
 * F1: `host` reflects `~/.claude.json`; `perAccount` reflects each
 * account-bound config — the same server is only truly present in a session
 * whose account received the merge.
 */
export interface McpImportResult {
  host: McpFileMergeResult;
  perAccount: McpFileMergeResult[];
}

/** Post-commit bidirectional hook-registration validator output (directive D5). */
export interface HookRegistrationValidationResult {
  /** Hook script files on disk with no matching registration (dead code). */
  orphanFiles: string[];
  /** Registration commands whose referenced script path does not exist. */
  orphanRegistrations: string[];
  /**
   * #2639 (F9): the THIRD drift direction — a hook whose `from lib.X` import does
   * NOT resolve against the landed `hooks/lib/`. Absent presence+registration are
   * both clean, but the hook crashes (unguarded import) or silently degrades
   * (try/except availability flag) at runtime. `hook` is the on-disk script path
   * (like {@link orphanFiles}); `module` is the missing `lib` module NAME (a code
   * path, never a secret). One entry per (hook, unresolved module) pair.
   */
  unresolvedImports: { hook: string; module: string }[];
  /**
   * #3590 (K5, rule 4): dynamic-loader registry names (from the DESTINATION
   * `hooks/lib/detector_registry.py` + `hooks/lib/hook_registry.py`) that resolve
   * to NO `hooks/<name>.<ext>` file at the destination — a registry references a
   * hook that never landed. The post-commit half of the fail-loud belt (R2): a
   * missing registry-referenced module here is the drift a `settings.json`-only
   * orphan check could never see (a dispatcher-form host registers no such name in
   * settings.json). Empty when every registry name resolves, or when the
   * destination carries no registry (never a false positive on a clean tree).
   */
  registryMissing: string[];
}

/** Per-account visibility snapshot: which imported dims are visible/pending/orphaned/absent. */
export interface AccountVisibility {
  /** The account UUID (the `<uuid>` directory name under `base`). */
  account: string;
  /** The account-config BASE dir this account was enumerated from. */
  base: string;
  /** Dims correctly symlinked to `<hostClaudeDir>/<dim>` — visible in the account's sessions. */
  visible: string[];
  /**
   * Dims not yet linked but that the bridge WILL link on the next spawn (dst
   * absent, or a wrong-target symlink it re-points). Informational — the normal
   * first-import state — NEVER a warning.
   */
  pending: string[];
  /**
   * Dims blocked by a REAL file/dir at the account path (the clobber-refusal
   * case): the bridge refuses to clobber, so the session falls back to the host
   * dir — isolation degraded for this account/dim.
   */
  orphaned: string[];
  /** Dims whose host source is absent — nothing to link (not an error). */
  absent: string[];
}

/** Per-dimension parity: what the selected plan promised vs what the commit did. */
export interface DimensionParity {
  /** Selected planned items in this dimension. */
  expected: number;
  /** Items actually written (new content). */
  written: number;
  /** Selected items skipped as byte-identical no-ops (already present). */
  alreadyPresent: number;
  /** Selected items skipped because they differ and overwrite was not chosen. */
  skippedConflicts: number;
  /**
   * The non-tautological gap: for `hooks`, registry-referenced modules absent at
   * the destination post-commit; for `hookSupport`, entries none of whose files
   * the plan writes at or under their path and that carry no plan-time omission
   * (#4185 reports an entry whose tar member is absent at plan time instead;
   * #5188 counts a folder entry whose files land; #5598 reports at plan time
   * the files an invalid entry leaves behind). Empty otherwise.
   */
  missing: string[];
}

/** #3590 (K6/D7): per-dimension parity report carried on {@link ImportResult}. */
export type ImportParity = Record<string, DimensionParity>;

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

/* ── Plugin install execution (#2465) ── */

/** A marketplace-level outcome (D-3: `pinnedRef` makes catalog pinning visible). */
export type MarketplaceStatus =
  | "added"
  | "already-present"
  | "skipped-untrusted"
  | "failed";
export interface MarketplaceOutcome {
  name: string;
  source: string;
  status: MarketplaceStatus;
  /** The `#<ref>` pin recorded on the source, or `null` when unpinned. */
  pinnedRef: string | null;
  /** Human-readable reason for `skipped-untrusted` / `failed`. */
  reason?: string;
}

export interface InstalledPluginRecord {
  name: string;
  marketplace: string;
  /** Version reported by `claude plugin list --json` after install, or null. */
  installedVersion: string | null;
  /** Version recorded in the descriptor, or null when unrecorded. */
  recordedVersion: string | null;
}

export interface SkippedPluginRecord {
  name: string;
  marketplace: string;
  reason: string;
}

export type FailedItemKind = "marketplace" | "plugin";
export interface FailedRecord {
  kind: FailedItemKind;
  /** `source` for a marketplace, `name@marketplace` for a plugin. */
  identifier: string;
  /** The secret-free `claude` command attempted, or null (pre-exec rejection). */
  command: string | null;
  reason: string;
}

export interface ReAuthRecord {
  plugin: string;
  marketplace: string;
  /** The bundled MCP server whose secret-bearing field is unresolved. */
  server: string;
  /** Field descriptors (env/header key names, or `url`/`args[i]`) needing a secret. */
  missingFields: string[];
}

export interface VersionDriftRecord {
  plugin: string;
  marketplace: string;
  recorded: string;
  installed: string;
}

/** The additive `ImportResult.pluginInstall` section (present only when the gate is ON). */
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
  /** Conflicts left unresolved (skipped — the pre-existing config was preserved). */
  skippedConflicts: Conflict[];
  /** #4129: byte-identical files given the archive's execute bit (still `alreadyPresent`). */
  modesCorrected: ModeCorrection[];
  /** #4129: byte-identical files whose mode was left alone, with the reason. */
  modesSkipped: ModeSkip[];
  /**
   * #2640 (F13/F14): MCP servers EXCLUDED from the import because their command
   * was unresolvable on the destination (missing runtime / non-portable path),
   * a secret could not be restored (#2638), or the reviewed command changed
   * before the commit (#5192). They are NOT in the `mcp` success counts —
   * listed separately so a dead-on-arrival server is never silently reported
   * as imported-functional.
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
   * install-execution gate (`HAPI_PORTER_PLUGIN_INSTALL`, server
   * `porterPluginInstallEnabled`) is ON AND the archive carried a plugin
   * descriptor. When the gate is OFF the field is ABSENT (not present-empty) —
   * this preserves R6 byte-identity with the #2343-alone result (the
   * deterministic remediation command list is still emitted at plan time via
   * {@link ImportPlanSummary} `plugins.remediation`).
   */
  pluginInstall?: PluginInstallResult;
  /**
   * #3246: resolved destination config root this import wrote to (mirrors
   * {@link ImportPlanSummary} `claudeDir` — plan/result destinations agree, R3).
   */
  claudeDir: string;
  /**
   * #3246: post-commit per-account visibility of the imported bridge dims via the
   * #1562 symlink bridge. `orphaned` = the session falls back to the host dir
   * (isolation degraded), NOT "skills invisible".
   */
  visibility: AccountVisibility[];
  /** #3246: `false` iff any imported dim is `orphaned` for any account (`pending` never demotes). */
  isolationIntact: boolean;
  /**
   * #3590 (K6/D7): per-dimension expected-vs-written parity. Surfaced in the UI +
   * on `GET /porter/installed.lastImport` until restart.
   */
  parity: ImportParity;
  /** #4173 (D4): carried scripts not written because every setting that runs them was kept. */
  settingsScriptsHeld: { destPath: string; keys: string[] }[];
  /**
   * #5202 (U12): notes the commit's own choices produced — a rewritten include
   * written while CLAUDE.md was not, with the `@claude-includes/…` line to add.
   * Absent from a server that predates #5202.
   */
  notices?: Omission[];
}
