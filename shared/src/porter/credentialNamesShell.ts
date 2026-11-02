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
import {
  ARCHIVE_CREDENTIAL_OMISSION_REASON,
  ARCHIVE_EXCLUSION_PATTERNS,
  DIMENSION_DIRS,
  HOOK_TREE_EXCLUSION_PATTERNS,
  ROOT_BELOW_SH,
  ROOT_HOLDS_SH,
} from "./exportShared";
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
    `  ( cd "$1" && LC_ALL=C find "$2" ${credentialFindPredicate()} -prune -print ) >| "$WORK/credential-names.raw"`,
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
    "  # A path missing here is still walked: for /proc (/proc/self/cwd/z is",
    "  # missing from this folder yet present from the one tar reads it in), and",
    "  # so a credential-named link on the way still returns 3 (#4928).",
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
    "  # #4928: a missing path prints nothing but keeps its status, so a dangling",
    "  # chain through a credential-named link is refused (3), as the pwsh twin's is.",
    '  [ "$_pe" -eq 1 ] || return "$_prc"',
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
 *   path missing from this folder prints nothing and keeps the status its walk
 *   reached: 3 when a credential-named link came first, 4 when the walk
 *   reaches `/proc`, otherwise 0. So a dangling chain through a credential
 *   store (`skills/keys -> ~/.ssh/id`, `~/.ssh -> ~/gone`) is refused (3), as
 *   the PowerShell twin refuses it, not reported as a broken link (#4928).
 * - `has_credential_part <path>` is true when a part of `<path>`, in any case,
 *   is credential-bearing. A lower-casing that fails counts as a match, so a
 *   missing `tr` refuses rather than ships.
 * - `holds_path <physical path> <physical folder>` (#5935) is true when the
 *   path is the folder or a folder above it: first by text (the folder's path
 *   begins with the path, whole part by whole part), then by identity, with
 *   `-ef` (one device and inode) against the folder and each of its parent
 *   folders as `physical_path` spelled them. `physical_path` resolves links but
 *   keeps the spelling it walks, so a bind mount, a case variant on a
 *   case-insensitive volume, a firmlink or a Unicode-normalization variant names
 *   the same folder in other text, and only the identity test sees it. A folder
 *   that holds another mount of the folder (a link to the parent of a bind
 *   source of the root) is neither a parent by text nor the same file as one,
 *   so `holds_path` does not see it; `holds_config_root` does, through
 *   `holds_root_mount` (#5953). It is false for an empty path; an empty folder
 *   matches only a `/` path, as the text test always did, and a relative folder
 *   (never a physical path) only by text. A stat that fails reads as "not the
 *   same", which leaves the text result.
 * - `holds_config_root <physical path>` (#5862) is `holds_path` against
 *   `CONFIG_ROOT_PHYS`, the root's physical path, which the caller reads once
 *   with `physical_path`, then `holds_root_mount` (#5953). It is false when
 *   `CONFIG_ROOT_PHYS` is empty or unset (a root that could not be read), so the
 *   other loop tests still apply.
 * - `holds_root_mount <physical folder>` (#5953) is true when the root is
 *   mounted somewhere below the folder: `~/.claude` bound from `/src/claude` (a
 *   bind may rename the folder) and a link to `/src`, or HOME bound from a
 *   folder under the link's target. `find` walks the folder without following
 *   links (a link below it is the next walk's to test), matches each entry with
 *   the root by `-samefile` and confirms a match with `test -ef` (one device and
 *   inode: BSD and macOS `find` match `-samefile` by inode number alone, which
 *   another volume can repeat), so a hit is always real containment. `-prune`
 *   stops it descending into a hit. Each call walks the target once, the folder
 *   the copy reads next when the link ships; it runs only when the text and
 *   `-ef` tests miss, and `credential_links_in` skips it for a link it has
 *   already found to be a loop. A `find` that cannot answer counts as holding
 *   the root, so the link is refused as a loop rather than shipped: one that
 *   lacks `-samefile` or `-exec`, or whose `test` lacks `-ef` (POSIX `find` has
 *   no `-samefile`, and `test -ef` is only in POSIX.1-2024; a one-entry check on
 *   the root itself finds out), or one that dies (exit above 1). A folder below
 *   the target it cannot read (exit 1, no hit) is not walked and is no loop: tar
 *   cannot read it either, so unless the copy excludes it by name, the copy of
 *   the staged link that reaches it fails with the omission that link got
 *   before #5953. It is false for a path that is not a folder and for an empty
 *   `CONFIG_ROOT_PHYS`.
 * - `link_into_root <physical path> [d]` (#5934) is true when the path lies
 *   inside the config root (`CONFIG_ROOT_PHYS`) but not in an exported section
 *   folder (`skills`, `agents`, `commands`, `rules`, `output-styles`, `hooks`),
 *   or in one where some part of its path below that folder matches a name the
 *   folder's copy excludes (`ARCHIVE_EXCLUSIONS`, plus `HOOK_TREE_EXCLUSIONS`
 *   below `hooks/`). With `d` (the target of a folder link) a path at or below
 *   `hooks/` is refused too: a copy through the link would take only the section
 *   exclusions, never the hooks tree's own. A physical path passes through no
 *   link, so `<root>/skills/...` names a real `skills` folder. It is false for an
 *   empty path and an empty `CONFIG_ROOT_PHYS`; every link below a root that
 *   cannot be read is refused as unchecked anyway. It is false for the root
 *   itself (under any spelling) and any folder above it; a folder-link caller
 *   tests those as loops first. Containment is `holds_path` (#5935): a path the
 *   root holds under a spelling its text does not begin with (a bind mount of
 *   the root) is refused whole, since its section cannot be read from its text.
 *   A path neither test places in the root goes to `root_holds_target` (#5985),
 *   and, with `d` when that finds nothing, to `root_held_below` (#6062).
 * - `root_held_below <physical folder>` (#6062) is true when an entry strictly
 *   below the folder is the same file as a root entry that `link_into_root`
 *   refuses (another mount of a root folder or file placed there, or a hard
 *   link of a root file), or when that cannot be answered. It runs
 *   `ROOT_BELOW_SH` (shared with the PowerShell twin) through `/bin/sh`, with
 *   the listing in `$WORK/root-inodes`, and judges each `d`/`f` line as the
 *   in-root path it is; a `?`, a `/bin/sh` failure, or any other line refuses.
 *   One answer per physical folder per run (`_rbyes` / `_rbno`; a path with a
 *   newline in it is never cached). It is false for a folder the root holds.
 * - `root_holds_target <physical path> [d]` (#5985) is true when an entry below
 *   the root is the same file (one device and inode) as the path and
 *   `link_into_root` refuses that entry's in-root path with the same mode, or
 *   when that cannot be answered: a bind mount of a folder inside the root
 *   (`~/.claude/projects` bound at `/mnt/proj`), renamed or not, or a file under
 *   one, is judged as the in-root path it is, so a bind of `projects/` is
 *   refused and a bind of `skills/demo` ships. It runs `ROOT_HOLDS_SH`
 *   (`./exportShared`, shared with the PowerShell twin) through `/bin/sh`, with
 *   the listing in `$WORK/root-inodes`. A `?`, a `/bin/sh` failure, or a line
 *   that is not an existing path below the root refuses (fail closed); a root
 *   holding a folder the user cannot search therefore refuses every link that
 *   points outside it.
 * - `credential_links <folder> <staging path> <out>` appends to `<out>` one
 *   `c<TAB>path` line per link under `<folder>` that `physical_path` refuses
 *   (3) or whose physical target has a credential-bearing part, and one
 *   `u<TAB>path` line per link it could not check (the target exists but does
 *   not resolve, it is more than 40 folder links deep, or the walk reaches
 *   `/proc`, which tar reads in its own process). A folder holding a
 *   name with a newline in it is refused whole as `u`: its paths cannot be read
 *   one per line. It follows folder links the way `tar -h` does, along every
 *   path (a folder two links reach is checked under both), stops only at a
 *   folder already on the current path, one that holds the link, or one that
 *   is the config root or a folder above its physical path (a loop; the last,
 *   #5862, also catches a root link inside a linked folder that points outside
 *   the root, which the holds-the-link test misses; both tests use `holds_path`,
 *   so another spelling of the folder counts, #5935, and the root test also
 *   refuses a folder that holds a mount of the root below it, #5953), and writes one
 *   `l<TAB>path` line for each such link, which the copy leaves out (#4321: GNU
 *   `tar -h` follows a loop without end). It writes one `r<TAB>path` line for a
 *   file or folder link whose physical target `link_into_root` refuses (#5934;
 *   a folder link with `d`), after the credential and loop tests; the copy
 *   leaves it out and records it as a loop is recorded. It never descends a
 *   refused link, and only reads.
 * - `under_link <root> <path>` is true when a folder between `<root>` and
 *   `<path>` (relative to `<root>`) is a link. A path below a staged link is not
 *   the export's copy: removing it would remove through the link, into the
 *   folder the link names. The hook registration walk's last arm (#6062) also
 *   asks it from the config root, so a registered script reached through any
 *   folder link is judged on its own physical path.
 * - `under_refused_link <root> <path>` (#5934 fix round 1) is true when a folder
 *   link between `<root>` and `<path>` is one the materialize pass refuses as a
 *   loop or into the root (the tests `materialize_links` applies to a staged
 *   link and `credential_links` to the links nested in it, the on-path test
 *   included), and sets `_rfkind` to `l` or `r`. The hook registration walk
 *   applies it below `hooks/`, so a registration never outlives the folder
 *   link its script is staged through. A link whose physical path cannot be
 *   read is passed over: the script's own physical path, below it, fails the
 *   same way (past 40 links too, where the walk stops), and the caller refuses
 *   that first.
 * - `root_content_refusal <physical path> [d]` (#6063) sets `_rckind` for a
 *   path that a copy outside the section folders reads through a link: `l` when
 *   `d` is given and `holds_config_root` holds it (the root or a folder above
 *   it), `r` when `link_into_root` refuses it, else empty. `CLAUDE.md`, the
 *   settings scripts, the tenant `projects` folder and the Codex home, skills
 *   roots and instructions file call it, after their own credential and
 *   unchecked tests, and each maps the kind to its own omission. It always
 *   returns 0.
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
    "# #6062: root_held_below's answer per physical folder, for this run.",
    '_rbyes="$_cnl"; _rbno="$_cnl"',
    ...physicalPathFunctionLines(),
    "# #5862: a folder link whose target is the config root or a folder above its",
    "# physical path copies the root into the archive (history, shell snapshots,",
    "# the raw settings.json), wherever the link sits. The caller sets",
    "# CONFIG_ROOT_PHYS once; empty, the other loop tests still apply.",
    "# #5935: the parent and root tests compare by text and then by identity:",
    "# physical_path keeps the spelling it was given, so a bind mount of a folder,",
    "# a case variant on a case-insensitive volume or a firmlink names the same",
    "# folder in other text, and only -ef (one device and inode) sees that. A",
    "# folder that holds another mount of the root is seen only by the root test",
    "# (holds_root_mount, #5953).",
    "holds_path() { # $1 = a physical path, $2 = a physical folder; true when $1 is $2 or a folder above it",
    '  [ -n "$1" ] || return 1',
    '  case "$2/" in "${1%/}/"*) return 0 ;; esac',
    '  [ -n "$2" ] || return 1',
    "  # A physical path is absolute; a relative one would never shorten to /.",
    '  case "$2" in /*) ;; *) return 1 ;; esac',
    '  local _hpa="$2"',
    "  while :; do",
    '    [ ! "$1" -ef "$_hpa" ] || return 0',
    '    case "$_hpa" in /) return 1 ;; esac',
    '    _hpa="${_hpa%/*}"; [ -n "$_hpa" ] || _hpa=/',
    "  done",
    "}",
    "holds_config_root() { # $1 = a physical path; true when it is the config root, a folder above it, or a folder holding a mount of it",
    '  [ -n "${CONFIG_ROOT_PHYS:-}" ] || return 1',
    '  if holds_path "$1" "$CONFIG_ROOT_PHYS"; then return 0; fi',
    '  holds_root_mount "$1"',
    "}",
    "# #5953: a bind mount gives the root a second parent chain (~/.claude bound",
    "# from /src/claude, a bind may rename it), which no text parent of the root",
    "# reaches, so a link to /src passes both tests above and the copy ships the",
    "# root. find walks the link's target without following links (a link below it",
    "# is the next walk's), matches each entry with the root by -samefile and",
    "# confirms a match with test -ef (BSD find matches -samefile by inode number",
    "# alone, which another volume can repeat), so a hit is always real",
    "# containment; -prune stops it descending into a hit. A find that cannot",
    "# answer (it lacks -samefile or -exec, its test lacks -ef, or it dies: exit",
    "# above 1) counts as holding the root, so the link is refused as a loop",
    "# rather than shipped. A folder below the target it cannot read (exit 1, no",
    "# hit) is not walked and is no loop: tar cannot read it either, so unless the",
    "# copy excludes it by name, the staged link's copy fails as it did before.",
    "holds_root_mount() { # $1 = a physical folder; true when the config root is mounted below it",
    '  [ -n "${CONFIG_ROOT_PHYS:-}" ] || return 1',
    '  [ -d "$1" ] || return 1',
    "  local _hrmo _hrmrc=0",
    '  _hrmo="$(find "$CONFIG_ROOT_PHYS" -prune -samefile "$CONFIG_ROOT_PHYS" -exec test {} -ef "$CONFIG_ROOT_PHYS" \\; -print 2>/dev/null)" || :',
    '  [ "$_hrmo" = "$CONFIG_ROOT_PHYS" ] || return 0',
    '  _hrmo="$(find "$1" -samefile "$CONFIG_ROOT_PHYS" -exec test {} -ef "$CONFIG_ROOT_PHYS" \\; -print -prune 2>/dev/null)" || _hrmrc=$?',
    '  [ -z "$_hrmo" ] || return 0',
    '  [ "$_hrmrc" -le 1 ] || return 0',
    "  return 1",
    "}",
    "# #5985: a target the text and -ef tests do not place in the root may still",
    "# be the same file as an entry below it: a bind mount of a folder inside the",
    "# root (~/.claude/projects bound at /mnt/proj), renamed or not, or a file",
    "# under one. ROOT_HOLDS_SH (shared with the PowerShell twin) prints each such",
    "# in-root path, which link_into_root then judges as text-contained, or ? when",
    "# it cannot answer (refused: fail closed).",
    "root_holds_target() { # $1 = a physical path the text and -ef tests leave outside the root, $2 = d for a folder link's target; true when an entry below the root is the same file and link_into_root refuses that entry, or when that cannot be answered",
    "  local _rht _rhe",
    `  _rht="$(HAPI_PORTER_EF_T="$1" HAPI_PORTER_EF_A="$CONFIG_ROOT_PHYS" HAPI_PORTER_EF_S="$WORK/root-inodes" /bin/sh -c '${ROOT_HOLDS_SH}')" || return 0`,
    '  [ -n "$_rht" ] || return 1',
    "  while IFS= read -r _rhe; do",
    "    # ? or a piece of a name with a newline in it: the answer cannot be read.",
    '    case "$_rhe" in "$CONFIG_ROOT_PHYS"/*) ;; *) return 0 ;; esac',
    '    [ -e "$_rhe" ] || return 0',
    '    if link_into_root "$_rhe" "${2:-}"; then return 0; fi',
    '  done <<< "$_rht" || return 0',
    "  return 1",
    "}",
    "# #6062: a folder link's target the text, -ef and #5985 tests leave outside",
    "# the root may HOLD, below it, another mount of a root folder or file",
    "# (~/.claude/projects bound at /area/proj, skills/m -> /area), renamed or not,",
    "# or a hard link of a root file: tar -h would cross into it. ROOT_BELOW_SH",
    "# (shared with the PowerShell twin) prints each such entry's in-root path, d",
    "# for a folder and f for a file, which link_into_root then judges as #5985",
    "# judges a match above the target, or ? when it cannot answer (refused: fail",
    "# closed). One answer per physical folder per run; a path with a newline in",
    "# it is never cached (it could read as two cached paths).",
    "root_held_below() { # $1 = a physical folder; true when an entry below it is the same file as a root entry that link_into_root refuses, or when that cannot be answered",
    '  [ -n "${CONFIG_ROOT_PHYS:-}" ] || return 1',
    '  [ -d "$1" ] || return 1',
    '  if holds_path "$CONFIG_ROOT_PHYS" "$1"; then return 1; fi',
    "  local _rbt _rbe _rbm _rbc=1 _rbr=1",
    '  case "$1" in *"$_cnl"*) _rbc=0 ;; esac',
    '  if [ "$_rbc" = 1 ]; then',
    '    case "$_rbno" in *"$_cnl$1$_cnl"*) return 1 ;; esac',
    '    case "$_rbyes" in *"$_cnl$1$_cnl"*) return 0 ;; esac',
    "  fi",
    `  _rbt="$(HAPI_PORTER_EF_T="$1" HAPI_PORTER_EF_A="$CONFIG_ROOT_PHYS" HAPI_PORTER_EF_S="$WORK/root-inodes" HAPI_PORTER_EF_P="\${_tgnu:-0}" /bin/sh -c '${ROOT_BELOW_SH}')" || _rbt="?"`,
    '  if [ -n "$_rbt" ]; then',
    "    while IFS= read -r _rbe; do",
    "      # ?, or a piece of a name with a newline in it: the answer cannot be read.",
    '      case "$_rbe" in d"$CONFIG_ROOT_PHYS"/*) _rbm=d ;; f"$CONFIG_ROOT_PHYS"/*) _rbm="" ;; *) _rbr=0; break ;; esac',
    '      _rbe="${_rbe#?}"',
    '      if [ ! -e "$_rbe" ] || link_into_root "$_rbe" "$_rbm"; then _rbr=0; break; fi',
    '    done <<< "$_rbt" || _rbr=0',
    "  fi",
    '  if [ "$_rbc" = 1 ]; then if [ "$_rbr" = 0 ]; then _rbyes="$_rbyes$1$_cnl"; else _rbno="$_rbno$1$_cnl"; fi; fi',
    '  return "$_rbr"',
    "}",
    "# #5934: a link whose physical target lies inside the config root but outside",
    "# the exported section folders (settings.json, history.jsonl, the shell",
    "# snapshots), or in one under a name that folder's copy leaves out, would",
    "# ship root content the export never carries. A folder link into hooks/ is",
    "# refused whole: a copy through it would skip the hooks tree's exclusions.",
    "# Containment is holds_path (#5935), so a target the root holds under another",
    "# spelling is refused too.",
    "link_into_root() { # $1 = a physical path, $2 = d for a folder link's target; true when the root holds it outside the section folders, in one under a name its copy excludes, or (d) at or below hooks/; for a path outside the root, when a root entry it is (#5985) or (d) one below it (#6062) is refused",
    '  [ -n "$1" ] || return 1',
    '  [ -n "${CONFIG_ROOT_PHYS:-}" ] || return 1',
    "  # #5985: not held by text or -ef: ask whether an entry below the root is the",
    "  # same file (another mount of a folder inside it).",
    "  # #6062: a folder link's target may instead HOLD another mount (or a hard",
    "  # link) of a root entry below it; root_held_below looks there.",
    '  if ! holds_path "$CONFIG_ROOT_PHYS" "$1"; then if root_holds_target "$1" "${2:-}"; then return 0; fi; [ "${2:-}" = d ] || return 1; root_held_below "$1"; return; fi',
    "  # Held under a spelling whose text does not begin with the root's: the root",
    "  # itself is the loop tests' (holds_config_root, the same holds_path test);",
    "  # anything else is refused whole, since its section cannot be read from its",
    "  # text.",
    '  case "$1" in "$CONFIG_ROOT_PHYS"/*) ;; *) if holds_path "$1" "$CONFIG_ROOT_PHYS"; then return 1; fi; return 0 ;; esac',
    '  _lisub="${1#"$CONFIG_ROOT_PHYS"/}"; _lisec="${_lisub%%/*}"',
    `  case "$_lisec" in ${[...DIMENSION_DIRS, "hooks"].join("|")}) ;; *) return 0 ;; esac`,
    '  if [ "$_lisec" = hooks ] && [ "${2:-}" = d ]; then return 0; fi',
    "  _lix=1",
    '  while :; do case "$_lisub" in */*) _lisub="${_lisub#*/}" ;; *) break ;; esac; _lipart="${_lisub%%/*}"',
    `    case "$_lipart" in ${ARCHIVE_EXCLUSION_PATTERNS.join("|")}) _lix=0 ;; esac`,
    `    if [ "$_lisec" = hooks ]; then case "$_lipart" in ${HOOK_TREE_EXCLUSION_PATTERNS.join("|")}) _lix=0 ;; esac; fi`,
    "  done",
    '  return "$_lix"',
    "}",
    "credential_links() { # $1 = folder, $2 = its staging path, $3 = list to append to (kind<TAB>path)",
    '  credential_links_in "$1" "$2" "$3" 0 "$_cnl$(physical_path "$1")$_cnl"',
    "}",
    "credential_links_in() { # $1 = folder, $2 = its staging path, $3 = list, $4 = links followed, $5 = physical folders on this path",
    '  local _cd="$1" _cpre="$2" _cout="$3" _chops="$4" _canc="$5" _cl _crel _cphys _crc _cpar _cloop',
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
    "      # link is left to tar: GNU tar skips it, while bsdtar (macOS tar) keeps it",
    "      # as a dangling link, which a later materialize pass records as a broken",
    "      # symlink and drops (the last pass has none after it).",
    '      if [ "$_crc" -eq 4 ] || [ -e "$_cl" ]; then printf \'u\\t%s\\n\' "$_cpre/$_crel" >> "$_cout"; fi',
    "      continue",
    "    fi",
    '    if has_credential_part "$_cphys"; then',
    '      printf \'c\\t%s\\n\' "$_cpre/$_crel" >> "$_cout"',
    "    # #5934: a file link into the config root outside the section folders.",
    '    elif [ ! -d "$_cl" ] && link_into_root "$_cphys"; then',
    '      printf \'r\\t%s\\n\' "$_cpre/$_crel" >> "$_cout"',
    '    elif [ -d "$_cl" ]; then',
    "      # #4321: a loop (its target is a folder on this path, or a folder that",
    "      # holds the link, such as loop -> . or up -> ..): the copy leaves it out,",
    "      # since GNU tar -h follows one without end.",
    "      _cloop=0",
    '      case "$_canc" in *"$_cnl$_cphys$_cnl"*) _cloop=1 ;; esac',
    '      _cpar="$(physical_path "${_cl%/*}")" || _cpar=""',
    '      if holds_path "$_cphys" "$_cpar"; then _cloop=1; fi',
    "      # #5862: or the config root or a folder above it. Inside a linked folder",
    "      # that points outside the root, the root does not hold the link's parent.",
    "      # Asked only while no test above has found the loop: it may walk the target.",
    '      if [ "$_cloop" -eq 0 ] && holds_config_root "$_cphys"; then _cloop=1; fi',
    '      if [ "$_cloop" -eq 1 ]; then printf \'l\\t%s\\n\' "$_cpre/$_crel" >> "$_cout"; continue; fi',
    "      # #5934: a folder link into the config root outside the section folders",
    "      # is never descended; the copy leaves it out.",
    '      if link_into_root "$_cphys" d; then printf \'r\\t%s\\n\' "$_cpre/$_crel" >> "$_cout"; continue; fi',
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
    "under_refused_link() { # $1 = root, $2 = a path under it; true (kind in _rfkind) when a folder link between them is refused as a loop (l) or into the root (r)",
    '  _rfr="$2"; _rfp="$1"; _rfkind=""; _rfanc="$_cnl"',
    "  while :; do",
    '    case "$_rfr" in */*) _rfp="$_rfp/${_rfr%%/*}"; _rfr="${_rfr#*/}" ;; *) return 1 ;; esac',
    '    { [ -L "$_rfp" ] && [ -d "$_rfp" ]; } || continue',
    '    _rfph="$(physical_path "$_rfp")" || _rfph=""',
    '    [ -n "$_rfph" ] || continue',
    "    # The tests materialize_links and credential_links apply, in their order: a",
    "    # loop (the target is a folder already passed on this path, holds the link's",
    "    # folder, or is the config root or a folder above it), then into the root",
    "    # as a folder link.",
    '    case "$_rfanc" in *"$_cnl$_rfph$_cnl"*) _rfkind=l; return 0 ;; esac',
    '    _rfpa="$(physical_path "${_rfp%/*}")" || _rfpa=""',
    '    if holds_path "$_rfph" "$_rfpa"; then _rfkind=l; return 0; fi',
    '    if holds_config_root "$_rfph"; then _rfkind=l; return 0; fi',
    '    if link_into_root "$_rfph" d; then _rfkind=r; return 0; fi',
    '    _rfanc="$_rfanc$_rfph$_cnl"',
    "  done",
    "}",
    "# #6063: the loop and into-root tests for a path a copy outside the section",
    "# folders reads through a link (CLAUDE.md, a settings script, the tenant",
    "# projects folder, a Codex home, skills root or instructions file). With d (a",
    "# folder) the config root or a folder above it is a loop (l); a path the root",
    "# holds outside the section folders is into the root (r). Each caller maps the",
    "# kind to its own omission. It always returns 0, so set -e never ends a run.",
    "root_content_refusal() { # $1 = a physical path, $2 = d for a folder; sets _rckind to l, r or empty",
    '  _rckind=""',
    '  [ -n "$1" ] || return 0',
    '  if [ "${2:-}" = d ] && holds_config_root "$1"; then _rckind=l; return 0; fi',
    '  if link_into_root "$1" "${2:-}"; then _rckind=r; fi',
    "  return 0",
    "}",
  ];
}
