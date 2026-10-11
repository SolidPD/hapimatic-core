// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Configuration Porter — the bash CLAUDE.md `@`-include packaging block, shared
 * by the bash exporter and the extraction prompt (issue #4164).
 *
 * #4154 put the include RULE (canonical in-tree `*.md`, not `CLAUDE.md`, regular
 * file, a symlink only when its final target is `.md`) into both script
 * exporters. The opt-in extraction prompt is the third export surface, and a
 * model may not follow a prose rule. So the prompt's Step 11 runs a block that
 * BUILDS the archive's `CLAUDE.md` and `claude-includes/` from the config root
 * (and, #4173, `settings-scripts/` from `$HOME/.claude`) with these same bash
 * lines — not a restated copy — in a temp directory,
 * leaving whatever the model staged untouched except `manifest.json` and
 * `config-port.tar.gz`, which it replaces. One source for the bash exporter
 * and the prompt; the PowerShell exporter shares the rule strings (`exportShared.ts`)
 * and is pinned to the bash result by the #3447 equivalence harness.
 *
 * NODE-FREE (R7): like every non-test module under `shared/src/porter`, this
 * file only builds strings.
 */
import {
  ARCHIVE_CREDENTIAL_OMISSION_REASON,
  CLAUDE_MD_INCLUDE_GREP,
  CLAUDE_MD_INCLUDE_NOT_FOUND_REASON_PREFIX,
  CLAUDE_MD_INCLUDE_NOT_FOUND_SURFACE,
  CLAUDE_MD_INCLUDE_SKIP_REASONS,
  CLAUDE_MD_INCLUDE_SURFACE_PREFIX,
  CLAUDE_MD_INCLUDE_WALK_FAILED_REASON,
  DEFINITIONS_ARCHIVE_MEMBERS,
  DIMENSION_DIRS,
  DIMENSION_FIELD,
} from "./exportShared";
import {
  credentialPathsFunctionLines,
  physicalPathFunctionLines,
} from "./credentialNamesShell";
import {
  PORTER_WALK_LINK_FUNCTION,
  porterWalkLinkLines,
} from "./linkWalkShell";
import { ARCHIVE_FORMAT, SECRETS_MEMBER_ENCRYPTED } from "./manifest";
import {
  SETTINGS_SCRIPTS_DIR,
  SETTINGS_SCRIPT_SURFACE_PREFIX,
} from "./settingsScripts";
import {
  SETTINGS_SCRIPT_CHECK_CARRIED,
  SETTINGS_SCRIPT_CHECK_SUMMARY_PREFIX,
  settingsScriptLoopLines,
} from "./settingsScriptShell";
import { PORTER_SCHEMA_VERSION } from "./version";

/**
 * The bash lines that copy CLAUDE.md to `$STAGING/CLAUDE.md`, package its
 * `@`-includes into `$STAGING/claude-includes/`, and set `$CLAUDE_MD_JSON`. The
 * caller runs them inside `if [ -f "$CONFIG_ROOT/CLAUDE.md" ]; then … fi` with
 * `CONFIG_ROOT`, `STAGING`, a `record_omission <surface> <reason>` function and
 * `porter_walk_link` (`./linkWalkShell`, defined once per script) in scope,
 * under `set -eu` (bash 3.2 safe), and with nothing already at
 * `$STAGING/CLAUDE.md` (a `cp` onto a staged symlink would write through it).
 * Extracted from `exportScript.ts` Step 3 (#4164); `buildExportScript` and the
 * Step 11 block embed these lines verbatim.
 *
 * #4188: an include is read from the directory of CLAUDE.md's final link
 * target, as Claude Code reads it, not from the config root. In a Hapimatic
 * account-config folder `CLAUDE.md` links to `~/.claude/CLAUDE.md`, whose
 * includes sit beside the target, so a config-root base packaged none of them.
 * The caller's `-f` guard already skips a CLAUDE.md whose chain is broken,
 * cyclic or longer than the kernel allows (40 links on Linux); when the walk
 * still refuses the chain (a
 * backslash in a link target), CLAUDE.md is packaged with ONE omission and no
 * include, because the base is unknown.
 *
 * Every `dirname` operand takes `--` (#4189). The include-line pattern admits a
 * leading `-` (the `$_inc` operand): GNU `dirname` read `-x/y.md` as an option
 * and printed nothing, so the `cp` into the missing `-x/` failed and `set -e`
 * ended the whole export with no archive. The walk's own `readlink`/`dirname`
 * operands take `--` too (`./linkWalkShell`).
 */
export function claudeMdIncludeLoopLines(): string[] {
  return [
    '  cp -p "$CONFIG_ROOT/CLAUDE.md" "$STAGING/CLAUDE.md"',
    "  _includes='[]'",
    '  mkdir -p "$STAGING/claude-includes"',
    "  # #4188: includes resolve from the directory of CLAUDE.md's final link",
    "  # target, as Claude Code resolves them. A chain the walk refuses (past the",
    "  # caller's -f guard, a backslash in a link target) packages no include.",
    `  ${PORTER_WALK_LINK_FUNCTION} "$CONFIG_ROOT/CLAUDE.md"`,
    '  _mdbase="$_wl_dir"',
    "  _mdincs=''",
    '  if [ "$_wl_status" -eq 0 ]; then',
    `    _mdincs="$(${CLAUDE_MD_INCLUDE_GREP} "$CONFIG_ROOT/CLAUDE.md" 2>/dev/null | awk '!seen[$0]++' || true)"`,
    "  else",
    `    record_omission "${CLAUDE_MD_INCLUDE_NOT_FOUND_SURFACE}" '${CLAUDE_MD_INCLUDE_WALK_FAILED_REASON}'`,
    "  fi",
    "  # @-include lines look like `@RULES.md` or `@dir/file.md` at line start.",
    "  # #4154: package an include ONLY when it is a canonical in-tree *.md path that",
    "  # is not CLAUDE.md; a symlinked include only when its final target is a .md",
    "  # file. Anything else is an omission and its bytes are never read or copied.",
    "  while IFS= read -r _line; do",
    '    _inc="${_line#@}"',
    '    [ -n "$_inc" ] || continue',
    `    _isurf="${CLAUDE_MD_INCLUDE_SURFACE_PREFIX}$_inc"`,
    '    case "/$_inc/" in',
    `      *//*|*/./*|*/../*) record_omission "$_isurf" '${CLAUDE_MD_INCLUDE_SKIP_REASONS.notCanonical}'; continue ;;`,
    "    esac",
    '    _ibase="${_inc##*/}"',
    '    case "$_ibase" in',
    "      *.[mM][dD]) ;;",
    `      *) record_omission "$_isurf" '${CLAUDE_MD_INCLUDE_SKIP_REASONS.notMarkdown}'; continue ;;`,
    "    esac",
    '    case "$_ibase" in',
    `      [cC][lL][aA][uU][dD][eE].[mM][dD]) record_omission "$_isurf" '${CLAUDE_MD_INCLUDE_SKIP_REASONS.shadowsClaudeMd}'; continue ;;`,
    "    esac",
    "    # Resolve a symlink chain by hand with the shared walk (`./linkWalkShell`),",
    "    # and copy its results into this loop's own names. A backslash in a link",
    "    # target is a literal filename character, never a separator, so that",
    "    # target is not a .md name (PowerShell agrees).",
    '    _isrc="$_mdbase/$_inc"',
    `    ${PORTER_WALK_LINK_FUNCTION} "$_isrc"`,
    '    _isrc="$_wl_path"',
    '    _ihops="$_wl_hops"',
    '    _iwalk="$_wl_status"',
    '    if [ "$_iwalk" -eq 2 ]; then',
    `      record_omission "$_isurf" '${CLAUDE_MD_INCLUDE_SKIP_REASONS.linkTargetNotMarkdown}'`,
    "      continue",
    "    fi",
    "    # Fail CLOSED on a link still unresolved after 40 hops (a cycle or an",
    "    # over-long chain) or with an unusable target, before any test follows it.",
    '    if [ "$_iwalk" -eq 1 ] || [ -L "$_isrc" ]; then',
    `      record_omission "$_isurf" '${CLAUDE_MD_INCLUDE_SKIP_REASONS.notRegularFile}'`,
    "      continue",
    "    fi",
    '    if [ ! -e "$_isrc" ]; then',
    `      record_omission "${CLAUDE_MD_INCLUDE_NOT_FOUND_SURFACE}" "${CLAUDE_MD_INCLUDE_NOT_FOUND_REASON_PREFIX}$_inc"`,
    "      continue",
    "    fi",
    '    if [ ! -f "$_isrc" ]; then',
    `      record_omission "$_isurf" '${CLAUDE_MD_INCLUDE_SKIP_REASONS.notRegularFile}'`,
    "      continue",
    "    fi",
    '    if [ "$_ihops" -gt 0 ]; then',
    '      case "${_isrc##*/}" in',
    "        *.[mM][dD]) ;;",
    `        *) record_omission "$_isurf" '${CLAUDE_MD_INCLUDE_SKIP_REASONS.linkTargetNotMarkdown}'; continue ;;`,
    "      esac",
    "    fi",
    '    mkdir -p "$STAGING/claude-includes/$(dirname -- "$_inc")"',
    '    cp -p "$_isrc" "$STAGING/claude-includes/$_inc"',
    '    _includes="$(printf \'%s\' "$_includes" | jq -c --arg p "claude-includes/$_inc" \'. + [$p]\')"',
    "  done <<INCLUDES_EOF",
    "$_mdincs",
    "INCLUDES_EOF",
    '  CLAUDE_MD_JSON="$(jq -cn --argjson inc "$_includes" \'{path: "CLAUDE.md", includes: $inc}\')"',
  ];
}

/**
 * The TOP-LEVEL names the extraction prompt may tar, in order: the bash
 * exporter's list ({@link DEFINITIONS_ARCHIVE_MEMBERS}) plus the encrypted
 * secrets member, which only the prompt path carries. No other top-level name
 * in the staging directory (a stray `settings.json`, a plaintext secrets file)
 * is archived. `CLAUDE.md` and `claude-includes` are built from the config
 * root, never taken from the staging directory; every other listed folder
 * carries whatever was staged under it.
 */
export const PROMPT_ARCHIVE_MEMBERS: readonly string[] = [
  ...DEFINITIONS_ARCHIVE_MEMBERS,
  SECRETS_MEMBER_ENCRYPTED,
];

/**
 * The prefix of every line the check block prints: its one-line success
 * summary (the prompt has the model relay it) and each refusal message.
 */
export const INCLUDE_CHECK_SUMMARY_PREFIX = "CLAUDE.md include check:";

/**
 * #4164: the words after the count in the success summary. Only the summary
 * has them (a refusal line shares just the prefix), so the prompt tells the
 * model to look for `<prefix> <n> <these words>`. One constant for the block's
 * `echo` and the prompt, so the two cannot drift apart.
 */
export const INCLUDE_CHECK_PACKAGED = "include(s) packaged,";

/**
 * #4172: the words after the third count in the success summary: how many
 * credential-bearing paths the block kept out of the archive (each is also a
 * `manifest.json` omission). One constant for the block's `echo` and the prompt.
 */
export const INCLUDE_CHECK_CREDENTIALS_REMOVED =
  "credential-bearing path(s) removed";

/**
 * #4172: the staged folders the block's credential prune covers — the section
 * folders and `hooks`, as in the bash exporter — and the manifest fields whose
 * entries can name a pruned path (each section field and `hookSupport`).
 */
const CREDENTIAL_DIRS: readonly string[] = [...DIMENSION_DIRS, "hooks"];
const CREDENTIAL_ENTRY_FIELDS: readonly string[] = [
  ...DIMENSION_DIRS.map(dir => DIMENSION_FIELD[dir]),
  "hookSupport",
];

/**
 * #4164: the last line of the check script. The wrapper runs the script only
 * when the write succeeded AND this is its last line, so a truncated write
 * (e.g. a full temp directory) never runs any part of it.
 */
export const INCLUDE_CHECK_END_LINE = "# end of the #4164 include check";

/**
 * #4164: the empty file the extraction prompt has the model create in its
 * staging directory. The Step 11 block refuses to run where it is missing, so
 * it will not write `manifest.json` or `config-port.tar.gz` in a directory that
 * lacks the marker (e.g. a project the model's shell drifted into).
 */
export const PORTER_STAGING_MARKER = ".hapi-porter-staging";

/**
 * #4164: the extraction prompt's Step 11 block.
 *
 * The contract (#4164 round 6, PM ruling): the block never moves, renames,
 * rewrites or deletes anything in the staging directory except its own two
 * outputs, `manifest.json` and `config-port.tar.gz`, and it replaces those by
 * a rename inside the staging directory, so a symlink or hard link at either
 * name is replaced, never written through. It builds `CLAUDE.md` and
 * `claude-includes/` in a temp directory from the config root with
 * {@link claudeMdIncludeLoopLines} (the bash exporter's own code, so a refused
 * include's bytes are never copied; #4188: each include is read from the
 * directory of CLAUDE.md's final link target) and archives them from there. A
 * `CLAUDE.md` or `claude-includes` the model staged stays where it is and is
 * not archived, so no file the config root uses can be lost through it,
 * however the two are linked or named.
 *
 * It refuses, changing nothing, unless it can read the working directory's
 * physical path (`pwd -P`), the working directory holds
 * {@link PORTER_STAGING_MARKER}, the config root is an absolute path, and the
 * working directory is not the config root (by physical path or by identity,
 * `-ef`, so `//path` matches). It then removes any earlier `config-port.tar.gz`
 * (a failed run must not leave one behind), refusing — and saying the earlier
 * archive is still there — when it cannot. It refuses unless `jq`, `find`,
 * `sed`, `sort` and `cmp` are installed and `manifest.json` is a single JSON
 * object whose `schemaVersion` equals the `schemaVersion` argument; those
 * refusals say that an earlier archive was removed.
 *
 * Past those checks it (1) builds `CLAUDE.md` and `claude-includes/` in a temp
 * directory and (#4172) lists, reading only, every file or folder staged under
 * a section folder or `hooks` whose name is credential-bearing (the bash
 * exporter's own lines, {@link credentialPathsFunctionLines}), (2) rewrites
 * `manifest.json`'s `claudeMd` (dropped when the config root has no CLAUDE.md,
 * as the exporter does), replaces its include omissions (surfaces starting
 * `CLAUDE.md include @`, or `claudeMd.include`) with the rebuilt set, adds one
 * omission per listed credential path (one already staged, identical, is not
 * repeated) and drops any section or `hookSupport` entry at or under a listed
 * path, writing a temp file here and renaming it over `manifest.json`, (3)
 * assembles one tree in the temp directory from the
 * {@link PROMPT_ARCHIVE_MEMBERS} that exist — `CLAUDE.md`, `claude-includes`
 * and (#4173) `settings-scripts` copied from the build, every other name
 * copied from the staging directory with a single-directory tar pipe (links
 * as links, rwx permission bits kept; setuid, setgid and sticky can be dropped) — removes
 * the listed credential paths from that tree (never from the staging
 * directory), refuses when a credential-bearing name is still in it, and tars
 * that tree from its one directory into a temp file here, so a tar that
 * honours only its last `-C` (BusyBox) builds the same archive, (4) reads the
 * archive back and renames it to `config-port.tar.gz` only when every step of
 * that check succeeds: the listing is not empty, printed no warning, and names
 * nothing twice and nothing non-canonical (a leading `/` or `./`, a `//`, or a
 * `.` or `..` segment); the archive's `manifest.json` is byte for byte the one
 * this block wrote; and its `CLAUDE.md`, `claude-includes` and
 * `settings-scripts`, extracted alone, are exactly the build's (as many
 * entries, the same names, only
 * regular files and directories, the same bytes). Those are all the members
 * the importer reads to decide what it installs as `CLAUDE.md` or an include
 * (`manifest.json`'s `claudeMd.path` and `claudeMd.includes` name the other
 * two), so the guarantee holds against a tar that misplaces, adds, duplicates
 * or rewrites any of them, as that tar lists and extracts the archive. The
 * scope is exactly that: the importer parses the archive with its OWN tar
 * parser, which is not byte-exact and can name a member differently from the
 * local tar (a global pax `path`, a GNU-format header's ustar prefix bytes, a
 * pax `size` record, a char-vs-byte pax length, and other header forms) — a
 * tar that writes such a header can pass this check yet be read differently on
 * import. Closing that class is the importer's job (#4285), not this block's.
 * Every other listed folder carries what was staged, unchecked. `TAR_*` and
 * `GZIP` are cleared first. (5) prints
 * one summary line for the includes and one for the settings scripts. Any
 * failure after the archive clear exits non-zero with no
 * `config-port.tar.gz` present, including a summary line that cannot be
 * printed (SIGPIPE is ignored, so a closed pipe fails the `echo` rather than
 * killing the run first). The exit cleanup removes its temp directory and temp
 * files, reports a temp directory it could not remove, and exits with the
 * run's own status. It never prints an include's contents; a `jq` error on a
 * malformed `manifest.json` can echo a short fragment of it.
 *
 * The wrapper writes the script to a temp file with `>|` (so a `noclobber`
 * shell cannot refuse the write) and runs it with bash (the exporter's dialect,
 * bash 3.2 safe), so the model's own shell may be zsh or bash. It runs the
 * script only when the write succeeded AND the file ends with
 * {@link INCLUDE_CHECK_END_LINE}, so a failed or truncated write runs none of
 * it; that path exits non-zero and, in a marked directory, removes an earlier
 * `config-port.tar.gz`, as it does when bash cannot be run (exit 126 or 127).
 * `mktemp` and `cat` run in conditions, `bash` runs as an `if` condition, and
 * each archive clear ends in `|| :`, so a `set -e` shell still reaches the
 * removal of the temp script; the final status test sets the exit status.
 */
export function buildIncludeCheckShellFragment(
  schemaVersion: string = PORTER_SCHEMA_VERSION
): string {
  const loop = claudeMdIncludeLoopLines();
  const archive = `config-port.${ARCHIVE_FORMAT}`;
  const cleared = `any earlier ${archive} here was removed`;
  return [
    `CHECK="$(mktemp)" || CHECK=''`,
    `if [ -n "$CHECK" ] && cat >| "$CHECK" <<'INCLUDE_CHECK_EOF'`,
    "set -eu",
    "# A closed stdout makes the summary echo fail (EPIPE), which removes the",
    "# archive, instead of killing the run with SIGPIPE before it can.",
    "trap '' PIPE",
    "# #4172: read every name as bytes: under a UTF-8 locale bash's read takes a",
    "# trailing byte that is not UTF-8 as the start of a character and swallows",
    "# the newline after it, so a listed credential path would be lost.",
    "export LC_ALL=C",
    "# GNU tar reads TAR_OPTIONS from the environment (bsdtar TAR_READER_OPTIONS",
    "# and TAR_WRITER_OPTIONS); clear every TAR_* variable, so the operator's shell",
    "# cannot change what the tars below write or list (and so an honest run is",
    "# never refused because of it). GZIP is the same hazard one layer down: gzip",
    "# reads it and, when set, warns 'GZIP environment variable is deprecated' to",
    "# stderr on every decompression (including the listing read below), which the",
    "# listing check would otherwise read as tar's own output — clear it too.",
    'for _v in "${!TAR_@}"; do unset "$_v"; done',
    "unset GZIP",
    'CONFIG_ROOT="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"',
    "# This directory's physical path, kept whole even when its name ends in a",
    "# newline (a bare $(pwd -P) would strip it, naming another directory). A",
    "# failed pwd -P prints no x, so HERE ends up empty and the run refuses.",
    `HERE="$(pwd -P && echo x)" || HERE=''`,
    `case "$HERE" in *?x) HERE="\${HERE%x}"; HERE="\${HERE%?}" ;; *) HERE='' ;; esac`,
    'case "$HERE" in',
    "  /*) ;;",
    `  *) echo "${INCLUDE_CHECK_SUMMARY_PREFIX} could not read this directory's physical path (pwd -P), so nothing was changed" >&2; exit 1 ;;`,
    "esac",
    "# This block never moves, renames, rewrites or deletes anything staged here",
    `# except its own outputs, manifest.json and ${archive}, and it replaces`,
    "# those by a rename in this directory, so a link at either name is replaced,",
    "# never written through. CLAUDE.md and claude-includes are built in a temp",
    "# directory from the config root and archived from there; a staged CLAUDE.md",
    "# or claude-includes stays where it is and is not archived.",
    `if [ ! -f ${PORTER_STAGING_MARKER} ]; then`,
    `  echo "${INCLUDE_CHECK_SUMMARY_PREFIX} no ${PORTER_STAGING_MARKER} here, so nothing was changed; cd into the staging directory in the same command that runs this block" >&2`,
    "  exit 1",
    "fi",
    "# A relative config root would resolve against this directory. (A missing",
    "# config root is not refused: the exporter exports without one, and so does",
    "# this block.)",
    'case "$CONFIG_ROOT" in',
    "  /*) ;;",
    `  *) echo "${INCLUDE_CHECK_SUMMARY_PREFIX} the config root ($CONFIG_ROOT: CLAUDE_CONFIG_DIR, or \\$HOME/.claude when that is unset) is not an absolute path, so nothing was changed; set CLAUDE_CONFIG_DIR to its absolute path" >&2; exit 1 ;;`,
    "esac",
    "# Compared by path AND by identity (-ef), so another spelling of the same",
    "# directory (a leading //, a case variant on a case-insensitive disk) matches.",
    'if [ "$HERE" = "$(cd -P "$CONFIG_ROOT" 2>/dev/null && pwd -P)" ] || [ . -ef "$CONFIG_ROOT" ]; then',
    `  echo "${INCLUDE_CHECK_SUMMARY_PREFIX} this is the config root, not the staging directory, so nothing was changed" >&2`,
    "  exit 1",
    "fi",
    "# An archive from an earlier run must not outlive a failed one, so a run",
    "# that cannot remove it stops here.",
    `rm -f ${archive} || :`,
    `if [ -e ${archive} ] || [ -L ${archive} ]; then`,
    `  echo "${INCLUDE_CHECK_SUMMARY_PREFIX} could not remove the earlier ${archive} here, so it is still there and nothing else was changed; delete it and run this block again" >&2`,
    "  exit 1",
    "fi",
    "if ! command -v jq >/dev/null 2>&1; then",
    `  echo "${INCLUDE_CHECK_SUMMARY_PREFIX} jq is not installed (${cleared}); install jq and run this block again" >&2`,
    "  exit 1",
    "fi",
    "# The archive check below needs find, sed, sort, cmp and grep; a missing one",
    "# refuses here, before manifest.json is rewritten. grep is on this list because",
    "# the name-strip rule below runs grep to catch tar's warning; proving grep present",
    "# here refuses an absent grep with a clean message before the rewrite. (The rule",
    "# also refuses on grep's own exit 2+/127 at run time, but this is the clean signal.)",
    "for _t in find sed sort cmp grep; do",
    '  if ! command -v "$_t" >/dev/null 2>&1; then',
    `    echo "${INCLUDE_CHECK_SUMMARY_PREFIX} $_t is not installed and the archive check needs it (${cleared}); install $_t and run this block again" >&2`,
    "    exit 1",
    "  fi",
    "done",
    `if ! jq -e -s --arg v '${schemaVersion}' 'length == 1 and (.[0] | type == "object" and .schemaVersion == $v)' manifest.json >/dev/null 2>&1; then`,
    `  echo "${INCLUDE_CHECK_SUMMARY_PREFIX} manifest.json here is not a single JSON object with schemaVersion ${schemaVersion} (checked with jq; ${cleared})" >&2`,
    "  exit 1",
    "fi",
    'WORK="$(mktemp -d)"',
    "TMP_MANIFEST=''",
    "TMP_ARCHIVE=''",
    "# Remove the temp directory and any temp file of ours left here, then exit",
    "# with the status the run already had, so nothing in here can change it. A",
    "# temp directory that cannot be removed is reported. Every file under WORK",
    "# was created by this block (no hard link reaches outside it), and chmod -R",
    "# does not follow a symbolic link it meets, so it changes only those files.",
    "cleanup() {",
    "  _st=$?",
    "  set +e",
    '  if [ -n "$TMP_MANIFEST" ]; then rm -f "$TMP_MANIFEST" 2>/dev/null || :; fi',
    '  if [ -n "$TMP_ARCHIVE" ]; then rm -f "$TMP_ARCHIVE" 2>/dev/null || :; fi',
    '  chmod -R u+w "$WORK" 2>/dev/null',
    `  rm -rf "$WORK" 2>/dev/null || echo "${INCLUDE_CHECK_SUMMARY_PREFIX} could not remove the temp directory $WORK; delete it" >&2`,
    '  exit "$_st"',
    "}",
    "trap cleanup EXIT",
    'OMISSIONS="$WORK/omissions.jsonl"; : > "$OMISSIONS"',
    "record_omission() {",
    '  jq -cn --arg s "$1" --arg r "$2" \'{surface: $s, reason: $r}\' >> "$OMISSIONS"',
    "}",
    ...credentialPathsFunctionLines(),
    ...physicalPathFunctionLines(),
    "# #4188: the one link walk, which the include and settings-script lines call.",
    ...porterWalkLinkLines(),
    "# Build CLAUDE.md and claude-includes with the bash exporter's own lines. They",
    "# write to $STAGING, which here is a new, empty build directory in WORK, never",
    "# this directory.",
    'BUILD="$WORK/build"',
    'mkdir "$BUILD"',
    "CLAUDE_MD_JSON=null",
    'if [ -f "$CONFIG_ROOT/CLAUDE.md" ]; then',
    '  STAGING="$BUILD"',
    ...loop,
    "fi",
    "# #4172: the credential-bearing names staged under the section folders and",
    "# hooks (find only reads here). The manifest names each as an omission, and",
    "# the temp tree below leaves them out; nothing staged is removed.",
    'CREDENTIAL_PATHS="$WORK/credential-paths.txt"; : > "$CREDENTIAL_PATHS"',
    `for _d in ${CREDENTIAL_DIRS.join(" ")}; do list_credential_names "$HERE" "$_d" "$CREDENTIAL_PATHS"; done`,
    `jq -Rc --arg r '${ARCHIVE_CREDENTIAL_OMISSION_REASON}' 'select(length > 0) | {surface: ., reason: $r}' "$CREDENTIAL_PATHS" > "$WORK/credential-omissions.jsonl"`,
    "# #4173: the scripts the two executable settings run are built into the",
    "# build directory with the bash exporter's own lines, from $HOME/.claude and",
    "# the settings in manifest.json (normalized there, D3). A settings-scripts",
    "# folder staged here is never archived; its omissions are rebuilt below.",
    `SETTINGS_JSON="$(jq -c 'if (.settings | type) == "object" then .settings else {} end' manifest.json)"`,
    'STAGING="$BUILD"',
    'SSCRIPT_SECTIONS="$HERE"',
    ...settingsScriptLoopLines(),
    "# claudeMd and the include omissions (by surface) now match the build. The",
    "# credential omissions are added (one already staged, identical, is not",
    "# repeated), and a section or hookSupport entry at or under a listed path is",
    "# dropped, so the manifest names no member the archive leaves out. The",
    "# new manifest is written to a temp file here and renamed over manifest.json.",
    `TMP_MANIFEST="$(mktemp "$HERE/.hapi-porter-manifest.XXXXXX")"`,
    `jq --argjson cm "$CLAUDE_MD_JSON" --slurpfile om "$OMISSIONS" --slurpfile co "$WORK/credential-omissions.jsonl" --arg pre '${CLAUDE_MD_INCLUDE_SURFACE_PREFIX}' --arg nf '${CLAUDE_MD_INCLUDE_NOT_FOUND_SURFACE}' --argjson st "$SETTINGS_JSON" --argjson ss "$SETTINGS_SCRIPTS_JSON" --arg spre '${SETTINGS_SCRIPT_SURFACE_PREFIX}' '`,
    "  (if $cm == null then del(.claudeMd) else .claudeMd = $cm end)",
    "  | .settings = $st | .settingsScripts = $ss",
    "  | .omissions = ([(.omissions // [])[] | select(((.surface | tostring) | startswith($pre) | not) and (.surface != $nf)) | select(((.surface | tostring) | startswith($spre)) | not) | select(. as $o | any($co[]; . == $o) | not)] + $om + $co)",
    "  | ($co | map(.surface)) as $cut",
    `  | reduce (${CREDENTIAL_ENTRY_FIELDS.map(f => `"${f}"`).join(", ")}) as $f (.;`,
    '      if (.[$f] | type) == "array"',
    '      then .[$f] |= map(select((type == "object" and (.path | type) == "string" and (.path as $p | any($cut[]; . as $c | $p == $c or ($p | startswith($c + "/"))))) | not))',
    "      else . end)",
    `' manifest.json > "$TMP_MANIFEST"`,
    "# The read-back check compares the archive's manifest.json with this copy.",
    'cp "$TMP_MANIFEST" "$WORK/manifest.written"',
    'mv -f "$TMP_MANIFEST" manifest.json',
    "TMP_MANIFEST=''",
    `_packaged="$(printf '%s' "$CLAUDE_MD_JSON" | jq 'if . == null then 0 else (.includes | length) end')"`,
    "# The include summary counts only the include omissions (#4173).",
    `_omitted="$(jq -s --arg spre '${SETTINGS_SCRIPT_SURFACE_PREFIX}' 'map(select((.surface | startswith($spre)) | not)) | length' "$OMISSIONS")"`,
    `_ssomitted="$(jq -s --arg spre '${SETTINGS_SCRIPT_SURFACE_PREFIX}' 'map(select(.surface | startswith($spre))) | length' "$OMISSIONS")"`,
    `_sscarried_n="$(printf '%s' "$SETTINGS_SCRIPTS_JSON" | jq 'length')"`,
    `_removed="$(jq -s 'length' "$WORK/credential-omissions.jsonl")"`,
    "# Assemble the listed names that exist in one tree, so every tar below reads",
    "# or writes a single directory (a tar that honours only its last -C, such as",
    "# BusyBox, builds the same archive): CLAUDE.md and claude-includes from the",
    "# build, every other name copied from here, links as links. A staged",
    "# CLAUDE.md or claude-includes never enters the tree.",
    'TREE="$WORK/tree"',
    'mkdir "$TREE"',
    "_args=()",
    "_here=()",
    `for _m in ${PROMPT_ARCHIVE_MEMBERS.join(" ")}; do`,
    '  case "$_m" in',
    '    CLAUDE.md|claude-includes) if [ -e "$BUILD/$_m" ]; then cp -Rp "$BUILD/$_m" "$TREE/$_m"; _args[${#_args[@]}]="$_m"; fi ;;',
    `    ${SETTINGS_SCRIPTS_DIR}) if [ -e "$BUILD/$_m" ]; then cp -Rp "$BUILD/$_m" "$TREE/$_m"; _args[\${#_args[@]}]="$_m"; fi ;;`,
    '    *) if [ -e "$_m" ]; then _here[${#_here[@]}]="$_m"; _args[${#_args[@]}]="$_m"; fi ;;',
    "  esac",
    "done",
    "# umask 000 keeps the staged rwx permission bits (GNU tar applies the umask",
    "# for a non-root user, and BusyBox tar has no -p); setuid, setgid and sticky",
    "# can be dropped, and the importer keeps at most 0755 anyway. pipefail",
    "# fails the run on a failed read.",
    'if [ ${#_here[@]} -gt 0 ]; then (set -o pipefail; tar -cf - "${_here[@]}" | (cd "$TREE" && umask 000 && tar -xf -)); fi',
    "# #4172: take the listed credential-bearing paths out of the temp tree, then",
    "# confirm none is left; the tree copies what was listed, so one left over",
    "# means the copy differs from it, and the run refuses.",
    'remove_credential_paths "$TREE" "$CREDENTIAL_PATHS"',
    ': > "$WORK/credential-left.txt"',
    `for _d in ${CREDENTIAL_DIRS.join(" ")}; do list_credential_names "$TREE" "$_d" "$WORK/credential-left.txt"; done`,
    'if [ -s "$WORK/credential-left.txt" ]; then',
    `  echo "${INCLUDE_CHECK_SUMMARY_PREFIX} a credential-bearing name was still in the archive's temp copy after it was removed, so no ${archive} was written (manifest.json here was already rewritten; ${cleared})" >&2`,
    "  exit 1",
    "fi",
    "# Build into a temp file here and rename it into place, so a failed tar",
    "# leaves no archive.",
    `TMP_ARCHIVE="$(mktemp "$HERE/.hapi-porter-archive.XXXXXX")"`,
    '(cd "$TREE" && tar -czf "$TMP_ARCHIVE" ${_args[@]+"${_args[@]}"})',
    "# Read the archive back before publishing it. The importer reads three kinds of",
    "# member to decide what it installs as CLAUDE.md or an include: manifest.json",
    "# (its claudeMd.path and claudeMd.includes name the members), and the members",
    "# they name. So the check requires: every listed name is canonical (relative, no",
    "# // and no . or .. segment) and appears once (the importer reads a repeated",
    "# name's first copy, extraction keeps its last), and listing it drew no tar",
    "# member-name warning (BusyBox strips a leading / or ../ from what it lists,",
    "# and says 'removing leading ... from member names' — so a name the case rules",
    "# below can no longer see is still caught by that warning; other stderr noise,",
    "# such as a gzip/loader/locale message, does NOT refuse an honest run);",
    "# the archive's manifest.json is byte for byte the one this block wrote; and",
    "# its CLAUDE.md, claude-includes and settings-scripts are exactly the build's",
    "# (as many entries, the same names, only regular files and directories, the",
    "# same bytes). Every",
    "# step must succeed, or the check fails; lines are counted here in bash, so a",
    "# tool that fails or prints nothing cannot make two lists look equal. Every",
    "# other listed folder carries what was staged; the check does not compare it.",
    'CHK="$WORK/check"',
    'mkdir "$CHK"',
    "archive_matches_build() (",
    "  set -o pipefail",
    '  _list="$(tar -tzf "$TMP_ARCHIVE" 2>"$WORK/list.err")" || return 1',
    "  # Refuse ONLY on tar's own name-stripping warning (GNU 'Removing leading",
    "  # ...', BusyBox 'removing leading ...'), which is the one stderr line that",
    "  # hides a non-canonical name from the case rules below. Any other stderr",
    "  # (gzip's GZIP-deprecation notice, a loader or locale warning) is ignored, so",
    "  # it never refuses an honest run. Capture grep's status instead of testing it",
    "  # in an `if`: 0 = warning found, refuse; 1 = no match, the ONLY status that",
    "  # continues; anything else (grep errored, exit 2+ — or was absent, 127) could",
    "  # not check, so refuse. An `if grep` would read a grep error as 'no warning'",
    "  # and publish a stripped name — the round-8 lying-tools fail-open class.",
    `  LC_ALL=C grep -qi 'removing leading' "$WORK/list.err"; _g=$?; [ "$_g" -eq 1 ] || return 1`,
    "  _count=0",
    "  _mine=0",
    "  while IFS= read -r _n; do",
    '    [ -n "$_n" ] || continue',
    '    case "$_n" in',
    "      /*) return 1 ;;",
    "      ./*|.) return 1 ;;",
    "      *//*) return 1 ;;",
    "      */./*|*/.) return 1 ;;",
    "      ..|../*|*/../*|*/..) return 1 ;;",
    "    esac",
    "    _count=$((_count + 1))",
    '    _n="${_n%/}"',
    '    case "$_n" in CLAUDE.md|claude-includes|claude-includes/*) _mine=$((_mine + 1)) ;; esac',
    `    case "$_n" in ${SETTINGS_SCRIPTS_DIR}|${SETTINGS_SCRIPTS_DIR}/*) _mine=$((_mine + 1)) ;; esac`,
    '  done <<< "$_list"',
    '  [ "$_count" -gt 0 ] || return 1',
    `  _sorted="$(printf '%s\\n' "$_list" | sed -e 's#/$##' | LC_ALL=C sort)" || return 1`,
    "  _seen=0",
    "  _prev=''",
    "  while IFS= read -r _n; do",
    '    [ -n "$_n" ] || continue',
    '    if [ "$_seen" -gt 0 ] && [ "$_n" = "$_prev" ]; then return 1; fi',
    '    _prev="$_n"',
    "    _seen=$((_seen + 1))",
    '  done <<< "$_sorted"',
    '  [ "$_seen" -eq "$_count" ] || return 1',
    "  # manifest.json names what the importer installs as CLAUDE.md and its",
    "  # includes, so it must be the one this block wrote, whether or not the config",
    "  # root has a CLAUDE.md.",
    '  (cd "$CHK" && tar -xzf "$TMP_ARCHIVE" manifest.json) || return 1',
    '  [ ! -L "$CHK/manifest.json" ] || return 1',
    '  cmp -s "$WORK/manifest.written" "$CHK/manifest.json" || return 1',
    "  _m=()",
    '  for _x in CLAUDE.md claude-includes; do if [ -e "$BUILD/$_x" ]; then _m[${#_m[@]}]="$_x"; fi; done',
    `  if [ -e "$BUILD/${SETTINGS_SCRIPTS_DIR}" ]; then _m[\${#_m[@]}]=${SETTINGS_SCRIPTS_DIR}; fi`,
    "  if [ ${#_m[@]} -eq 0 ]; then",
    '    [ "$_mine" -eq 0 ] || return 1',
    "    return 0",
    "  fi",
    '  _want="$(cd "$BUILD" && find "${_m[@]}" -print | LC_ALL=C sort)" || return 1',
    '  [ -n "$_want" ] || return 1',
    "  _wanted=0",
    '  while IFS= read -r _n; do if [ -n "$_n" ]; then _wanted=$((_wanted + 1)); fi; done <<< "$_want"',
    '  [ "$_mine" -eq "$_wanted" ] || return 1',
    '  (cd "$CHK" && tar -xzf "$TMP_ARCHIVE" "${_m[@]}") || return 1',
    '  _odd="$(cd "$CHK" && find "${_m[@]}" ! -type f ! -type d -print)" || return 1',
    '  [ -z "$_odd" ] || return 1',
    '  _got="$(cd "$CHK" && find "${_m[@]}" -print | LC_ALL=C sort)" || return 1',
    '  [ "$_got" = "$_want" ] || return 1',
    '  _files="$(cd "$BUILD" && find "${_m[@]}" -type f -print)" || return 1',
    "  _compared=0",
    "  while IFS= read -r _f; do",
    '    [ -n "$_f" ] || continue',
    '    cmp -s "$BUILD/$_f" "$CHK/$_f" || return 1',
    "    _compared=$((_compared + 1))",
    '  done <<< "$_files"',
    '  [ "$_compared" -gt 0 ] || return 1',
    ")",
    "if ! archive_matches_build; then",
    `  echo "${INCLUDE_CHECK_SUMMARY_PREFIX} could not confirm that the archive holds exactly the CLAUDE.md and claude-includes built from the config root, the settings-scripts built from \\$HOME/.claude and the manifest.json this block wrote, under canonical names, so no ${archive} was written (manifest.json here was already rewritten; ${cleared})" >&2`,
    "  exit 1",
    "fi",
    `mv -f "$TMP_ARCHIVE" ${archive}`,
    "TMP_ARCHIVE=''",
    'if [ "$CLAUDE_MD_JSON" = null ]; then',
    "  _src='the config root has no CLAUDE.md, so the archive has neither CLAUDE.md nor claude-includes'",
    "else",
    '  _src="the archive\'s CLAUDE.md and claude-includes were built from the config root"',
    "fi",
    "# A summary that cannot be printed is a failed run: leave no archive of its own.",
    `echo "${INCLUDE_CHECK_SUMMARY_PREFIX} $_packaged ${INCLUDE_CHECK_PACKAGED} $_omitted omitted (listed in manifest.json omissions); $_removed ${INCLUDE_CHECK_CREDENTIALS_REMOVED}; $_src; nothing staged here was changed except manifest.json and ${archive}." || { rm -f ${archive}; exit 1; }`,
    `echo "${SETTINGS_SCRIPT_CHECK_SUMMARY_PREFIX} $_sscarried_n ${SETTINGS_SCRIPT_CHECK_CARRIED} $_ssomitted omitted (listed in manifest.json omissions); the archive's ${SETTINGS_SCRIPTS_DIR} were built from \\$HOME/.claude" || { rm -f ${archive}; exit 1; }`,
    INCLUDE_CHECK_END_LINE,
    "INCLUDE_CHECK_EOF",
    "then _w=0; else _w=1; fi",
    "_last=''",
    'if [ "$_w" -eq 0 ]; then while IFS= read -r _l; do _last="$_l"; done < "$CHECK"; fi',
    `if [ "$_last" = "${INCLUDE_CHECK_END_LINE}" ]; then`,
    '  if bash "$CHECK"; then _rc=0; else _rc=$?; fi',
    "  # bash missing or not runnable (126/127): the script may not have cleared an earlier archive.",
    `  if [ "$_rc" -eq 126 ] || [ "$_rc" -eq 127 ]; then if [ -f ${PORTER_STAGING_MARKER} ]; then rm -f ${archive} || :; fi; fi`,
    "else",
    `  echo "${INCLUDE_CHECK_SUMMARY_PREFIX} could not write the check script\${CHECK:+ to $CHECK} in full, so none of it ran" >&2`,
    `  if [ -f ${PORTER_STAGING_MARKER} ]; then rm -f ${archive} || :; fi`,
    "  _rc=1",
    "fi",
    'if [ -n "$CHECK" ]; then rm -f "$CHECK"; fi',
    '[ "$_rc" -eq 0 ]',
  ].join("\n");
}
