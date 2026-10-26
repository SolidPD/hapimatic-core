// SPDX-License-Identifier: AGPL-3.0-only
import type {
  FederationConfig,
  FederationNodeState,
  JobRegistry,
  SessionSummary,
} from "@hapi/protocol";
import type { PeerStore } from "../store/peerStore";
import type { FileClaimSync } from "./fileClaimSync";

export type NodeRegistryOptions = {
  config: FederationConfig;
  apiToken: string | null;
  getLocalSessionCount: () => number;
  peerStore?: PeerStore;
  /** Override the default eviction threshold (default: 10 consecutive failures). */
  evictionThreshold?: number;
  /** Runtime job registry to register the poll loop into (#1963). */
  jobRegistry?: JobRegistry | null;
  /**
   * Issue #1969 (File Conflict Monitor Sub D): the federation claim-sync replica.
   * NodeRegistry merges bridged + polled peer snapshots into it (R4) and drops a
   * peer's register on eviction / the offline transition (R6). Optional so tests
   * that construct a NodeRegistry without claim-sync still compile.
   */
  fileClaimSync?: FileClaimSync | null;
  /**
   * Inactivity ceiling for one SSE event-bridge stream, in ms (default
   * `EVENT_BRIDGE_IDLE_TIMEOUT_MS`, 90 s = three remote heartbeat periods).
   * A connect or read that makes no progress for this long is treated as a
   * dead stream and reconnected. Tests lower it to exercise the watchdog.
   */
  eventBridgeIdleTimeoutMs?: number;
  /**
   * Issue #5127: decides whether a home node's URL may be sent a shared-API-key
   * request (Tailscale or loopback only). Defaults to `createHomeUrlGuard()`;
   * tests inject one to avoid DNS.
   */
  homeUrlGuard?: (url: string) => Promise<boolean>;
};

export type CachedRemoteSessions = {
  nodeId: string;
  nodeLabel: string;
  sessions: SessionSummary[];
  fetchedAt: number;
};
