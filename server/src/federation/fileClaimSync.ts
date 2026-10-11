// SPDX-License-Identifier: AGPL-3.0-only
import { FileClaimSyncSnapshotSchema } from "@hapi/protocol";
import type { FileClaimSyncSnapshot } from "@hapi/protocol";

import type { ErrorLogger } from "../logging/errorLogger";
import type { StoredFileClaim } from "../store/types";

/**
 * Epic #1965 (File Conflict Monitor) Sub D / #1969 — federation-wide claim sync.
 *
 * In-memory CRDT replica of EVERY peer node's live file-claims. Each peer owns a
 * register keyed by its `nodeId`; the value is `{ version, claims }` = that
 * peer's live-claim snapshot at a monotonic (wall-clock-max) version.
 *
 * Merge rule (per-node last-writer-wins on `version`): accept an incoming
 * snapshot for a `nodeId` iff its `version` is strictly newer than the stored
 * register. Because a claim row is written by exactly ONE node (single-writer-
 * per-node, K2 — claims post to the session's OWN node; the `handleSessionEnd`
 * auto-release + the 60 s reaper both run there), two nodes never contend on the
 * same register, so this map of per-node LWW-registers is conflict-free BY
 * CONSTRUCTION — commutative, associative, and idempotent (R2). Release-wins (R3)
 * falls out for free: a release is simply a later snapshot with the claim absent
 * AND a higher version, so it always wins over the earlier add regardless of
 * arrival order or duplication.
 *
 * Kept OUT of the local `session_file_claims` store on purpose (K3): #1968's
 * `reapOrphanedClaims` / `filterClaimsToLiveSessions` use the LOCAL live-session
 * set and would soft-release or hide foreign-node claims. Foreign snapshots
 * already carry only the owner's LIVE, #1968-liveness-filtered claims (the emit
 * in `SyncEngine.buildFileClaimSnapshot`), so this replica needs no further
 * liveness filtering.
 *
 * Modeled on `NodeRegistry.sessionCache` (the per-node session map) for reviewer
 * familiarity, and on the `PeerStore` module shape.
 */

/** Defense vs a malformed/hostile peer: cap the claims a single merge accepts. */
const MAX_CLAIMS_PER_SNAPSHOT = 5000;

/**
 * A claim tagged with the `nodeId` that owns it. The cross-node union
 * (`GET /file-claims`, Task 11) returns these so a consumer can attribute each
 * claim to its source node — the "sessions + node" column #1971 renders (M4).
 * The tag rides along legally because `FileClaimSchema` is `.passthrough()` and
 * `StoredFileClaim` carries no `nodeId` field of its own.
 */
export type NodeTaggedClaim = StoredFileClaim & { nodeId: string };

interface Replica {
  version: number;
  claims: StoredFileClaim[];
}

export class FileClaimSync {
  private readonly ownNodeId: string;
  private readonly errorLogger: ErrorLogger | null;
  /** peer `nodeId` → its latest accepted `{ version, live-claim snapshot }`. */
  private readonly replicas = new Map<string, Replica>();

  constructor(ownNodeId: string, errorLogger: ErrorLogger | null = null) {
    this.ownNodeId = ownNodeId;
    this.errorLogger = errorLogger;
  }

  /**
   * CRDT merge — the ONE code path both sync flows share (the SSE-bridge fast
   * path AND the poll anti-entropy backstop). Validates the untrusted snapshot
   * (the bridge receive path is a raw `JSON.parse(...) as SyncEvent` with NO
   * upstream Zod — M5), rejects our own node id (self-merge double-count defense,
   * L7) and over-cap payloads, then applies the per-node LWW-version rule.
   * Returns whether the replica changed (for logging/diagnostics).
   *
   * Idempotent + commutative + monotonic: re-delivering, reordering, or
   * duplicating deltas converges to the same state, because acceptance depends
   * ONLY on `(nodeId, version)`, never on arrival order (R2).
   */
  mergeSnapshot(snapshot: FileClaimSyncSnapshot): boolean {
    // The static type is a promise the wire cannot keep (bridge receive is a raw
    // cast), so re-validate at this trust boundary.
    const parsed = FileClaimSyncSnapshotSchema.safeParse(snapshot);
    if (!parsed.success) {
      this.errorLogger?.warn("Rejected malformed file-claim snapshot", {
        category: "federation",
        context: { issues: parsed.error.issues.slice(0, 5) },
      });
      return false;
    }
    const { nodeId, version, claims } = parsed.data;

    // Self-merge defense (L7): our own snapshot must never fold into a replica —
    // it would double-count our claims into the cross-node union.
    if (nodeId === this.ownNodeId) return false;

    if (claims.length > MAX_CLAIMS_PER_SNAPSHOT) {
      this.errorLogger?.warn("Rejected oversized file-claim snapshot", {
        category: "federation",
        context: {
          nodeId,
          count: claims.length,
          cap: MAX_CLAIMS_PER_SNAPSHOT,
        },
      });
      return false;
    }

    // Per-node LWW: accept iff STRICTLY newer than what we hold. `?? -1` lets a
    // fresh snapshot (any version >= 0) into a never-seen OR dropped-then-rejoined
    // (R6) register regardless of its absolute version.
    const current = this.replicas.get(nodeId);
    if (current !== undefined && version <= current.version) return false;

    // `claims` is `FileClaim[]` (the snapshot schema's inferred type), which is
    // structurally the store's `StoredFileClaim`. Reconstruct the known columns
    // so the replica holds exactly the `StoredFileClaim` shape (drops any
    // `.passthrough()` extras a peer may have appended).
    const stored: StoredFileClaim[] = claims.map(c => ({
      id: c.id,
      sessionId: c.sessionId,
      repo: c.repo,
      path: c.path,
      claimType: c.claimType,
      changeKind: c.changeKind,
      claimedAt: c.claimedAt,
      releasedAt: c.releasedAt,
    }));
    this.replicas.set(nodeId, { version, claims: stored });
    return true;
  }

  /**
   * R5: the union across ALL peer replicas of live claims matching `(repo,
   * path)`, each tagged with the peer `nodeId` that owns it. Foreign snapshots
   * already contain only the owner's live, #1968-liveness-filtered claims, so no
   * extra filtering is applied here. The caller (the `GET /file-claims` union,
   * Task 11) de-dups against its local set by claim `id`.
   */
  getClaimsByPath(repo: string, path: string): NodeTaggedClaim[] {
    const out: NodeTaggedClaim[] = [];
    for (const [nodeId, replica] of this.replicas.entries()) {
      for (const claim of replica.claims) {
        if (claim.repo === repo && claim.path === path) {
          out.push({ ...claim, nodeId });
        }
      }
    }
    return out;
  }

  /** The own node id — used to tag LOCAL claims in the cross-node union (M4). */
  getOwnNodeId(): string {
    return this.ownNodeId;
  }

  /**
   * R6: drop a peer's replica (called on the edge-triggered transition into
   * offline / on eviction). Returns whether a register existed. A subsequent
   * fresh snapshot re-populates it (the `?? -1` guard in `mergeSnapshot`).
   */
  dropNode(nodeId: string): boolean {
    return this.replicas.delete(nodeId);
  }

  /** Diagnostics/tests: the peer node ids currently replicated. */
  getReplicaNodeIds(): string[] {
    return [...this.replicas.keys()];
  }

  /** Diagnostics/tests: the version currently held for a peer (or undefined). */
  getVersion(nodeId: string): number | undefined {
    return this.replicas.get(nodeId)?.version;
  }

  /** Diagnostics/tests: number of replicated peers. */
  size(): number {
    return this.replicas.size;
  }
}
