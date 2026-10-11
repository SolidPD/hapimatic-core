// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { useAppContext } from "@/lib/app-context";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { useEmojiFavicon } from "@/hooks/useEmojiFavicon";
import { useFileConflicts } from "@/hooks/queries/useFileConflicts";
import { useFileClaimHistory } from "@/hooks/queries/useFileClaimHistory";
import { FileWarning, RefreshCw } from "lucide-react";
import {
  SettingsSectionHeader,
  TitleChip,
} from "@/components/settings/SettingsSectionHeader";
import { FileConflictTable } from "@/components/FileConflictTable";
import { InFlightClaimsSection } from "@/components/InFlightClaimsSection";
import { ConflictHistoryTable } from "@/components/ConflictHistoryTable";
import { Button } from "@/components/ui/button";

/**
 * File Conflicts — the `/settings/file-conflicts` route (epic #1965 Sub F, issue
 * #1971; extended by #2815).
 *
 * Three read-only observe surfaces, top-priority first:
 *   1. the standardized conflict table (files claimed live by ≥2 sessions),
 *   2. the in-flight claims inventory (EVERY live claim, grouped by session),
 *   3. the recent-conflicts history panel (overlapping claim windows, local
 *      node, on-demand fetch with a window selector).
 * No blocking, no warning prompt, no state mutation — the later warn banner
 * (Phase 2) reuses the same table component. Empty/loading states live inside
 * each component.
 */

const HISTORY_WINDOWS = [7, 30, 90] as const;

export default function AdminFileConflictsPage() {
  useDocumentTitle("File Conflicts - Hapimatic");
  useEmojiFavicon(null);
  const { api } = useAppContext();
  const { rows, ignoredPaths, inFlightRows, sessions, isLoading, error } =
    useFileConflicts(api);
  const [historyDays, setHistoryDays] = useState<number>(7);
  const history = useFileClaimHistory(api, sessions, { days: historyDays });

  return (
    <div
      data-testid="settings-file-conflicts-root"
      className="flex h-full flex-col overflow-y-auto"
    >
      <SettingsSectionHeader
        icon={
          <TitleChip icon={FileWarning} accent="var(--accent-orange-400)" />
        }
        title="File Conflicts"
      />

      <div className="mx-auto w-full max-w-content">
        {error ? (
          <p
            data-testid="file-conflicts-error"
            className="px-4 py-8 text-center text-[length:var(--text-body)] text-red-400"
          >
            Couldn't load file conflicts: {error}
          </p>
        ) : (
          <div className="px-4 py-3">
            <p className="mb-3 text-[length:var(--text-body)] text-[var(--app-hint)]">
              Read-only observe view — live conflicts (files claimed by two or
              more sessions, most severe first), the full in-flight claims
              inventory, and recent conflict history. Live surfaces update
              automatically as sessions and claims change.
            </p>
            <FileConflictTable
              rows={rows}
              ignoredPaths={ignoredPaths}
              isLoading={isLoading}
            />

            <InFlightClaimsSection
              groups={inFlightRows}
              isLoading={isLoading}
            />

            <section data-testid="conflict-history-section" className="mt-6">
              <div className="mb-1 flex items-center gap-2">
                <h2 className="text-[length:var(--text-label-strong)] font-semibold text-[var(--app-fg)]">
                  Recent conflicts
                </h2>
                <div
                  className="ml-auto flex items-center gap-1"
                  role="group"
                  aria-label="History window"
                >
                  {HISTORY_WINDOWS.map(d => (
                    <button /* design-tokens-allow: sub-24px history-window filter chip (px-1.5 py-0.5 segmented control) - Button box breaks the tight chip - D2 E1 exception (#3358) */
                      key={d}
                      type="button"
                      data-testid={`history-window-${d}`}
                      onClick={() => setHistoryDays(d)}
                      className={`rounded px-1.5 py-0.5 text-[length:var(--text-caption)] tabular-nums ${
                        historyDays === d
                          ? "border border-[var(--app-accent,var(--app-fg))] text-[var(--app-fg)]"
                          : "border border-[var(--app-border)] text-[var(--app-muted)]"
                      }`}
                    >
                      {d}d
                    </button>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    data-testid="history-refresh"
                    title="Refresh history"
                    onClick={() => history.refetch()}
                    className="ml-1 h-auto rounded p-1 text-[var(--app-muted)] hover:bg-transparent"
                  >
                    <RefreshCw size={12} />
                  </Button>
                </div>
              </div>
              <p className="mb-2 text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
                Past overlapping claim windows on the same file — this node
                only. Fetched on demand.
              </p>
              {history.error ? (
                <p
                  data-testid="conflict-history-error"
                  className="py-4 text-center text-[length:var(--text-body)] text-red-400"
                >
                  Couldn't load history: {history.error}
                </p>
              ) : (
                <ConflictHistoryTable
                  rows={history.rows}
                  ignoredPaths={history.ignoredPaths}
                  isLoading={history.isLoading}
                  days={historyDays}
                />
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
