// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HarnessDescriptor, InstallFlavor } from "@hapi/protocol";

/**
 * Harness detection primitives (issue #1770). Each function is TOTAL and
 * NON-THROWING (R5): on any failure — binary missing, subprocess timeout,
 * network error, malformed output — it returns `null`/`false`. The poll service
 * (`harnessPollService.ts`) records those nulls as state (`last_error`) rather
 * than letting a failure trip the SupervisedLoop's death handling.
 *
 * Binary resolution mirrors `server/src/utils/mcpPoller.ts` `findClaudePath`
 * (KD-5): a systemd-launched server has a minimal PATH, so a naive `which` alone
 * fails in production. The npm-latest fetch (KD-6) uses the registry HTTP API,
 * NOT a `npm view` subprocess — no subprocess to fail under that minimal PATH.
 *
 * Subprocess execution uses `execFile` (argv array, NO shell) with a hard
 * timeout — never a shell string — and the argv comes from the code-defined
 * registry (`registry.ts`), never user input, so there is no injection surface.
 */

const execFileAsync = promisify(execFile);

/** Timeout for the `--version` detect subprocess. */
const DETECT_TIMEOUT_MS = 10_000;
/** Timeout for the npm-registry + changelog HTTP fetches. */
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Resolve the absolute path of the detect binary. For a session-backend harness
 * prefer the explicitly-configured `claudePath` (federation #933); otherwise
 * resolve the first token of `detect.cmd` via `Bun.which` then well-known
 * install locations. Returns null when unresolvable (→ caller records an error).
 */
export function resolveDetectBinary(
  descriptor: HarnessDescriptor,
  opts: { claudePath?: string } = {}
): string | null {
  try {
    const firstToken = descriptor.detect.cmd.trim().split(/\s+/)[0];
    if (!firstToken) return null;

    // An absolute path baked into the cmd → use as-is if it exists.
    if (firstToken.startsWith("/")) {
      return existsSync(firstToken) ? firstToken : null;
    }

    // Session backend: prefer the configured claude path (#933) when it is an
    // existing absolute path.
    if (
      descriptor.is_session_backend &&
      opts.claudePath &&
      opts.claudePath.startsWith("/") &&
      existsSync(opts.claudePath)
    ) {
      return opts.claudePath;
    }

    // Bun-native PATH resolution.
    const fromPath = Bun.which(firstToken);
    if (fromPath) return fromPath;

    // Well-known install locations (systemd daemons have a minimal PATH).
    const home = homedir();
    const candidates = [
      join(home, ".local", "bin", firstToken),
      join(home, ".npm-global", "bin", firstToken),
      `/usr/local/bin/${firstToken}`,
      `/usr/bin/${firstToken}`,
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Run the detect command and extract the installed version via
 * `detect.version_regex`. Returns the first capture group (or the whole match
 * when the regex has none), or null on any failure.
 */
export async function detectInstalledVersion(
  descriptor: HarnessDescriptor,
  opts: { claudePath?: string; timeoutMs?: number } = {}
): Promise<string | null> {
  try {
    const bin = resolveDetectBinary(descriptor, opts);
    if (!bin) return null;
    const args = descriptor.detect.cmd.trim().split(/\s+/).slice(1);
    const { stdout } = await execFileAsync(bin, args, {
      timeout: opts.timeoutMs ?? DETECT_TIMEOUT_MS,
    });
    const match = new RegExp(descriptor.detect.version_regex).exec(stdout);
    if (!match) return null;
    return match[1] ?? match[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch the latest installable version. For `type: "npm"` this reads the npm
 * registry's `latest` dist-tag over HTTP (no subprocess — robust under the
 * minimal systemd PATH). Returns null on any failure or an unhandled source type.
 */
export async function fetchLatestVersion(
  descriptor: HarnessDescriptor,
  opts: { timeoutMs?: number } = {}
): Promise<string | null> {
  try {
    if (descriptor.latest_source.type === "npm") {
      const ref = descriptor.latest_source.ref;
      const res = await fetch(`https://registry.npmjs.org/${ref}/latest`, {
        signal: AbortSignal.timeout(opts.timeoutMs ?? FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { version?: unknown };
      return typeof body.version === "string" ? body.version : null;
    }
    // `github_release` has no descriptor in Sub A; a future one is additive.
    return null;
  } catch {
    return null;
  }
}

/**
 * Fetch the raw changelog text. Persisted during the poll (KD-7) and served
 * server-side to #1771; never rides on the status wire. Returns null on failure.
 */
export async function fetchChangelog(
  descriptor: HarnessDescriptor,
  opts: { timeoutMs?: number } = {}
): Promise<string | null> {
  try {
    const res = await fetch(descriptor.changelog.url, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/** Parse a leading `X.Y.Z` semver triple. Returns null when the string has no
 *  leading semver (e.g. a git-sha version). */
function parseSemver(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Compare two semver triples: <0 if a<b, 0 if equal, >0 if a>b; null when
 *  either side is not parseable as semver. */
function compareSemver(a: string, b: string): number | null {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/**
 * Whether an update is available. TOTAL: null inputs → false. When both parse
 * as semver, true only when `latest` is strictly newer than `installed`. When
 * either is unparseable, falls back to plain string inequality (any difference
 * ⇒ update available) so a non-semver version still surfaces a change.
 */
export function computeUpdateAvailable(
  installed: string | null,
  latest: string | null
): boolean {
  if (!installed || !latest) return false;
  if (installed === latest) return false;
  const cmp = compareSemver(installed, latest);
  if (cmp === null) return installed !== latest;
  return cmp < 0;
}

/**
 * Classify the install flavor from a RESOLVED binary path (the flavor-detection
 * seam #1774 consumes). Realpaths the binary, then inspects the path:
 *   - under `.local/share/claude/versions/` (native-installer layout) → "native"
 *   - inside a `node_modules` tree (npm global install) → "npm"
 *   - otherwise null (indeterminate — callers never guess).
 * Pure path inspection, no execution.
 */
export function detectInstallFlavor(
  resolvedBinaryPath: string
): InstallFlavor | null {
  try {
    if (!resolvedBinaryPath) return null;
    let real = resolvedBinaryPath;
    try {
      real = realpathSync(resolvedBinaryPath);
    } catch {
      // Broken symlink / missing target — inspect the raw path instead.
      real = resolvedBinaryPath;
    }
    const normalized = real.replace(/\\/g, "/");
    if (normalized.includes("/.local/share/claude/versions/")) {
      return "native";
    }
    if (normalized.includes("/node_modules/@anthropic-ai/claude-code")) {
      return "npm";
    }
    if (normalized.includes("/node_modules/")) {
      return "npm";
    }
    return null;
  } catch {
    return null;
  }
}
