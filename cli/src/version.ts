// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The CLI's own build version (issue #4594).
 *
 * `cli/package.json` has carried the upstream "0.6.0" since 2026-01-05 and is
 * never bumped: scripts/version-bump.ts writes only the ROOT package.json and
 * server/src/version.generated.ts. The server half of the same binary already
 * reads the real version from that generated file, which `build:single-exe`
 * regenerates from the root package.json and version-bump.ts commits beside it.
 * The CLI reads the same file, so `hapi --version`, `hapi doctor`, the machine
 * and session metadata and daemon.state.json all name the build that is running.
 * Always take the version from here, never from cli/package.json.
 */
import { VERSION, VERSION_TIMESTAMP } from "../../server/src/version.generated";

export const CLI_VERSION: string = VERSION;
export const CLI_VERSION_TIMESTAMP: string = VERSION_TIMESTAMP;

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
 * The line `hapi doctor` and `daemon start` print when the running daemon
 * recorded a different build from this CLI's, or null when they match or the
 * daemon recorded no version.
 *
 * D-4594-1 (ruled A, 2026-10-03): a build difference is REPORTED, never acted on.
 * No CLI command stops or replaces a running daemon because of it; the deploy
 * flows restart the daemon's unit, and that stays the only upgrade path.
 */
export function describeDaemonBuildSkew(
  daemonVersion: string | null | undefined,
  cliVersion: string = CLI_VERSION
): string | null {
  if (!daemonVersion || daemonVersion === cliVersion) {
    return null;
  }
  const order = compareBuildVersions(daemonVersion, cliVersion);
  if (order !== null && order < 0) {
    return `the daemon runs an older build (${daemonVersion}) than this CLI (${cliVersion}) — restart its unit to run this build`;
  }
  if (order !== null && order > 0) {
    return `the daemon runs a newer build (${daemonVersion}) than this CLI (${cliVersion}) — this CLI binary is older than the one the daemon started from`;
  }
  return `the daemon's build (${daemonVersion}) differs from this CLI's (${cliVersion}) — restart its unit to run this build`;
}

/**
 * #5103: the "Build skew: …" line `daemon start`, `daemon start-sync` and
 * `hapi claude` report for a live daemon whose build differs, or null.
 */
export function formatDaemonBuildSkew(daemon: {
  running: boolean;
  skew: string | null;
}): string | null {
  return daemon.running && daemon.skew ? `Build skew: ${daemon.skew}` : null;
}
