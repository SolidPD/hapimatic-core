// SPDX-License-Identifier: AGPL-3.0-only
import type { ApiClient } from "@/api/client";
import { useNodeHealth } from "@/hooks/queries/useNodeHealth";
import { useFederationAlerts } from "@/hooks/queries/useFederationHealth";
import { formatBytes } from "@/utils/formatBytes";
import { NodeResourceMeter } from "./NodeResourceMeter";
import { FederationAlertsFeed } from "./federation/FederationAlertsFeed";
import {
  isCriticalStatus,
  severityToColor,
  severityToLabel,
} from "./federation/federationHealthColors";

export type NodeDetailDashboardProps = {
  nodeId: string;
  api: ApiClient | null;
};

function MeterSkeleton() {
  return (
    <div
      data-testid="node-detail-loading"
      className="grid grid-cols-1 gap-3 sm:grid-cols-2"
    >
      {[0, 1, 2, 3].map(i => (
        <div
          key={i}
          className="h-28 animate-pulse rounded-lg border border-[var(--app-border)] bg-[var(--app-secondary-bg)]"
        />
      ))}
    </div>
  );
}

/**
 * Per-node detail dashboard (issue #1444, Task 8): the critical-status banner,
 * the four full-size resource meters, and the (reused) #1037 alerts feed
 * filtered to this node. Reads the SERVER-computed `node.status` for the
 * worst-case banner — it never re-aggregates on the client (#1445 owns that).
 * The 404 "Node not found" empty state lives in the host `NodeDetailView` so
 * this component stays data-focused.
 */
export function NodeDetailDashboard({ nodeId, api }: NodeDetailDashboardProps) {
  const { node, isLoading, isDisabled, isError } = useNodeHealth(api, nodeId);
  const {
    alerts,
    hasMoreAlerts,
    isLoadingMore,
    isLoading: alertsLoading,
    loadMoreAlerts,
  } = useFederationAlerts(api, { nodeId });

  // Standalone/spoke deployments (503) — steady state, not a fault.
  if (isDisabled) {
    return (
      <div
        data-testid="node-detail-disabled"
        className="px-4 py-10 text-center text-[length:var(--text-body)] text-[var(--app-hint)]"
      >
        Health monitoring is not enabled for this deployment.
      </div>
    );
  }

  const critical = node ? isCriticalStatus(node.status) : false;

  return (
    <div
      data-testid="node-detail-dashboard"
      className="flex flex-col gap-3 px-4 py-3"
    >
      {critical && node && (
        <div
          data-testid="node-detail-critical-banner"
          className="rounded-md px-3 py-2 text-[length:var(--text-body)] font-semibold text-white"
          style={{ backgroundColor: severityToColor(node.status) }}
        >
          {severityToLabel(node.status)} — {node.nodeLabel}
        </div>
      )}

      {node ? (
        <div className="flex flex-col gap-3 lg:grid lg:grid-cols-[2fr_1fr] lg:items-start">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <NodeResourceMeter
              label="CPU"
              value={node.cpu.value}
              unit="%"
              severity={node.cpu.severity}
              detail={
                node.cpu.temperatureF !== null
                  ? `${Math.round(node.cpu.temperatureF)}°F`
                  : undefined
              }
              samples={node.timeSeries.map(p => p.cpu)}
            />
            <NodeResourceMeter
              label="RAM"
              value={node.ram.value}
              unit="%"
              severity={node.ram.severity}
              detail={`${formatBytes(node.ram.usedBytes)} / ${formatBytes(
                node.ram.totalBytes
              )}`}
              samples={node.timeSeries.map(p => p.ram)}
            />
            <NodeResourceMeter
              label="Disk"
              value={node.disk.value}
              unit="%"
              severity={node.disk.severity}
              detail={`${formatBytes(node.disk.usedBytes)} / ${formatBytes(
                node.disk.totalBytes
              )} · ${node.disk.mountPoint}`}
              samples={node.timeSeries.map(p => p.disk)}
            />
            <NodeResourceMeter
              label="Latency"
              value={node.latency.value}
              unit="ms"
              severity={node.latency.severity}
              detail={node.latency.value === null ? "local node" : undefined}
              samples={node.timeSeries.map(p => p.latency)}
            />
          </div>

          <FederationAlertsFeed
            alerts={alerts}
            hasMore={hasMoreAlerts}
            isLoadingMore={isLoadingMore}
            isLoading={alertsLoading}
            onLoadMore={loadMoreAlerts}
          />
        </div>
      ) : isError ? (
        <div
          data-testid="node-detail-error"
          className="px-4 py-10 text-center text-[length:var(--text-body)] text-[var(--app-hint)]"
        >
          Could not load node health. Retrying…
        </div>
      ) : (
        <MeterSkeleton />
      )}
    </div>
  );
}
