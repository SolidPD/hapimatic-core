// SPDX-License-Identifier: AGPL-3.0-only
import type { HistoryConflictRow } from "@/lib/fileConflicts";

// #2815 — the recent-conflicts history table. Deliberately NOT the shared
// 7-column conflict spec (that spec is a cross-surface contract owned by
// FileConflictTable — history has different semantics: no live severity, no
// recommended action, sessions are usually dead). Purely presentational;
// tokens only, never a hardcoded hex (web/CLAUDE.md Styling).

interface ConflictHistoryTableProps {
  rows: HistoryConflictRow[];
  ignoredPaths: string[];
  isLoading: boolean;
  /** The window the rows cover, for the empty-state copy. */
  days: number;
}

const COLUMNS = [
  "File",
  "Repo",
  "Sessions",
  "Change",
  "Pairs",
  "Last conflict",
] as const;

/** Compact relative time — history granularity, not a live timer. */
function formatAgo(epochMs: number, now: number): string {
  const s = Math.max(0, Math.floor((now - epochMs) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function ConflictHistoryTable({
  rows,
  ignoredPaths,
  isLoading,
  days,
}: ConflictHistoryTableProps) {
  const now = Date.now();
  return (
    <div>
      <div className="overflow-x-auto">
        <table
          data-testid="conflict-history-table"
          className="w-full text-left text-sm"
        >
          <thead>
            <tr className="border-b border-[var(--app-border)] text-[var(--app-muted)]">
              {COLUMNS.map(col => (
                <th key={col} className="px-2 py-2 font-medium">
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading && rows.length === 0 && (
              <tr>
                <td
                  colSpan={COLUMNS.length}
                  data-testid="conflict-history-loading"
                  className="py-6 text-center text-[var(--app-muted)]"
                >
                  Loading…
                </td>
              </tr>
            )}
            {!isLoading && rows.length === 0 && (
              <tr>
                <td
                  colSpan={COLUMNS.length}
                  data-testid="conflict-history-empty-state"
                  className="py-6 text-center text-[var(--app-muted)]"
                >
                  No conflicts in the last {days} day{days === 1 ? "" : "s"}.
                </td>
              </tr>
            )}
            {rows.map(row => (
              <tr
                key={`${row.repo}:${row.path}`}
                data-testid="conflict-history-row"
                className="border-b border-[var(--app-border)]"
              >
                <td
                  className={
                    /* design-tokens-allow: 220px table-cell truncation max-width, no spacing token (scale tops at 32px) (L8 #3410) */ "max-w-[220px] truncate px-2 py-2 text-[var(--app-fg)]"
                  }
                  title={`${row.repo} · ${row.path}`}
                >
                  {row.path.split("/").pop()}
                  {row.open && (
                    <span
                      className="ml-1 text-[length:var(--text-caption-xs)] text-[var(--status-warn)]"
                      title="A claim window on this file is still open"
                    >
                      ● open
                    </span>
                  )}
                </td>
                <td className="px-2 py-2 text-[var(--app-hint)]">
                  {row.repo.split("/").pop()}
                </td>
                <td className="px-2 py-2 text-[var(--app-fg)]">
                  <div className="flex flex-col gap-0.5">
                    {row.sessions.map(s => (
                      <span
                        key={s.sessionId}
                        className={
                          /* design-tokens-allow: 160px session-label truncation max-width, no spacing token (L8 #3410) */ "max-w-[160px] truncate"
                        }
                        title={s.sessionId}
                      >
                        {s.label}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-2 py-2 text-[var(--app-fg)]">
                  {row.changeKind}
                </td>
                <td className="px-2 py-2 text-[var(--app-fg)] tabular-nums">
                  {row.pairCount}
                </td>
                <td className="px-2 py-2 whitespace-nowrap text-[var(--app-fg)]">
                  {formatAgo(row.lastConflictAt, now)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {ignoredPaths.length > 0 && (
        <p
          data-testid="conflict-history-ignored-note"
          className="mt-2 px-2 text-[length:var(--text-caption)] text-[var(--app-hint)]"
        >
          {ignoredPaths.length} churn path
          {ignoredPaths.length === 1 ? "" : "s"} hidden (lockfiles, docs,
          tests).
        </p>
      )}
    </div>
  );
}
