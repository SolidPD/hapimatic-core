// SPDX-License-Identifier: AGPL-3.0-only
import { useNavigate } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import { displayNodeLabel } from "@hapi/protocol";
import { useAppContext } from "@/lib/app-context";
import { useNodeHealth } from "@/hooks/queries/useNodeHealth";
import { NodeDetailDashboard } from "@/components/NodeDetailDashboard";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export type NodeHealthStatus = "online" | "degraded" | "offline";

const HEALTH_TEXT_CLASS: Record<NodeHealthStatus, string> = {
  online: "text-[var(--app-badge-success-text)]",
  degraded: "text-[var(--app-badge-warning-text)]",
  offline: "text-[var(--app-badge-error-text)]",
};

/**
 * NodeHealthModal — the Settings → Federation per-node health page
 * (`NodeDetailDashboard`, the body of `/settings/federation/$nodeId`) hosted in
 * the app's standard centered modal, opened by tapping a session's Node Badge
 * (operator ruling, epic #3285 round 10, 2026-09-07: "1-tap access to the node
 * stats" from the Session Basic Info Bar).
 *
 * Same data path as the page: `useNodeHealth(api, nodeId)` (30s poll, 404 →
 * "Node not found", 503 → the dashboard's health-disabled placeholder). The
 * footer keeps the two links the badge used to carry / the page offers: the
 * node's native UI (when it has a URL) and the full Settings page.
 */
export function NodeHealthModal({
  nodeId,
  nodeLabel,
  nodeUrl,
  nodeStatus,
  labelAsReceived = false,
  open,
  onOpenChange,
}: {
  nodeId: string;
  nodeLabel?: string;
  nodeUrl?: string;
  nodeStatus?: NodeHealthStatus;
  /** #4468 Task 2 (added by #4464): render `nodeLabel` as given — the server has
   *  already cased it and a URL-less label cannot be classified client-side. */
  labelAsReceived?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { api } = useAppContext();
  const navigate = useNavigate();
  const { node, isNotFound } = useNodeHealth(api, nodeId);

  // System-wide casing rule (epic #3285 round 11): local machines UPPER CASE,
  // cloud VMs lower case — the same helper the Node Badge applies, so the badge
  // and its modal can never disagree. (The old 3-letter uppercased id chip is
  // gone: it was one of the "random" casings the rule replaces.)
  const label =
    labelAsReceived && nodeLabel
      ? nodeLabel
      : displayNodeLabel(node?.nodeLabel ?? nodeLabel ?? nodeId, {
          url: nodeUrl,
        });
  // An unknown status on a node we can render is, by construction, reachable
  // (the same call NodeBadge makes for its health dot).
  const health: NodeHealthStatus = nodeStatus ?? "online";

  const openFullPage = () => {
    onOpenChange(false);
    void navigate({
      to: "/settings/federation/$nodeId",
      params: { nodeId },
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid={`node-health-modal-${nodeId}`}
        description={`Health and resource metrics for node ${label}`}
        className="flex flex-col overflow-hidden p-0"
        style={{ maxHeight: "85vh" }}
      >
        {/* Header — `pr-12` clears the primitive's absolute close button. */}
        <div className="flex items-center gap-2 border-b border-[var(--app-border)] px-4 py-3 pr-12">
          <DialogTitle className="min-w-0 truncate text-[length:var(--text-body)] font-semibold leading-tight tracking-normal text-[var(--app-fg)]">
            {label}
          </DialogTitle>
          <span
            data-testid="node-health-modal-status"
            className={`shrink-0 text-[length:var(--text-caption)] font-medium ${HEALTH_TEXT_CLASS[health]}`}
          >
            {health}
          </span>
        </div>

        {/* Body — the Settings page's dashboard, unchanged. */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {isNotFound ? (
            <p
              data-testid="node-health-modal-not-found"
              className="px-4 py-10 text-center text-[length:var(--text-body)] text-[var(--app-hint)]"
            >
              No node with ID “{nodeId}” is currently connected.
            </p>
          ) : (
            <NodeDetailDashboard nodeId={nodeId} api={api} />
          )}
        </div>

        {/* Footer — the deep links. */}
        <div className="flex items-center justify-end gap-2 border-t border-[var(--app-border)] px-4 py-3">
          {nodeUrl && (
            <Button
              asChild
              variant="outline"
              className="h-auto rounded-md px-2.5 py-1.5 text-xs font-normal"
            >
              <a
                href={nodeUrl}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="node-health-modal-open-node-ui"
                className="inline-flex items-center gap-1.5 no-underline"
              >
                Open node UI
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </Button>
          )}
          <Button
            type="button"
            variant="ghostStatic"
            onClick={openFullPage}
            data-testid="node-health-modal-full-page"
            className="h-auto rounded-md px-2.5 py-1.5 text-xs font-normal hover:text-[var(--app-fg)]"
          >
            Open in Settings
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
