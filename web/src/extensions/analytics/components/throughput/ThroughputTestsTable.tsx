// SPDX-License-Identifier: AGPL-3.0-only
import type { ApiClient } from "@/api/client";
import {
  useThroughputTests,
  type ThroughputRange,
} from "../../hooks/useThroughput";
import { formatCount } from "./format";

const TOP = 15;

/**
 * The tests that catch problems (issue #6164): failing units from CI logs and
 * from agents' own test runs in the window, most catches first.
 */
export function ThroughputTestsTable({
  api,
  range,
}: {
  api: ApiClient | null;
  range: ThroughputRange;
}) {
  const { page, isLoading, error } = useThroughputTests(api, range);
  if (isLoading) {
    return (
      <div className="py-6 text-center text-xs text-[var(--app-muted)]">
        Loading...
      </div>
    );
  }
  // #6367: a failed request is not "no failing tests". The error wins over a
  // cached page, as in the summary and the breakdown.
  if (error) {
    return (
      <div className="py-6 text-center text-xs text-[var(--app-muted)]">
        Could not load the failing tests ({error}).
      </div>
    );
  }
  const rows = page?.rows.slice(0, TOP) ?? [];
  if (rows.length === 0) {
    return (
      <div className="py-6 text-center text-xs text-[var(--app-muted)]">
        No failing tests recorded in this window.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead className="text-[var(--app-muted)]">
          <tr>
            <th className="py-1 pr-2 font-medium">Test or suite</th>
            <th className="py-1 pr-2 text-right font-medium">CI</th>
            <th className="py-1 pr-2 text-right font-medium">Agents</th>
            <th className="py-1 text-right font-medium">Sessions</th>
          </tr>
        </thead>
        <tbody className="text-[var(--app-fg)]">
          {rows.map(r => (
            <tr key={r.unit} className="border-t border-[var(--app-border)]">
              <td
                className="max-w-[14rem] truncate py-1 pr-2 font-mono"
                title={r.unit}
              >
                {r.unit}
              </td>
              <td className="py-1 pr-2 text-right">
                {formatCount(r.ciCatches)}
              </td>
              <td className="py-1 pr-2 text-right">
                {formatCount(r.agentCatches)}
              </td>
              <td className="py-1 text-right">{formatCount(r.sessions)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {page && page.total > TOP ? (
        <div className="mt-2 text-xs text-[var(--app-muted)]">
          Top {TOP} of {formatCount(page.total)}.
        </div>
      ) : null}
    </div>
  );
}
