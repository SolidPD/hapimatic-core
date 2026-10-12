// SPDX-License-Identifier: AGPL-3.0-only
/**
 * §13 Corresponding-Source offer (issues #3869 R2, #4676). Hapimatic is AGPL-3.0, so network
 * users of the running program must be able to reach the Corresponding Source for the EXACT
 * running version. The AGPL core ships as a SEPARATE public repository (ER D6), distinct from
 * the MIT toolkit repo (`PUBLIC_TOOLKIT_REPO`, never `SolidPD/claude-toolkit`).
 *
 * `PUBLIC_CORE_REPO_URL` is EMPTY until the public repo exists. While it is empty the About
 * page shows "—" in its Source row instead of a link that cannot resolve. At go-live (#4342
 * Task 9) one commit fills it AND `scripts/lib/public-core-repo.txt` with the same URL, in the
 * canonical form `https://github.com/SolidPD/<repo>`: `SolidPD` is GitHub's own spelling of the
 * org login, with no trailing `/` and no `.git`. `scripts/test-public-source-gate.sh` fails
 * when the two values differ or the URL is not in that form.
 *
 * INVARIANT: this module has NO imports. That test reads the constant from bash
 * (`bun -e 'import(...)'`), and an import would pull the app's module graph into it.
 */
export const PUBLIC_CORE_REPO_URL = "https://github.com/SolidPD/hapimatic-core";

const RELEASE_VERSION_RE = /^\d+\.\d+\.\d+$/;

/**
 * The §13 link for the running version, or `null` while the public repo is not configured.
 *
 * The link anchors to the release TAG, NOT a commit SHA (ER D7, legal memo L7.2): a
 * filtered/squashed export has different SHAs than the private repo, so a SHA deep-link would
 * 404 — hence `/tree/v<VERSION>`. Only a release version (`X.Y.Z`) has a public tag. While the
 * version is loading, if it failed to load, or for a test build (`X.Y.Z-AA`, never tagged), the
 * link is the repository root, exactly as configured.
 */
export function correspondingSourceHref(
  repoUrl: string,
  version: string | undefined
): string | null {
  if (repoUrl === "") return null;
  return version && RELEASE_VERSION_RE.test(version)
    ? `${repoUrl}/tree/v${version}`
    : repoUrl;
}
