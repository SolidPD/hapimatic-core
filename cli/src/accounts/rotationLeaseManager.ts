// SPDX-License-Identifier: AGPL-3.0-only
import { configuration } from "@/configuration";
import { RotationLeaseClient } from "@/accounts/rotationLeaseClient";

/**
 * Process-singleton coordinator for the daemon's cross-machine rotation leases
 * (issue #1644).
 *
 * Both lease-acquisition sites — the proactive scheduler
 * (`TokenRefreshService.tick`) and the spawn-time recovery
 * (`isolatedSnapshotRecovery` tier-b, reached via the resolver in
 * `accountTokenInjection.ts`) — acquire through this ONE manager so they share a
 * single held-families set.
 *
 * Lease lifetime (issue #5021): the lease covers only the rotation critical
 * section. The daemon's rotation sites acquire, rotate, then {@link release} in
 * `finally`, so between rotations this node holds no row and another node's idle
 * backstop can rotate its own copy of the account. The 60s maintenance loop still
 * heartbeats whatever is held, which now only matters for a lease held across a
 * loop iteration. With `HAPI_ROTATION_LEASE_RELEASE_AFTER_ROTATION` off, nothing
 * releases and the heartbeat keeps this node the family's standing owner
 * (#1644 KD-D/KD-E), exactly as before #5021.
 *
 * The hub row is keyed by node, not process: a daemon release also frees a lease
 * a session wrapper on the same node took for spawn recovery. That matters only
 * for a copied chain, which the #4423 copy guard prevents (#5021 OR-1).
 *
 * A crashed holder stops heartbeating, so its lease expires via the hub TTL and
 * another node can acquire it (R4). All operations are **fail-open / never-throw**
 * — the underlying {@link RotationLeaseClient} grants on any error and the gate-off
 * path makes zero HTTP calls (R5/R6).
 *
 * Process scope (corrected by #4423): the module singleton is per PROCESS. The
 * daemon's idle backstop acquires and heartbeats here, but the spawn-time
 * resolver (`resolveAccountConfigDirForSession` → snapshot recovery) runs in the
 * SESSION WRAPPER process, not the daemon — so a lease acquired by recovery lives
 * in the wrapper's own singleton and is never heartbeated by the daemon's 60s
 * maintenance loop; it lapses at the hub TTL.
 */
export class RotationLeaseManager {
  private readonly client: RotationLeaseClient;
  private readonly held = new Set<string>();

  constructor(client?: RotationLeaseClient) {
    this.client = client ?? new RotationLeaseClient();
  }

  private get enabled(): boolean {
    return configuration.rotationLeaseEnabled;
  }

  /**
   * Acquire (or renew) the family lease and track it as held on grant. Returns
   * true ⇒ this node may rotate the family; false ⇒ another node holds it (defer).
   */
  async acquire(accountUuid: string): Promise<boolean> {
    const granted = await this.client.acquireRotationLease(accountUuid);
    // Only track when the feature is on — keeps the held set empty (and the
    // heartbeat loop a no-op) under the gate, preserving #1635 byte-equivalence.
    if (this.enabled) {
      if (granted) this.held.add(accountUuid);
      else this.held.delete(accountUuid);
    }
    return granted;
  }

  /** Heartbeat every held family; drop any the hub reports lost (R4). */
  async heartbeatHeld(): Promise<void> {
    if (!this.enabled || this.held.size === 0) return;
    for (const uuid of [...this.held]) {
      const stillHeld = await this.client.heartbeat(uuid);
      if (!stillHeld) this.held.delete(uuid);
    }
  }

  /**
   * Release one family's lease after a rotation completes (issue #5021).
   * Fail-open and never throws. The held set is updated before the HTTP call so
   * a concurrent {@link heartbeatHeld} cannot re-extend the lease being dropped.
   */
  async release(accountUuid: string): Promise<void> {
    // Gate off ⇒ zero HTTP and nothing tracked (#1635 byte-equivalence).
    if (!this.enabled) return;
    this.held.delete(accountUuid);
    await this.client.release(accountUuid);
  }

  /** Best-effort release of all held families (daemon shutdown). */
  async releaseAll(): Promise<void> {
    if (this.held.size === 0) return;
    for (const uuid of [...this.held]) {
      await this.client.release(uuid);
    }
    this.held.clear();
  }

  /** Diagnostic/test accessor: count of currently-held families. */
  get heldCount(): number {
    return this.held.size;
  }
}

/**
 * Process singleton — imported by both `daemon/run.ts` (scheduler inject +
 * heartbeat loop + shutdown release) and `claude/accountTokenInjection.ts`
 * (spawn-recovery acquire).
 */
export const rotationLeaseManager = new RotationLeaseManager();
