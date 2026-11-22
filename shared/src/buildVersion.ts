// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Build-version order (issue #4594; moved here from `cli/src/version.ts` by
 * #6800 so the CLI and the server share one rule).
 */

const BUILD_VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([A-Z]+))?$/;

/**
 * Orders two build versions: negative when `a` is older than `b`, positive when
 * newer, 0 when equal, and null when either does not parse.
 *
 * This is NOT semver. A suffixed local test build sits ON TOP of its base
 * (#1819: `version:test` claims no patch number), so `1.0.N-AA` is newer than
 * `1.0.N`, and `-AB` is newer than `-AA`.
 */
export function compareBuildVersions(a: string, b: string): number | null {
  const ma = a.match(BUILD_VERSION_RE);
  const mb = b.match(BUILD_VERSION_RE);
  if (!ma || !mb) {
    return null;
  }
  for (let i = 1; i <= 3; i++) {
    const delta = Number(ma[i]) - Number(mb[i]);
    if (delta !== 0) {
      return Math.sign(delta);
    }
  }
  const suffixA = ma[4] ?? "";
  const suffixB = mb[4] ?? "";
  if (suffixA.length !== suffixB.length) {
    return Math.sign(suffixA.length - suffixB.length);
  }
  return suffixA === suffixB ? 0 : suffixA < suffixB ? -1 : 1;
}

/**
 * Issue #6161 (DEC-3): the first build whose daemon runs no CredentialsWatcher,
 * so it can no longer copy the `~/.claude` login chain over a sign-in. #6800's
 * squash (`f84a9b32a`) still carries 1.2.6; the next commit (`527762b44`) is the
 * v1.2.7 release.
 */
export const FIRST_WATCHER_FREE_VERSION = "1.2.7";

/**
 * Issue #6800: true when a sibling Hapimatic daemon on this machine may still
 * copy the `~/.claude` login chain. Build order, so `1.1.11-AA` (which carries
 * #6800) is newer than a released `1.1.11` (which does not). A sibling version
 * that is missing or does not parse counts as older (the safe side). Used by
 * the CLI's shared-chain detector and the server's sign-in warning.
 *
 * Issue #6161 (DEC-3): the sibling is compared with the OLDER of `ownVersion`
 * and {@link FIRST_WATCHER_FREE_VERSION}, so for every build at or above 1.2.7 a
 * sibling counts as older only below 1.2.7 (or unparsable): a sibling one build
 * behind no longer runs the watcher. A `1.2.6-AA` test build of the #6800
 * branch still counts as older (the safe side). For a caller below 1.2.7 (only
 * test fixtures) the rule is #6800's, so their cases keep their meaning.
 */
export function isOlderSiblingVersion(
  siblingVersion: string | null | undefined,
  ownVersion: string
): boolean {
  if (!siblingVersion) return true;
  const ownOrder = compareBuildVersions(ownVersion, FIRST_WATCHER_FREE_VERSION);
  const reference =
    ownOrder !== null && ownOrder > 0 ? FIRST_WATCHER_FREE_VERSION : ownVersion;
  const order = compareBuildVersions(siblingVersion, reference);
  return order === null || order < 0;
}
