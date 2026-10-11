// SPDX-License-Identifier: AGPL-3.0-only
import type { FederationAlert } from "@hapi/protocol";
import { FederationStatusDot } from "./FederationStatusDot";

function formatRelativeTime(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return `${Math.max(seconds, 0)}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

type FederationAlertsFeedProps = {
  alerts: FederationAlert[];
  hasMore: boolean;
  isLoadingMore: boolean;
  isLoading: boolean;
  onLoadMore: () => void;
};

/**
 * Tier-1 Warnings/Incidents feed (issue #1037, R4). Renders the alerts from
 * `useFederationAlerts` newest-first with a severity badge, node label,
 * dimension, message, and relative timestamp; offers cursor-based "Load more".
 */
export function FederationAlertsFeed({
  alerts,
  hasMore,
  isLoadingMore,
  isLoading,
  onLoadMore,
}: FederationAlertsFeedProps) {
  return (
    <section
      data-testid="federation-alerts-feed"
      className="flex flex-col gap-2 px-4 py-3"
    >
      <h2 className="text-[length:var(--text-caption)] font-medium uppercase tracking-wide text-[var(--app-hint)]">
        Warnings &amp; Incidents
      </h2>

      {alerts.length === 0 ? (
        <p
          data-testid="federation-alerts-empty"
          className="text-[length:var(--text-body)] text-[var(--app-hint)]"
        >
          {isLoading ? "Loading alerts…" : "No recent alerts."}
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5" role="list">
          {alerts.map(alert => (
            <li
              key={alert.id}
              data-testid="federation-alert"
              className="flex items-start gap-2 rounded-md bg-[var(--app-secondary-bg)] px-3 py-2"
            >
              <FederationStatusDot
                status={alert.severity}
                size="sm"
                className="mt-1"
                label={`severity ${alert.severity}`}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[length:var(--text-body)] font-medium text-[var(--app-fg)]">
                    {alert.nodeLabel}
                  </span>
                  <span className="flex-shrink-0 text-[length:var(--text-caption)] text-[var(--app-hint)]">
                    {formatRelativeTime(alert.timestamp)}
                  </span>
                </div>
                <p className="text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
                  <span className="uppercase">{alert.dimension}</span> ·{" "}
                  {alert.message}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}

      {hasMore && (
        <button /* design-tokens-allow: bare-inline text link (link color + hover:underline, no box; disabled-without-title) — <Button>'s box model breaks the inline link; D2 bare-text-link exception precedent (#3358) */
          type="button"
          onClick={onLoadMore}
          disabled={isLoadingMore}
          data-testid="federation-alerts-load-more"
          className="self-start text-[length:var(--text-body)] text-[var(--app-link)] hover:underline disabled:opacity-50"
        >
          {isLoadingMore ? "Loading…" : "Load more"}
        </button>
      )}
    </section>
  );
}
