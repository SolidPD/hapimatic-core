// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";
import { isValidPeerUrl } from "../utils/urlValidator";

export type StoredPeer = {
  id: string;
  url: string;
  label: string;
  capabilities: string[];
  firstSeen: number;
  lastSeen: number;
  status: "online" | "offline" | "draining";
};

/**
 * Default tombstone TTL: 24h (#2531). Long enough to suppress mesh-wide gossip
 * resurrection across many 5-min announce cycles, short enough that a same-id
 * redeploy can rejoin once it lapses. Override via env or the constructor.
 */
export const DEFAULT_TOMBSTONE_TTL_MS =
  Number(process.env.HAPI_FEDERATION_TOMBSTONE_TTL_MS) || 24 * 60 * 60 * 1000;

/**
 * SQLite-backed persistence for known federation peers.
 * Follows the existing store pattern: synchronous queries, Database in constructor.
 */
export class PeerStore {
  private readonly db: Database;
  /** #2531: tombstone lifetime before GC (ms). */
  private readonly tombstoneTtlMs: number;

  constructor(db: Database, opts?: { tombstoneTtlMs?: number }) {
    this.db = db;
    this.tombstoneTtlMs = opts?.tombstoneTtlMs ?? DEFAULT_TOMBSTONE_TTL_MS;
    this.ensureTable();
  }

  private ensureTable(): void {
    // DDL via prepare().run() per statement (the codebase convention — see
    // store/parityRuns.ts — so a single migration statement can't partially
    // apply and drop the rest).
    this.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS peers (
          id TEXT PRIMARY KEY,
          url TEXT NOT NULL,
          label TEXT NOT NULL,
          capabilities TEXT NOT NULL DEFAULT '[]',
          first_seen INTEGER NOT NULL,
          last_seen INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'online',
          direct_seen INTEGER NOT NULL DEFAULT 0
        )`
      )
      .run();
    // #2531: guarded migration for DBs created before the direct_seen column.
    // `direct_seen` is the NON-contaminated liveness signal — bumped ONLY by a
    // direct announce (handleIncomingAnnouncement), never by a gossip upsert — so
    // a stale gossiped tombstone can never re-evict a peer we've directly seen
    // alive more recently than the eviction (the R4 proof-of-life override).
    const cols = this.db.prepare("PRAGMA table_info(peers)").all() as Array<{
      name: string;
    }>;
    if (!cols.some(c => c.name === "direct_seen")) {
      this.db
        .prepare(
          "ALTER TABLE peers ADD COLUMN direct_seen INTEGER NOT NULL DEFAULT 0"
        )
        .run();
    }
    // #2531: death-certificate table. An explicit eviction writes a row here and
    // removes the live peer row; gossip re-upserts are suppressed until TTL.
    this.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS peer_tombstones (
          id TEXT PRIMARY KEY,
          evicted_at INTEGER NOT NULL
        )`
      )
      .run();
  }

  /**
   * Upsert a peer — insert or update on conflict.
   *
   * #2531: `opts.direct` distinguishes a DIRECT announce (the peer itself
   * contacted us — proof of life) from GOSSIP (a peer learned via a third-party
   * exchange list). A direct announce clears any tombstone for this id and
   * stamps `direct_seen`; a gossip upsert of a tombstoned id is SUPPRESSED (the
   * death certificate wins) until the tombstone's TTL lapses.
   */
  upsert(
    peer: {
      id: string;
      url: string;
      label: string;
      capabilities?: string[];
    },
    opts?: { direct?: boolean }
  ): void {
    const urlCheck = isValidPeerUrl(peer.url);
    if (!urlCheck.valid) {
      console.warn(
        `[PeerStore] Refusing to store peer ${peer.id}: ${urlCheck.reason}`
      );
      return;
    }

    if (opts?.direct) {
      // Proof of life: a direct announce overrides (clears) any tombstone.
      this.clearTombstone(peer.id);
    } else if (this.getTombstone(peer.id) !== null) {
      // Gossip re-add of a tombstoned peer — suppressed until the tombstone
      // expires. This is the anti-resurrection gate (R1/R4).
      return;
    }

    const now = Date.now();
    const caps = JSON.stringify(peer.capabilities ?? []);
    if (opts?.direct) {
      // Direct announce: (re)insert and stamp direct_seen = now.
      this.db
        .prepare(
          `INSERT INTO peers (id, url, label, capabilities, first_seen, last_seen, status, direct_seen)
           VALUES (?, ?, ?, ?, ?, ?, 'online', ?)
           ON CONFLICT(id) DO UPDATE SET
             url = excluded.url,
             label = excluded.label,
             capabilities = excluded.capabilities,
             last_seen = excluded.last_seen,
             status = 'online',
             direct_seen = excluded.direct_seen`
        )
        .run(peer.id, peer.url, peer.label, caps, now, now, now);
    } else {
      // Gossip: insert with direct_seen=0 for a new peer; NEVER bump direct_seen
      // on an existing row (keep the non-contaminated liveness signal intact).
      this.db
        .prepare(
          `INSERT INTO peers (id, url, label, capabilities, first_seen, last_seen, status, direct_seen)
           VALUES (?, ?, ?, ?, ?, ?, 'online', 0)
           ON CONFLICT(id) DO UPDATE SET
             url = excluded.url,
             label = excluded.label,
             capabilities = excluded.capabilities,
             last_seen = excluded.last_seen,
             status = 'online'`
        )
        .run(peer.id, peer.url, peer.label, caps, now, now);
    }
  }

  /** Get all known peers. */
  getAll(): StoredPeer[] {
    const rows = this.db
      .prepare("SELECT * FROM peers ORDER BY last_seen DESC")
      .all() as Array<{
      id: string;
      url: string;
      label: string;
      capabilities: string;
      first_seen: number;
      last_seen: number;
      status: string;
    }>;
    return rows.map(r => {
      let capabilities: string[] = [];
      try {
        capabilities = JSON.parse(r.capabilities) as string[];
      } catch {
        // Corrupted capabilities JSON — return empty array rather than crashing
      }
      return {
        id: r.id,
        url: r.url,
        label: r.label,
        capabilities,
        firstSeen: r.first_seen,
        lastSeen: r.last_seen,
        status: r.status as "online" | "offline" | "draining",
      };
    });
  }

  /** Get online peers only (excludes draining — they shouldn't receive new sessions). */
  getOnline(): StoredPeer[] {
    return this.getAll().filter(p => p.status === "online");
  }

  /** Get a single peer by ID. */
  get(id: string): StoredPeer | null {
    const row = this.db.prepare("SELECT * FROM peers WHERE id = ?").get(id) as {
      id: string;
      url: string;
      label: string;
      capabilities: string;
      first_seen: number;
      last_seen: number;
      status: string;
    } | null;
    if (!row) return null;
    let capabilities: string[] = [];
    try {
      capabilities = JSON.parse(row.capabilities) as string[];
    } catch {
      // Corrupted capabilities JSON — return empty array rather than crashing
    }
    return {
      id: row.id,
      url: row.url,
      label: row.label,
      capabilities,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      status: row.status as "online" | "offline" | "draining",
    };
  }

  /** Mark a peer as offline. */
  markOffline(id: string): void {
    this.db.prepare("UPDATE peers SET status = 'offline' WHERE id = ?").run(id);
  }

  /** Mark a peer as online (e.g., on successful poll or re-announcement). */
  markOnline(id: string): void {
    this.db
      .prepare("UPDATE peers SET status = 'online', last_seen = ? WHERE id = ?")
      .run(Date.now(), id);
  }

  /** Mark a peer as draining (existing sessions continue, no new sessions routed). */
  markDraining(id: string): void {
    this.db
      .prepare(
        "UPDATE peers SET status = 'draining', last_seen = ? WHERE id = ?"
      )
      .run(Date.now(), id);
  }

  /** Get peers that are currently draining. */
  getDraining(): StoredPeer[] {
    return this.getAll().filter(p => p.status === "draining");
  }

  /** Remove a peer entirely (rarely needed — prefer markOffline). */
  remove(id: string): void {
    this.db.prepare("DELETE FROM peers WHERE id = ?").run(id);
  }

  // ─── Tombstones (#2531): death certificates for explicit eviction ─────────

  /**
   * Explicitly evict a peer: write a death-certificate tombstone AND remove the
   * live row. Gossip re-upserts are then suppressed until the tombstone's TTL
   * lapses (see `upsert`) or a DIRECT announce clears it (see `clearTombstone`).
   * `evictedAt` defaults to now; pass a received value to record a gossiped one
   * (newest-wins on an existing tombstone).
   */
  tombstone(id: string, evictedAt: number = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO peer_tombstones (id, evicted_at) VALUES (?, ?)
         ON CONFLICT(id) DO UPDATE SET evicted_at = MAX(evicted_at, excluded.evicted_at)`
      )
      .run(id, evictedAt);
    this.db.prepare("DELETE FROM peers WHERE id = ?").run(id);
  }

  /** Clear a tombstone (a direct announce from the peer = proof of life). */
  clearTombstone(id: string): void {
    this.db.prepare("DELETE FROM peer_tombstones WHERE id = ?").run(id);
  }

  /**
   * The un-expired tombstone's `evictedAt` for `id`, or null. Lazily GCs an
   * expired tombstone so a same-id redeploy can rejoin once the TTL lapses.
   */
  getTombstone(id: string): number | null {
    const row = this.db
      .prepare("SELECT evicted_at FROM peer_tombstones WHERE id = ?")
      .get(id) as { evicted_at: number } | null;
    if (!row) return null;
    if (Date.now() - row.evicted_at >= this.tombstoneTtlMs) {
      this.db.prepare("DELETE FROM peer_tombstones WHERE id = ?").run(id);
      return null;
    }
    return row.evicted_at;
  }

  /** All un-expired tombstones (for the peer-exchange response). GCs first. */
  getTombstones(): Array<{ id: string; evictedAt: number }> {
    this.gcTombstones();
    const rows = this.db
      .prepare("SELECT id, evicted_at FROM peer_tombstones")
      .all() as Array<{ id: string; evicted_at: number }>;
    return rows.map(r => ({ id: r.id, evictedAt: r.evicted_at }));
  }

  /** Drop tombstones older than the TTL. */
  gcTombstones(): void {
    this.db
      .prepare("DELETE FROM peer_tombstones WHERE evicted_at < ?")
      .run(Date.now() - this.tombstoneTtlMs);
  }

  /**
   * Apply a tombstone received via the peer exchange (gossip). Newest-wins on an
   * existing tombstone. Skips (returns false) when the tombstone is already
   * expired, OR — the R4 proof-of-life override — when we have DIRECTLY observed
   * this peer alive more recently than `evictedAt` (a stale gossiped tombstone
   * must never re-evict a live, re-registered node). Returns true when applied
   * (peer removed + tombstone recorded locally for onward propagation).
   */
  applyReceivedTombstone(id: string, evictedAt: number): boolean {
    if (Date.now() - evictedAt >= this.tombstoneTtlMs) return false;
    const directSeen = this.getDirectSeen(id);
    if (directSeen !== null && directSeen > evictedAt) return false;
    this.tombstone(id, evictedAt);
    return true;
  }

  /**
   * The peer's `direct_seen` (last DIRECT announce, epoch ms), or null when the
   * peer row is absent. Never contaminated by gossip upserts, so it is the sound
   * liveness signal for the tombstone proof-of-life override.
   */
  private getDirectSeen(id: string): number | null {
    const row = this.db
      .prepare("SELECT direct_seen FROM peers WHERE id = ?")
      .get(id) as { direct_seen: number } | null;
    return row ? row.direct_seen : null;
  }

  /** Count of all known peers. */
  count(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM peers")
      .get() as { count: number };
    return row.count;
  }
}
