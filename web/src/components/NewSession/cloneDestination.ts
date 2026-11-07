// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Clone-on-spawn destination helpers (#6312).
 *
 * The Create page clones a picked repository into `~/projects/<name>`. Once the
 * picker lists organization and collaborator repositories, two repositories can
 * share a name (`MattStarfield/Vectis` and `SolidPD/Vectis`). If the default folder
 * already holds the OTHER one, the daemon skips the clone (it never clones into a
 * non-empty folder) and the session would silently open the wrong repository — so
 * the page redirects such a pick to an owner-qualified folder instead.
 */

/** True when two `owner/name` strings name the same repository (GitHub is case-insensitive). */
export function sameRepo(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * The owner part of `owner/name` (#6326 — the picker's owner chips). A string with no
 * slash is returned whole.
 */
export function repoOwner(nameWithOwner: string): string {
  const slash = nameWithOwner.indexOf("/");
  return slash === -1 ? nameWithOwner : nameWithOwner.slice(0, slash);
}

/** The default clone destination: `~/projects/<name>` (the pre-#6312 rule, unchanged). */
export function defaultCloneDir(repo: { name: string }): string {
  return `~/projects/${repo.name}`;
}

/**
 * The destination used when `~/projects/<name>` already holds a different
 * repository: `~/projects/<owner>-<name>`.
 */
export function ownerQualifiedCloneDir(nameWithOwner: string): string {
  const slash = nameWithOwner.indexOf("/");
  if (slash === -1) return `~/projects/${nameWithOwner}`;
  const owner = nameWithOwner.slice(0, slash);
  const name = nameWithOwner.slice(slash + 1);
  return `~/projects/${owner}-${name}`;
}

/**
 * The auto-detected Repo field's label: `name` for a repository the selected
 * account owns (the pre-#6312 display), `owner/name` otherwise — so a folder that
 * holds someone else's same-named repository is visible at a glance. With no
 * account selected, the owner is always shown.
 */
export function detectedRepoLabel(
  nameWithOwner: string,
  account: string | null
): string {
  const slash = nameWithOwner.indexOf("/");
  if (slash === -1) return nameWithOwner;
  const owner = nameWithOwner.slice(0, slash);
  if (account && owner.toLowerCase() === account.toLowerCase()) {
    return nameWithOwner.slice(slash + 1);
  }
  return nameWithOwner;
}
