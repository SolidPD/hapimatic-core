// SPDX-License-Identifier: AGPL-3.0-only
/**
 * HAL skill-projection — provenance emission + drift check (issue #3130, epic
 * #3117 Sub-Issue P).
 *
 * Populates the frozen cross-repo `HarnessProvenance` contract (`@hapi/protocol`)
 * — `runtime.harness.{id,version}`, `model`, `canonical_blob_shas` — from a
 * projection's ACTUAL SHA-pinned input (the #3122 compiler already holds the blob
 * SHAs), and provides the pure drift check the scorecard (#3128) and conformance
 * suite (#3129) key on.
 *
 * `buildProvenance` and `isProjectionStale` are PURE (no I/O) so they are trivially
 * unit-testable; `probeHarnessVersion` / `resolveHarnessVersion` are the
 * best-effort `<cli> --version` probe (the one I/O touch), cached per binary and
 * fully defensive — a probe failure NEVER throws, it falls back to the manifest's
 * verified-against range.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HarnessProvenance } from "@hapi/protocol";

const execFileAsync = promisify(execFile);

/** Inputs for {@link buildProvenance} — the runtime facts a projection knows. */
export interface BuildProvenanceInput {
  /** The harness id (`claude` / `codex` / `gemini` / `opencode`, or a manifest id). */
  harness: string;
  /** The resolved harness version (exact from a probe, or a `range:`-prefixed fallback). */
  version?: string;
  /** The spawn's selected model id; omit for a default spawn (reader attributes harness-default). */
  model?: string;
  /** The SHA-pinned canonical blob SHAs the projection was built from (#3122 input). */
  blobShas: readonly string[];
}

/**
 * Assemble the frozen `HarnessProvenance` contract from the runtime facts. Pure —
 * no I/O. `version`/`model` are omitted (not set to `undefined`) when absent so a
 * legacy reader that iterates keys sees a clean record (R4).
 */
export function buildProvenance(
  input: BuildProvenanceInput
): HarnessProvenance {
  const harness: { id: string; version?: string } = { id: input.harness };
  if (input.version) {
    harness.version = input.version;
  }
  const provenance: HarnessProvenance = {
    runtime: { harness },
    canonical_blob_shas: [...input.blobShas],
  };
  if (input.model) {
    provenance.model = input.model;
  }
  return provenance;
}

/**
 * Drift check (R5) — the mechanical drift backbone. Returns `true` when a
 * session's `canonical_blob_shas` differ (as a SET) from canonical HEAD, i.e. the
 * projection is STALE relative to the current canonical blobs. Pure + order- and
 * duplicate-insensitive (it compares sorted values). A provenance record with NO
 * `canonical_blob_shas` (legacy / unavailable projection) compares as the empty
 * set — stale iff canonical HEAD is non-empty.
 */
export function isProjectionStale(
  provenance: HarnessProvenance,
  canonicalHeadShas: readonly string[]
): boolean {
  const session = [...(provenance.canonical_blob_shas ?? [])].sort();
  const head = [...canonicalHeadShas].sort();
  if (session.length !== head.length) {
    return true;
  }
  return session.some((sha, i) => sha !== head[i]);
}

/**
 * Cache of `<binary> --version` probe results (`null` = probed-and-unavailable).
 * Probing once per binary keeps the projection hot path off a subprocess per
 * spawn.
 */
const versionProbeCache = new Map<string, string | null>();

/** Reset the probe cache — test-only seam (a fresh probe per test binary). */
export function _clearHarnessVersionCache(): void {
  versionProbeCache.clear();
}

/**
 * Best-effort `<binary> --version` probe → the first semver-ish token, or `null`
 * when the binary is missing / errors / prints no version. Cached per binary;
 * never throws (a 2s timeout bounds a hung binary).
 */
export async function probeHarnessVersion(
  binary: string
): Promise<string | null> {
  const cached = versionProbeCache.get(binary);
  if (cached !== undefined) {
    return cached;
  }
  let version: string | null = null;
  try {
    const { stdout } = await execFileAsync(binary, ["--version"], {
      timeout: 2000,
    });
    const match = stdout.match(/\d+\.\d+\.\d+[^\s]*/);
    version = match ? match[0] : null;
  } catch {
    version = null;
  }
  versionProbeCache.set(binary, version);
  return version;
}

/**
 * Resolve the harness version for provenance: the exact probed version, or the
 * manifest's verified-against RANGE with an explicit `range:` prefix so a
 * consumer never mistakes a range for an exact installed version (directive
 * Task 2). Never throws.
 */
export async function resolveHarnessVersion(
  binary: string,
  verifiedAgainst: string
): Promise<string> {
  const probed = await probeHarnessVersion(binary);
  return probed ?? `range:${verifiedAgainst}`;
}
