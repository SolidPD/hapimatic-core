// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Configuration Porter — script-driven, secrets-free export generator
 * (epic #2339, issue #3245).
 *
 * {@link buildExportScript} returns a self-contained POSIX/bash shell script the
 * user runs DIRECTLY on their SOURCE machine — there is NO Claude/LLM step in
 * this default export path. It replaces `buildExtractionPrompt`'s "paste this
 * into a Claude session" flow, which newer Claude models (Opus 5) HARD-REFUSE
 * the moment it asks them to bundle + `age`-encrypt credentials (pattern-matched
 * as exfiltration). Prompt-tuning that refusal is a losing arms race; the fix is
 * to remove the LLM — and the secrets — from the default path entirely.
 *
 * 🔴 SECRETS-FREE BY DESIGN (R2). The generated script collects ONLY config
 * DEFINITIONS: it never reads, encrypts, or writes any secret VALUE, never
 * invokes `age`, and never embeds a recipient key. MCP env/header/url/args
 * secret SLOTS are DECLARED (key names only, per `McpServerEntry`) so the
 * destination knows to re-auth (surfaced as secret-unrestorable at import,
 * #3245 Task 2b), but their values are never collected. `settings.env` VALUES
 * are omitted entirely (the schema has no import backstop that would keep them
 * from being written plaintext, so carrying them at all would leak). The archive
 * self-marks definitions-only via the {@link DEFINITIONS_ONLY_SECRETS_OMISSION}
 * marker, which the import tolerance ({@link isDefinitionsOnlyManifest}) matches
 * to accept a no-`secrets.age` archive instead of hard-rejecting it.
 *
 * PLACEMENT / PURITY — like `buildExtractionPrompt`, this is a PURE function in
 * `shared/` (no `node:*` imports, no I/O): it produces SHELL TEXT. `web/`
 * renders it and the server serves it (Task 3), so a browser-safe pure function
 * is the only placement that avoids duplication.
 *
 * DRIFT PREVENTION — every dimension list, exclusion, settings key, secret-slot
 * literal, and the export-dir/filename convention is IMPORTED from the schema
 * modules (`manifest.ts`, `exportNaming.ts`) and interpolated, never restated.
 * A schema change breaks this build (or `exportScript.test.ts`) instead of
 * silently producing an archive the importer rejects. The export dir + filename
 * are single-sourced from {@link buildExportShellFragment} (#3239), the SAME
 * surface `buildExtractionPrompt`'s Step 11 uses.
 */
import { ARCHIVE_FORMAT, PORTER_SCHEMA_VERSION } from "./version";
import {
  ARGS_SECRET_SLOT_PREFIX,
  DEFINITIONS_ONLY_SECRETS_OMISSION,
  HOOK_SUPPORT_DIRS,
  SECRETS_MEMBER_ENCRYPTED,
  SECRETS_MEMBER_PLAINTEXT,
  URL_SECRET_SLOT,
} from "./manifest";
import { buildExportShellFragment } from "./exportNaming";
// #3447 (Sub B, K7): the dimension map, settings allowlist, archive-exclusion
// patterns and secret/marketplace regex SOURCES were private module locals here;
// hoisted to ./exportShared so the PowerShell twin emitter cites the SAME source
// (never restated). `toJqRegex` renders a canonical regex into the jq form these
// functions embed — the bash output is byte-identical after the hoist [1B#15].
import {
  ARCHIVE_CREDENTIAL_OMISSION_REASON,
  ARCHIVE_HOOK_PATH_ESCAPE_OMISSION_REASON,
  ARCHIVE_HOOK_SLOT_TAKEN_OMISSION_REASON,
  ARCHIVE_HOOK_SLOT_UNLISTABLE_OMISSION_REASON,
  ARCHIVE_LINK_UNCHECKED_OMISSION_REASON,
  ARCHIVE_EXCLUSION_PATTERNS,
  DEFINITIONS_ARCHIVE_MEMBERS,
  HOOK_TREE_EXCLUSION_PATTERNS,
  DIMENSION_DIRS,
  DIMENSION_FIELD,
  MARKETPLACE_SOURCE_PATTERNS,
  SECRET_HIGH_ENTROPY_BODY,
  SECRET_KEYWORD_GROUP,
  SECRET_TOKEN_PREFIX_GROUP,
  SECRET_URL_QUERYFRAG_PATTERN,
  SECRET_URL_USERINFO_PATTERN,
  SETTINGS_KEYS_NO_ENV,
  bashSingleQuote,
  headerCommentLabel,
  toJqRegex,
  validUploadUrl,
} from "./exportShared";
// #4164: the Step 3 include loop, shared with the extraction prompt's check block.
import { claudeMdIncludeLoopLines } from "./claudeMdIncludeShell";
// #4173: the Step 7b settings-script lines, shared with the same check block.
import { settingsScriptLoopLines } from "./settingsScriptShell";
// #4188: the one link walk Step 3 and Step 7b both call.
import { porterWalkLinkLines } from "./linkWalkShell";
// #4172: the credential-name prune, shared with the extraction prompt's check block,
// and the link-target refusal the materialization uses (OOS-6).
import {
  credentialLinkFunctionLines,
  pruneCredentialNamesFunctionLines,
} from "./credentialNamesShell";
// #3448 (Sub C, K7): the multi-source discovery table — probed per-source config
// paths + the source-id set both emitters and the manifest cite.
import {
  PORTER_SOURCE_IDS,
  SOURCE_CONFIG_PATHS,
  type PorterPathBase,
  type PorterSourceId,
} from "./sources";
// #4373: the tenant profile's bash lines (a sibling module, so this file grows
// only by its call sites) and the archive hygiene gate this script runs last.
import { type PorterExportProfile } from "./tenantProfile";
import {
  memoryStagingShellLines,
  premiumFilterShellLines,
  profileDetectionShellLines,
} from "./tenantProfileShell";
import { archiveHygieneShellLines } from "./archiveHygiene";

/**
 * Input to {@link buildExportScript}. Mirrors the relevant subset of
 * `ExtractionPromptInput` — MINUS `recipient` and `instanceUrl`, which only the
 * secrets-encrypting prompt path needs (there is no recipient in a secrets-free
 * export).
 */
export interface ExportScriptInput {
  /**
   * The manifest schema version the produced archive must target. Defaults to
   * {@link PORTER_SCHEMA_VERSION} — pass a value only to target a specific
   * version deliberately; never a hard-coded literal that could drift.
   */
  schemaVersion?: string;
  /**
   * Optional human label for the destination instance, shown in the script
   * header comment so the user can confirm they are packaging for the right
   * target. Header-only; the script embeds nothing destination-specific. A CR
   * or LF in it becomes a space, so it cannot end the comment line (#5239).
   */
  instanceLabel?: string;
  /**
   * ISO-8601 UTC timestamp of script generation, embedded into the header
   * comment AND used as the manifest's `generatedAt`. Passed as INPUT (never
   * read from `Date.now()` inside this function) so `buildExportScript` stays
   * PURE and `exportScript.test.ts` remains deterministic — same reasoning as
   * `buildExtractionPrompt`. Omit to render the header without a specific
   * timestamp; the manifest's `generatedAt` is then stamped at RUN time with
   * `$(date -u …)`.
   */
  generatedAt?: string;
  /**
   * The generating instance's app version (e.g. `1.0.1049`), embedded in the
   * header comment AND printed in the runtime banner so the user can always
   * tell WHICH script iteration they are running (Matt's 2026-08-27 standing
   * directive: script artifacts must self-identify their version — the
   * unversioned-filename trap made a stale copy indistinguishable from the
   * fixed one). Passed IN (never read from the environment) to keep this
   * function pure. The serving route also derives the versioned download
   * FILENAME from the same value.
   */
  generatorVersion?: string;
  /**
   * #3446 (Sub A, R3): the single-use upload leg URL
   * (`<origin>/p/<token>/archive`). When present, the script gains a final
   * self-upload step that POSTs the finished archive to this URL (stderr-only
   * progress; the archive-path stdout contract is preserved), and falls back to
   * the manual Download/Upload path on failure. When ABSENT the script is the
   * legacy Download/Copy export — its output stays BYTE-IDENTICAL to before this
   * field existed (no upload step, `TOTAL_STEPS=11`). Passed IN (server-derived
   * from the token + instance origin) to keep this builder PURE. A value that is
   * not an http(s) URL is treated as absent (#5239, `validUploadUrl`).
   */
  uploadUrl?: string;
  /**
   * #4373 (R2): the export profile to mint, `full` (the default, today's
   * definitions-only export) or `tenant` (the hosted customer's own surfaces:
   * plus auto-memory, minus premium plugin descriptors). The minted value is a
   * floor: on a hosted customer VM the script reads the VM's markers at run
   * time (K13, `../vmClass`) and uses `tenant` whatever was minted, because the
   * destination that mints the script cannot know where it will run.
   */
  profile?: PorterExportProfile;
}

// #3447 (K7): DIMENSION_DIRS, DIMENSION_FIELD and SETTINGS_KEYS_NO_ENV now live
// in ./exportShared (imported above) so the PowerShell twin emitter shares them
// rather than restating the dimension map / settings allowlist.

/**
 * `tar --exclude` flags for {@link ARCHIVE_EXCLUSION_PATTERNS}, plus any `extra`
 * patterns the caller appends (#3590: the whole-`hooks/`-tree stage passes
 * {@link HOOK_TREE_EXCLUSION_PATTERNS}). Emits BOTH a bare pattern and a
 * wildcard-slash-prefixed variant per entry: GNU tar matches a slash-free pattern
 * against every path component (so the bare form suffices), while bsdtar/libarchive
 * needs the wildcard-slash variant to reach one level deep. Deeper bsdtar nesting
 * may leave a junk dir in the archive — cosmetic bloat, never a secrets concern
 * (this export carries no secrets at all).
 */
function tarExcludeFlags(extra: readonly string[] = []): string {
  const flags: string[] = [];
  for (const pat of [...ARCHIVE_EXCLUSION_PATTERNS, ...extra]) {
    flags.push(`--exclude='${pat}'`, `--exclude='*/${pat}'`);
  }
  return flags.join(" ");
}

/**
 * The jq program (Step 5) that extracts MCP server DEFINITIONS from
 * `~/.claude.json` `.mcpServers` — key names only, NO secret values.
 *
 *  - `envNames` / `headerNames` — ALL env/header key names (the schema has no
 *    plaintext env member, so every value is absent in a secrets-free export and
 *    the destination re-auths for all of them; declaring the names is the honest
 *    representation, and omitting them would husk the server, D2a).
 *  - `url` — carried plaintext ONLY when provably credential-free (no userinfo
 *    `@`, no query, no fragment). Anything that might carry a token is
 *    placeholdered: the plaintext `url` is dropped and `urlName` names the
 *    {@link URL_SECRET_SLOT} slot (fail-safe over-detection — a needlessly
 *    placeholdered url costs a re-auth, an under-detected one leaks).
 *  - `args` — each element that looks credential-bearing (a known token prefix,
 *    a long high-entropy token, a `--secret-flag=value`, or the value following
 *    a bare `--secret-flag`) is replaced by an empty-string placeholder and
 *    recorded in `argsNames` under its {@link ARGS_SECRET_SLOT_PREFIX} slot;
 *    non-credential args are carried verbatim.
 *
 * Interpolated with the canonical slot literals so the script and schema cite
 * ONE source.
 *
 * #3448 (Sub C, 1B#30): EXPORTED so the multi-source probes (Cursor / Claude
 * Desktop) reuse the SAME projection per config file — the jq IS the translation,
 * there is no server-side translator. Every entry is stamped with the caller's
 * `--arg source <id>` (so EVERY invocation MUST pass one), and the transport is
 * INFERRED for a url-only (no-`command`) remote entry — Cursor remote servers are
 * `url`-only, Claude Desktop entries are always stdio [1B#40].
 */
export function mcpExtractionJq(): string {
  return [
    "def looks_token:",
    '  type == "string" and (',
    `    test("^(${toJqRegex(SECRET_TOKEN_PREFIX_GROUP)})")`,
    `    or test("^${toJqRegex(SECRET_HIGH_ENTROPY_BODY)}$")`,
    "  );",
    "def secret_flag:",
    '  type == "string"',
    `  and test("^--?(${toJqRegex(SECRET_KEYWORD_GROUP)})$"; "i");`,
    "def secret_kv:",
    '  type == "string"',
    `  and test("^--?[A-Za-z0-9_-]*(${toJqRegex(SECRET_KEYWORD_GROUP)})=.+$"; "i");`,
    "def is_secret_url:",
    `  type == "string" and (test("${toJqRegex(SECRET_URL_USERINFO_PATTERN)}") or test("${toJqRegex(SECRET_URL_QUERYFRAG_PATTERN)}"));`,
    ".mcpServers // {} | to_entries | map(",
    "  .key as $name | (.value // {}) as $cfg |",
    "  ($cfg.args // []) as $args |",
    "  ([ range(0; ($args | length)) as $i",
    "     | select(",
    "         ($args[$i] | looks_token)",
    "         or ($args[$i] | secret_kv)",
    "         or (($i > 0) and ($args[$i - 1] | secret_flag))",
    "       )",
    "     | $i ]) as $sidx |",
    "  (($cfg.env // {}) | keys) as $envNames |",
    "  (($cfg.headers // {}) | keys) as $hdrNames |",
    "  ($cfg.url // null) as $url |",
    "  ( { name: $name, source: $source,",
    "      transport: ( $cfg.type // $cfg.transport",
    "        // (if (($cfg.url // null) != null) and (($cfg.command // null) == null)",
    '            then (if ($cfg.url | test("/sse$")) then "sse" else "http" end)',
    '            else "stdio" end) ) }',
    "    + (if ($cfg.command // null) != null then { command: $cfg.command } else {} end)",
    "    + (if ($args | length) > 0",
    "        then { args: [ range(0; ($args | length)) as $i",
    '                       | if ($sidx | index($i)) != null then "" else $args[$i] end ] }',
    "        else {} end)",
    "    + (if ($sidx | length) > 0",
    `        then { argsNames: [ $sidx[] | { index: ., name: ("${ARGS_SECRET_SLOT_PREFIX}" + (. | tostring) + "__") } ] }`,
    "        else {} end)",
    "    + (if $url != null",
    `        then (if ($url | is_secret_url) then { urlName: "${URL_SECRET_SLOT}" } else { url: $url } end)`,
    "        else {} end)",
    "    + (if ($envNames | length) > 0 then { envNames: $envNames } else {} end)",
    "    + (if ($hdrNames | length) > 0 then { headerNames: $hdrNames } else {} end)",
    "    + (if ($cfg.disabled // false) then { disabled: true } else {} end)",
    "  )",
    ")",
  ].join("\n");
}

/**
 * #3448 (Sub C): render a NON-Claude-Code source's candidate MCP config paths
 * (from the shared {@link SOURCE_CONFIG_PATHS} table) as bash path expressions.
 * `appdata`-based candidates have NO POSIX equivalent and are dropped here; the
 * PowerShell twin renders them instead. Uses string concatenation (never a
 * template literal) so the shell `${XDG_CONFIG_HOME:-$HOME/.config}` parameter
 * expansion is emitted verbatim, not evaluated as JS interpolation.
 */
function posixSourcePaths(
  id: Exclude<PorterSourceId, "claude-code">
): string[] {
  const prefixByBase: Record<PorterPathBase, string | null> = {
    home: "$HOME",
    appdata: null,
    "xdg-config": "${XDG_CONFIG_HOME:-$HOME/.config}",
  };
  const out: string[] = [];
  for (const p of SOURCE_CONFIG_PATHS[id]) {
    const prefix = prefixByBase[p.base];
    if (prefix === null) continue;
    out.push(prefix + "/" + p.segments);
  }
  return out;
}

/**
 * #3448 (Sub C, R1/R2): the bash probe block for one NON-Claude-Code source —
 * first EXISTING candidate wins (file-existence, never `uname`-gated so Linux CI
 * can seed a macOS path), extracted through the shared {@link mcpExtractionJq}
 * with `--arg source <id>`. Sets `<VAR>_MCP` (tagged entries) and `<VAR>_FOUND`.
 */
function posixProbeBlock(
  id: Exclude<PorterSourceId, "claude-code">,
  varName: string,
  label: string
): string[] {
  const forList = posixSourcePaths(id)
    .map(p => '"' + p + '"')
    .join(" ");
  return [
    "# " +
      label +
      " — first existing global MCP config (file-existence, never uname-gated).",
    varName + '_MCP="[]"; ' + varName + "_FOUND=false",
    "for _f in " + forList + "; do",
    '  if [ -f "$_f" ]; then',
    "    " +
      varName +
      '_MCP="$(jq -c --arg source ' +
      id +
      " '" +
      mcpExtractionJq() +
      "' \"$_f\" 2>/dev/null || echo '[]')\"",
    '    [ -n "$' + varName + '_MCP" ] || ' + varName + '_MCP="[]"',
    "    " + varName + "_FOUND=true",
    "    break",
    "  fi",
    "done",
  ];
}

/**
 * #3448 (Sub C, D4(a)/K10): the `jq -n` program that dedupes the three sources'
 * server arrays by name in precedence order (Claude Code → Cursor → Claude
 * Desktop — `unique_by` keeps the FIRST) and builds the `sources[]` metadata.
 * Emits `{ mcpServers: <deduped, tagged>, sources: [{id, found, counts}] }` where
 * `counts.mcpServers` is the source's LANDED count and `counts.duplicates` is
 * what it LOST to a higher-precedence source. Args: `$cc/$cur/$dt` (per-source
 * arrays) + `$ccf/$curf/$dtf` (found booleans).
 */
function mcpDedupeAndSourcesJq(): string {
  const arg: Record<PorterSourceId, { arr: string; found: string }> = {
    "claude-code": { arr: "$cc", found: "$ccf" },
    cursor: { arr: "$cur", found: "$curf" },
    "claude-desktop": { arr: "$dt", found: "$dtf" },
  };
  const entry = (id: PorterSourceId): string => {
    const { arr, found } = arg[id];
    const landed = '($landed | map(select(.source == "' + id + '")) | length)';
    return [
      '  { id: "' + id + '", found: ' + found + ",",
      "    counts: { mcpServers: " + landed + ",",
      "              duplicates: ((" + arr + " | length) - " + landed + ") } }",
    ].join("\n");
  };
  return [
    "(($cc + $cur + $dt) | unique_by(.name)) as $landed",
    "| { mcpServers: $landed,",
    "    sources: [",
    PORTER_SOURCE_IDS.map(entry).join(",\n"),
    "    ] }",
  ].join("\n");
}

/**
 * The jq program (Step 8) that extracts the plugin DESCRIPTOR — marketplaces +
 * installed-plugin identifiers, NO payload bytes. Fail-safe per item: a
 * marketplace whose source is not a valid `owner/repo`-or-git-URL, or a
 * plugin/marketplace name that is not kebab-case, is DROPPED (the destination's
 * `PorterManifestSchema` rejects the WHOLE manifest on an invalid descriptor, so
 * dropping the bad item keeps the archive importable). Takes the two source
 * files as `$km` (known_marketplaces) and `$ip` (installed_plugins).
 */
function pluginExtractionJq(): string {
  return [
    'def kebab: type == "string" and test("^[a-z0-9]+(-[a-z0-9]+)*$");',
    "def valid_source:",
    '  type == "string" and (',
    `    test("${toJqRegex(MARKETPLACE_SOURCE_PATTERNS[0])}")`,
    `    or test("${toJqRegex(MARKETPLACE_SOURCE_PATTERNS[1])}")`,
    `    or test("${toJqRegex(MARKETPLACE_SOURCE_PATTERNS[2])}")`,
    "  );",
    "{",
    "  marketplaces: [",
    "    ($km // {}) | to_entries[]",
    "    | .key as $name",
    "    | ( .value.source.repo",
    '        // (if (.value.source | type) == "string" then .value.source else null end)',
    "        // .value.source.url ) as $src",
    "    | select(($name | kebab) and ($src | valid_source))",
    "    | { name: $name, source: $src }",
    "  ],",
    "  plugins: [",
    "    ($ip.plugins // {}) | to_entries[]",
    '    | (.key | split("@")) as $parts',
    "    | select(($parts | length) == 2)",
    "    | { name: $parts[0], marketplace: $parts[1] }",
    '      + ( (.value | if type == "array" then .[0] else . end | .version)',
    '          | if type == "string" then { version: . } else {} end )',
    "    | select((.name | kebab) and (.marketplace | kebab))",
    "  ]",
    "}",
  ].join("\n");
}

/**
 * Build the script-driven, secrets-free export script (R1). Pure — no I/O.
 *
 * The returned script, run on the SOURCE machine, packages `~/.claude`
 * (or `$CLAUDE_CONFIG_DIR`) into a definitions-only `.tar.gz` written to the
 * stable export directory (default `~/config-export/`, overridable via
 * `HAPI_PORTER_EXPORT_DIR`) under a timestamped, machine-named filename — the
 * SAME export convention the extraction prompt uses (#3239) — and prints that
 * path.
 */
export function buildExportScript(input: ExportScriptInput = {}): string {
  const {
    schemaVersion = PORTER_SCHEMA_VERSION,
    instanceLabel,
    generatedAt,
    generatorVersion,
  } = input;
  // #5239: only an http(s) URL gets the self-upload leg.
  const uploadUrl = validUploadUrl(input.uploadUrl);
  // #4373: only the two known profiles; anything else mints the default.
  const profile: PorterExportProfile =
    input.profile === "tenant" ? "tenant" : "full";

  // The export-dir move/rename/collision fragment (#3239), single-sourced. It
  // moves `config-port.<fmt>` from the CWD — the script `cd`s into $STAGING
  // before running it (Step 11), so that relative name resolves.
  const exportFragment = buildExportShellFragment();

  // Manifest `generatedAt`: a caller-pinned literal, or stamped at run time.
  const generatedAtExpr = generatedAt
    ? `'${generatedAt}'`
    : '"$(date -u +%Y-%m-%dT%H:%M:%SZ)"';

  const headerTarget = instanceLabel
    ? `# Target instance: ${headerCommentLabel(instanceLabel)}`
    : "# Target: another Hapimatic instance";
  const headerWhen = generatedAt ? [`# Generated at: ${generatedAt}`] : [];
  const headerVersion = generatorVersion
    ? [`# Export script version: v${generatorVersion}`]
    : [];

  // The tar members a definitions-only archive can carry — NEVER a secrets one.
  const tarMembers = DEFINITIONS_ARCHIVE_MEMBERS.join(" ");

  const lines: string[] = [
    "#!/usr/bin/env bash",
    "#",
    "# Hapimatic Configuration Porter — script-driven export (definitions-only, secrets-free).",
    headerTarget,
    `# Manifest schema version: ${schemaVersion}`,
    ...headerWhen,
    ...headerVersion,
    "#",
    "# Run this DIRECTLY on the machine whose Claude Code configuration you want to",
    "# bring over. There is NO Claude/LLM step. It uses only jq, tar, and gzip — it",
    "# NEVER reads, encrypts, or writes any secret VALUE and NEVER invokes age. The",
    "# archive it produces carries config DEFINITIONS only; the destination re-auths",
    "# any MCP/env secret. Upload the printed archive path to the destination instance.",
    "set -eu",
    "# #4172: no cd searches CDPATH: a relative path names one folder, and a cd",
    "# that found it through CDPATH would print it into a captured value.",
    "unset CDPATH",
    "# #4172: under a UTF-8 locale, bash's read takes a trailing byte that is not",
    "# UTF-8 (a Latin-1 caf<0xE9>) as the start of a character and swallows the",
    "# newline or NUL after it, so a listed path is lost or merged with the next:",
    "# a credential named that way was never pruned, and a link was never checked.",
    "# Every name is handled as bytes.",
    "export LC_ALL=C",
    "# #4587 (R7-R1-6): when this is not set, macOS bsdtar adds a ._<name>",
    "# AppleDouble member for a file with extended attributes. GNU tar and",
    "# BusyBox ignore it.",
    "export COPYFILE_DISABLE=1",
    "# An inherited BASHOPTS/SHELLOPTS could break the globs and path checks:",
    "# failglob (an unmatched .[!.]* or ..?* is an error), nocasematch (a path",
    "# case matches any letter case, while the ${x#...} removal after it does",
    "# not) and noglob (no listing at all). Switched off.",
    "shopt -u failglob nocasematch 2>/dev/null || :",
    "set +f",
    "_HLC=abcdefghijklmnopqrstuvwxyz; _HUC=ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    "",
    "# ── Progress: stderr-only (stdout carries ONLY the final archive path) ──",
    // #3446: 12 steps when the self-upload leg is present, 11 without — so the
    // step bar never renders "12/11" (or "11/12") when the upload step is added.
    `TOTAL_STEPS=${uploadUrl ? 12 : 11}`,
    "STEP_N=0",
    "step() {",
    "  STEP_N=$((STEP_N + 1))",
    "  _filled=$((STEP_N * 20 / TOTAL_STEPS))",
    "  _bar=''",
    "  _i=0",
    '  while [ "$_i" -lt 20 ]; do',
    '    if [ "$_i" -lt "$_filled" ]; then _bar="${_bar}#"; else _bar="${_bar}."; fi',
    "    _i=$((_i + 1))",
    "  done",
    '  printf \'[%s] %2d/%d %s\\n\' "$_bar" "$STEP_N" "$TOTAL_STEPS" "$1" >&2',
    "}",
    "printf '\\n== Hapimatic Configuration Porter — secrets-free, symlink-safe export ==\\n' >&2",
    "printf 'Collecting your Claude Code configuration. Depending on its size this\\n' >&2",
    "printf 'can take a few minutes; each step reports below as it starts.\\n' >&2",
    ...(generatorVersion
      ? [
          `printf 'Script version: v${generatorVersion}%s\\n\\n' ${
            generatedAt ? `' (generated ${generatedAt})'` : "''"
          } >&2`,
        ]
      : ["printf '\\n' >&2"]),
    "",
    "# ── Step 0 — preflight (jq, tar, gzip required; NO age: no secrets are handled) ──",
    'step "Checking required tools (jq, tar, gzip)"',
    "for _tool in jq tar gzip; do",
    '  command -v "$_tool" >/dev/null 2>&1 || {',
    "    printf 'error: required tool %s not found on PATH\\n' \"$_tool\" >&2",
    // #3446 (K14): per-OS install hints for jq — the one preflight tool a fresh
    // machine most often lacks. macOS 15+ ships /usr/bin/jq; ≤14 needs Homebrew.
    '    if [ "$_tool" = "jq" ]; then',
    '      printf \'  install jq: macOS <=14 "brew install jq" (macOS 15+ ships /usr/bin/jq); Linux "sudo apt install jq" or "sudo dnf install jq"\\n\' >&2',
    "    fi",
    "    exit 1",
    "  }",
    "done",
    "",
    `SCHEMA_VERSION='${schemaVersion}'`,
    'CONFIG_ROOT="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"',
    "# ── P7a guard (#3446, K12/D8(a)) — WARN-ONLY ──",
    "# A Hapimatic session terminal sets CLAUDE_CONFIG_DIR to the session's",
    "# ISOLATED config root, so an ambient value that is not your personal",
    "# $HOME/.claude means this one-liner is packaging the SESSION's config, not",
    "# your own. Warn and CONTINUE: never normalize (that would regress legitimate",
    "# non-default CLAUDE_CONFIG_DIR users) and never abort (a piped one-liner has",
    "# no interactive prompt to fall back to). Honours the ambient value as before.",
    'if [ -n "${CLAUDE_CONFIG_DIR:-}" ] && [ "$CLAUDE_CONFIG_DIR" != "$HOME/.claude" ]; then',
    '  printf \'warning: CLAUDE_CONFIG_DIR is set to %s (not %s/.claude)\\n\' "$CLAUDE_CONFIG_DIR" "$HOME" >&2',
    "  printf '         this looks like a Hapimatic session terminal — run the line in a\\n' >&2",
    "  printf '         regular terminal if you meant your personal config.\\n' >&2",
    "fi",
    'HOST_CONFIG="$HOME/.claude.json"',
    "# ── Preflight relax (#3448 Sub C, 1B#34) ── the ~/.claude config root is no",
    "# longer a HARD prerequisite: it feeds only the claude-code source, while Cursor",
    "# and Claude Desktop live elsewhere. CLAUDE_CODE_FOUND records whether it exists;",
    "# every downstream $CONFIG_ROOT read is already -d/-f guarded, so an absent root",
    "# collects nothing from it and continues. The 'no source found at all' error",
    "# moves to Step 5, after every source is probed.",
    "CLAUDE_CODE_FOUND=false",
    'if [ -d "$CONFIG_ROOT" ]; then CLAUDE_CODE_FOUND=true; fi',
    "# #4172: read the config root once, as one physical path, so every later",
    "# check and copy (cd, find, tar, physical_path) names the same folder. A '..'",
    "# in CLAUDE_CONFIG_DIR is taken as text first (a plain cd, as the PowerShell",
    "# twin and Claude Code's Node path.join take it; bash falls back to the",
    "# kernel's reading when the text folder does not exist), then every link is",
    "# resolved (pwd -P). With no '..' only the spelling changes; with a '..' after",
    "# a link, every later read takes the text reading, where -d, -f, cp and",
    "# physical_path took the kernel's. The existence check above (-d) still takes",
    "# the kernel's reading, so where only the text folder exists bash finds no",
    "# configuration while the PowerShell twin (Test-Path) exports it (#4321).",
    "# The x keeps a trailing newline. The root as",
    "# given is kept: a hook registered through that spelling maps onto this one.",
    "# A trailing / is dropped, as the PowerShell twin's TrimEnd does; the loop keeps a",
    "# / root as / (TrimEnd empties it, so the twin never maps through it):",
    "# otherwise <root>/ + /* never matches <root>/hooks/... and hooks merge.",
    'CONFIG_ROOT_GIVEN="$CONFIG_ROOT"',
    'while [ "$CONFIG_ROOT_GIVEN" != "/" ] && [ "${CONFIG_ROOT_GIVEN%/}" != "$CONFIG_ROOT_GIVEN" ]; do CONFIG_ROOT_GIVEN="${CONFIG_ROOT_GIVEN%/}"; done',
    'if [ "$CLAUDE_CODE_FOUND" = true ]; then',
    '  _croot="$(CDPATH= cd -- "$CONFIG_ROOT" 2>/dev/null && pwd -P && printf x)" || _croot=\'\'',
    '  _croot="${_croot%x}"; _croot="${_croot%?}"',
    '  if [ -n "$_croot" ]; then CONFIG_ROOT="$_croot"; fi',
    "fi",
    ...profileDetectionShellLines(profile),
    "",
    "# Staging holds the archive tree; WORK holds scratch JSON kept OUT of the tar.",
    'STAGING="$(mktemp -d)"',
    'WORK="$(mktemp -d)"',
    "# A relative TMPDIR gives relative folders, which a later cd would move: both",
    "# are made absolute, so every read, removal and the cleanup name the same ones.",
    'case "$STAGING" in /*) ;; *) STAGING="$PWD/$STAGING" ;; esac',
    'case "$WORK" in /*) ;; *) WORK="$PWD/$WORK" ;; esac',
    'cleanup() { rm -rf "$STAGING" "$WORK"; }',
    "trap cleanup EXIT INT TERM",
    'OMISSIONS="$WORK/omissions.jsonl"; : > "$OMISSIONS"',
    "record_omission() {",
    '  jq -cn --arg s "$1" --arg r "$2" \'{surface: $s, reason: $r}\' >> "$OMISSIONS"',
    "}",
    ...pruneCredentialNamesFunctionLines(),
    ...credentialLinkFunctionLines(),
    "",
    "# Replace every staged symlink with its ORIGINAL target's content, because the",
    "# destination import refuses link members outright (archive containment: a link",
    "# is an escape vector) and a RELATIVE link target only resolves from the source",
    "# tree, never from staging. Directory targets are re-tarred with the same junk",
    "# exclusions (-h dereferences nested links against their true locations); file",
    "# targets are copied dereferenced; unresolvable targets are dropped and recorded",
    "# as omissions. Residual (documented): a broken link NESTED inside a linked",
    "# directory is skipped by tar with a stderr warning, not an omission entry.",
    "materialize_links() {",
    "  # NUL-delimited, so a name with a newline stays one name. Before #4172 the",
    "  # list was read one per line: each piece after a newline became a path of",
    "  # its own (relative to the current folder, or absolute when it began with",
    "  # /), and the rm below removed it.",
    '  find "$STAGING" -type l -print0 > "$WORK/links.txt" 2>/dev/null || : > "$WORK/links.txt"',
    "  while IFS= read -r -d '' _lnk; do",
    '    case "$_lnk" in "$STAGING"/*) ;; *) continue ;; esac',
    '    [ -L "$_lnk" ] || continue',
    '    _lrel="${_lnk#"$STAGING"/}"',
    '    _lsrc="$CONFIG_ROOT/$_lrel"',
    '    rm -f "$_lnk"',
    "    # A link with a newline in its staged path is refused whole: the refusal",
    "    # lists below are read one per line, where its pieces would name nothing",
    "    # and the store it reaches would ship.",
    '    case "$_lrel" in *"$_cnl"*)',
    `      record_omission "$_lrel" '${ARCHIVE_LINK_UNCHECKED_OMISSION_REASON}'`,
    "      continue ;;",
    "    esac",
    "    # #4172 (OOS-6): a link whose physical target is a credential store, or",
    "    # that reaches one through a link naming a store (~/.ssh -> ~/Dropbox/k),",
    "    # is refused, with one omission, before anything is copied (except",
    "    # through the link-target newline gaps tracked in #4332).",
    '    _lrc=0; _lphys="$(physical_path "$_lsrc")" || _lrc=$?',
    '    if [ "$_lrc" -eq 3 ]; then',
    `      record_omission "$_lrel" '${ARCHIVE_CREDENTIAL_OMISSION_REASON}'`,
    "      continue",
    "    fi",
    '    if [ -z "$_lphys" ] && { [ "$_lrc" -eq 4 ] || [ -e "$_lsrc" ]; }; then',
    `      record_omission "$_lrel" '${ARCHIVE_LINK_UNCHECKED_OMISSION_REASON}'`,
    "      continue",
    "    fi",
    '    if [ -n "$_lphys" ] && has_credential_part "$_lphys"; then',
    `      record_omission "$_lrel" '${ARCHIVE_CREDENTIAL_OMISSION_REASON}'`,
    "      continue",
    "    fi",
    '    if [ -d "$_lsrc" ]; then',
    '      mkdir -p "$_lnk"',
    '      : > "$WORK/credential-links.txt"',
    '      credential_links "$_lsrc" "$_lrel" "$WORK/credential-links.txt"',
    `      if ( cd "$_lsrc" && tar -cf - -h ${tarExcludeFlags()} . ) \\`,
    '        | ( cd "$_lnk" && tar -xpf - ); then',
    "        # tar -h followed the links under it too: take out each one that",
    "        # credential_links refused, with one omission per path it staged. A",
    "        # path below a link tar kept is not this copy's, so it is left alone.",
    "        # Each line is split at its first TAB by hand: read would strip a TAB",
    "        # that ends the path.",
    '        : > "$WORK/credential-links-staged.txt"',
    '        while IFS= read -r _cline; do _ck="${_cline%%"$_ctab"*}"; _cl="${_cline#*"$_ctab"}"',
    '          if under_link "$STAGING" "$_cl"; then continue; fi',
    '          if [ -e "$STAGING/$_cl" ] || [ -L "$STAGING/$_cl" ]; then',
    `            if [ "$_ck" = u ]; then _cwhy='${ARCHIVE_LINK_UNCHECKED_OMISSION_REASON}'; else _cwhy='${ARCHIVE_CREDENTIAL_OMISSION_REASON}'; fi`,
    '            record_omission "$_cl" "$_cwhy"',
    '            printf \'%s\\n\' "$_cl" >> "$WORK/credential-links-staged.txt"',
    "          fi",
    '        done < "$WORK/credential-links.txt"',
    '        remove_credential_paths "$STAGING" "$WORK/credential-links-staged.txt"',
    "      else",
    '        record_omission "$_lrel" "symlinked directory could not be copied"',
    '        rm -rf "$_lnk"',
    "      fi",
    '    elif [ -f "$_lsrc" ]; then',
    '      cp -L "$_lsrc" "$_lnk" || {',
    '        record_omission "$_lrel" "symlinked file could not be copied"',
    '        rm -f "$_lnk"',
    "      }",
    "    else",
    '      record_omission "$_lrel" "broken symlink (target does not resolve)"',
    "    fi",
    '  done < "$WORK/links.txt"',
    "}",
    "",
    "# ── Step 1 & 2 — collect dimension directories, pruning junk (exclusions) ──",
    'step "Collecting configuration directories"',
    `for _dim in ${DIMENSION_DIRS.join(" ")}; do`,
    '  if [ -d "$CONFIG_ROOT/$_dim" ]; then',
    "    printf '        %s...\\n' \"$_dim\" >&2",
    `    ( cd "$CONFIG_ROOT" && tar -cf - ${tarExcludeFlags()} "$_dim" ) \\`,
    '      | ( cd "$STAGING" && tar -xpf - )',
    "  fi",
    "done",
    "",
    "# ── Step 2.5 — materialize symlinked members (the import refuses link members) ──",
    'step "Materializing symlinked entries (the import refuses raw links)"',
    "materialize_links",
    "",
    "# #4172 (P1): no credential-bearing name leaves this machine. After the links",
    "# are materialized (a linked folder's content is real now) and before the",
    "# entries are listed; the listing skips dotfiles, but tar does not.",
    `for _dim in ${DIMENSION_DIRS.join(" ")}; do prune_credential_names "$_dim"; done`,
    "",
    "# {name,path}[] for a dimension dir (immediate children; files lose one extension).",
    "dim_entries() { # $1 = dimension dir",
    '  _d="$STAGING/$1"',
    "  if [ ! -d \"$_d\" ]; then printf '[]\\n'; return; fi",
    '  ( cd "$_d" && for _e in *; do',
    '      [ -e "$_e" ] || continue',
    '      _n="$_e"',
    '      if [ -f "$_e" ]; then case "$_e" in *.*) _n="${_e%.*}";; esac; fi',
    '      printf \'%s\\t%s/%s\\n\' "$_n" "$1" "$_e"',
    "    done ) \\",
    "    | jq -Rn '[inputs | select(length > 0) | split(\"\\t\") | {name: .[0], path: .[1]}]'",
    "}",
    "",
  ];

  // Per-dimension entry arrays → WORK/<field>.json
  for (const dir of DIMENSION_DIRS) {
    lines.push(`dim_entries '${dir}' > "$WORK/${DIMENSION_FIELD[dir]}.json"`);
  }

  lines.push(
    "",
    "# ── Step 3 — CLAUDE.md and its @-includes ──",
    'step "Packaging CLAUDE.md and its @-includes"',
    "# #4188: the one link walk (this step and Step 7b call it).",
    ...porterWalkLinkLines(),
    "CLAUDE_MD_JSON=null",
    'if [ -f "$CONFIG_ROOT/CLAUDE.md" ]; then',
    ...claudeMdIncludeLoopLines(),
    "fi",
    "",
    "# ── Step 4 — hooks: registration walk (never filter on matcher) + support modules ──",
    'step "Collecting hooks and support modules"',
    'HOOKS_JSON="$WORK/hooks.json"; echo "[]" > "$HOOKS_JSON"',
    'HOOKSUPPORT_JSON="$WORK/hooksupport.json"; echo "[]" > "$HOOKSUPPORT_JSON"',
    'SETTINGS_SRC="$CONFIG_ROOT/settings.json"',
    'if [ -f "$SETTINGS_SRC" ]; then',
    '  mkdir -p "$STAGING/hooks"',
    "  # One row per command, matcher optional — the empty-matcher-safe recipe.",
    "  jq -c '.hooks // {} | to_entries[] as $e | $e.value[] as $b | ($b.hooks // [])[]",
    "    | select(.command != null)",
    "    | {event: $e.key, command: .command}",
    '      + (if ($b.matcher // "") != "" then {matcher: $b.matcher} else {} end)\' \\',
    '    "$SETTINGS_SRC" 2>/dev/null > "$WORK/regs.jsonl" || : > "$WORK/regs.jsonl"',
    "  while IFS= read -r _reg; do",
    '    [ -n "$_reg" ] || continue',
    '    _cmd="$(printf \'%s\' "$_reg" | jq -r .command)"',
    "    # First token ending in a known hook script extension.",
    "    _raw=\"$(printf '%s' \"$_cmd\" | grep -oE '[^[:space:]]+\\.(py|sh|js|ts|mjs|cjs)' | head -1 || true)\"",
    '    if [ -z "$_raw" ]; then',
    '      record_omission "hooks" "no resolvable script file in command: $_cmd"',
    "      continue",
    "    fi",
    '    _resolved="$_raw"',
    '    case "$_resolved" in',
    '      "$CONFIG_ROOT_GIVEN"/*) _resolved="$CONFIG_ROOT/${_resolved#"$CONFIG_ROOT_GIVEN"/}" ;;',
    '      "$HOME/.claude"*) _resolved="$CONFIG_ROOT${_resolved#"$HOME"/.claude}" ;;',
    '      "~/.claude"*)     _resolved="$CONFIG_ROOT${_resolved#\\~/.claude}" ;;',
    '      */.claude/*)      _resolved="$CONFIG_ROOT/${_resolved#*/.claude/}" ;;',
    "    esac",
    "    # A registration spelled <root>//hooks/... leaves a leading / after the root:",
    "    # drop it, as the PowerShell twin's Join-Path does, so it still reads as hooks/.",
    '    case "$_resolved" in "$CONFIG_ROOT"/*) _rr="${_resolved#"$CONFIG_ROOT"/}"; while [ "${_rr#/}" != "$_rr" ]; do _rr="${_rr#/}"; done; _resolved="$CONFIG_ROOT/$_rr" ;; esac',
    '    if [ ! -f "$_resolved" ]; then',
    '      record_omission "hooks" "registration references missing file: $_raw"',
    "      continue",
    "    fi",
    "    # Archive-relative path under hooks/ (mirrors the source hooks/ subtree).",
    '    case "$_resolved" in',
    '      "$CONFIG_ROOT/hooks/"*) _rel="hooks/${_resolved#"$CONFIG_ROOT"/hooks/}" ;;',
    '      *) _rel="hooks/$(basename "$_resolved")" ;;',
    "    esac",
    "    # #4172 (OOS-6): a registered script whose physical path is in a credential",
    "    # store (or cannot be checked) is refused, registration and all (except",
    "    # through the trailing-newline gap in a link target, tracked in #4332).",
    "    # One outside hooks/ is recorded here. One under hooks/ is queued and",
    "    # recorded after the last prune, unless the hooks-tree copy recorded it",
    "    # first: Step 4b skips tests/ and the other excluded folders, so it may",
    "    # never see the script.",
    '    _hrc=0; _hphys="$(physical_path "$_resolved")" || _hrc=$?',
    "    _hwhy=''",
    `    if [ "$_hrc" -eq 3 ]; then _hwhy='${ARCHIVE_CREDENTIAL_OMISSION_REASON}'; elif [ -z "$_hphys" ]; then _hwhy='${ARCHIVE_LINK_UNCHECKED_OMISSION_REASON}'; elif has_credential_part "$_hphys"; then _hwhy='${ARCHIVE_CREDENTIAL_OMISSION_REASON}'; fi`,
    '    if [ -n "$_hwhy" ]; then',
    '      case "$_resolved" in',
    '        "$CONFIG_ROOT/hooks/"*) printf \'%s\\t%s\\n\' "$_rel" "$_hwhy" >> "$WORK/hook-refused.tsv" ;;',
    '        *) record_omission "$_rel" "$_hwhy" ;;',
    "      esac",
    "      continue",
    "    fi",
    "    # #4172: the staged path is built from settings.json. Its empty, . and x/..",
    "    # parts are collapsed as text: the copy is given the collapsed text, so no",
    "    # .. is read after a link, and every kept path lies under hooks/, which",
    "    # holds no link at this point (only folders made by mkdir -p and files",
    "    # earlier registrations copied; bash reads a backslash as a name",
    "    # character). A path that stays inside hooks/ is registered and copied",
    "    # under its collapsed form (hooks/./run.py as hooks/run.py). One that",
    "    # leaves hooks/ but not staging is staged as hooks/<name> (unless that name",
    "    # is taken, below), as a script registered from outside hooks/ is: only",
    "    # hooks/ and the section folders",
    "    # are archived (x.py or scripts/tool.sh are not), and the importer stages",
    "    # each registered hook at hooks/<name>, so any other path would either be",
    "    # missing from the archive or, from a section folder, replace a real",
    "    # top-level hook of that name. One whose .. climbs above staging",
    "    # (hooks/../../x lands outside it, onto whatever file is there) is refused,",
    "    # registration and all.",
    "    _crest=\"$_rel/\"; _cout=''; _cclimb=0",
    '    while [ -n "$_crest" ]; do',
    '      _cseg="${_crest%%/*}"; _crest="${_crest#*/}"',
    '      case "$_cseg" in',
    '        ""|.) ;;',
    '        ..) if [ -z "$_cout" ]; then _cclimb=1; break; fi; case "$_cout" in */*) _cout="${_cout%/*}" ;; *) _cout="" ;; esac ;;',
    '        *) _cout="${_cout:+$_cout/}$_cseg" ;;',
    "      esac",
    "    done",
    '    _hreg="$_rel"; _hfb=0',
    '    case "$_cclimb:$_cout" in',
    '      0:hooks/?*) _rel="$_cout" ;;',
    '      0:?*) _rel="hooks/$(basename "$_resolved")"; _hfb=1 ;;',
    `      *) record_omission "$_rel" '${ARCHIVE_HOOK_PATH_ESCAPE_OMISSION_REASON}'; continue ;;`,
    "    esac",
    "    # A re-staged script never replaces another hook's different bytes (staged",
    "    # by an earlier registration, or in the source hooks/): first writer wins,",
    "    # as the importer stages hooks, and Step 4b cannot always put the real",
    "    # bytes back (an excluded name, a failed tree copy). Every entry whose name",
    "    # matches in any ASCII case counts, so a case-insensitive destination never",
    "    # merges two of them. The pattern is built without a fork, from explicit",
    "    # letter lists (no locale), and the glob follows a linked hooks/ and yields",
    "    # whole names. The same bytes (one script registered for several events)",
    "    # are no conflict; a folder, a dangling link, an unreadable file or a",
    "    # missing cmp counts as different. The exact name is always compared",
    "    # first, through the filesystem's own lookup. A hooks/ that cannot be",
    "    # listed stops the copy too, under its own reason when no name was found",
    "    # taken (it cannot show the name is free). The registration is kept: its",
    "    # command still names the script's own path. The omission is recorded",
    "    # unless the script ships and is imported at its own path: under a",
    "    # listed (non-dot) section entry, with the same bytes.",
    "    _htaken=0; _hunl=0",
    '    if [ "$_hfb" -eq 1 ]; then',
    "      _hname=\"${_rel#hooks/}\"; _hpat=''; _hi=0",
    '      while [ "$_hi" -lt "${#_hname}" ]; do',
    '        _hc="${_hname:$_hi:1}"',
    '        case "$_hc" in',
    '          [abcdefghijklmnopqrstuvwxyz]) _hx="${_HLC%%"$_hc"*}"; _hpat="$_hpat[$_hc${_HUC:${#_hx}:1}]" ;;',
    '          [ABCDEFGHIJKLMNOPQRSTUVWXYZ]) _hx="${_HUC%%"$_hc"*}"; _hpat="$_hpat[${_HLC:${#_hx}:1}$_hc]" ;;',
    '          *) _hpat="$_hpat\\\\$_hc" ;;',
    "        esac",
    "        _hi=$((_hi + 1))",
    "      done",
    '      for _hd in "$STAGING/hooks" "$CONFIG_ROOT/hooks"; do',
    '        [ -d "$_hd" ] || continue',
    "        # The exact name is always compared (the kernel's own lookup, with the",
    "        # filesystem's case and Unicode rules), whatever the listing shows.",
    '        if [ -e "$_hd/$_hname" ] || [ -L "$_hd/$_hname" ]; then cmp -s "$_resolved" "$_hd/$_hname" || _htaken=1; fi',
    '        [ -r "$_hd" ] || { _hunl=1; continue; }',
    '        for _hs in "$_hd"/* "$_hd"/.[!.]* "$_hd"/..?*; do',
    '          [ -e "$_hs" ] || [ -L "$_hs" ] || continue',
    '          case "${_hs##*/}" in $_hpat) cmp -s "$_resolved" "$_hs" || _htaken=1 ;; esac',
    "        done",
    "      done",
    "    fi",
    '    if [ "$_htaken" -eq 1 ] || [ "$_hunl" -eq 1 ]; then',
    "      _hship=0",
    `      case "$_cout" in ${DIMENSION_DIRS.map(d => `${d}/[!.]*`).join("|")}) if [ -f "$STAGING/$_cout" ] && cmp -s "$_resolved" "$STAGING/$_cout"; then _hship=1; fi ;; esac`,
    `      if [ "$_hship" -eq 0 ]; then if [ "$_htaken" -eq 1 ]; then record_omission "$_hreg" '${ARCHIVE_HOOK_SLOT_TAKEN_OMISSION_REASON}'; else record_omission "$_hreg" '${ARCHIVE_HOOK_SLOT_UNLISTABLE_OMISSION_REASON}'; fi; fi`,
    "    else",
    '      mkdir -p "$STAGING/$(dirname "$_rel")"',
    '      cp -p "$_resolved" "$STAGING/$_rel"',
    "    fi",
    "    # Normalize the command's source-home prefix to the portable $HOME token.",
    "    _ncmd=\"$(printf '%s' \"$_cmd\" | sed -E 's#/home/[^/ ]+/\\.claude#$HOME/.claude#g; s#(^|[[:space:]])~/\\.claude#\\1$HOME/.claude#g')\"",
    '    _event="$(printf \'%s\' "$_reg" | jq -r .event)"',
    '    _matcher="$(printf \'%s\' "$_reg" | jq -r \'if has("matcher") then .matcher else "" end\')"',
    '    _entry="$(jq -cn --arg path "$_rel" --arg event "$_event" --arg command "$_ncmd" --arg matcher "$_matcher" \\',
    "      '{file: {path: $path}, registration: ({events: [$event], command: $command}",
    '        + (if $matcher != "" then {matcher: $matcher} else {} end))}\')"',
    '    _tmp="$(jq -c --argjson e "$_entry" \'. + [$e]\' "$HOOKS_JSON")"; printf \'%s\' "$_tmp" > "$HOOKS_JSON"',
    '  done < "$WORK/regs.jsonl"',
    "fi",
    "",
    "# #4172 (OOS-6): a linked hooks/ is checked once, as materialize_links checks",
    "# a staged link, before its support folders or its tree are copied through",
    "# it (each registered script was checked on its own path). Refused: nothing",
    "# more is copied through it, its support folders get no hookSupport entry,",
    "# and Step 4b records one omission.",
    '_hrefuse=""',
    'if [ -L "$CONFIG_ROOT/hooks" ] && [ -d "$CONFIG_ROOT/hooks" ]; then',
    '  _hrc=0; _hphys="$(physical_path "$CONFIG_ROOT/hooks")" || _hrc=$?',
    '  if [ "$_hrc" -eq 3 ] || { [ -n "$_hphys" ] && has_credential_part "$_hphys"; }; then',
    `    _hrefuse='${ARCHIVE_CREDENTIAL_OMISSION_REASON}'`,
    '  elif [ -z "$_hphys" ]; then',
    `    _hrefuse='${ARCHIVE_LINK_UNCHECKED_OMISSION_REASON}'`,
    "  fi",
    "fi",
    "",
    "# Hook-support subtrees (lib, _shared) hooks import but that carry no registration.",
    `for _sup in ${HOOK_SUPPORT_DIRS.join(" ")}; do`,
    '  if [ -d "$CONFIG_ROOT/hooks/$_sup" ] && [ -z "$_hrefuse" ]; then',
    '    mkdir -p "$STAGING/hooks/$_sup"',
    `    ( cd "$CONFIG_ROOT/hooks" && tar -cf - ${tarExcludeFlags()} "$_sup" ) \\`,
    '      | ( cd "$STAGING/hooks" && tar -xpf - )',
    '    _tmp="$(jq -c --arg n "$_sup" --arg p "hooks/$_sup" \'. + [{name: $n, path: $p}]\' "$HOOKSUPPORT_JSON")"',
    '    printf \'%s\' "$_tmp" > "$HOOKSUPPORT_JSON"',
    "  fi",
    "done",
    "",
    "# ── Step 4b — #3590: stage the WHOLE hooks tree (whole-tree archive) ──",
    "# Closes the registry-dispatched / dynamically-loaded hook class the",
    "# registration walk above never reaches (on a dispatcher-form host it ships",
    "# ONE hook of ~135). Runtime state, caches, tests/ etc. are excluded",
    "# (ARCHIVE_EXCLUSIONS + HOOK_TREE_EXCLUSIONS). NOT gated on settings.json.",
    'if [ -d "$CONFIG_ROOT/hooks" ]; then',
    '  mkdir -p "$STAGING/hooks"',
    "  # #4172: a linked hooks/ that passed the check above has its content",
    "  # copied: staged as a link, it could not be extracted over the scripts the",
    "  # walk above already staged there. Its own links stay links, for the",
    "  # materialize pass. A refused one: one omission, nothing copied.",
    '  if [ -n "$_hrefuse" ]; then',
    '    record_omission hooks "$_hrefuse"',
    '  elif [ -L "$CONFIG_ROOT/hooks" ] && ! ( cd "$CONFIG_ROOT/hooks" ) 2>/dev/null; then',
    "    # A linked folder the export cannot enter is recorded, as materialize_links",
    "    # records one. Below, a copy whose extraction fails stops the run; a file",
    "    # the reading tar cannot read is left out without a record, as elsewhere",
    "    # in the tree copy (#4332).",
    '    record_omission hooks "symlinked directory could not be copied"',
    '  elif [ -L "$CONFIG_ROOT/hooks" ]; then',
    `    ( cd "$CONFIG_ROOT/hooks" && tar -cf - ${tarExcludeFlags(HOOK_TREE_EXCLUSION_PATTERNS)} . ) \\`,
    '      | ( cd "$STAGING/hooks" && tar -xpf - )',
    "  else",
    `    ( cd "$CONFIG_ROOT" && tar -cf - ${tarExcludeFlags(HOOK_TREE_EXCLUSION_PATTERNS)} "hooks" ) \\`,
    '      | ( cd "$STAGING" && tar -xpf - )',
    "  fi",
    "  # #4172 (P2): before the per-file walk below, so a removed credential file",
    "  # never gets a hookSupport entry.",
    "  prune_credential_names hooks",
    "  # One hookSupport entry per staged file that is NOT a registered hooks[]",
    "  # path and NOT under lib/_shared (K1: exactly one manifest reference per",
    "  # file). Collect as JSONL and fold ONCE with jq (never the O(N^2) rewrite).",
    '  jq -r \'.[].file.path\' "$HOOKS_JSON" 2>/dev/null > "$WORK/registered_paths.txt" || : > "$WORK/registered_paths.txt"',
    '  : > "$WORK/hooksupport_perfile.jsonl"',
    '  find "$STAGING/hooks" -type f | while IFS= read -r _hf; do',
    '    _rel="hooks/${_hf#"$STAGING"/hooks/}"',
    '    case "$_rel" in',
    "      hooks/lib/*|hooks/_shared/*) continue ;;",
    "    esac",
    '    grep -qxF "$_rel" "$WORK/registered_paths.txt" && continue',
    '    jq -cn --arg n "$(basename "$_rel")" --arg p "$_rel" \'{name: $n, path: $p}\' >> "$WORK/hooksupport_perfile.jsonl"',
    "  done",
    '  if [ -s "$WORK/hooksupport_perfile.jsonl" ]; then',
    '    _tmp="$(jq -c --slurpfile perfile "$WORK/hooksupport_perfile.jsonl" \'. + $perfile\' "$HOOKSUPPORT_JSON")"',
    '    printf \'%s\' "$_tmp" > "$HOOKSUPPORT_JSON"',
    "  fi",
    "fi",
    "",
    "# Hook-support trees can also carry symlinks — materialize those too.",
    "materialize_links",
    "# #4172 (P3): the last materialization, so prune the section folders and",
    "# hooks again: a linked folder inside hooks/ was just copied in with",
    "# junk-only exclusions, and a link a tar kept in a section folder (bsdtar",
    "# keeps a loop) has just been turned into content. CLAUDE.md and its",
    "# includes follow Step 3's rule, not this one.",
    `for _dim in ${DIMENSION_DIRS.join(" ")} hooks; do prune_credential_names "$_dim"; done`,
    "# #4172: record each refused hook under hooks/ that the passes above did not.",
    "# One in an excluded folder was never staged, so nothing else records it. An",
    "# omission for the same path, or for a folder above it refused as a store or",
    "# as unchecked, already covers it. A check that fails records it anyway.",
    'if [ -s "$WORK/hook-refused.tsv" ]; then while IFS= read -r _hline; do',
    '  _hs="${_hline%%"$_ctab"*}"; _hw="${_hline#*"$_ctab"}"',
    `  if ! jq -ne --arg s "$_hs" --arg c '${ARCHIVE_CREDENTIAL_OMISSION_REASON}' --arg u '${ARCHIVE_LINK_UNCHECKED_OMISSION_REASON}' \\`,
    "    'any(inputs; .surface as $o | $s == $o or ((.reason == $c or .reason == $u) and ($s | startswith($o + \"/\"))))' \\",
    '    "$OMISSIONS" >/dev/null 2>&1; then',
    '    record_omission "$_hs" "$_hw"',
    "  fi",
    'done < "$WORK/hook-refused.tsv"; fi',
    "",
    ...memoryStagingShellLines(tarExcludeFlags()),
    "",
    "# ── Step 5 — MCP server DEFINITIONS from EVERY source (key names only, NO values) ──",
    'step "Extracting MCP server definitions (names only — no secret values)"',
    "# Claude Code — the host ~/.claude.json (definitions-only). Its found flag is the",
    "# ~/.claude config root, computed in preflight (CLAUDE_CODE_FOUND).",
    'CC_MCP="[]"',
    'if [ -f "$HOST_CONFIG" ]; then',
    "  CC_MCP=\"$(jq -c --arg source claude-code '" +
      mcpExtractionJq() +
      "' \"$HOST_CONFIG\" 2>/dev/null || echo '[]')\"",
    '  [ -n "$CC_MCP" ] || CC_MCP="[]"',
    "fi",
    ...posixProbeBlock("cursor", "CURSOR", "Cursor (~/.cursor/mcp.json)"),
    ...posixProbeBlock("claude-desktop", "DESKTOP", "Claude Desktop"),
    "# No supported source found at all → error (preflight no longer hard-exits, 1B#34).",
    'if [ "$CLAUDE_CODE_FOUND" != true ] && [ "$CURSOR_FOUND" != true ] && [ "$DESKTOP_FOUND" != true ]; then',
    "  printf 'error: no supported configuration found\\n' >&2",
    "  exit 1",
    "fi",
    "# Cross-source dedupe by name in precedence order + build sources[] metadata.",
    '_MSRC="$(jq -cn --argjson cc "$CC_MCP" --argjson cur "$CURSOR_MCP" \\',
    '  --argjson dt "$DESKTOP_MCP" \\',
    '  --argjson ccf "$CLAUDE_CODE_FOUND" --argjson curf "$CURSOR_FOUND" \\',
    '  --argjson dtf "$DESKTOP_FOUND" \'' + mcpDedupeAndSourcesJq() + "')\"",
    '[ -n "$_MSRC" ] || _MSRC=\'{"mcpServers":[],"sources":[]}\'',
    "MCP_JSON=\"$(printf '%s' \"$_MSRC\" | jq -c '.mcpServers')\"",
    '  [ -n "$MCP_JSON" ] || MCP_JSON="[]"',
    "SOURCES_JSON=\"$(printf '%s' \"$_MSRC\" | jq -c '.sources')\"",
    '  [ -n "$SOURCES_JSON" ] || SOURCES_JSON="[]"',
    "",
    "# ── Step 7 — settings.json: project the allowlist with jq, OMITTING env VALUES ──",
    'step "Projecting settings.json (env values omitted)"',
    'SETTINGS_JSON="{}"',
    'SKIPPED_JSON="[]"',
    'if [ -f "$SETTINGS_SRC" ]; then',
    "  # Allowlisted keys EXCEPT env (env values are omitted entirely — secrets-free).",
    `  SETTINGS_JSON="$(jq -c '{${SETTINGS_KEYS_NO_ENV.map(
      k => `${k}: .${k}`
    ).join(
      ", "
    )}} | with_entries(select(.value != null))' "$SETTINGS_SRC" 2>/dev/null || echo '{}')"`,
    '  [ -n "$SETTINGS_JSON" ] || SETTINGS_JSON="{}"',
    "  # Every settings key NOT in the projected allowlist is reported as skipped.",
    `  SKIPPED_JSON="$(jq -c --argjson keep '${JSON.stringify(
      SETTINGS_KEYS_NO_ENV
    )}' 'keys - $keep' "$SETTINGS_SRC" 2>/dev/null || echo '[]')"`,
    '  [ -n "$SKIPPED_JSON" ] || SKIPPED_JSON="[]"',
    "  # env is deliberately omitted: record it as skipped + a distinct omission.",
    '  if jq -e \'has("env")\' "$SETTINGS_SRC" >/dev/null 2>&1; then',
    '    SKIPPED_JSON="$(printf \'%s\' "$SKIPPED_JSON" | jq -c \'. + ["env"] | unique\')"',
    '    record_omission "settings.env" "definitions-only: env values omitted (re-supply at destination)"',
    "  fi",
    "fi",
    "",
    "# ── Step 7b — #4173: the top-level script an executable setting runs ──",
    "# (no step call: the step count and progress bar are unchanged)",
    'SSCRIPT_SECTIONS="$STAGING"',
    ...settingsScriptLoopLines(),
    "",
    "# ── Step 8 — plugin descriptor (identifiers only, NO payload bytes) ──",
    'step "Recording plugin identifiers"',
    "PLUGINS_JSON=null",
    '_km="$CONFIG_ROOT/plugins/known_marketplaces.json"',
    '_ip="$CONFIG_ROOT/plugins/installed_plugins.json"',
    'if [ -f "$_km" ] || [ -f "$_ip" ]; then',
    '  _kmc=\'{}\'; [ -f "$_km" ] && _kmc="$(cat "$_km")"',
    '  _ipc=\'{}\'; [ -f "$_ip" ] && _ipc="$(cat "$_ip")"',
    '  _desc="$(jq -cn --argjson km "$_kmc" --argjson ip "$_ipc" \'' +
      pluginExtractionJq() +
      "' 2>/dev/null || echo 'null')\"",
    ...premiumFilterShellLines(),
    "  # Include the plugins member only when it carries at least one entry.",
    '  if [ -n "$_desc" ] && [ "$_desc" != "null" ] \\',
    '     && [ "$(printf \'%s\' "$_desc" | jq -r \'((.marketplaces | length) + (.plugins | length))\')" != "0" ]; then',
    '    PLUGINS_JSON="$_desc"',
    "  fi",
    "fi",
    "",
    "# ── Step 9 & 10 — assemble manifest.json (NO secrets member; definitions-only marker) ──",
    'step "Assembling manifest"',
    'SOURCE_MACHINE="$(hostname 2>/dev/null || true)"',
    "# Collapse the omissions JSONL into an array, then ALWAYS append the",
    "# definitions-only secrets marker (Task 1) — the exact entry the import",
    "# tolerance (Task 2b) matches to accept a no-secrets.age archive.",
    "OMISSIONS_JSON=\"$(jq -cs '.' \"$OMISSIONS\" 2>/dev/null || echo '[]')\"",
    '[ -n "$OMISSIONS_JSON" ] || OMISSIONS_JSON="[]"',
    "OMISSIONS_JSON=\"$(printf '%s' \"$OMISSIONS_JSON\" | jq -c --arg s '" +
      DEFINITIONS_ONLY_SECRETS_OMISSION.surface +
      "' --arg r '" +
      DEFINITIONS_ONLY_SECRETS_OMISSION.reason +
      "' '. + [{surface: $s, reason: $r}]')\"",
    "jq -n \\",
    '  --arg schemaVersion "$SCHEMA_VERSION" \\',
    `  --arg generatedAt ${generatedAtExpr} \\`,
    '  --arg sourceMachine "$SOURCE_MACHINE" \\',
    ...DIMENSION_DIRS.map(
      dir =>
        `  --slurpfile ${DIMENSION_FIELD[dir]} "$WORK/${DIMENSION_FIELD[dir]}.json" \\`
    ),
    '  --argjson claudeMd "$CLAUDE_MD_JSON" \\',
    '  --argjson settings "$SETTINGS_JSON" \\',
    '  --argjson skippedSettingsKeys "$SKIPPED_JSON" \\',
    '  --argjson mcpServers "$MCP_JSON" \\',
    '  --argjson sources "$SOURCES_JSON" \\',
    '  --slurpfile hooks "$HOOKS_JSON" \\',
    '  --slurpfile hookSupport "$HOOKSUPPORT_JSON" \\',
    '  --argjson settingsScripts "$SETTINGS_SCRIPTS_JSON" \\',
    '  --argjson plugins "$PLUGINS_JSON" \\',
    '  --argjson omissions "$OMISSIONS_JSON" \\',
    '  --arg profile "$PROFILE" \\',
    '  --argjson memory "$MEMORY_JSON" \\',
    "  '{",
    "    schemaVersion: $schemaVersion,",
    "    generatedAt: $generatedAt,",
    '    generator: {name: "config-porter", version: $schemaVersion},',
    ...DIMENSION_DIRS.map(
      dir => `    ${DIMENSION_FIELD[dir]}: ($${DIMENSION_FIELD[dir]}[0] // []),`
    ),
    "    settings: $settings,",
    "    skippedSettingsKeys: $skippedSettingsKeys,",
    "    mcpServers: $mcpServers,",
    "    sources: $sources,",
    "    hooks: ($hooks[0] // []),",
    "    hookSupport: ($hookSupport[0] // []),",
    "    settingsScripts: $settingsScripts,",
    "    omissions: $omissions",
    "  }",
    '  + (if $sourceMachine != "" then {sourceMachine: $sourceMachine} else {} end)',
    "  + (if $claudeMd != null then {claudeMd: $claudeMd} else {} end)",
    "  + (if $plugins != null then {plugins: $plugins} else {} end)",
    // #4373: a `full` manifest stays byte-identical to before (no profile field).
    '  + (if $profile == "tenant" then {profile: $profile} else {} end)',
    "  + (if $memory != null then {memory: $memory} else {} end)' \\",
    '  > "$STAGING/manifest.json"',
    "",
    "# ── Step 10.5 — break hard links (the import refuses hardlink members too) ──",
    'step "Normalizing hard links"',
    "# tar stores a second name resolving to an already-archived inode as a hardlink",
    "# member (both when -h dereferences two names onto one target and when a source",
    "# tree carries its own hardlinks); any link member poisons the import, so",
    "# rewrite every multi-linked staged file as its own independent copy.",
    "# NUL-delimited and staging-only, as materialize_links: a split name must",
    "# never make the cp/mv below touch a file outside staging.",
    'find "$STAGING" -type f -links +1 -print0 > "$WORK/hardlinks.txt" 2>/dev/null || : > "$WORK/hardlinks.txt"',
    "while IFS= read -r -d '' _hf; do",
    '  case "$_hf" in "$STAGING"/*) ;; *) continue ;; esac',
    '  cp -p "$_hf" "$_hf.__unlink_tmp" && mv -f "$_hf.__unlink_tmp" "$_hf"',
    'done < "$WORK/hardlinks.txt"',
    "",
    "# ── Step 11 — build the archive, then write it to the stable export directory ──",
    'step "Compressing the archive and writing it to the export directory"',
    'cd "$STAGING"',
    "# Only tar the members that exist (a small config may omit whole dimensions).",
    "_members=''",
    `for _m in ${tarMembers}; do`,
    '  [ -e "$_m" ] && _members="$_members $_m"',
    "done",
    `tar -czf "config-port.${ARCHIVE_FORMAT}" $_members`,
    "",
    "# ── Step 11.5 — #4373 (R5): the hygiene gate ──",
    "# (no step call: the step count and progress bar are unchanged)",
    "# An archive copied off this machine cannot be recalled, so it is checked",
    "# before its path is printed or it is uploaded: no plugin payload, credential",
    "# file, transcript or credential-bearing name, no secret value shape in any",
    "# file, and no premium plugin in a tenant manifest. On a hit the archive is",
    "# deleted and the export stops, naming each rule and file.",
    ...archiveHygieneShellLines(),
    'mkdir -p "$WORK/hygiene"',
    "_grc=0",
    `porter_archive_hygiene "config-port.${ARCHIVE_FORMAT}" "$WORK/hygiene" > "$WORK/hygiene-hits.txt" || _grc=$?`,
    'if [ "$_grc" -ne 0 ]; then',
    `  rm -f "config-port.${ARCHIVE_FORMAT}"`,
    '  if [ "$_grc" -eq 2 ]; then',
    "    printf '\\nerror: the hygiene check could not read the archive, so it was deleted\\n' >&2",
    "    printf 'and nothing was written or uploaded.\\n' >&2",
    "  else",
    "    printf '\\nerror: the archive failed its hygiene check, so it was deleted and nothing\\n' >&2",
    "    printf 'was written or uploaded. Each line names the rule and the file:\\n' >&2",
    '    while IFS= read -r _gl; do printf \'  %s\\n\' "$_gl" >&2; done < "$WORK/hygiene-hits.txt"',
    "    printf 'Remove the secret (or the file) from your configuration, then run the export again.\\n' >&2",
    "  fi",
    "  exit 1",
    "fi",
    "",
    "printf '\\nDone. Upload THIS file to the destination instance:\\n' >&2",
    ...exportFragment.split("\n"),
    // #3446 (Sub A, R3): self-upload the finished archive to the token's
    // single-use upload leg. Emitted ONLY when uploadUrl is set (the one-liner
    // flow) — the legacy Download/Copy export passes no uploadUrl and its output
    // stays byte-identical (no upload step, TOTAL_STEPS=11). `$DEST`/`$FINAL` are
    // the fragment's own shell vars (still in scope; it is not a subshell).
    ...(uploadUrl
      ? [
          "",
          "# ── Step 12 — self-upload to the token's single-use upload leg (R3) ──",
          '# stderr-only: the fragment\'s `echo "$DEST/$FINAL"` stays the sole stdout',
          "# line. `</dev/null` keeps curl off the script's stdin; `-o /dev/null`",
          "# keeps the server's JSON response off stdout. `curl -f` fails non-zero on",
          "# an HTTP error, handled by the `if` (set -e safe); on failure we print the",
          "# manual Download/Upload fallback and exit non-zero.",
          `UPLOAD_URL=${bashSingleQuote(uploadUrl)}`,
          'step "Uploading the archive to the destination instance"',
          'if curl -fsS -o /dev/null -F "file=@$DEST/$FINAL" "$UPLOAD_URL" </dev/null >&2; then',
          "  printf 'Uploaded. Return to the page to review the plan.\\n' >&2",
          "else",
          "  printf 'Upload failed. Archive kept at %s\\n' \"$DEST/$FINAL\" >&2",
          "  printf 'Open %s and use the page'\\''s Download / Upload to finish.\\n' \"${UPLOAD_URL%%/p/*}\" >&2",
          "  exit 1",
          "fi",
        ]
      : []),
    ""
  );

  return lines.join("\n") + "\n";
}

/**
 * The secrets member names — re-exported so a test can assert the generated
 * script NEVER references them (the secrets-free invariant).
 */
export { SECRETS_MEMBER_PLAINTEXT, SECRETS_MEMBER_ENCRYPTED };
