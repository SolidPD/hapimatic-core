// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Federation-route-internal presentational component (issue #1792).
 *
 * Single consumer by design: `web/src/routes/settings/federation.tsx`. It lives in
 * `components/federation/` alongside the shared federation primitives; its single
 * import site is intentional, not accidental dead code — a future "single-use"
 * audit should treat it as federation-internal.
 */
import { useState, type KeyboardEvent } from "react";
import { ChevronDown } from "lucide-react";
import type { ApiClient } from "@/api/client";
import type {
  FederationNodeHealthStatus,
  FederationHealthSeverity,
} from "@hapi/protocol";
import {
  severityToColor,
  LATENCY_FULL_SCALE_MS,
} from "./federationHealthColors";
import { ActiveAccountRow } from "./ActiveAccountRow";
import { FederationStatusDot } from "./FederationStatusDot";
import { Button } from "@/components/ui/button";

export type NodeCardReading = {
  value: number | null;
  severity: FederationHealthSeverity;
};

export type FederationNodeCardProps = {
  api: ApiClient | null;
  nodeId: string;
  nodeLabel: string;
  region?: string;
  status: FederationNodeHealthStatus;
  lastSampleAt: number | null;
  /** Per-dimension current readings (#1632). Absent → placeholder bars (R12). */
  readings?: {
    cpu: NodeCardReading;
    ram: NodeCardReading;
    disk: NodeCardReading;
    latency: NodeCardReading;
  };
  isLocalNode?: boolean;
  onOpen: (nodeId: string) => void;
};

function formatLastSeen(ts: number | null): string {
  if (!ts) return "never seen";
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return "seen just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `seen ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `seen ${hours}h ago`;
  return `seen ${Math.floor(hours / 24)}d ago`;
}

function DimensionBar({
  label,
  reading,
  unit,
}: {
  label: string;
  reading: NodeCardReading | undefined;
  unit: "%" | "ms";
}) {
  const value = reading?.value ?? null;
  const color = reading ? severityToColor(reading.severity) : undefined;
  const fillPct =
    value === null
      ? 0
      : unit === "%"
        ? Math.min(Math.max(value, 0), 100)
        : Math.min(Math.max((value / LATENCY_FULL_SCALE_MS) * 100, 0), 100);
  const valueText =
    value === null
      ? "—"
      : unit === "%"
        ? `${Math.round(value)}%`
        : `${Math.round(value)}ms`;

  return (
    <div className="flex items-center gap-2" data-testid={`dimbar-${label}`}>
      <span className="w-8 flex-shrink-0 text-[length:var(--text-caption)] text-[var(--app-hint)]">
        {label}
      </span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--app-secondary-bg)]">
        {value !== null && (
          <div
            className="h-full rounded-full"
            style={{ width: `${fillPct}%`, backgroundColor: color }}
          />
        )}
      </div>
      <span className="w-12 flex-shrink-0 text-right text-[length:var(--text-caption)] text-[var(--app-fg)]">
        {valueText}
      </span>
    </div>
  );
}

/**
 * Tier-2 per-node summary card (issue #1037, R5–R10). The whole card is a
 * role="button" (a real <button> can't wrap the nested Switch/expand buttons)
 * → navigates to the per-node detail view (R7). A chevron toggles the expanded
 * summary (mini-sparklines + Active Account row, R8) without navigating. The
 * card never renders full per-dimension meters — those live on #1444's page.
 */
export function FederationNodeCard({
  api,
  nodeId,
  nodeLabel,
  region,
  status,
  lastSampleAt,
  readings,
  isLocalNode,
  onOpen,
}: FederationNodeCardProps) {
  const [expanded, setExpanded] = useState(false);

  const navigate = () => onOpen(nodeId);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      navigate();
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      data-testid={`federation-node-card-${nodeId}`}
      onClick={navigate}
      onKeyDown={onKeyDown}
      className="flex cursor-pointer flex-col gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-3 text-left transition-colors hover:border-[var(--app-link)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
    >
      {/* Collapsed header row. */}
      <div className="flex items-center gap-2">
        <FederationStatusDot
          status={status}
          size="md"
          data-testid="node-health-dot"
          label={`status ${status}`}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <span
            className={
              /* design-tokens-allow: 16px is above the dense type-scale ladder (tops at 14px label-strong); text-base would inject a 1.5rem line-height (R6 forbids line-height change) — D2 px-floor exception precedent (#3358) */ "truncate text-[16px] font-medium text-[var(--app-fg)]"
            }
          >
            {nodeLabel}
            {isLocalNode ? (
              <span className="ml-1.5 text-[length:var(--text-caption)] text-[var(--app-hint)]">
                (this machine)
              </span>
            ) : null}
          </span>
          <span className="truncate text-[length:var(--text-caption)] text-[var(--app-hint)]">
            {region ? `${region} · ` : ""}
            {formatLastSeen(lastSampleAt)}
          </span>
        </div>
        <Button
          type="button"
          variant="ghostStatic"
          data-testid="node-card-expand"
          aria-label={
            expanded ? "Collapse node summary" : "Expand node summary"
          }
          aria-expanded={expanded}
          onClick={e => {
            e.stopPropagation();
            setExpanded(v => !v);
          }}
          className="h-auto flex-shrink-0 rounded p-1 hover:text-[var(--app-fg)]"
        >
          <ChevronDown
            className={`h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`}
          />
        </Button>
      </div>

      {/* Expanded summary: mini-sparklines + Active Account row. */}
      {expanded && (
        <div
          data-testid="node-card-expanded"
          className="flex flex-col gap-2 pt-1"
        >
          <DimensionBar label="CPU" reading={readings?.cpu} unit="%" />
          <DimensionBar label="RAM" reading={readings?.ram} unit="%" />
          <DimensionBar label="Disk" reading={readings?.disk} unit="%" />
          <DimensionBar label="Lat" reading={readings?.latency} unit="ms" />
          <ActiveAccountRow api={api} nodeId={nodeId} />
        </div>
      )}

      <span className="text-[length:var(--text-body-dense)] text-[var(--app-link)]">
        Open node →
      </span>
    </div>
  );
}
