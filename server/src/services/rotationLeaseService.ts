// SPDX-License-Identifier: AGPL-3.0-only
import type { FederationConfig } from "@hapi/protocol";
import type { LeaseStore } from "../store/leaseStore";
import type { PeerAnnouncer } from "../federation/peerAnnouncer";

/**
 * Federation capability advertised by the hub so peers can discover the
 * authoritative lease coordinator. Single source of truth — the capability
 * detector (issue #1644 Task 4) imports this same constant.
 */
export const ACCOUNT_LEASE_COORDINATOR_CAPABILITY = "account-lease-coordinator";

/** TTL = 3× the 60s daemon heartbeat (KD-G). Env-overridable in server.ts wiring. */
export const DEFAULT_ROTATION_LEASE_TTL_MS = 180_000;
const COORDINATOR_TIMEOUT_MS = 4_000;

export type RotationLeaseReason =
  | "hub-local"
  | "coordinator"
  | "federation-disabled"
  | "no-coordinator"
  | "offline-fallback";

export interface RotationLeaseResult {
  /** True iff this node may rotate the family (fresh acquire, renew, or fail-open). */
  granted: boolean;
  /** The owning node id (this node's id, or another node's when denied). */
  holder: string | null;
  /** Why the verdict was reached — useful for journal/audit lines. */
  reason: RotationLeaseReason;
}

interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
type FetchLike = (
  url: string,
  init?: RequestInit
) => Promise<FetchResponseLike>;

export interface RotationLeaseServiceDeps {
  leaseStore: LeaseStore;
  federationConfig: FederationConfig | null;
  getPeerAnnouncer: () => PeerAnnouncer | null;
  federationApiToken: string | null;
  ttlMs?: number;
  now?: () => number;
  fetchImpl?: FetchLike;
}

type LeaseOp = "acquire" | "heartbeat" | "release";

/**
 * The single serve-local / proxy-to-coordinator / **fail-open** choke point for
 * cross-machine rotation leases (issue #1644, R3/R5/R7).
 *
 * - **Hub** (`role === "hub"`): serves the authoritative {@link LeaseStore}
 *   directly from its own `hapi.db`.
 * - **Peer**: resolves the coordinator URL from the advertised
 *   {@link ACCOUNT_LEASE_COORDINATOR_CAPABILITY} (or the first `seedPeers` entry
 *   as a cold-start fallback) and proxies the request, forwarding only
 *   `accountUuid` + `holderNodeId` — never a token (R7).
 * - **Fail-open everywhere** (R5, Fallback Preservation Rule): federation
 *   disabled, no node identity, no coordinator discoverable, or any
 *   network/timeout/non-2xx error → grant local rotation rather than block the
 *   spawn or scheduler. This method NEVER throws.
 */
export class RotationLeaseService {
  private readonly leaseStore: LeaseStore;
  private readonly federationConfig: FederationConfig | null;
  private readonly getPeerAnnouncer: () => PeerAnnouncer | null;
  private readonly federationApiToken: string | null;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly fetchImpl: FetchLike;

  constructor(deps: RotationLeaseServiceDeps) {
    this.leaseStore = deps.leaseStore;
    this.federationConfig = deps.federationConfig;
    this.getPeerAnnouncer = deps.getPeerAnnouncer;
    this.federationApiToken = deps.federationApiToken;
    this.ttlMs = deps.ttlMs ?? DEFAULT_ROTATION_LEASE_TTL_MS;
    this.now = deps.now ?? Date.now;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  acquire(accountUuid: string): Promise<RotationLeaseResult> {
    return this.dispatch("acquire", accountUuid);
  }

  heartbeat(accountUuid: string): Promise<RotationLeaseResult> {
    return this.dispatch("heartbeat", accountUuid);
  }

  release(accountUuid: string): Promise<RotationLeaseResult> {
    return this.dispatch("release", accountUuid);
  }

  private async dispatch(
    op: LeaseOp,
    accountUuid: string
  ): Promise<RotationLeaseResult> {
    const fc = this.federationConfig;
    const holder = fc?.nodeId ?? null;

    // R5/R6: federation disabled or no node identity → fail-open grant. This is
    // the #1635 machine-local path — exactly today's behavior, no coordination.
    if (!fc || !fc.enabled || !holder) {
      return { granted: true, holder, reason: "federation-disabled" };
    }

    // Hub: serve from the local authoritative ledger.
    if (fc.role === "hub") {
      return this.serveLocal(op, accountUuid, holder);
    }

    // Peer: resolve the coordinator and proxy; fail-open on any failure.
    const coordinatorUrl = this.resolveCoordinatorUrl();
    if (!coordinatorUrl) {
      return { granted: true, holder, reason: "no-coordinator" };
    }
    return this.proxyToCoordinator(op, accountUuid, holder, coordinatorUrl);
  }

  private serveLocal(
    op: LeaseOp,
    accountUuid: string,
    holder: string
  ): RotationLeaseResult {
    try {
      const now = this.now();
      if (op === "acquire") {
        const r = this.leaseStore.tryAcquire(
          accountUuid,
          holder,
          this.ttlMs,
          now
        );
        return { granted: r.granted, holder: r.holder, reason: "hub-local" };
      }
      if (op === "heartbeat") {
        const granted = this.leaseStore.heartbeat(
          accountUuid,
          holder,
          this.ttlMs,
          now
        );
        return { granted, holder, reason: "hub-local" };
      }
      this.leaseStore.release(accountUuid, holder);
      return { granted: true, holder, reason: "hub-local" };
    } catch (err) {
      // Unexpected store error (e.g. malformed uuid) → fail open (never block).
      console.warn(
        `[RotationLease] hub-local ${op} failed; failing open:`,
        err
      );
      return { granted: true, holder, reason: "offline-fallback" };
    }
  }

  private resolveCoordinatorUrl(): string | null {
    try {
      const peers = this.getPeerAnnouncer()?.getKnownPeers() ?? [];
      const coordinator = peers.find(p =>
        p.capabilities?.includes(ACCOUNT_LEASE_COORDINATOR_CAPABILITY)
      );
      if (coordinator?.url) return coordinator.url;
    } catch {
      // PeerStore read error — fall through to the seed fallback.
    }
    // KD-C cold-start fallback: a peer's first seed URL IS the hub. Covers the
    // window before the hub's capability has propagated through an announce cycle.
    return this.federationConfig?.seedPeers?.[0] ?? null;
  }

  private async proxyToCoordinator(
    op: LeaseOp,
    accountUuid: string,
    holder: string,
    coordinatorUrl: string
  ): Promise<RotationLeaseResult> {
    try {
      // R7: only accountUuid + holderNodeId (+ the proposed TTL) cross the wire.
      const body: Record<string, unknown> = {
        accountUuid,
        holderNodeId: holder,
      };
      if (op !== "release") body.ttlMs = this.ttlMs;

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (this.federationApiToken) {
        headers["Authorization"] = `Bearer ${this.federationApiToken}`;
      }

      const res = await this.fetchImpl(
        `${coordinatorUrl}/api/federation/account-lease/${op}`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(COORDINATOR_TIMEOUT_MS),
        }
      );

      // Reachable but errored → fail open (R5).
      if (!res.ok) {
        return { granted: true, holder, reason: "offline-fallback" };
      }

      if (op === "release") {
        return { granted: true, holder, reason: "coordinator" };
      }

      const json = (await res.json().catch(() => null)) as {
        granted?: boolean;
        holder?: string | null;
      } | null;
      // Honor an explicit deny; anything else (malformed body, missing field)
      // biases to grant — a reachable-but-uninterpretable hub still must not
      // block the spawn (R5).
      return {
        granted: json?.granted !== false,
        holder: json?.holder ?? holder,
        reason: "coordinator",
      };
    } catch {
      // Network error / timeout / abort → fail open (R5, Fallback Preservation).
      return { granted: true, holder, reason: "offline-fallback" };
    }
  }
}
