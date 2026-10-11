// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Configuration Porter — the bash credential-name prune, shared by the bash
 * exporter and the extraction prompt's Step 11 block (issue #4172).
 *
 * A file or folder whose name (any case) is credential-bearing
 * ({@link ARCHIVE_CREDENTIAL_NAMES}, or a name starting with one of
 * {@link ARCHIVE_CREDENTIAL_PREFIXES}) is never packaged: a secret that reaches
 * an archive cannot be recalled. The prune runs AFTER staging, not as a
 * `tar --exclude`, because `--exclude` is silent (no omission) and
 * case-sensitive. It records one omission per removed path, so the operator
 * sees what was left out. The PowerShell exporter carries a twin
 * (`pruneCredentialNames`), pinned to this result by the #3447 equivalence
 * harness.
 *
 * NODE-FREE (R7): like every non-test module under `shared/src/porter`, this
 * file only builds strings.
 */
import { ARCHIVE_CREDENTIAL_OMISSION_REASON } from "./exportShared";
import {
  ARCHIVE_CREDENTIAL_NAMES,
  ARCHIVE_CREDENTIAL_PREFIXES,
} from "./manifest";

/**
 * The `find` test for a credential-bearing name: one `-iname` per listed name
 * and one `-iname '<prefix>*'` per prefix, OR-ed in a group. `-iname` matches
 * case-insensitively in GNU, BSD/macOS and BusyBox `find`.
 */
export function credentialFindPredicate(): string {
  const globs = [
    ...ARCHIVE_CREDENTIAL_NAMES,
    ...ARCHIVE_CREDENTIAL_PREFIXES.map(prefix => `${prefix}*`),
  ];
  return `\\( ${globs.map(glob => `-iname '${glob}'`).join(" -o ")} \\)`;
}

/**
 * The bash lines that define two functions, for a caller with `WORK` in scope
 * under `set -eu` (bash 3.2 safe):
 *
 * - `list_credential_names <root> <subtree> <out>` appends to `<out>`, in
 *   `LC_ALL=C` order, every path under `<root>/<subtree>` (relative to
 *   `<root>`) whose name is credential-bearing, stopping at the first matching
 *   ancestor (`-prune`: a `.ssh/` folder is one path, not one per file). It
 *   only reads. `find` runs under `LC_ALL=C`, so its case folding is plain
 *   ASCII in every locale (a Turkish locale folds `I` to a dotless i, so
 *   `.CREDENTIALS.JSON` would slip past `-iname`), and it never follows a
 *   symbolic link.
 * - `remove_credential_paths <root> <list>` removes each listed path under
 *   `<root>`: a link as a link, anything else after making it (and its
 *   folder) writable, so a write-protected copy is still removed. A listed
 *   path whose folder cannot be entered or is not physically inside `<root>`,
 *   or whose last part is `.` or `..`, is refused on stderr and the function
 *   returns 1 (stopping the run under `set -e`), so nothing outside `<root>`
 *   is removed or made writable and no listed credential is silently left in
 *   place (a name with a newline splits into list lines such as `../.ssh` or
 *   a bare `..`). Returns 1 too when `<root>` cannot be entered. A credential
 *   whose own name holds a newline is named by no line; in every case tried,
 *   one of its pieces is refused this way or names a missing path, and either
 *   stops the run (#4321 carries the class).
 *
 * The extraction prompt's Step 11 block embeds these two (it lists what was
 * staged and removes it from its own temp tree).
 */
export function credentialPathsFunctionLines(): string[] {
  return [
    "# #4172: credential-bearing names (any case) never leave this machine. list",
    "# only reads; remove takes a link out as a link.",
    "list_credential_names() { # $1 = root, $2 = subtree under it, $3 = list to append to",
    '  [ -d "$1/$2" ] || return 0',
    `  ( cd "$1" && LC_ALL=C find "$2" ${credentialFindPredicate()} -prune -print ) > "$WORK/credential-names.raw"`,
    '  LC_ALL=C sort "$WORK/credential-names.raw" >> "$3"',
    "}",
    "remove_credential_paths() { # $1 = root, $2 = list of paths under it",
    "  # Only ever under $1, and fail closed: a listed path whose last part is . or",
    "  # .., or whose folder cannot be entered or is not physically inside the root,",
    "  # stops the run (a name with a newline splits into pieces such as ../.ssh or",
    "  # a bare .., whose chmod -R would reach the root's parent; skipping one would",
    "  # leave the listed credential in place).",
    '  _rroot="$(cd -P -- "$1" && pwd -P)" || return 1',
    "  while IFS= read -r _c; do",
    '    [ -n "$_c" ] || continue',
    '    case "/$_c" in */.|*/..) printf \'porter: refusing to remove %s\\n\' "$_c" >&2; return 1 ;; esac',
    '    _rdir="$(cd -P -- "$(dirname -- "$1/$_c")" 2>/dev/null && pwd -P)" || { printf \'porter: refusing to remove %s\\n\' "$_c" >&2; return 1; }',
    '    case "$_rdir/" in "$_rroot"/*) ;; *) printf \'porter: refusing to remove %s\\n\' "$_c" >&2; return 1 ;; esac',
    '    chmod u+w "$(dirname "$1/$_c")"',
    '    if [ ! -L "$1/$_c" ]; then chmod -R u+w "$1/$_c"; fi',
    '    rm -rf "$1/$_c"',
    '  done < "$2"',
    "}",
  ];
}

/**
 * {@link credentialPathsFunctionLines} plus `prune_credential_names <subtree>`,
 * which lists `$STAGING/<subtree>`, records one omission per path with
 * {@link ARCHIVE_CREDENTIAL_OMISSION_REASON} (`record_omission` must be in
 * scope), and removes them. The bash exporter embeds these. A `find`, `sort`,
 * `chmod` or `rm` failure stops the run (fail closed), so a prune that could
 * not finish never ships what it missed.
 */
export function pruneCredentialNamesFunctionLines(): string[] {
  return [
    ...credentialPathsFunctionLines(),
    "prune_credential_names() { # $1 = subtree relative to $STAGING; records an omission per removed path",
    '  : > "$WORK/credential-names.txt"',
    '  list_credential_names "$STAGING" "$1" "$WORK/credential-names.txt"',
    "  while IFS= read -r _c; do",
    '    [ -n "$_c" ] || continue',
    `    record_omission "$_c" '${ARCHIVE_CREDENTIAL_OMISSION_REASON}'`,
    '  done < "$WORK/credential-names.txt"',
    '  remove_credential_paths "$STAGING" "$WORK/credential-names.txt"',
    "}",
  ];
}

/**
 * The `case` pattern for a credential-bearing name in lower case: each listed
 * name, and each prefix followed by `*`. No listed name holds a glob
 * character, so each alternative matches only itself.
 */
export function credentialCasePattern(): string {
  return [
    ...ARCHIVE_CREDENTIAL_NAMES,
    ...ARCHIVE_CREDENTIAL_PREFIXES.map(prefix => `${prefix}*`),
  ].join("|");
}

/**
 * The `physical_path` and `has_credential_part` functions of
 * {@link credentialLinkFunctionLines} (see there), on their own, for a caller
 * that needs only them: the extraction prompt's Step 11 block, whose
 * settings-script lines (#4173, PM ruling B1) refuse a script reached through a
 * link with a credential-bearing part by the same rule.
 */
export function physicalPathFunctionLines(): string[] {
  return [
    "physical_path() { # $1 = a path; prints the physical path it names, or nothing; returns 3 when a link it follows (its name or target) names a credential store, 4 when its walk reaches /proc",
    "  # A path missing here is still walked, for /proc only: /proc/self/cwd/z is",
    "  # missing from this folder yet present from the one tar reads it in.",
    '  _pe=1; [ -e "$1" ] || _pe=0',
    "  # One part at a time, as the pwsh twin walks: cd -P would hide a link in the",
    "  # middle of the path, and a followed link's name or target text can name a",
    "  # credential store the physical path no longer shows (~/.ssh -> ~/Dropbox/k).",
    '  case "$1" in /*) _pr="$1/" ;; *) _pr="$(pwd -P)/$1/" ;; esac',
    "  _pc=''; _pn=0; _prc=0",
    '  while [ -n "$_pr" ]; do',
    '    _px="${_pr%%/*}"; _pr="${_pr#*/}"',
    '    case "$_px" in ""|.) continue ;; ..) _pc="${_pc%/*}"; continue ;; esac',
    '    if [ -L "$_pc/$_px" ]; then',
    '      [ "$_pn" -lt 40 ] || return "$_prc"',
    "      _pn=$((_pn + 1))",
    '      _pl="$(readlink "$_pc/$_px")" || return "$_prc"',
    '      if has_credential_part "$_px/$_pl"; then _prc=3; fi',
    '      case "$_pl" in /*) _pc="" ;; esac',
    '      _pr="$_pl/$_pr"',
    "    else",
    '      _pc="$_pc/$_px"',
    "      # A path through /proc is left unchecked (4): read here, /proc/self is the",
    "      # short-lived readlink process, never tar.",
    '      case "$_pc" in /proc|/proc/*) [ "$_prc" -ne 3 ] || return 3; return 4 ;; esac',
    "    fi",
    "  done",
    '  [ "$_pe" -eq 1 ] || return 0',
    "  printf '%s\\n' \"${_pc:-/}\"",
    '  return "$_prc"',
    "}",
    "has_credential_part() { # $1 = a path; true when one of its parts is credential-bearing (any case)",
    "  _hl=\"$(printf '%s' \"$1\" | LC_ALL=C tr '[:upper:]' '[:lower:]')\" || return 0",
    '  [ -n "$_hl" ] || return 0',
    '  _hr="$_hl/"',
    '  while [ -n "$_hr" ]; do',
    '    _hc="${_hr%%/*}"; _hr="${_hr#*/}"',
    `    case "$_hc" in ${credentialCasePattern()}) return 0 ;; esac`,
    "  done",
    "  return 1",
    "}",
  ];
}

/**
 * #4172 (OOS-6): the bash lines that define the functions the bash exporter's
 * link materialization uses to refuse a link whose physical target is a
 * credential store (`skills/keys -> ~/.aws`), for a caller with `WORK` in
 * scope under `set -eu`. Bash 3.2 safe, with no `readlink -f` or `realpath`
 * (macOS bash 3.2 hosts lack them):
 *
 * - `physical_path <path>` prints the physical path `<path>` names, or nothing
 *   when it does not resolve. It walks the path one part at a time, following
 *   each link by hand (a `..` in a link target is taken after the link before
 *   it; a relative `<path>` is taken from the current folder; a folder that
 *   cannot be entered still resolves; a walk that reaches `/proc` prints
 *   nothing, even for a path missing from this folder, since `/proc/self`
 *   names the process that reads it, never tar).
 *   It returns 3 when a link it follows has a
 *   credential-bearing part in its own name or in its target text, even when
 *   the physical path no longer shows one (`~/.ssh -> ~/Dropbox/keys`, reached
 *   through the link `skills/k -> ~/.ssh` or as `~/.ssh/x`); 4 when the walk
 *   reaches `/proc` (3 still wins when such a link came first); otherwise 0. A
 *   path missing from this folder prints nothing and returns 0, unless a
 *   credential-named link came before a link it cannot follow or before
 *   `/proc` (3), or the walk reaches `/proc` (4).
 * - `has_credential_part <path>` is true when a part of `<path>`, in any case,
 *   is credential-bearing. A lower-casing that fails counts as a match, so a
 *   missing `tr` refuses rather than ships.
 * - `credential_links <folder> <staging path> <out>` appends to `<out>` one
 *   `c<TAB>path` line per link under `<folder>` that `physical_path` refuses
 *   (3) or whose physical target has a credential-bearing part, and one
 *   `u<TAB>path` line per link it could not check (the target exists but does
 *   not resolve, it is more than 40 folder links deep, or the walk reaches
 *   `/proc`, which tar reads in its own process). A folder holding a
 *   name with a newline in it is refused whole as `u`: its paths cannot be read
 *   one per line. It follows folder links the way `tar -h` does, along every
 *   path (a folder two links reach is checked under both), stops only at a
 *   folder already on the current path (a loop), never descends a refused
 *   link, and only reads.
 * - `under_link <root> <path>` is true when a folder between `<root>` and
 *   `<path>` (relative to `<root>`) is a link. A path below a staged link is not
 *   the export's copy: removing it would remove through the link, into the
 *   folder the link names.
 *
 * Known gaps, tracked in #4332 (not regressions: before #4172 no link was
 * checked for a credential store): `physical_path` reads a link target with
 * `$(readlink ...)`, which drops a trailing newline, so it can check a
 * different path than the kernel follows; and `credential_links` reads its link
 * lists one per line, so a newline anywhere in the physical path of a folder
 * link below the staged one (from its own target or any link above it, the
 * staged link included) splits the list read under it, and those links go
 * unchecked.
 */
export function credentialLinkFunctionLines(): string[] {
  return [
    "# #4172 (OOS-6): a link whose physical target has a credential-bearing part",
    "# (skills/keys -> ~/.aws) is refused, at any depth tar -h would follow, except",
    "# through two newline gaps tracked in #4332: a link target that ends in a",
    "# newline (read with $(readlink), which drops it), and a newline anywhere in",
    "# the physical path of a folder link below it (it splits the one-per-line",
    "# list of the links read under that folder).",
    "_cnl=$'\\n'",
    "_ctab=$'\\t'",
    ...physicalPathFunctionLines(),
    "credential_links() { # $1 = folder, $2 = its staging path, $3 = list to append to (kind<TAB>path)",
    '  credential_links_in "$1" "$2" "$3" 0 "$_cnl$(physical_path "$1")$_cnl"',
    "}",
    "credential_links_in() { # $1 = folder, $2 = its staging path, $3 = list, $4 = links followed, $5 = physical folders on this path",
    '  local _cd="$1" _cpre="$2" _cout="$3" _chops="$4" _canc="$5" _cl _crel _cphys _crc',
    "  # A name with a newline in it cannot be read one per line (a piece of it can",
    "  # even be another link's name): refuse the whole folder, never part of it.",
    '  find -H "$_cd" -name "*$_cnl*" -print > "$WORK/credential-newline-$_chops.txt" 2>/dev/null || true',
    '  if [ -s "$WORK/credential-newline-$_chops.txt" ]; then',
    '    printf \'u\\t%s\\n\' "$_cpre" >> "$_cout"',
    "    return 0",
    "  fi",
    '  find -H "$_cd" -type l -print > "$WORK/credential-links-$_chops.txt" 2>/dev/null || true',
    "  while IFS= read -r _cl; do",
    '    [ -n "$_cl" ] || continue',
    '    _crel="${_cl#"$_cd"/}"',
    '    _crc=0; _cphys="$(physical_path "$_cl")" || _crc=$?',
    '    if [ "$_crc" -eq 3 ]; then',
    '      printf \'c\\t%s\\n\' "$_cpre/$_crel" >> "$_cout"',
    "      continue",
    "    fi",
    '    if [ -z "$_cphys" ]; then',
    "      # A target that exists but does not resolve, or one reached through /proc",
    "      # (which tar reads in its own process), is refused (fail closed); a broken",
    "      # link is left to tar, which skips it.",
    '      if [ "$_crc" -eq 4 ] || [ -e "$_cl" ]; then printf \'u\\t%s\\n\' "$_cpre/$_crel" >> "$_cout"; fi',
    "      continue",
    "    fi",
    '    if has_credential_part "$_cphys"; then',
    '      printf \'c\\t%s\\n\' "$_cpre/$_crel" >> "$_cout"',
    '    elif [ -d "$_cl" ]; then',
    '      case "$_canc" in *"$_cnl$_cphys$_cnl"*) continue ;; esac',
    '      if [ "$_chops" -ge 40 ]; then',
    '        printf \'u\\t%s\\n\' "$_cpre/$_crel" >> "$_cout"',
    "      else",
    "        # Walk on from the physical folder: a path through many links fails",
    "        # with too many levels of links long before tar -h stops following.",
    '        credential_links_in "$_cphys" "$_cpre/$_crel" "$_cout" $((_chops + 1)) "$_canc$_cphys$_cnl"',
    "      fi",
    "    fi",
    '  done < "$WORK/credential-links-$_chops.txt"',
    "}",
    "under_link() { # $1 = root, $2 = a path under it; true when a folder between them is a link",
    '  _ur="$2"; _up="$1"',
    "  while :; do",
    '    case "$_ur" in */*) _up="$_up/${_ur%%/*}"; _ur="${_ur#*/}" ;; *) return 1 ;; esac',
    '    [ ! -L "$_up" ] || return 0',
    "  done",
    "}",
  ];
}
