// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Configuration Porter — the bash lines of the Codex source (issue #5169), a
 * sibling of `exportScript.ts` so that file grows only by its call sites (the
 * `tenantProfileShell.ts` precedent). The dialect-neutral rules (the accepted
 * TOML subset, the omission reasons) live in `codexSource.ts`; the PowerShell
 * twin is `codexSourcePowerShell.ts`, and `exportEquivalence.test.ts` pins the
 * two.
 *
 * The lines run inside the bash exporter and rely on its helpers and state:
 * `record_omission`, `prune_credential_names`, `physical_path`,
 * `has_credential_part`, `$STAGING`, `$WORK`, `$HOME` and `$_cnl` (a newline).
 *
 * NODE-FREE: string builders only.
 */
import {
  ARCHIVE_CREDENTIAL_OMISSION_REASON,
  ARCHIVE_LINK_UNCHECKED_OMISSION_REASON,
  bashSingleQuote,
} from "./exportShared";
import {
  CODEX_AGENTS_SKILLS_DIR,
  CODEX_BEARER_HEADER,
  CODEX_CONFIG_SURFACE,
  CODEX_HOME_SURFACE,
  CODEX_HTTP_UNUSED_FIELDS,
  CODEX_INSTRUCTION_FILES,
  CODEX_INSTRUCTIONS_SURFACE,
  CODEX_INSTRUCTIONS_UNREADABLE_REASON,
  CODEX_LINK_OMISSION_REASON,
  CODEX_MCP_MAP_FIELDS,
  CODEX_MCP_STRING_FIELDS,
  CODEX_PROMPTS_OMISSION_REASON,
  CODEX_PROMPTS_SURFACE,
  CODEX_RULE_ARCHIVE_PATH,
  CODEX_RULE_NAME,
  CODEX_RULE_SHADOWED_REASON,
  CODEX_SERVER_DROPPED_PARTS,
  CODEX_SERVER_UNSUPPORTED_PARTS,
  CODEX_SKILL_SHADOWED_REASON,
  CODEX_SKILLS_SURFACE,
  CODEX_SKILLS_SURFACE_PREFIX,
  CODEX_SKILLS_UNREADABLE_REASON,
  CODEX_STDIO_UNUSED_FIELDS,
  CODEX_TOML_BARE_KEY_PATTERN,
  CODEX_TOML_BASIC_BODY_PATTERN,
  CODEX_TOML_LITERAL_BODY_PATTERN,
  CODEX_TOML_TOKEN_PATTERN,
  CODEX_TOML_UNREADABLE_REASON,
} from "./codexSource";

/** A jq string literal (jq's string syntax is JSON's for these values). */
function jqStr(s: string): string {
  return JSON.stringify(s);
}

/** A jq array literal of strings. */
function jqArr(items: readonly string[]): string {
  return "[" + items.map(jqStr).join(", ") + "]";
}

/**
 * Preflight: where Codex's home is, and whether it exists. `${CODEX_HOME:-}`
 * reads an empty `CODEX_HOME` as unset, as Codex does. The folder is checked
 * for a credential store (and resolved to one physical path) later, by
 * {@link codexStagingShellLines}, where the exporter's link helpers exist.
 */
export function codexDiscoveryShellLines(): string[] {
  return [
    "# #5169: Codex's home ($CODEX_HOME, else ~/.codex; an empty value is unset).",
    'CODEX_ROOT="${CODEX_HOME:-$HOME/.codex}"',
    'case "$CODEX_ROOT" in /*) ;; *) CODEX_ROOT="$PWD/$CODEX_ROOT" ;; esac',
    "CODEX_FOUND=false; CODEX_READ=false",
    'if [ -d "$CODEX_ROOT" ]; then CODEX_FOUND=true; fi',
  ];
}

/**
 * The jq program that reads a Codex `config.toml` (raw text, `jq -Rs`) through
 * the subset described in `codexSource.ts` and emits either
 * `{"unreadable": true}` or `{mcpServers, unsupported, dropped}`: `mcpServers`
 * shaped like a `~/.claude.json` `mcpServers` object (every env and header
 * value `""`, so the projection sees names only), `unsupported` the names of
 * the servers left out whole, and `dropped` `[{name, fields}]` for the fields
 * a kept server lost. Values of env and headers are never assigned.
 */
export function codexMcpReaderJq(): string {
  return [
    `def maps: ${jqArr(CODEX_MCP_MAP_FIELDS)};`,
    `def strf: ${jqArr(CODEX_MCP_STRING_FIELDS)};`,
    "def has_el($x): any(.[]; . == $x);",
    "def kind:",
    '  if . == "\\n" or . == "\\r\\n" then "NL"',
    '  elif test("^[ \\t]") then "WS"',
    '  elif startswith("#") then "COM"',
    '  elif startswith("\\"\\"\\"") then "MLB"',
    '  elif startswith("\'\'\'") then "MLL"',
    '  elif startswith("\\"") and length >= 2 then "BS"',
    '  elif startswith("\'") and length >= 2 then "LS"',
    '  elif length == 1 and (. as $c | "[]{}=,." | contains($c)) then "P"',
    `  elif test("^[A-Za-z0-9_+:-]+$") then "BARE"`,
    '  else "ERR" end;',
    `def bdec: .[1:-1] | if test(${jqStr(CODEX_TOML_BASIC_BODY_PATTERN)}) then ("\\"" + . + "\\"" | fromjson) else null end;`,
    `def ldec: .[1:-1] | if test(${jqStr(CODEX_TOML_LITERAL_BODY_PATTERN)}) then . else null end;`,
    'def sdec: if .k == "BS" then (.t | bdec) elif .k == "LS" then (.t | ldec) else null end;',
    `def kdec: if .k == "BARE" then (if (.t | test(${jqStr(CODEX_TOML_BARE_KEY_PATTERN)})) then .t else null end) else sdec end;`,
    "def sk($a): $a | tojson;",
    "def unsup($s): .U += [$s];",
    "def mark($a): .seen[sk($a)] = true;",
    "def seen($a): .seen[sk($a)] == true;",
    "def ensure($s): if .S[$s] == null then .S[$s] = {has: [], drop: [], keys: {env: [], http_headers: [], env_http_headers: []}} else . end;",
    "def skiptok($o):",
    '  if $o.t == "[" or $o.t == "{" then .d += 1',
    '  elif $o.t == "]" or $o.t == "}" then .d -= 1 | (if .d < 0 then .bad = true else . end)',
    '  elif $o.k == "NL" and .d == 0 then .m = "S"',
    "  else . end;",
    'def toskip($o): .m = "SKIP" | skiptok($o);',
    "def fail($o): unsup(.ts) | toskip($o);",
    'def keyfail($o): if .tk == "srv" or .tk == "map" then fail($o) else .bad = true end;',
    'def keypart($o): ($o | kdec) as $p | if $p != null then .kp += [$p] | .m = "KD" else keyfail($o) end;',
    'def hkeypart($o): ($o | kdec) as $p | if $p != null then .hp += [$p] | .m = "HD" else .bad = true end;',
    "def finish_header:",
    "  .hp as $p | ($p | length) as $n |",
    '  if $p[0] != "mcp_servers" then .tk = "other"',
    '  elif .ha then (if $n == 1 then .bad = true else unsup($p[1]) | .tk = "ign" end)',
    '  elif $n == 1 then .tk = "mcproot"',
    "  else ensure($p[1]) | .ts = $p[1] |",
    "    if $n == 2 then",
    '      (if seen(["h", $p[1]]) then unsup($p[1]) else . end) | mark(["h", $p[1]]) | .tk = "srv"',
    "    elif (maps | has_el($p[2])) then",
    '      if $n >= 4 then unsup($p[1]) | .tk = "ign"',
    "      else",
    '        (if seen(["t", $p[1], $p[2]]) or seen(["a", $p[1], $p[2]]) or seen(["d", $p[1], $p[2]]) then unsup($p[1]) else . end)',
    '        | mark(["t", $p[1], $p[2]]) | .S[$p[1]].has += [$p[2]] | .tk = "map" | .tf = $p[2]',
    "      end",
    '    else .S[$p[1]].drop += [$p[2]] | .tk = "ign"',
    "    end",
    "  end;",
    "def begin_value:",
    "  .kp as $k | ($k | length) as $n | $k[0] as $p0 |",
    '  if .tk == "root" then',
    '    if $p0 == "mcp_servers" then (if $n == 1 then .bad = true else unsup($k[1]) | .m = "SKIP" | .d = 0 end)',
    '    else .m = "SKIP" | .d = 0 end',
    '  elif .tk == "mcproot" then unsup($p0) | .m = "SKIP" | .d = 0',
    '  elif .tk == "srv" then .ts as $s |',
    "    if $n == 1 and (strf | has_el($p0)) then",
    '      (if seen(["k", $s, $p0]) then unsup($s) else . end) | mark(["k", $s, $p0]) | .vc = "str" | .tf = $p0 | .m = "V"',
    '    elif $n == 1 and ($p0 == "args" or $p0 == "enabled") then',
    '      (if seen(["k", $s, $p0]) then unsup($s) else . end) | mark(["k", $s, $p0])',
    '      | .vc = (if $p0 == "args" then "arr" else "bool" end) | .m = "V"',
    "    elif $n == 1 and (maps | has_el($p0)) then",
    '      (if seen(["t", $s, $p0]) or seen(["d", $s, $p0]) or seen(["a", $s, $p0]) then unsup($s) else . end)',
    '      | mark(["a", $s, $p0]) | .vc = "itab" | .tf = $p0 | .m = "V"',
    "    elif $n == 2 and (maps | has_el($p0)) then",
    '      (if seen(["t", $s, $p0]) or seen(["a", $s, $p0]) or seen(["k", $s, $p0, $k[1]]) then unsup($s) else . end)',
    '      | mark(["d", $s, $p0]) | mark(["k", $s, $p0, $k[1]]) | .vc = "mstr" | .tf = $p0 | .tk2 = $k[1] | .m = "V"',
    '    elif (maps | has_el($p0)) then unsup($s) | .m = "SKIP" | .d = 0',
    '    else .S[$s].drop += [$p0] | .m = "SKIP" | .d = 0',
    "    end",
    '  elif .tk == "map" then .ts as $s | .tf as $f |',
    "    if $n == 1 then",
    '      (if seen(["k", $s, $f, $p0]) then unsup($s) else . end) | mark(["k", $s, $f, $p0]) | .vc = "mstr" | .tk2 = $p0 | .m = "V"',
    '    else unsup($s) | .m = "SKIP" | .d = 0 end',
    '  else .m = "SKIP" | .d = 0 end;',
    "def assign_str($v): .ts as $s | .tf as $f |",
    '  (if $v == "" and ($f == "command" or $f == "url") then unsup($s)',
    '   elif $f == "command" then .S[$s].cmd = $v',
    '   elif $f == "url" then .S[$s].url = $v',
    "   else .S[$s].bearer = true end) | .S[$s].has += [$f];",
    "def addkey($key): .ts as $s | .tf as $f |",
    '  if $key == "" then unsup($s) else .S[$s].keys[$f] += [$key] | .S[$s].has += [$f] end;',
    'def assign_args: .ts as $s | .S[$s].args = .arr | .S[$s].has += ["args"];',
    "def assign_itab: .ts as $s | .tf as $f | .S[$s].has += [$f] |",
    '  if (.itk | has_el("")) or ((.itk | unique | length) != (.itk | length)) then unsup($s) else .S[$s].keys[$f] += .itk end;',
    "def value1($o):",
    '  if .vc == "str" then ($o | sdec) as $v | (if $v == null then fail($o) else assign_str($v) | .m = "VE" end)',
    '  elif .vc == "mstr" then (if $o.k == "BS" or $o.k == "LS" then addkey(.tk2) | .m = "VE" else fail($o) end)',
    '  elif .vc == "bool" then',
    '    (if $o.k == "BARE" and ($o.t == "true" or $o.t == "false")',
    '     then .ts as $s | .S[$s].en = ($o.t == "true") | .S[$s].has += ["enabled"] | .m = "VE"',
    "     else fail($o) end)",
    '  elif .vc == "arr" then (if $o.t == "[" then .d = 1 | .arr = [] | .ast = "e" | .m = "VA" else fail($o) end)',
    '  else (if $o.t == "{" then .d = 1 | .itk = [] | .ist = "k0" | .m = "VI" else fail($o) end) end;',
    "def varr($o):",
    '  if $o.k == "NL" then .',
    '  elif $o.t == "]" then .d = 0 | assign_args | .m = "VE"',
    '  elif .ast == "e" then',
    '    (if $o.k == "BS" or $o.k == "LS" then ($o | sdec) as $v | (if $v == null then fail($o) else .arr += [$v] | .ast = "c" end)',
    "     else fail($o) end)",
    '  elif $o.t == "," then .ast = "e"',
    "  else fail($o) end;",
    "def vitab($o):",
    '  if .ist == "k0" and $o.t == "}" then .d = 0 | assign_itab | .m = "VE"',
    '  elif .ist == "k0" or .ist == "k" then ($o | kdec) as $p | (if $p != null then .ikey = $p | .ist = "e" else fail($o) end)',
    '  elif .ist == "e" then (if $o.t == "=" then .ist = "v" else fail($o) end)',
    '  elif .ist == "v" then (if $o.k == "BS" or $o.k == "LS" then .itk += [.ikey] | .ist = "c" else fail($o) end)',
    '  elif $o.t == "," then .ist = "k"',
    '  elif $o.t == "}" then .d = 0 | assign_itab | .m = "VE"',
    "  else fail($o) end;",
    "def step($o):",
    "  if .bad then .",
    '  elif $o.k == "ERR" then .bad = true',
    '  elif .m == "S" then',
    '    if $o.k == "NL" then .',
    '    elif $o.t == "[" then .m = "H0" | .hp = [] | .ha = false',
    '    elif .tk == "other" or .tk == "ign" then toskip($o)',
    "    else .kp = [] | keypart($o) end",
    '  elif .m == "H0" then (if $o.t == "[" then .ha = true | .m = "HK" else hkeypart($o) end)',
    '  elif .m == "HK" then hkeypart($o)',
    '  elif .m == "HD" then',
    '    if $o.t == "." then .m = "HK"',
    '    elif $o.t == "]" then (if .ha then .m = "HC" else finish_header | .m = "HE" end)',
    "    else .bad = true end",
    '  elif .m == "HC" then (if $o.t == "]" then finish_header | .m = "HE" else .bad = true end)',
    '  elif .m == "HE" then (if $o.k == "NL" then .m = "S" else .bad = true end)',
    '  elif .m == "K" then keypart($o)',
    '  elif .m == "KD" then',
    '    if $o.t == "." then .m = "K"',
    '    elif $o.t == "=" then begin_value',
    "    else keyfail($o) end",
    '  elif .m == "V" then value1($o)',
    '  elif .m == "VA" then varr($o)',
    '  elif .m == "VI" then vitab($o)',
    '  elif .m == "VE" then (if $o.k == "NL" then .m = "S" else fail($o) end)',
    "  else skiptok($o) end;",
    `(ltrimstr("\\ufeff") | [scan(${jqStr(CODEX_TOML_TOKEN_PATTERN)})]`,
    '  | map({t: ., k: kind}) | map(select(.k != "WS" and .k != "COM"))',
    '  | . + [{t: "\\n", k: "NL"}]) as $toks',
    '| reduce $toks[] as $o ({m: "S", d: 0, tk: "root", S: {}, U: [], seen: {}, bad: false}; step($o))',
    '| if .bad or .m != "S" then {unreadable: true}',
    "  else .U as $U |",
    "  [ .S | to_entries[] | .key as $n | .value as $c |",
    '    if ($U | has_el($n)) or $n == "" or (($c.cmd != null) == ($c.url != null)) then {n: $n, u: true}',
    "    elif $c.cmd != null and (($c.keys.env | map(ascii_downcase) | unique | length) != ($c.keys.env | length)) then {n: $n, u: true}",
    "    elif $c.cmd != null then",
    "      {n: $n, e: ({command: $c.cmd}",
    "        + (if $c.args != null then {args: $c.args} else {} end)",
    '        + (if ($c.keys.env | length) > 0 then {env: ($c.keys.env | map({key: ., value: ""}) | from_entries)} else {} end)',
    "        + (if $c.en == false then {disabled: true} else {} end)),",
    `       f: ($c.drop + ($c.has | map(select(. as $x | ${jqArr(CODEX_STDIO_UNUSED_FIELDS)} | has_el($x)))))}`,
    "    else",
    `      (($c.keys.http_headers + $c.keys.env_http_headers + (if $c.bearer then [${jqStr(CODEX_BEARER_HEADER)}] else [] end)) | unique) as $h |`,
    "      if (($h | map(ascii_downcase) | unique | length) != ($h | length)) then {n: $n, u: true} else",
    '      {n: $n, e: ({type: "http", url: $c.url}',
    '        + (if ($h | length) > 0 then {headers: ($h | map({key: ., value: ""}) | from_entries)} else {} end)',
    "        + (if $c.en == false then {disabled: true} else {} end)),",
    `       f: ($c.drop + ($c.has | map(select(. as $x | ${jqArr(CODEX_HTTP_UNUSED_FIELDS)} | has_el($x)))))} end`,
    "    end ] as $r",
    "  # Two kept names equal when ASCII case is ignored are both refused: the",
    "  # PowerShell twin cannot hold them as two properties (its own cxCaseClash).",
    "  | ([ $r[] | select(.u != true) | .n | ascii_downcase ] | group_by(.) | map(select(length > 1) | .[0])) as $cl",
    "  | ($r | map(if .u != true and ((.n | ascii_downcase) as $l | $cl | has_el($l)) then {n: .n, u: true} else . end)) as $r",
    "  | { mcpServers: ([ $r[] | select(.u != true) | {key: .n, value: .e} ] | sort_by(.key) | from_entries),",
    "      unsupported: (($U + [ $r[] | select(.u == true) | .n ]) | unique),",
    "      dropped: [ $r[] | select(.u != true) | select((.f | length) > 0) | {name: .n, fields: (.f | unique)} ] | sort_by(.name) }",
    "  end",
  ].join("\n");
}

/** A reason, single-quoted for bash. */
const q = bashSingleQuote;

/**
 * The lines that check one path before anything is read through it: run
 * `physical_path` on `$<src>` into `$<out>`, and when the physical path is a
 * credential store or cannot be checked, record one omission at `surface` and
 * run `onRefuse`. The exporter's own link-target checks, as the memory and
 * hooks stages run them.
 */
function physicalCheckLines(
  indent: string,
  src: string,
  out: string,
  surface: string,
  onRefuse: string
): string[] {
  return [
    `_xrc=0; ${out}="$(physical_path "$${src}")" || _xrc=$?`,
    `if [ "$_xrc" -eq 3 ] || { [ -n "$${out}" ] && has_credential_part "$${out}"; }; then`,
    `  record_omission ${surface} ${q(ARCHIVE_CREDENTIAL_OMISSION_REASON)}; ${onRefuse}`,
    `elif [ -z "$${out}" ]; then`,
    `  record_omission ${surface} ${q(ARCHIVE_LINK_UNCHECKED_OMISSION_REASON)}; ${onRefuse}`,
    "fi",
  ].map(l => indent + l);
}

/**
 * Step 4d: check the Codex home once (a credential store, or a folder that
 * cannot be resolved, is refused with one omission and nothing is read from
 * it), then stage its instructions as `rules/codex-agents.md` and its user
 * skills under `skills/<name>`, and record a `prompts/` folder as an omission.
 * Runs after the last materialize pass, so a skill is copied as it is (tar
 * without -h) and every link in it is removed and recorded, never followed.
 * The entries are appended to `$WORK/rules.json` and `$WORK/skills.json`,
 * which Step 9 reads. `excludeFlags` are the exporter's junk `--exclude` flags.
 */
export function codexStagingShellLines(excludeFlags: string): string[] {
  const [instA, instB] = CODEX_INSTRUCTION_FILES;
  return [
    "# ── Step 4d — #5169: the Codex home's instructions and skills ──",
    "# (no step call: the step count and progress bar are unchanged)",
    'CODEX_PHYS=""',
    'if [ "$CODEX_FOUND" = true ]; then',
    ...physicalCheckLines(
      "  ",
      "CODEX_ROOT",
      "_xphys",
      q(CODEX_HOME_SURFACE),
      "_xphys=''"
    ),
    '  if [ -n "$_xphys" ]; then CODEX_PHYS="$_xphys"; CODEX_READ=true; fi',
    "fi",
    'if [ "$CODEX_READ" = true ]; then',
    "  # Instructions: the override when it holds a non-blank byte, else AGENTS.md",
    "  # (Codex's order). A linked file is read at its physical path once that is",
    "  # checked; a refused one stops here, so AGENTS.md never stands in for it.",
    "  _xi=''",
    `  for _xn in ${instA} ${instB}; do`,
    '    _xf="$CODEX_PHYS/$_xn"',
    '    [ -f "$_xf" ] || continue',
    '    if [ -L "$_xf" ]; then',
    ...physicalCheckLines(
      "      ",
      "_xf",
      "_xp",
      q(CODEX_INSTRUCTIONS_SURFACE),
      "_xi=refused; break"
    ),
    '      [ -f "$_xp" ] || continue',
    '      _xf="$_xp"',
    "    fi",
    "    # A file it cannot read is recorded and ends the search: it is never",
    "    # mistaken for a blank one, so AGENTS.md never stands in for it.",
    "    _xg=0",
    '    if [ -r "$_xf" ]; then LC_ALL=C grep -q \'[^[:space:]]\' "$_xf" 2>/dev/null || _xg=$?; else _xg=2; fi',
    '    case "$_xg" in',
    '      0) _xi="$_xf"; break ;;',
    "      1) ;;",
    `      *) record_omission ${q(CODEX_INSTRUCTIONS_SURFACE)} ${q(CODEX_INSTRUCTIONS_UNREADABLE_REASON)}; _xi=refused; break ;;`,
    "    esac",
    "  done",
    `  if [ -n "$_xi" ] && [ "$_xi" != refused ]; then`,
    `    if [ -e "$STAGING/${CODEX_RULE_ARCHIVE_PATH}" ] || [ -L "$STAGING/${CODEX_RULE_ARCHIVE_PATH}" ]; then`,
    `      record_omission ${q(CODEX_INSTRUCTIONS_SURFACE)} ${q(CODEX_RULE_SHADOWED_REASON)}`,
    `    elif mkdir -p "$STAGING/rules" && cp "$_xi" "$STAGING/${CODEX_RULE_ARCHIVE_PATH}"; then`,
    `      _tmp="$(jq -c --arg n ${q(CODEX_RULE_NAME)} --arg p ${q(CODEX_RULE_ARCHIVE_PATH)} '. + [{name: $n, path: $p, source: "codex"}]' "$WORK/rules.json")"`,
    '      printf \'%s\' "$_tmp" > "$WORK/rules.json"',
    "    else",
    `      record_omission ${q(CODEX_INSTRUCTIONS_SURFACE)} 'instructions file could not be copied'`,
    "    fi",
    "  fi",
    "  # Skills: ~/.agents/skills first, then the deprecated $CODEX_HOME/skills, each",
    "  # in byte order. Only a folder holding a SKILL.md file (not a link) counts;",
    "  # dot-names (.system is Codex's bundled cache) are skipped; a name already",
    "  # staged (Claude Code's, or an earlier root's) wins.",
    `  for _xr in "$HOME/${CODEX_AGENTS_SKILLS_DIR}" "$CODEX_PHYS/skills"; do`,
    '    [ -d "$_xr" ] || continue',
    ...physicalCheckLines(
      "    ",
      "_xr",
      "_xrp",
      q(CODEX_SKILLS_SURFACE),
      "continue"
    ),
    "    # A folder it cannot list is recorded, never read as empty.",
    `    if [ ! -r "$_xrp" ] || [ ! -x "$_xrp" ]; then record_omission ${q(CODEX_SKILLS_SURFACE)} ${q(CODEX_SKILLS_UNREADABLE_REASON)}; continue; fi`,
    '    find -H "$_xrp" -mindepth 1 -maxdepth 1 -print0 2>/dev/null | LC_ALL=C sort -z > "$WORK/codex-skills.txt" || : > "$WORK/codex-skills.txt"',
    "    while IFS= read -r -d '' _xc; do",
    '      _xs="${_xc##*/}"',
    '      case "$_xs" in',
    `        ''|.*) continue ;;`,
    `        *"$_cnl"*) record_omission ${q(CODEX_SKILLS_SURFACE)} ${q(ARCHIVE_LINK_UNCHECKED_OMISSION_REASON)}; continue ;;`,
    "      esac",
    `      if [ -L "$_xc" ]; then record_omission "${CODEX_SKILLS_SURFACE_PREFIX}$_xs" ${q(CODEX_LINK_OMISSION_REASON)}; continue; fi`,
    '      [ -d "$_xc" ] && [ -f "$_xc/SKILL.md" ] && [ ! -L "$_xc/SKILL.md" ] || continue',
    `      if has_credential_part "$_xrp/$_xs"; then record_omission "${CODEX_SKILLS_SURFACE_PREFIX}$_xs" ${q(ARCHIVE_CREDENTIAL_OMISSION_REASON)}; continue; fi`,
    '      if [ -e "$STAGING/skills/$_xs" ] || [ -L "$STAGING/skills/$_xs" ]; then',
    `        record_omission "${CODEX_SKILLS_SURFACE_PREFIX}$_xs" ${q(CODEX_SKILL_SHADOWED_REASON)}`,
    "        continue",
    "      fi",
    '      mkdir -p "$STAGING/skills/$_xs"',
    `      ( cd "$_xc" && tar -cf - ${excludeFlags} . ) \\`,
    '        | ( cd "$STAGING/skills/$_xs" && tar -xpf - )',
    "      # A link inside is removed and recorded (in byte order), never followed.",
    '      find "$STAGING/skills/$_xs" -type l -print0 2>/dev/null | LC_ALL=C sort -z > "$WORK/codex-links.txt" || : > "$WORK/codex-links.txt"',
    "      while IFS= read -r -d '' _xl; do",
    '        case "$_xl" in "$STAGING"/skills/*) ;; *) continue ;; esac',
    '        _xlr="${_xl#"$STAGING"/}"',
    '        rm -f "$_xl"',
    '        case "$_xlr" in *"$_cnl"*) _xlr="skills/$_xs" ;; esac',
    `        record_omission "$_xlr" ${q(CODEX_LINK_OMISSION_REASON)}`,
    '      done < "$WORK/codex-links.txt"',
    '      prune_credential_names "skills/$_xs"',
    `      _tmp="$(jq -c --arg n "$_xs" --arg p "skills/$_xs" '. + [{name: $n, path: $p, source: "codex"}]' "$WORK/skills.json")"`,
    '      printf \'%s\' "$_tmp" > "$WORK/skills.json"',
    '    done < "$WORK/codex-skills.txt"',
    "  done",
    "  # D6: Codex has no custom prompts any more; a prompts/ folder is not carried.",
    `  if [ -d "$CODEX_PHYS/prompts" ]; then record_omission ${q(CODEX_PROMPTS_SURFACE)} ${q(CODEX_PROMPTS_OMISSION_REASON)}; fi`,
    "fi",
  ];
}

/**
 * Step 5: read the Codex MCP servers. `config.toml` is parsed by
 * {@link codexMcpReaderJq} and never copied; its output (names, no env or
 * header value) goes through the exporter's own projection (`projectionJq`,
 * the same `mcpExtractionJq()` every source uses) with `--arg source codex`.
 * Sets `CODEX_MCP`. One omission per server left out whole, one per server
 * that lost fields, or one when the file cannot be read.
 */
export function codexMcpShellLines(projectionJq: string): string[] {
  const [ua, ub] = CODEX_SERVER_UNSUPPORTED_PARTS;
  const [da, db] = CODEX_SERVER_DROPPED_PARTS;
  const S = q(CODEX_CONFIG_SURFACE);
  return [
    "# Codex — $CODEX_HOME/config.toml through the TOML subset reader (never copied).",
    'CODEX_MCP="[]"',
    'if [ "$CODEX_READ" = true ] && [ -f "$CODEX_PHYS/config.toml" ]; then',
    '  _xf="$CODEX_PHYS/config.toml"; _xok=1',
    '  if [ -L "$_xf" ]; then',
    ...physicalCheckLines("    ", "_xf", "_xp", S, "_xok=0"),
    "  fi",
    '  if [ "$_xok" -eq 1 ]; then',
    `    _cx="$(jq -Rs -c ${q(codexMcpReaderJq())} "$_xf" 2>/dev/null || :)"`,
    "    if [ -z \"$_cx\" ] || printf '%s' \"$_cx\" | jq -e '.unreadable == true' >/dev/null 2>&1; then",
    `      record_omission ${S} ${q(CODEX_TOML_UNREADABLE_REASON)}`,
    "    else",
    `      printf '%s' "$_cx" | jq -c --arg s ${S} --arg ua ${q(ua)} --arg ub ${q(ub)} --arg da ${q(da)} --arg db ${q(db)} \\`,
    "        '(.unsupported[] | {surface: $s, reason: ($ua + . + $ub)}), (.dropped[] | {surface: $s, reason: ($da + .name + $db + (.fields | join(\", \")))})' \\",
    '        >> "$OMISSIONS"',
    `      CODEX_MCP="$(printf '%s' "$_cx" | jq -c --arg source codex ${q(projectionJq)} 2>/dev/null || echo '[]')"`,
    '      [ -n "$CODEX_MCP" ] || CODEX_MCP="[]"',
    "    fi",
    "  fi",
    "fi",
  ];
}
