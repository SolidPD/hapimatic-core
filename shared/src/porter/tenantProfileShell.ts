// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Configuration Porter — the bash lines of the `tenant` export profile (issue
 * #4373, R2), a sibling of `exportScript.ts` so that file grows only by its
 * call sites (the `settingsScriptShell.ts` precedent). The PowerShell twin is
 * `tenantProfilePowerShell.ts`; the #3447 equivalence harness pins the two.
 *
 * The lines run inside the bash exporter and rely on its helpers and state:
 * `record_omission`, `prune_credential_names`, `physical_path`,
 * `has_credential_part`, `$CONFIG_ROOT`, `$STAGING`, `$WORK`, `$_cnl` (a
 * newline) and, for the premium filter, `$_kmc` / `$_desc` from Step 8.
 *
 * NODE-FREE: string builders only.
 */
import {
  ARCHIVE_CREDENTIAL_OMISSION_REASON,
  ARCHIVE_LINK_UNCHECKED_OMISSION_REASON,
  bashSingleQuote,
} from "./exportShared";
import {
  MEMORY_ARCHIVE_DIR,
  MEMORY_LINK_OMISSION_REASON,
  MEMORY_PROJECT_LINK_OMISSION_REASON,
  PREMIUM_MARKETPLACE_NAMES,
  PREMIUM_MARKETPLACE_SOURCE_PATTERN,
  TENANT_PREMIUM_OMISSION,
  type PorterExportProfile,
} from "./tenantProfile";
import {
  VM_CLASS_ENV,
  VM_CLASS_MARKER_REL,
  VM_CLASS_OPERATOR,
  VM_TIER_ENV,
  VM_TIER_MARKER_REL,
} from "../vmClass";

/**
 * The profile lines: set `PROFILE` to the minted profile, then force `tenant`
 * on a hosted customer VM (K13: the tier marker is present and the class is
 * not operator). The destination minted the script and cannot know where it
 * runs, so the VM's own markers decide.
 */
export function profileDetectionShellLines(
  profile: PorterExportProfile
): string[] {
  return [
    "# ── #4373 — the export profile ──",
    "# The destination minted this script and cannot know it runs on a hosted",
    "# customer VM, so the VM's own markers decide (K13: the tier marker is present",
    "# and the class is not operator) and force the tenant profile.",
    "# Each value: its env override, else the marker file; case and spaces ignored.",
    `PROFILE='${profile}'`,
    `_vt="\${${VM_TIER_ENV}:-}"; if [ -z "$_vt" ] && [ -f "$HOME/${VM_TIER_MARKER_REL}" ]; then _vt="$(cat "$HOME/${VM_TIER_MARKER_REL}" 2>/dev/null || :)"; fi`,
    `_vc="\${${VM_CLASS_ENV}:-}"; if [ -z "$_vc" ] && [ -f "$HOME/${VM_CLASS_MARKER_REL}" ]; then _vc="$(cat "$HOME/${VM_CLASS_MARKER_REL}" 2>/dev/null || :)"; fi`,
    "_vt=\"$(printf '%s' \"$_vt\" | tr -d '[:space:]')\"",
    "_vc=\"$(printf '%s' \"$_vc\" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')\"",
    `if [ -n "$_vt" ] && [ "$_vc" != '${VM_CLASS_OPERATOR}' ]; then`,
    '  if [ "$PROFILE" != tenant ]; then',
    "    printf 'note: this is a hosted customer VM, so the export uses the tenant profile\\n' >&2",
    "    printf '      (your own skills, agents, hooks, settings and memory; no premium packs).\\n' >&2",
    "  fi",
    "  PROFILE=tenant",
    "fi",
  ];
}

/**
 * Step 4c: stage `projects/<key>/memory/**` under `memory/<key>/` (tenant
 * only), never the transcripts beside it, and set `MEMORY_JSON` (`null`, or
 * `{sourceHomeKey, entries}`). Runs after the last materialize pass, so memory
 * is copied as it is (tar without -h): a link in it is removed and recorded,
 * never followed. A linked `projects/` folder is checked once, as a linked
 * `hooks/` is; a linked project folder is never descended, and is recorded
 * with {@link MEMORY_PROJECT_LINK_OMISSION_REASON} so its memory is not lost
 * silently.
 * `excludeFlags` are the exporter's junk `--exclude` flags.
 */
export function memoryStagingShellLines(excludeFlags: string): string[] {
  const M = MEMORY_ARCHIVE_DIR;
  return [
    "# ── Step 4c — #4373: the tenant profile's auto-memory ──",
    "# (no step call: the step count and progress bar are unchanged)",
    "MEMORY_JSON=null",
    'if [ "$PROFILE" = tenant ] && [ -d "$CONFIG_ROOT/projects" ]; then',
    "  _mrefuse=''",
    '  if [ -L "$CONFIG_ROOT/projects" ]; then',
    '    _mrc=0; _mphys="$(physical_path "$CONFIG_ROOT/projects")" || _mrc=$?',
    '    if [ "$_mrc" -eq 3 ] || { [ -n "$_mphys" ] && has_credential_part "$_mphys"; }; then',
    `      _mrefuse='${ARCHIVE_CREDENTIAL_OMISSION_REASON}'`,
    '    elif [ -z "$_mphys" ]; then',
    `      _mrefuse='${ARCHIVE_LINK_UNCHECKED_OMISSION_REASON}'`,
    "    fi",
    "  fi",
    '  if [ -n "$_mrefuse" ]; then',
    `    record_omission ${M} "$_mrefuse"`,
    "  else",
    "    # Project folders in byte order (the PowerShell twin's order); a linked project",
    "    # folder is never followed, and is recorded so its memory is not lost silently.",
    '    find -H "$CONFIG_ROOT/projects" -mindepth 1 -maxdepth 1 -print0 2>/dev/null | LC_ALL=C sort -z > "$WORK/memory-dirs.txt" || : > "$WORK/memory-dirs.txt"',
    "    while IFS= read -r -d '' _pe; do",
    '      _mkey="${_pe##*/}"',
    '      case "$_mkey" in',
    "        ''|.|..) continue ;;",
    `        *"$_cnl"*) record_omission ${M} '${ARCHIVE_LINK_UNCHECKED_OMISSION_REASON}'; continue ;;`,
    "      esac",
    '      [ -d "$_pe" ] || continue',
    '      if [ -L "$_pe" ]; then',
    `        record_omission "${M}/$_mkey" '${MEMORY_PROJECT_LINK_OMISSION_REASON}'`,
    "        continue",
    "      fi",
    '      _md="$_pe/memory"',
    '      if [ -L "$_md" ]; then',
    `        record_omission "${M}/$_mkey" '${MEMORY_LINK_OMISSION_REASON}'`,
    "        continue",
    "      fi",
    '      [ -d "$_md" ] || continue',
    `      mkdir -p "$STAGING/${M}/$_mkey"`,
    `      ( cd "$_md" && tar -cf - ${excludeFlags} . ) \\`,
    `        | ( cd "$STAGING/${M}/$_mkey" && tar -xpf - )`,
    '    done < "$WORK/memory-dirs.txt"',
    `    if [ -d "$STAGING/${M}" ]; then`,
    "      # Links, in byte order so both exporters record them alike.",
    `      find "$STAGING/${M}" -type l -print0 2>/dev/null | LC_ALL=C sort -z > "$WORK/memory-links.txt" || : > "$WORK/memory-links.txt"`,
    "      while IFS= read -r -d '' _ml; do",
    `        case "$_ml" in "$STAGING"/${M}/*) ;; *) continue ;; esac`,
    '        _mrel="${_ml#"$STAGING"/}"',
    '        rm -f "$_ml"',
    `        case "$_mrel" in *"$_cnl"*) _mrel=${M} ;; esac`,
    `        record_omission "$_mrel" '${MEMORY_LINK_OMISSION_REASON}'`,
    '      done < "$WORK/memory-links.txt"',
    `      prune_credential_names ${M}`,
    "      # One entry per project folder that still holds a file; an empty one goes.",
    '      : > "$WORK/memory.jsonl"',
    `      for _mk in "$STAGING/${M}"/* "$STAGING/${M}"/.[!.]* "$STAGING/${M}"/..?*; do`,
    '        [ -d "$_mk" ] || continue',
    '        if [ -n "$(find "$_mk" -type f 2>/dev/null | head -n 1)" ]; then',
    `          jq -cn --arg k "\${_mk##*/}" '{projectKey: $k, path: ("${M}/" + $k)}' >> "$WORK/memory.jsonl"`,
    "        else",
    '          rm -rf "$_mk"',
    "        fi",
    "      done",
    '      if [ -s "$WORK/memory.jsonl" ]; then',
    "        _mhome=\"$(printf '%s' \"$HOME\" | LC_ALL=C sed 's/[^A-Za-z0-9]/-/g')\"",
    `        MEMORY_JSON="$(jq -cs --arg h "$_mhome" '{sourceHomeKey: $h, entries: sort_by(.projectKey)}' "$WORK/memory.jsonl")"`,
    "      else",
    `        rm -rf "$STAGING/${M}"`,
    "      fi",
    "    fi",
    "  fi",
    "fi",
  ];
}

/**
 * The jq program the tenant profile runs on the Step 8 descriptor: drops every
 * marketplace and plugin whose marketplace is the licensed premium one, by name
 * or by its source (the raw `known_marketplaces.json` is `$km`, so a premium
 * marketplace the descriptor already dropped for an invalid source still marks
 * its plugins premium). Emits `{d: <descriptor>, dropped: <count>}`. Args:
 * `$km`, `$n` (premium names, JSON array), `$s` (source pattern).
 */
export function premiumFilterJq(): string {
  return [
    'def premium_src: (. // "") | test($s; "i");',
    "([($km // {}) | to_entries[]",
    "  | select((.key as $k | $n | any(. == $k))",
    "      or (( .value.source.repo",
    '            // (if (.value.source | type) == "string" then .value.source else null end)',
    "            // .value.source.url ) | premium_src))",
    "  | .key] + $n) as $prem",
    "| (.marketplaces | map(select(((.name as $k | $prem | any(. == $k)) or (.source | premium_src)) | not))) as $mk",
    "| (.plugins | map(select(.marketplace as $k | $prem | any(. == $k) | not))) as $pl",
    "| {d: {marketplaces: $mk, plugins: $pl},",
    "   dropped: ((.marketplaces | length) - ($mk | length) + (.plugins | length) - ($pl | length))}",
  ].join("\n");
}

/**
 * Step 8 (tenant): drop premium marketplaces and plugins from `$_desc` and
 * record one omission. A filter that cannot run keeps nothing, rather than
 * ship a premium name.
 */
export function premiumFilterShellLines(): string[] {
  const om = TENANT_PREMIUM_OMISSION;
  return [
    "  # #4373: the tenant profile drops every premium marketplace and plugin (a",
    "  # licensed pack is installed through its entitlement channel, never by an",
    "  # import) and records one omission.",
    '  if [ "$PROFILE" = tenant ] && [ -n "$_desc" ] && [ "$_desc" != "null" ]; then',
    `    _pf="$(jq -c --argjson km "$_kmc" --argjson n ${bashSingleQuote(
      JSON.stringify(PREMIUM_MARKETPLACE_NAMES)
    )} --arg s ${bashSingleQuote(PREMIUM_MARKETPLACE_SOURCE_PATTERN)} \\`,
    `      ${bashSingleQuote(premiumFilterJq())} <<< "$_desc" 2>/dev/null || echo '')"`,
    '    if [ -z "$_pf" ]; then',
    "      _desc=null",
    `      record_omission '${om.surface}' '${om.reason}'`,
    "    else",
    "      _desc=\"$(printf '%s' \"$_pf\" | jq -c '.d')\"",
    "      if [ \"$(printf '%s' \"$_pf\" | jq -r '.dropped')\" != 0 ]; then",
    `        record_omission '${om.surface}' '${om.reason}'`,
    "      fi",
    "    fi",
    "  fi",
  ];
}
