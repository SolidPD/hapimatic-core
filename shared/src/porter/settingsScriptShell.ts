// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Configuration Porter — the bash settings-script lines, shared by the bash
 * exporter (Step 7b) and the extraction prompt's Step 11 block (issue #4173).
 *
 * The rule lives in `./settingsScripts`; this module renders it for bash and
 * jq. The PowerShell exporter renders the same constants for .NET
 * (`./settingsScriptPowerShell`), and the #3447 equivalence harness pins the
 * two manifests to each other.
 *
 * A reference is resolved against `$HOME/.claude`, the path the shell runs,
 * never against the exporter's config root: in a Hapimatic session terminal
 * `CLAUDE_CONFIG_DIR` is the account-config folder, where the script is not.
 * The symbolic-link walk is the one the include loop uses,
 * `porter_walk_link` from `./linkWalkShell` (#4188: before it, this module
 * carried its own copy). A chain with a credential-bearing part in a link's name, in a
 * link's target text, or in its physical path is refused with the #4172 reason,
 * by #4172's own `physical_path` / `has_credential_part` (PM ruling B1).
 *
 * NODE-FREE (R7): like every non-test module under `shared/src/porter`, this
 * file only builds strings.
 */
import {
  ARCHIVE_CREDENTIAL_NAMES,
  ARCHIVE_CREDENTIAL_PREFIXES,
  EXECUTABLE_SETTINGS_KEYS,
} from "./manifest";
import { PORTER_WALK_LINK_FUNCTION } from "./linkWalkShell";
import {
  SETTINGS_SCRIPTS_DIR,
  SETTINGS_SCRIPT_CREDENTIAL_PATTERN,
  SETTINGS_SCRIPT_NAME_PATTERN,
  SETTINGS_SCRIPT_OUTSIDE_START_PATTERN,
  SETTINGS_SCRIPT_REF_PATTERN,
  SETTINGS_SCRIPT_REF_START_PATTERN,
  SETTINGS_SCRIPT_SECTION_FOLDERS,
  SETTINGS_SCRIPT_SKIP_REASONS,
  SETTINGS_SCRIPT_SURFACE_PREFIX,
  SETTINGS_SCRIPT_WORD_SPLIT_PATTERN,
  settingsScriptCaseGlob,
} from "./settingsScripts";
/**
 * #4173: the prefix of the Step 11 block's second summary line (the prompt has
 * the model relay it), and the words after its first count. One constant for
 * the block's `echo` and the prompt, so the two cannot drift apart.
 */
export const SETTINGS_SCRIPT_CHECK_SUMMARY_PREFIX = "Settings script check:";
export const SETTINGS_SCRIPT_CHECK_CARRIED = "script(s) carried,";

/**
 * The jq program that classifies every reference the two executable values in
 * its input (the settings object) make: one compact `{key, ref, rel?,
 * verdict}` row per reference, in `./settingsScripts` `collectSettingsScriptRefs`
 * order. The patterns and lists arrive as `--arg`/`--argjson` values
 * ({@link settingsScriptClassifierArgs}), never in the program text, and the
 * text holds no single quote (the quote-strip class writes it as the jq escape
 * `\u0027`), so it embeds in a single-quoted bash literal.
 */
export function settingsScriptClassifierJq(): string {
  return [
    'def strip: sub("^[\\"\\u0027]"; "") | sub("[\\"\\u0027]$"; "");',
    'def cmd($k): if $k == "apiKeyHelper" then (if (.apiKeyHelper | type) == "string" then .apiKeyHelper else null end) else (if (.statusLine | type) == "object" and (.statusLine.command | type) == "string" then .statusLine.command else null end) end;',
    "def credname: ascii_downcase as $l | any($credNames[]; . == $l) or any($credPrefixes[]; . as $p | $l | startswith($p));",
    'def verdict: . as $r | if ("/" + $r + "/" | (contains("//") or contains("/./") or contains("/../"))) then "notCanonical" else ($r | split("/")) as $s | if ($s | length) >= 2 then (if any($sections[]; . == $s[0]) then "section" else "notTopLevel" end) elif ($r | credname) then "credentialName" elif ($r | test($namePat) | not) then "notScript" else "ok" end end;',
    `. as $settings | ${JSON.stringify(EXECUTABLE_SETTINGS_KEYS)}[] as $k | ($settings | cmd($k)) as $c | select($c != null)`,
    '| ( [ $c | match($refPat; "g") | {key: $k, ref: .string, rel: .captures[1].string} ] | unique_by(.ref)[] | . + {verdict: (.rel | verdict)} ),',
    '  ( [ $c | splits($split) | select(length > 0) | strip | select(test($outStart) and (test($refStart) | not) and (startswith("/dev/") | not)) ] | unique[] | {key: $k, ref: ., verdict: "outside"} )',
  ].join(" ");
}

/** A value for a single-quoted bash literal (no value here holds a `'`). */
function sq(value: string): string {
  if (value.includes("'")) {
    throw new Error(`settings-script shell: ${value} holds a single quote`);
  }
  return `'${value}'`;
}

/** The `--arg`/`--argjson` flags {@link settingsScriptClassifierJq} reads. */
export function settingsScriptClassifierArgs(): string {
  return [
    `--argjson sections ${sq(JSON.stringify(SETTINGS_SCRIPT_SECTION_FOLDERS))}`,
    `--argjson credNames ${sq(JSON.stringify(ARCHIVE_CREDENTIAL_NAMES))}`,
    `--argjson credPrefixes ${sq(JSON.stringify(ARCHIVE_CREDENTIAL_PREFIXES))}`,
    `--arg namePat ${sq(SETTINGS_SCRIPT_NAME_PATTERN)}`,
    `--arg refPat ${sq(SETTINGS_SCRIPT_REF_PATTERN)}`,
    `--arg refStart ${sq(SETTINGS_SCRIPT_REF_START_PATTERN)}`,
    `--arg outStart ${sq(SETTINGS_SCRIPT_OUTSIDE_START_PATTERN)}`,
    `--arg split ${sq(SETTINGS_SCRIPT_WORD_SPLIT_PATTERN)}`,
  ].join(" ");
}

/**
 * D3: the jq program that rewrites the literal `$home` prefix (the caller
 * passes `"$HOME/.claude/"`) to `$HOME/.claude/` in the two executable values,
 * with jq's literal `split`/`join` (no regex escaping of a home path, and no
 * bash `${var//}`, whose quoting differs between bash 3.2 and 5.2).
 */
export function settingsScriptNormalizeJq(): string {
  return [
    '(if (.apiKeyHelper | type) == "string" then .apiKeyHelper |= (split($home) | join("$HOME/.claude/")) else . end)',
    '| (if (.statusLine | type) == "object" and (.statusLine.command | type) == "string" then .statusLine.command |= (split($home) | join("$HOME/.claude/")) else . end)',
  ].join(" ");
}

/**
 * The bash lines that normalize the two executable values in `$SETTINGS_JSON`
 * (D3), carry each referenced top-level script into
 * `$STAGING/settings-scripts/`, record an omission for every other reference,
 * and set `$SETTINGS_SCRIPTS_JSON` (the manifest's `settingsScripts`).
 *
 * Caller contract, under `set -eu` (bash 3.2 safe) and `LC_ALL=C`:
 * - `HOME`, `STAGING`, `WORK` and `SETTINGS_JSON` (a compact JSON OBJECT) set;
 * - `SSCRIPT_SECTIONS` set to the folder where the section folders were staged
 *   (a reference into one is that section's to carry);
 * - `record_omission <surface> <reason>`, `physical_path` and
 *   `has_credential_part` (`./credentialNamesShell`) and `porter_walk_link`
 *   (`./linkWalkShell`, #4188) defined;
 * - nothing at `$STAGING/settings-scripts` yet.
 *
 * The folder is created only when the first script is carried, so an empty
 * one never exists. The lines never print a script's contents, and the
 * credential scan never prints its match (`grep -q`). A failing classifier
 * stops the run (`set -e`): its input is always the exporter's own JSON object.
 */
export function settingsScriptLoopLines(): string[] {
  const r = SETTINGS_SCRIPT_SKIP_REASONS;
  return [
    "# #4173: the top-level script an executable setting runs. A reference is",
    "# resolved against $HOME/.claude, the path the shell runs, never the config",
    "# root (a session terminal's CLAUDE_CONFIG_DIR is an account-config folder).",
    "SETTINGS_SCRIPTS_JSON='[]'",
    "_ssnl=$'\\n'",
    '_sscarried="$_ssnl"',
    "# D3: the literal <home>/.claude/ prefix becomes $HOME/.claude/ in the two values.",
    `SETTINGS_JSON="$(printf '%s' "$SETTINGS_JSON" | jq -c --arg home "$HOME/.claude/" '${settingsScriptNormalizeJq()}' 2>/dev/null || printf '%s' "$SETTINGS_JSON")"`,
    `printf '%s' "$SETTINGS_JSON" | jq -c ${settingsScriptClassifierArgs()} '${settingsScriptClassifierJq()}' > "$WORK/sscript-rows.jsonl"`,
    "while IFS= read -r _ssrow; do",
    '  [ -n "$_ssrow" ] || continue',
    '  _sskey="$(printf \'%s\' "$_ssrow" | jq -r .key)"',
    '  _ssref="$(printf \'%s\' "$_ssrow" | jq -r .ref)"',
    '  _ssrel="$(printf \'%s\' "$_ssrow" | jq -r \'.rel // ""\')"',
    '  _ssv="$(printf \'%s\' "$_ssrow" | jq -r .verdict)"',
    `  _sssurf="${SETTINGS_SCRIPT_SURFACE_PREFIX}$_sskey runs $_ssref"`,
    '  case "$_ssv" in',
    `    outside) record_omission "$_sssurf" '${r.outsideConfigRoot}'; continue ;;`,
    `    notCanonical) record_omission "$_sssurf" '${r.notCanonical}'; continue ;;`,
    `    notTopLevel) record_omission "$_sssurf" '${r.notTopLevel}'; continue ;;`,
    `    credentialName) record_omission "$_sssurf" '${r.credentialName}'; continue ;;`,
    `    notScript) record_omission "$_sssurf" '${r.notScript}'; continue ;;`,
    "    section)",
    "      # The section's own export carries it; report only when it did not.",
    `      if [ ! -f "$SSCRIPT_SECTIONS/$_ssrel" ]; then record_omission "$_sssurf" '${r.sectionNotStaged}'; fi`,
    "      continue ;;",
    "    ok) ;;",
    `    *) record_omission "$_sssurf" '${r.notCanonical}'; continue ;;`,
    "  esac",
    "  # Two keys naming one file carry it once; a failure is reported per key.",
    '  case "$_sscarried" in *"$_ssnl$_ssrel$_ssnl"*) continue ;; esac',
    "  # The shared #4154 symlink walk (`./linkWalkShell`, #4188), its results",
    "  # copied into this loop's own names. A backslash in a target is a filename",
    "  # character here, never a separator.",
    '  _sssrc="$HOME/.claude/$_ssrel"',
    `  ${PORTER_WALK_LINK_FUNCTION} "$_sssrc"`,
    '  _sssrc="$_wl_path"',
    '  _sshops="$_wl_hops"',
    '  _sswalk="$_wl_status"',
    '  if [ "$_sswalk" -eq 2 ]; then',
    `    record_omission "$_sssurf" '${r.linkTargetNotScript}'`,
    "    continue",
    "  fi",
    "  # PM ruling B1 (#4172's rule): a link chain with a credential-bearing part",
    "  # in a link's name or target text (3), or in its physical path, is refused;",
    "  # one whose walk reaches /proc (4) could not be checked.",
    "  _ssphys=''",
    '  if [ "$_sshops" -gt 0 ]; then',
    '    _ssprc=0; _ssphys="$(physical_path "$HOME/.claude/$_ssrel")" || _ssprc=$?',
    '    if [ "$_ssprc" -eq 3 ] || { [ -n "$_ssphys" ] && has_credential_part "$_ssphys"; }; then',
    `      record_omission "$_sssurf" '${r.linkThroughCredential}'`,
    "      continue",
    "    fi",
    '    if [ "$_ssprc" -eq 4 ]; then',
    `      record_omission "$_sssurf" '${r.linkUnchecked}'`,
    "      continue",
    "    fi",
    "  fi",
    "  # Fail CLOSED on a link still unresolved after 40 hops (a cycle or an",
    "  # over-long chain) or with an unusable target, before any test follows it.",
    '  if [ "$_sswalk" -eq 1 ] || [ -L "$_sssrc" ]; then',
    `    record_omission "$_sssurf" '${r.notRegularFile}'`,
    "    continue",
    "  fi",
    '  if [ ! -e "$_sssrc" ]; then',
    `    record_omission "$_sssurf" '${r.notFound}'`,
    "    continue",
    "  fi",
    '  if [ ! -f "$_sssrc" ]; then',
    `    record_omission "$_sssurf" '${r.notRegularFile}'`,
    "    continue",
    "  fi",
    '  if [ "$_sshops" -gt 0 ]; then',
    '    case "${_sssrc##*/}" in',
    `      ${settingsScriptCaseGlob()}) ;;`,
    `      *) record_omission "$_sssurf" '${r.linkTargetNotScript}'; continue ;;`,
    "    esac",
    "    # A linked script whose physical path could not be read is not carried.",
    '    if [ -z "$_ssphys" ]; then',
    `      record_omission "$_sssurf" '${r.linkUnchecked}'`,
    "      continue",
    "    fi",
    "  fi",
    "  # D2: a script that holds a known credential token is not carried (grep -q:",
    "  # the match is never printed). 0 = a match, 1 = none; anything else could",
    "  # not read the file, so it is not carried either.",
    `  _ssg=0; LC_ALL=C grep -aqE -- '${SETTINGS_SCRIPT_CREDENTIAL_PATTERN}' "$_sssrc" || _ssg=$?`,
    '  if [ "$_ssg" -eq 0 ]; then',
    `    record_omission "$_sssurf" '${r.looksLikeCredential}'`,
    "    continue",
    "  fi",
    '  if [ "$_ssg" -ne 1 ]; then',
    `    record_omission "$_sssurf" '${r.unreadable}'`,
    "    continue",
    "  fi",
    `  mkdir -p "$STAGING/${SETTINGS_SCRIPTS_DIR}"`,
    `  cp -p "$_sssrc" "$STAGING/${SETTINGS_SCRIPTS_DIR}/$_ssrel"`,
    '  _sscarried="$_sscarried$_ssrel$_ssnl"',
    `  SETTINGS_SCRIPTS_JSON="$(printf '%s' "$SETTINGS_SCRIPTS_JSON" | jq -c --arg p "${SETTINGS_SCRIPTS_DIR}/$_ssrel" '. + [{path: $p}]')"`,
    'done < "$WORK/sscript-rows.jsonl"',
  ];
}
