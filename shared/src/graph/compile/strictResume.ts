// SPDX-License-Identifier: AGPL-3.0-only
/**
 * STRICT_RESUME guard — issue #2886 (Graph Engineering Phase 1, sub-issue D),
 * requirements R2 + R5.
 *
 * Charter I.2: divergence between a launched workflow and a resumed one is
 * SILENT today (fail-open). STRICT_RESUME makes a compiled-artifact hash mismatch
 * an EXPLICIT, refusable condition — `recordLaunchHash` snapshots the artifact's
 * SHA-256 at launch, and `checkResume` refuses a resume whose current artifact
 * hashes differently, UNLESS the caller attests the change is append-only or an
 * approved migration.
 *
 * 🔴 R5 (Fallback Preservation Rule): this guard AUGMENTS, never replaces, the
 * existing resume path. When the hash MATCHES (or STRICT_RESUME is not engaged),
 * `checkResume` returns `{ allow: true }` and does nothing else — the prior
 * resume behavior is byte-for-byte unchanged. The guard only ever ADDS a refusal
 * on a genuine mismatch; it never removes an existing allow.
 *
 * v0.1 scope: this is a STANDALONE decision function. Wiring it into a live
 * session/driver resume is a DECLARED (not enforced) integration point — there
 * is no in-repo `resumeFromRunId` runtime to hook (directive Key Decisions).
 */
import type { CompiledWorkflow } from "./types";
import { hashObject } from "../../deterministicJson";

/**
 * Caller attestations that permit a resume DESPITE a hash mismatch. Per the
 * directive: `checkResume` itself verifies ONLY the hash — a one-way hash cannot
 * reconstruct the old artifact, so append-only / migration provenance is the
 * CALLER's concern. `appendOnly` is normally the result of `isAppendOnly`;
 * `approvedMigration` is an explicit human/ops attestation.
 */
export interface ResumeCheckOptions {
  /** The change is a structural superset-append (normally `isAppendOnly(old, new)`). */
  appendOnly?: boolean;
  /** The change is an explicitly approved migration. */
  approvedMigration?: boolean;
}

/** The resume decision. `allow:false` always carries a human-readable `reason`. */
export type ResumeDecision = { allow: true } | { allow: false; reason: string };

/**
 * Record the launch-time SHA-256 of a compiled artifact. Uses the DEFAULT
 * `DeterministicJsonOptions` — `checkResume` re-hashes with the SAME defaults, so
 * an options mismatch (which would cause permanent spurious refusal) is
 * impossible by construction.
 */
export function recordLaunchHash(compiled: CompiledWorkflow): string {
  return hashObject(compiled);
}

/**
 * Decide whether a resume is allowed.
 *
 *  - hash MATCHES → `{ allow: true }` (no-op; existing resume path untouched, R5).
 *  - hash MISMATCH + `appendOnly` attested → allow.
 *  - hash MISMATCH + `approvedMigration` attested → allow.
 *  - hash MISMATCH + neither → refuse with a reason (R2).
 *
 * Verifies ONLY the hash; the escapes are caller attestations (see
 * `ResumeCheckOptions`).
 */
export function checkResume(
  recordedHash: string,
  currentCompiled: CompiledWorkflow,
  opts: ResumeCheckOptions = {}
): ResumeDecision {
  const currentHash = hashObject(currentCompiled);
  if (currentHash === recordedHash) {
    return { allow: true };
  }
  if (opts.appendOnly === true) {
    return { allow: true };
  }
  if (opts.approvedMigration === true) {
    return { allow: true };
  }
  return {
    allow: false,
    reason:
      `STRICT_RESUME: compiled-artifact hash mismatch ` +
      `(recorded ${recordedHash.slice(0, 12)}…, current ${currentHash.slice(0, 12)}…) ` +
      `and neither appendOnly nor approvedMigration was attested`,
  };
}

/**
 * Stable key for an edge, used in the append-only superset check. The `from`/`to`
 * separator is written as the six-character U+0000 escape sequence — NEVER a raw
 * NUL byte, which would make this file binary to grep/rg/diff. The runtime value is
 * identical either way; issue #3161 replaced the pre-existing raw byte with the
 * escape per ruling R7 (same hygiene as `execute/identity.ts`). Do NOT revert it.
 */
function edgeKey(edge: { from: string; to: string }): string {
  return `${edge.from}\u0000${edge.to}`;
}

/**
 * Structural superset-append check: `newCompiled` is append-only relative to
 * `oldCompiled` iff EVERY old node is still present AND unchanged, and EVERY old
 * edge is still present — new nodes/edges may only be ADDED. A modification to
 * an existing node (e.g. a `step` becoming a `commit`, or a changed ledger) is
 * NOT append-only.
 *
 * Node identity is by `id`; "unchanged" is deep equality via the deterministic
 * hash (same primitive as the launch hash, so it sees ledger/idempotency-key
 * drift). This is the value a caller normally passes as
 * `ResumeCheckOptions.appendOnly`.
 */
export function isAppendOnly(
  oldCompiled: CompiledWorkflow,
  newCompiled: CompiledWorkflow
): boolean {
  const newNodeById = new Map(newCompiled.nodes.map(n => [n.id, n]));
  for (const oldNode of oldCompiled.nodes) {
    const current = newNodeById.get(oldNode.id);
    if (!current) return false; // an old node was removed → not append-only
    if (hashObject(current) !== hashObject(oldNode)) return false; // an old node changed
  }
  const newEdgeKeys = new Set(newCompiled.edges.map(edgeKey));
  for (const oldEdge of oldCompiled.edges) {
    if (!newEdgeKeys.has(edgeKey(oldEdge))) return false; // an old edge was removed
  }
  return true;
}
