// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAppContext } from "@/lib/app-context";
import { useNodeHealth } from "@/hooks/queries/useNodeHealth";
import { NodeDetailDashboard } from "@/components/NodeDetailDashboard";
import { Network } from "lucide-react";
import {
  SettingsSectionHeader,
  TitleChip,
} from "@/components/settings/SettingsSectionHeader";

/**
 * Per-node detail page (issue #1444; promoted to the `/settings/federation/$nodeId`
 * route in #1935). Rendered by that nested route — the URL is shareable and the
 * PWA back gesture works natively.
 *
 * Owns the navigation chrome (back arrow + node identity header) and the R2
 * "Node not found" empty state; delegates the meters/banner/alerts to
 * `NodeDetailDashboard`. Both call `useNodeHealth(api, nodeId)` with the same
 * query key, so React Query serves them from ONE fetch.
 *
 * Back navigates explicitly to `/settings/federation` (the overview). This is more
 * robust than plain history-back: a deep-linked / shared `/settings/federation/$nodeId`
 * URL has no in-app back entry, and explicit navigation still returns to the overview.
 */
export function NodeDetailView({ nodeId }: { nodeId: string }) {
  const { api } = useAppContext();
  const navigate = useNavigate();
  const { node, isNotFound } = useNodeHealth(api, nodeId);

  // #1935: return to the federation overview route.
  const handleBack = useCallback(
    () => navigate({ to: "/settings/federation" }),
    [navigate]
  );

  // The id chip shows the node id VERBATIM (epic #3285 round 11): the old
  // 3-letter `.toUpperCase()` fragment was the one place a node read as "RP1"
  // while every other surface read "rp1". Labels now follow the system-wide
  // casing rule (displayNodeLabel — server-applied); ids are identifiers.
  const idChip = nodeId;

  return (
    <div
      data-testid="node-detail-view"
      className="flex h-full flex-col overflow-y-auto"
    >
      <SettingsSectionHeader
        onBack={handleBack}
        icon={
          <>
            <TitleChip icon={Network} accent="var(--accent-emerald-400)" />
            <span className="flex-shrink-0 rounded bg-[var(--app-subtle-bg)] px-1.5 py-0.5 font-mono text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
              {idChip}
            </span>
          </>
        }
        title={node?.nodeLabel ?? nodeId}
      />

      {/* #2331: ONE shared wrapper caps both body branches at the header's
          `max-w-content`. The scroll root above stays full-width. */}
      <div className="mx-auto w-full max-w-content">
        {isNotFound ? (
          <div
            data-testid="node-not-found"
            className="flex flex-col items-center gap-3 px-4 py-12 text-center"
          >
            <p className="text-[length:var(--text-label-strong)] font-medium text-[var(--app-fg)]">
              Node not found
            </p>
            <p className="text-[length:var(--text-body)] text-[var(--app-hint)]">
              No node with ID “{nodeId}” is currently connected.
            </p>
            <button /* design-tokens-allow: bare-inline text link (link color + hover:underline, no box) — <Button>'s box model breaks the inline link; D2 bare-text-link exception precedent (#3358) */
              type="button"
              onClick={handleBack}
              data-testid="node-not-found-back"
              className="text-[length:var(--text-body)] text-[var(--app-link)] hover:underline"
            >
              Back to Federation
            </button>
          </div>
        ) : (
          <NodeDetailDashboard nodeId={nodeId} api={api} />
        )}
      </div>
    </div>
  );
}
