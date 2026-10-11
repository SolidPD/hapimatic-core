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
 * single held-families set. The daemon's 60s maintenance loop heartbeats that set
 * to keep this node a STABLE owner (KD-D standing lease): once a node owns a
 * family, peers keep deferring instead of re-rotating, which is what converts the
 * cross-machine ping-pong into a one-time re-login on the non-owner (KD-E).
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
