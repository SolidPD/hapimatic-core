// SPDX-License-Identifier: AGPL-3.0-only
import type { Severity } from "@hapi/protocol";
import type { FileConflictRow, RowClaimType } from "@/lib/fileConflicts";

// File Conflict Monitor (epic #1965) Sub F / #1971 — the standardized, read-only
// conflict table. This is the SHARED spec surface (same 7 columns as the rp1-home
// PreToolUse escalation and spawn-gate output); the observe-phase report and the
// later warn banner (Phase 2) reuse this component verbatim, so it stays purely
// presentational: props in, table out, no data fetching and no state mutation (R6).
//
// The severity glyph IS the value from the shared `@hapi/protocol` computeSeverity —
// rendered as-is (KD4), with an optional token-driven left accent for scanability.
// Tokens only, never a hardcoded hex (web/CLAUDE.md Styling).

interface FileConflictTableProps {
  rows: FileConflictRow[];
  ignoredPaths: string[];
  isLoading: boolean;
}

/** Fixed column order (R1) — do NOT reorder; the spec is shared cross-surface. */
const COLUMNS = [
  "File/Pattern",
  "Severity",
  "Change",
  "Issues",
  "Sessions+Node",
  "Claim",
  "Action",
] as const;

/** Status-triad CSS var per severity glyph (KD4 — the row's left-accent color). */
const SEVERITY_VAR: Record<Severity, string> = {
  "🔴": "--status-hot",
  "🟡": "--status-warn",
  "🟢": "--status-ok",
};

/** Claim-type badge color (active/mixed are warmer to flag an in-flight edit). */
const CLAIM_VAR: Record<RowClaimType, string> = {
  active: "--status-warn",
  mixed: "--status-hot",
  expected: "--app-muted",
};

/** Shared with the #2815 in-flight inventory — exported, still purely presentational. */
export function ClaimBadge({ claimType }: { claimType: RowClaimType }) {
  return (
    <span
      className="inline-block rounded px-1.5 py-0.5 text-xs font-medium"
      style={{
        color: `var(${CLAIM_VAR[claimType]})`,
        border: `1px solid var(${CLAIM_VAR[claimType]})`,
      }}
    >
      {claimType}
    </span>
  );
}

function NodeBadge({ nodeLabel }: { nodeLabel?: string }) {
  if (!nodeLabel) return null;
  return (
    <span className="ml-1 rounded-full bg-[var(--app-hint)]/15 px-1.5 py-0.5 text-[length:var(--text-caption-xs)] text-[var(--app-hint)]">
      {nodeLabel}
    </span>
  );
}

export function FileConflictTable({
  rows,
  ignoredPaths,
  isLoading,
}: FileConflictTableProps) {
  return (
    <div>
      <div className="overflow-x-auto">
        <table
          data-testid="file-conflict-table"
          className="w-full text-left text-sm"
        >
          <thead>
            <tr className="border-b border-[var(--app-border)] text-[var(--app-muted)]">
              {COLUMNS.map((col, i) => (
                <th
                  key={col}
                  className={`px-2 py-2 font-medium ${
                    i === 1 ? "text-center" : ""
                  }`}
                >
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
                  data-testid="file-conflicts-loading-row"
                  className="py-8 text-center text-[var(--app-muted)]"
                >
                  Loading…
                </td>
              </tr>
            )}
            {!isLoading && rows.length === 0 && (
              <tr>
                <td
                  colSpan={COLUMNS.length}
                  data-testid="file-conflicts-empty-state"
                  className="py-8 text-center text-[var(--app-muted)]"
                >
                  No file conflicts among live sessions.
                </td>
              </tr>
            )}
            {rows.map(row => (
              <tr
                key={`${row.repo}\u0000${row.path}`}
                data-testid="file-conflict-row"
                className="border-b border-[var(--app-border)]"
              >
                <td
                  className={
                    /* design-tokens-allow: 220px table-cell truncation max-width, no spacing token (scale tops at 32px) (L8 #3410) */ "max-w-[220px] truncate px-2 py-2 text-[var(--app-fg)]"
                  }
                  style={{
                    borderLeft: `3px solid var(${SEVERITY_VAR[row.severity]})`,
                  }}
                  title={`${row.repo} · ${row.path}`}
                >
                  {row.path.split("/").pop()}
                </td>
                <td
                  className="px-2 py-2 text-center text-base"
                  aria-label={`severity ${row.severity}`}
                >
                  {row.severity}
                </td>
                <td className="px-2 py-2 text-[var(--app-fg)]">
                  {row.changeKind}
                </td>
                <td className="px-2 py-2 text-[var(--app-fg)] tabular-nums">
                  {row.issues.length > 0
                    ? row.issues.map(n => `#${n}`).join(", ")
                    : "—"}
                </td>
                <td className="px-2 py-2 text-[var(--app-fg)]">
                  <div className="flex flex-col gap-0.5">
                    {row.sessions.map(s => (
                      <span key={s.sessionId} className="whitespace-nowrap">
                        <span
                          className={
                            /* design-tokens-allow: 140px session-label truncation max-width, no spacing token (L8 #3410) */ "max-w-[140px] truncate align-middle"
                          }
                          title={s.sessionId}
                        >
                          {s.label}
                        </span>
                        <NodeBadge nodeLabel={s.nodeLabel} />
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-2 py-2">
                  <ClaimBadge claimType={row.claimType} />
                </td>
                <td className="px-2 py-2 text-[var(--app-fg)]">
                  {row.recommendedAction}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {ignoredPaths.length > 0 && (
        <p
          data-testid="file-conflicts-ignored-note"
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
