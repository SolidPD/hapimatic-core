// SPDX-License-Identifier: AGPL-3.0-only
import { queryOptions, useQuery } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import type { EffortLevel, FederationNodeStatus } from "@hapi/protocol";
import type { DaemonCapSource } from "@hapi/protocol/schemas";
import type { SessionSummary } from "@/types/api";
import { queryKeys } from "@/lib/query-keys";
import { applyFederationOverrides } from "@/lib/federation-mutation-overrides";
import {
  isFederationSpawnPlaceholder,
  reconcilePendingSpawns,
} from "@/lib/pending-spawns";
import { withoutDeletePending } from "@/lib/session-action-pending";
import { msUntilPollDue } from "@/lib/sessionHeartbeat";

export type FederationRemoteNode = {
  nodeId: string;
  nodeLabel: string;
  status: FederationNodeStatus;
  url: string;
  sessionCount: number;
  platform?: string;
  capabilities?: string[];
  // #2533: node's home dir, forwarded via getNodeSummaries(). Undefined for
  // stale peers — the Create page falls back to the hub default + recovery walk.
  homeDir?: string;
  // #1805: per-machine spawn capacity from the node's /effective-count,
  // forwarded via getNodeSummaries(). Undefined for stale peers / unknown.
  effectiveCount?: number;
  maxConcurrent?: number;
  // #4417: the node's warn-at count + which resolver layer set its cap, forwarded
  // via getNodeSummaries() from the peer's /federation/info. Undefined for a
  // pre-#4417 peer → the remote meter shows no warn threshold / source "remote".
  recommendedConcurrent?: number;
  capSource?: DaemonCapSource;
  // #6028: the node daemon's resolved spawn default effort, forwarded via
  // getNodeSummaries(). Undefined for a pre-#6028 peer → the shared default label.
  defaultEffort?: EffortLevel;
};

// #3508: module-level stable empty fallbacks — keep the pending-query array
// identities constant across renders (the #3462 render-loop fuel). Pattern:
// useMessages.ts EMPTY_BUBBLES.
const EMPTY_REMOTE_SESSIONS: SessionSummary[] = [];
const EMPTY_REMOTE_NODES: FederationRemoteNode[] = [];

/**
 * The all-sessions query, shared by every reader so the poll interval, the
 * optimistic-override pass, and the spawn reconciliation cannot drift.
 */
function federationAllSessionsQuery(api: ApiClient | null) {
  return queryOptions({
    queryKey: queryKeys.federationAllSessions,
    queryFn: async () => {
      if (!api) throw new Error("API unavailable");
      const data = await api.getFederationAllSessions();
      // Re-apply any pending optimistic overrides on top of poll data.
      // The NodeRegistry cache on the hub may hold stale session metadata
      // for up to 10s after a mutation; overrides prevent stale data from
      // reverting optimistic UI updates.
      // #3516 follow-up: then drop rows whose delete is in flight, so a poll or
      // SSE-driven refetch mid-delete cannot resurrect the removed row.
      const polled = withoutDeletePending(
        applyFederationOverrides(data.sessions)
      );
      // Auto-remove pending spawn stubs that now have a matching real session.
      // Issue #2150: the hub's federation spawn placeholders ride in the same
      // array — the reconciler reads them (a failed one flips its stub), then
      // they are dropped: the client stub is the one row the list renders for a
      // remote spawn, and a placeholder has no session behind it to open.
      reconcilePendingSpawns(polled);
      const sessions = polled.filter(s => !isFederationSpawnPlaceholder(s));
      return { ...data, sessions };
    },
    enabled: Boolean(api),
    // Background backstop poll (30s). SSE invalidates federationAllSessions
    // on real session changes (see useSSE.ts) and mutations invalidate it
    // directly. This interval catches drift in slowly-changing fields
    // (nodeStatus, nodeUrl; Issue #1214) and, since keepalives stopped
    // refetching (Issue #6208), keeps remote rows' read-time fields
    // (messageCount, workflowBadge) fresh. It counts from the last real fetch
    // (msUntilPollDue), because keepalive `activeAt` patches restart
    // TanStack's interval timer on every write.
    refetchInterval: cached => msUntilPollDue(30_000, cached.state),
    // Don't fail hard if federation isn't enabled
    retry: 1,
  });
}

/**
 * Issue #6208: keep the federation session list cached and fresh without
 * re-rendering the caller (`notifyOnChangeProps: []`). A session view needs the
 * cache — `SessionHeader` counts a session's remote descendants from it for
 * "Delete all (N)", and the keepalive check compares remote sessions against
 * it — but must not re-render on every change anywhere in the mesh.
 */
export function useFederationSessionsCache(api: ApiClient | null): void {
  useQuery({ ...federationAllSessionsQuery(api), notifyOnChangeProps: [] });
}

/**
 * Issue #6208: the local federation node identity, from the nodes query alone.
 *
 * Components that only need `localNode` use this instead of
 * `useFederatedSessions`, because subscribing to the all-sessions list
 * re-rendered them on every session change anywhere in the mesh.
 */
export function useFederationLocalNode(api: ApiClient | null): {
  localNode: { nodeId: string; nodeLabel: string } | null;
  /** #4461: the federation-nodes read has answered or failed (not pending). */
  localNodeSettled: boolean;
} {
  const nodesQuery = useQuery({
    queryKey: queryKeys.federationNodes,
    queryFn: async () => {
      if (!api) throw new Error("API unavailable");
      return await api.getFederationNodes();
    },
    enabled: Boolean(api),
    // Rarely changes — long stale time
    staleTime: 60000,
    retry: 1,
  });

  return {
    localNode: nodesQuery.data?.localNode ?? null,
    // Issue #4461: true once `GET /api/federation/nodes` has answered OR failed.
    // A null `localNode` alone cannot tell a pending read from a failed one, and
    // the re-login deep link must not decide "UI host or not" while pending.
    localNodeSettled: nodesQuery.isFetched,
  };
}

export function useFederatedSessions(api: ApiClient | null): {
  remoteSessions: SessionSummary[];
  remoteNodes: FederationRemoteNode[];
  localNode: { nodeId: string; nodeLabel: string } | null;
  /** #4461: the federation-nodes read has answered or failed (not pending). */
  localNodeSettled: boolean;
  isLoading: boolean;
  /** #3491: the all-sessions read has answered and its last fetch did not fail. */
  isSuccess: boolean;
  error: string | null;
  isEnabled: boolean;
} {
  const allSessionsQuery = useQuery(federationAllSessionsQuery(api));

  // Fetch federation nodes to get localNode identity (one query definition,
  // shared with the nodes-only hook so the two cannot drift).
  const { localNode, localNodeSettled } = useFederationLocalNode(api);

  return {
    remoteSessions: allSessionsQuery.data?.sessions ?? EMPTY_REMOTE_SESSIONS,
    remoteNodes: (allSessionsQuery.data?.nodes ??
      EMPTY_REMOTE_NODES) as FederationRemoteNode[],
    localNode,
    localNodeSettled,
    isLoading: allSessionsQuery.isLoading,
    isSuccess: allSessionsQuery.isSuccess,
    error:
      allSessionsQuery.error instanceof Error
        ? allSessionsQuery.error.message
        : null,
    isEnabled: (allSessionsQuery.data?.nodes?.length ?? 0) > 0,
  };
}
