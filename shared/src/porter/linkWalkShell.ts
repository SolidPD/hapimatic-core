// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Configuration Porter — the one bash symbolic-link walk (issue #4188, K-INC-2).
 *
 * Every bash surface that follows a file's link chain to decide what to package
 * calls this function: the CLAUDE.md include base and each `@`-include
 * (`./claudeMdIncludeShell`), and each settings script (`./settingsScriptShell`,
 * #4173). Before #4188 the walk was written out twice, and each copy carried
 * the details that make it safe; one copy drifting from the other would package
 * a file the other refuses. (`physical_path` in `./credentialNamesShell` reads
 * links part by part for a different question, the physical path the #4172
 * credential check needs.) The PowerShell exporter's twin is `walkLink`
 * (`./exportScriptPowerShell`), pinned to this one by the #3447 equivalence
 * harness; its CLAUDE.md, include and settings-script lines
 * (`./settingsScriptPowerShell`, since #4928) all call it.
 *
 * NODE-FREE (R7): like every non-test module under `shared/src/porter`, this
 * file only builds strings.
 */

/** The name of the bash function {@link porterWalkLinkLines} defines. */
export const PORTER_WALK_LINK_FUNCTION = "porter_walk_link";

/**
 * The bash lines that define `porter_walk_link <path>`. Each emitted script
 * defines it ONCE, before the first caller, and the caller copies the results
 * into its own names right after the call (a later call overwrites them).
 *
 * It follows the chain from `<path>` and sets:
 * - `_wl_path`: where the walk stopped (the final target when it resolved);
 * - `_wl_dir`: the directory of `_wl_path`;
 * - `_wl_hops`: the number of links followed;
 * - `_wl_status`: 0 when the walk stopped at a path that is not a link (that
 *   path may not exist); 1 on an unusable link target (empty, `.`, `..`, or
 *   ending in `/`, `/.` or `/..`) or a link still unresolved after 40 hops (a
 *   cycle or an over-long chain); 2 on a backslash in a link target.
 *
 * It always returns 0, so a `set -e` caller is never ended by a refusal; the
 * caller decides what a non-zero `_wl_status` means.
 *
 * The recipe, bash 3.2 safe (macOS) and the same on every caller:
 * - `readlink` without `-f`, and `--` before every `readlink`/`dirname` operand
 *   (#4189: a leading `-` is then never read as an option);
 * - the `echo x` sentinel on every command substitution, so a link target or a
 *   folder name that ends in a newline keeps it (`$(…)` strips trailing
 *   newlines: a target `s.md<LF>` would pass a `.md` name check as `s.md`, and a
 *   folder `a<LF>` would become `a`, #4189 review OOS-2);
 * - a backslash is a literal filename character here, never a separator, so
 *   the walk stops on it rather than guess (PowerShell agrees);
 * - at most 40 links, Linux's own bound (`MAXSYMLINKS`), so there a chain the
 *   walk refuses is one `[ -f ]` and `[ -e ]` also fail on (ELOOP). A kernel
 *   with a lower bound (macOS is believed to use 32) makes `-f` skip a shorter
 *   CLAUDE.md chain than the walk would accept. Both exporters let the OS
 *   decide whether CLAUDE.md is a file: bash with `[ -f ]` and `cp -p`, and
 *   PowerShell with `[IO.File]::Copy` and then, off Windows, the same
 *   `test -f` (#4928), so they agree by construction. Only the Linux bound is
 *   runtime-tested; no macOS host or CI leg runs the lower one, so that case
 *   is unverified.
 *
 * It reads only link names and link targets; it never opens a file.
 */
export function porterWalkLinkLines(): string[] {
  return [
    `${PORTER_WALK_LINK_FUNCTION}() { # $1 = a path; sets _wl_path, _wl_dir, _wl_hops, _wl_status (see linkWalkShell.ts)`,
    '  _wl_path="$1"',
    "  _wl_hops=0",
    "  _wl_status=0",
    "  while :; do",
    "    # The directory of the current path, kept whole even when its name ends",
    "    # in a newline (the `echo x` sentinel; dirname adds one newline of its own).",
    '    _wl_dir="$(dirname -- "$_wl_path"; echo x)"',
    '    _wl_dir="${_wl_dir%x}"',
    '    _wl_dir="${_wl_dir%?}"',
    '    [ -L "$_wl_path" ] || return 0',
    '    if [ "$_wl_hops" -ge 40 ]; then _wl_status=1; return 0; fi',
    '    _wl_t="$(readlink -- "$_wl_path"; echo x)"',
    '    _wl_t="${_wl_t%x}"',
    '    _wl_t="${_wl_t%?}"',
    '    case "$_wl_t" in ""|.|..|*/|*/.|*/..) _wl_status=1; return 0 ;; esac',
    '    case "$_wl_t" in *\\\\*) _wl_status=2; return 0 ;; esac',
    '    case "$_wl_t" in /*) _wl_path="$_wl_t" ;; *) _wl_path="$_wl_dir/$_wl_t" ;; esac',
    "    _wl_hops=$((_wl_hops + 1))",
    "  done",
    "}",
  ];
}
