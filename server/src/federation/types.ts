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
};

export type CachedRemoteSessions = {
  nodeId: string;
  nodeLabel: string;
  sessions: SessionSummary[];
  fetchedAt: number;
};
