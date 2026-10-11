// SPDX-License-Identifier: AGPL-3.0-only
import {
  PeerExchangeResponseSchema,
  SupervisedLoop,
  type FederationConfig,
  type JobRegistry,
  type PeerAnnouncement,
} from "@hapi/protocol";
import { detectCapabilities } from "./capabilityDetector";
import { MAX_PEERS } from "./nodeRegistry";
import { isValidPeerUrl } from "../utils/urlValidator";
import type { PeerStore, StoredPeer } from "../store/peerStore";

const FETCH_TIMEOUT_MS = 10_000;
const STARTUP_DELAY_MS = 5_000;

export type PeerAnnouncerOptions = {
  config: FederationConfig;
  apiToken: string | null;
  peerStore: PeerStore;
  /** Runtime job registry to register the periodic-announce loop into (#1963). */
  jobRegistry?: JobRegistry | null;
};

/**
 * PeerAnnouncer handles dynamic peer discovery for the P2P mesh.
 *
 * Startup: contacts seed peers → receives peer lists → announces to all.
 * Periodic: re-announces to all known peers at `announceIntervalMs`.
 * Incoming: when a peer announces to us (via the /announce route),
 *           the route handler calls `handleIncomingAnnouncement()`.
 */
export class PeerAnnouncer {
  private readonly config: FederationConfig;
  private readonly apiToken: string | null;
  private readonly peerStore: PeerStore;
  private readonly loop: SupervisedLoop;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: PeerAnnouncerOptions) {
    this.config = options.config;
    this.apiToken = options.apiToken;
    this.peerStore = options.peerStore;
    // #1963: the periodic re-announce is a supervised loop (finally-reschedule
    // + stall watchdog + job-registry registration). The startup seed-discovery
    // remains a separate one-shot; the loop is started after it.
    this.loop = new SupervisedLoop({
      name: "peer-announcer",
      node: this.config.nodeId,
      intervalMs: this.config.announceIntervalMs,
      immediate: false,
      registry: options.jobRegistry ?? undefined,
      tick: () => this.runAnnounceTick(),
    });
  }

  /** Start the announcer: initial seed discovery + periodic re-announcement. */
  start(): void {
    if (!this.config.selfUrl) {
      console.warn(
        "[PeerAnnouncer] selfUrl not configured — peer discovery disabled"
      );
      return;
    }

    if (this.config.seedPeers.length === 0) {
      console.log(
        "[PeerAnnouncer] No seed peers configured — waiting for incoming announcements"
      );
      this.loop.start();
      return;
    }

    console.log(
      `[PeerAnnouncer] Starting — ${this.config.seedPeers.length} seed peer(s), ` +
        `announce interval ${this.config.announceIntervalMs}ms`
    );

    // Delay startup to let the server fully initialize
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.discoverFromSeeds();
      this.loop.start();
    }, STARTUP_DELAY_MS);
  }

  /** Stop the announcer and clear timers. */
  stop(): void {
    this.loop.stop();
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    console.log("[PeerAnnouncer] Stopped");
  }

  /**
   * Handle an incoming announcement from another peer.
   * Called by the /announce route handler.
   * Returns the list of known peers for the peer exchange response.
   */
  handleIncomingAnnouncement(announcement: PeerAnnouncement): StoredPeer[] {
    // Check if this is a genuinely new peer before upserting
    const isNewPeer = !this.peerStore.get(announcement.selfId);

    // Reject new peers when at capacity (existing peers can always re-announce)
    if (isNewPeer && this.peerStore.getOnline().length >= MAX_PEERS) {
      console.warn(
        `[PeerAnnouncer] Rejected announcement from ${announcement.selfId} ` +
          `(${announcement.selfLabel}) — at MAX_PEERS capacity (${MAX_PEERS})`
      );
      return this.peerStore.getAll();
    }

    // #2531: a direct announce is proof of life — it clears any tombstone for
    // this peer and stamps direct_seen, so a stale gossiped tombstone can never
    // re-evict a node that just re-registered directly.
    this.peerStore.upsert(
      {
        id: announcement.selfId,
        url: announcement.selfUrl,
        label: announcement.selfLabel,
        capabilities: announcement.capabilities,
      },
      { direct: true }
    );

    console.log(
      `[PeerAnnouncer] Received announcement from ${announcement.selfId} (${announcement.selfLabel})${isNewPeer ? " [new]" : ""}`
    );

    // Only reverse-announce to genuinely new peers to prevent infinite
    // ping-pong loops between two peers re-announcing to each other.
    if (isNewPeer) {
      void this.announceTo(announcement.selfUrl).catch(err => {
        console.warn(
          `[PeerAnnouncer] Reverse-announce to ${announcement.selfUrl} failed:`,
          err instanceof Error ? err.message : err
        );
      });
    }

    // Return all known peers for the exchange response
    return this.peerStore.getAll();
  }

  /** Get the count of all known peers. */
  getPeerCount(): number {
    return this.peerStore.count();
  }

  /** Get all known peers (for the /peers route). */
  getKnownPeers(): StoredPeer[] {
    return this.peerStore.getAll();
  }

  /** Get all un-expired tombstones for the peer-exchange response (#2531). */
  getTombstones(): Array<{ id: string; evictedAt: number }> {
    return this.peerStore.getTombstones();
  }

  /** Contact seed peers and discover the mesh. */
  private async discoverFromSeeds(): Promise<void> {
    console.log(
      `[PeerAnnouncer] Discovering peers from ${this.config.seedPeers.length} seed(s)`
    );

    const results = await Promise.allSettled(
      this.config.seedPeers.map(url => this.announceTo(url))
    );

    let discoveredPeers = 0;
    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        discoveredPeers += result.value.length;
      }
    }

    console.log(
      `[PeerAnnouncer] Seed discovery complete — ${discoveredPeers} peer(s) discovered`
    );

    // Announce to all newly discovered peers (not just seeds)
    const allPeers = this.peerStore.getAll().filter(
      p => p.id !== this.config.nodeId // Don't announce to self
    );

    if (allPeers.length > 0) {
      console.log(
        `[PeerAnnouncer] Announcing to ${allPeers.length} discovered peer(s)`
      );
      await Promise.allSettled(allPeers.map(p => this.announceTo(p.url)));
    }
  }

  /** Announce ourselves to a single peer URL and process the response. */
  private async announceTo(peerUrl: string): Promise<StoredPeer[] | null> {
    const urlCheck = isValidPeerUrl(peerUrl);
    if (!urlCheck.valid) {
      console.warn(
        `[PeerAnnouncer] Refusing to announce to invalid URL ${peerUrl}: ${urlCheck.reason}`
      );
      return null;
    }

    const url = `${peerUrl}/api/federation/announce`;
    const payload: PeerAnnouncement = {
      selfId: this.config.nodeId,
      selfUrl: this.config.selfUrl!,
      selfLabel: this.config.nodeLabel,
      // Issue #1644: thread the role so the hub advertises the lease-coordinator capability.
      capabilities: detectCapabilities({ role: this.config.role }),
    };

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (this.apiToken) {
        headers["Authorization"] = `Bearer ${this.apiToken}`;
      }

      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!resp.ok) {
        console.warn(
          `[PeerAnnouncer] Announce to ${peerUrl} failed: HTTP ${resp.status}`
        );
        return null;
      }

      const rawBody = await resp.json().catch(err => {
        console.warn(
          `[PeerAnnouncer] Failed to parse response body from ${peerUrl}:`,
          err instanceof Error ? err.message : err
        );
        return null;
      });
      const parsed = PeerExchangeResponseSchema.safeParse(rawBody);
      if (!parsed.success) {
        console.warn(
          `[PeerAnnouncer] Invalid exchange response from ${peerUrl}`
        );
        return null;
      }

      // #2531: apply received death certificates FIRST (newest-wins, with the
      // proof-of-life override that protects a live re-registered node), THEN
      // upsert the surviving peers — so a tombstone in the same exchange wins
      // over a stale "online" entry for the same id.
      for (const t of parsed.data.tombstones) {
        if (t.id === this.config.nodeId) continue; // never tombstone self
        this.peerStore.applyReceivedTombstone(t.id, t.evictedAt);
      }

      // Store all validated peers from the exchange response. This is GOSSIP —
      // a tombstoned id is suppressed by upsert until its TTL lapses (the
      // anti-resurrection gate). New, un-tombstoned peers still discover here.
      for (const peer of parsed.data.peers) {
        if (peer.id === this.config.nodeId) continue; // Skip self
        const urlCheck = isValidPeerUrl(peer.url);
        if (!urlCheck.valid) {
          console.warn(
            `[PeerAnnouncer] Skipping peer ${peer.id} from exchange: ${urlCheck.reason}`
          );
          continue;
        }
        this.peerStore.upsert({
          id: peer.id,
          url: peer.url,
          label: peer.label,
          capabilities: peer.capabilities,
        });
      }

      return this.peerStore.getAll();
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        console.warn(`[PeerAnnouncer] Announce to ${peerUrl} timed out`);
      } else {
        console.warn(
          `[PeerAnnouncer] Announce to ${peerUrl} failed:`,
          err instanceof Error ? err.message : err
        );
      }
      return null;
    }
  }

  /**
   * One supervised announce tick: re-announce to all known peers, logging
   * any failure (preserving the prior "[PeerAnnouncer] Periodic announce
   * failed" log) then rethrowing so the SupervisedLoop records lastError +
   * re-arms via its finally.
   */
  private async runAnnounceTick(): Promise<void> {
    try {
      await this.announceToAllPeers();
    } catch (err) {
      console.warn(
        "[PeerAnnouncer] Periodic announce failed:",
        err instanceof Error ? err.message : err
      );
      throw err;
    }
  }

  /** Re-announce to all known online peers. */
  private async announceToAllPeers(): Promise<void> {
    if (!this.config.selfUrl) return;

    const peers = this.peerStore
      .getOnline()
      .filter(p => p.id !== this.config.nodeId);

    if (peers.length === 0) return;

    await Promise.allSettled(peers.map(p => this.announceTo(p.url)));
  }
}
