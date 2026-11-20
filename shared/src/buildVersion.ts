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
 * Issue #6800: true when a sibling Hapimatic daemon on this machine runs an
 * older build than `ownVersion`, so its CredentialsWatcher may still copy the
 * `~/.claude` login chain. Build order, so `1.1.11-AA` (which carries #6800)
 * is newer than a released `1.1.11` (which does not). A sibling version that
 * is missing or does not parse counts as older (the safe side). Used by the
 * CLI's shared-chain detector and the server's sign-in warning.
 */
export function isOlderSiblingVersion(
  siblingVersion: string | null | undefined,
  ownVersion: string
): boolean {
  if (!siblingVersion) return true;
  const order = compareBuildVersions(siblingVersion, ownVersion);
  return order === null || order < 0;
}
