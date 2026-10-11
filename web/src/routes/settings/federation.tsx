// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type {
  FederationNodeHealth,
  FederationNodeHealthStatus,
  FederationNodeStatus,
} from "@hapi/protocol";
import { LOCAL_NODE_ID, LOCAL_NODE_LABEL } from "@hapi/protocol";
import { useAppContext } from "@/lib/app-context";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { useEmojiFavicon } from "@/hooks/useEmojiFavicon";
import { useFederatedSessions } from "@/hooks/queries/useFederatedSessions";
import { useHealthStatus } from "@/hooks/queries/useHealthStatus";
import {
  useFederationHealthAggregate,
  useFederationHealthNodes,
  useFederationAlerts,
} from "@/hooks/queries/useFederationHealth";
import {
  AggregateHealthHeader,
  type NodeFilter,
  type FederationStatusCounts,
} from "@/components/federation/AggregateHealthHeader";
import {
  FederationNodeCard,
  type FederationNodeCardProps,
} from "@/components/federation/FederationNodeCard";
import { localReadingsFromMetrics } from "@/components/federation/localNodeHealth";
import { FederationAlertsFeed } from "@/components/federation/FederationAlertsFeed";
import { Network } from "lucide-react";
import {
  SettingsSectionHeader,
  TitleChip,
} from "@/components/settings/SettingsSectionHeader";

type NodeCardModel = Pick<
  FederationNodeCardProps,
  | "nodeId"
  | "nodeLabel"
  | "region"
  | "status"
  | "lastSampleAt"
  | "readings"
  | "isLocalNode"
>;

// Map the coarse federation reachability status (online/degraded/offline) onto
// the per-node health status enum, used only for the identity-only fallback
// cards when the #1632 batch health endpoint is unavailable (503 standalone).
const REACHABILITY_TO_HEALTH: Record<
  FederationNodeStatus,
  FederationNodeHealthStatus
> = {
  online: "healthy",
  degraded: "degraded",
  offline: "offline",
};

// Which filter bucket a per-node status falls into (R3). "degraded" is the
// catch-all for any non-healthy, non-offline status.
function bucketOf(
  status: FederationNodeHealthStatus
): keyof FederationStatusCounts {
  if (status === "healthy") return "healthy";
  if (status === "offline") return "offline";
  return "degraded";
}

function matchesFilter(
  status: FederationNodeHealthStatus,
  filter: NodeFilter
): boolean {
  if (filter === "all") return true;
  return bucketOf(status) === filter;
}

function toCardModel(
  node: FederationNodeHealth,
  isLocal: boolean
): NodeCardModel {
  return {
    nodeId: node.nodeId,
    nodeLabel: node.nodeLabel,
    // OQ3: FederationNodeHealth carries no `region` field — omit gracefully.
    region: undefined,
    status: node.status,
    lastSampleAt: node.lastSampleAt,
    readings: {
      cpu: { value: node.cpu.value, severity: node.cpu.severity },
      ram: { value: node.ram.value, severity: node.ram.severity },
      disk: { value: node.disk.value, severity: node.disk.severity },
      latency: { value: node.latency.value, severity: node.latency.severity },
    },
    isLocalNode: isLocal,
  };
}

/**
 * Federation Health Dashboard — the `/settings/federation` route overview (issue #1037,
 * promoted to a standalone route in #1935).
 *
 * Rendered by the `/settings/federation` route (registered in `router.tsx`). Assembles:
 * Tier 1 `AggregateHealthHeader` (worst-case severity + filter tabs), a responsive
 * Tier-2 card grid of `FederationNodeCard`, and the Tier-1 `FederationAlertsFeed`.
 * Data: `useFederationHealthAggregate` (header), `useFederationHealthNodes` (#1632
 * batch — cards), `useFederationAlerts` (feed), with `useFederatedSessions` as the
 * identity-only fallback when the health endpoints return 503 (standalone/spoke).
 *
 * Card click navigates to the per-node detail route `/settings/federation/$nodeId`
 * (#1444 design, promoted to a nested route in #1935 — `NodeDetailView` is rendered
 * by that route, NOT branched on a `?nodeId=` search param anymore).
 */
export default function FederationDashboard() {
  useDocumentTitle("Federation - Hapimatic");
  useEmojiFavicon(null);
  const { api } = useAppContext();
  const navigate = useNavigate();

  const { aggregate, isError: aggIsError } = useFederationHealthAggregate(api);
  const {
    nodes,
    lastSampleAt,
    isError: nodesIsError,
  } = useFederationHealthNodes(api);
  const { alerts, hasMoreAlerts, isLoadingMore, isLoading, loadMoreAlerts } =
    useFederationAlerts(api);
  const { localNode, remoteNodes } = useFederatedSessions(api);

  // Health endpoints unavailable (503 standalone / federation disabled) → the
  // dashboard renders identity-only cards + a non-blocking banner (R12).
  const metricsUnavailable = aggIsError || nodesIsError;

  // #2513: on a standalone VM the federation HealthAggregator is never
  // constructed (federationConfig is null), so GET /api/federation/health/nodes
  // 503s and the dashboard falls back to identity-only cards with NO readings —
  // CPU/RAM/disk render as "—". The local /api/system-health collector is ALWAYS
  // available (JWT-only, not federation-gated), so source the LOCAL node's card
  // readings from it. Gated on `metricsUnavailable` (a null api makes the hook a
  // no-op) so a federated hub — which takes the aggregator path — never starts
  // this extra poll and its cards stay byte-unchanged (R4).
  const { metrics: localHealthMetrics } = useHealthStatus(
    metricsUnavailable ? api : null
  );

  const [filter, setFilter] = useState<NodeFilter>("all");

  const cards = useMemo<NodeCardModel[]>(() => {
    if (nodes.length > 0) {
      return nodes.map(n =>
        toCardModel(n, Boolean(localNode && n.nodeId === localNode.nodeId))
      );
    }
    // Fallback: identity-only cards from the federation session registry.
    const fallback: NodeCardModel[] = [];
    // #2332: unconditional — a node must at minimum render ITSELF, so this is a
    // floor rather than a conditional. `localNode` is non-null from any server
    // carrying #2332's fix, but stays nullable for an older server binary; the
    // synthesized id/label match the server's own fallback and account-usage.tsx.
    // Kept as a client-side floor per CLAUDE.md's Fallback Preservation Rule —
    // the server fix is the fast path, this is the slow path it augments.
    fallback.push({
      nodeId: localNode?.nodeId ?? LOCAL_NODE_ID,
      nodeLabel: localNode?.nodeLabel ?? LOCAL_NODE_LABEL,
      status: "healthy",
      lastSampleAt: null,
      // #2513: enrich ONLY the local card's readings from the local collector.
      // Remote peers have no reachable metrics without federation, so their
      // fallback cards stay readings-free. `undefined` (no metrics yet) keeps the
      // pre-existing readings-free identity floor (Fallback Preservation Rule).
      readings: localReadingsFromMetrics(localHealthMetrics),
      isLocalNode: true,
    });
    for (const rn of remoteNodes) {
      fallback.push({
        nodeId: rn.nodeId,
        nodeLabel: rn.nodeLabel,
        status: REACHABILITY_TO_HEALTH[rn.status] ?? "offline",
        lastSampleAt: null,
        isLocalNode: false,
      });
    }
    return fallback;
  }, [nodes, localNode, remoteNodes, localHealthMetrics]);

  const counts = useMemo<FederationStatusCounts>(() => {
    const c: FederationStatusCounts = { healthy: 0, degraded: 0, offline: 0 };
    for (const card of cards) c[bucketOf(card.status)] += 1;
    return c;
  }, [cards]);

  const visibleCards = useMemo(
    () => cards.filter(card => matchesFilter(card.status, filter)),
    [cards, filter]
  );

  // #1935: navigate to the nested per-node detail route. Back from the detail is
  // plain history-back (returns to this overview).
  const onOpen = (nodeId: string) =>
    navigate({ to: "/settings/federation/$nodeId", params: { nodeId } });

  return (
    <div
      data-testid="settings-federation-root"
      className="flex h-full flex-col overflow-y-auto"
    >
      <SettingsSectionHeader
        icon={<TitleChip icon={Network} accent="var(--accent-emerald-400)" />}
        title="Federation"
      />

      {/* #2331: ONE shared wrapper caps the aggregate header, the card grid, and
          the alerts feed at the same `max-w-content` as SettingsSectionHeader, so the
          page reads as one column instead of a centred header over a full-bleed body. */}
      <div className="mx-auto w-full max-w-content">
        <AggregateHealthHeader
          aggregate={aggregate}
          counts={counts}
          totalNodes={cards.length}
          openAlertsCount={alerts.length}
          lastSampleAt={aggregate?.lastSampleAt ?? lastSampleAt}
          metricsUnavailable={metricsUnavailable}
          activeFilter={filter}
          onFilterChange={setFilter}
        />

        {cards.length === 0 ? (
          <p
            data-testid="federation-empty-state"
            className="px-4 py-8 text-center text-[length:var(--text-body)] text-[var(--app-hint)]"
          >
            No federation nodes are currently connected.
          </p>
        ) : visibleCards.length === 0 ? (
          // #2332 (SEPARATE in-path fix — NOT the reported root cause): the empty
          // state above gates on the UNFILTERED `cards` while the grid below maps
          // the FILTERED `visibleCards`. When a filter excluded every card, neither
          // branch rendered anything and the user saw an unexplained blank region.
          <p
            data-testid="federation-filter-empty-state"
            className="px-4 py-8 text-center text-[length:var(--text-body)] text-[var(--app-hint)]"
          >
            No nodes match the “{filter}” filter.
          </p>
        ) : (
          // #2331: `lg:grid-cols-3` was DROPPED deliberately. Tailwind breakpoints
          // are VIEWPORT-scoped, not container-scoped, so inside the 720px cap of the
          // time (1024px since #3455) above
          // the lg: query still fired on a >=1024px desktop and squeezed three cards
          // into ~230px each. Two columns now yield (1024 - 32 px-4 - 12 gap-3) / 2 = 490px
          // per card — wider than the 300px SettingsDrawer panel already accepted as usable.
          <div
            data-testid="federation-card-grid"
            className="grid grid-cols-1 gap-3 px-4 py-3 sm:grid-cols-2"
          >
            {visibleCards.map(card => (
              <FederationNodeCard
                key={card.nodeId}
                api={api}
                nodeId={card.nodeId}
                nodeLabel={card.nodeLabel}
                region={card.region}
                status={card.status}
                lastSampleAt={card.lastSampleAt}
                readings={card.readings}
                isLocalNode={card.isLocalNode}
                onOpen={onOpen}
              />
            ))}
          </div>
        )}

        <FederationAlertsFeed
          alerts={alerts}
          hasMore={hasMoreAlerts}
          isLoadingMore={isLoadingMore}
          isLoading={isLoading}
          onLoadMore={loadMoreAlerts}
        />
      </div>
    </div>
  );
}
