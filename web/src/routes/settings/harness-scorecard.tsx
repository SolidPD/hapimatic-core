// SPDX-License-Identifier: AGPL-3.0-only
import { ClipboardList } from "lucide-react";
import {
  SettingsSectionHeader,
  TitleChip,
} from "@/components/settings/SettingsSectionHeader";
import { useAppContext } from "@/lib/app-context";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { useEmojiFavicon } from "@/hooks/useEmojiFavicon";
import { useScorecard, type ScorecardRow } from "@/hooks/queries/useScorecard";

/**
 * HarnessScorecardPage — the `/settings/harness-scorecard` route (issue #3128,
 * epic #3117 Sub N). The per-(skill × harness × model) evidence table: runs,
 * gate violations, conformance pass rate, and the operator rating, aggregated
 * from provenance runs + gate-revert events + #3129 conformance reports + one-tap
 * ratings.
 *
 * Registered in BOTH `router.tsx` (route) and `settings/index.tsx` (nav row) —
 * the #2344 lesson: an unregistered route is an invisible page.
 *
 * `null` conformanceRate/avgRating render as "—" (not measured), never a
 * misleading 0 (OR4). A `skill: null` row is a HARNESS-LEVEL rollup (gate
 * violations, harness-level conformance, skill-less runs) and is labelled
 * distinctly (KD4).
 */
function fmtPct(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

function fmtRating(row: ScorecardRow): string {
  return row.avgRating === null
    ? "—"
    : `${row.avgRating.toFixed(1)} (${row.ratingCount})`;
}

export default function HarnessScorecardPage() {
  useDocumentTitle("Harness Scorecard - Hapimatic");
  useEmojiFavicon(null);
  const { api } = useAppContext();

  const scorecard = useScorecard(api);
  const rows = scorecard.data ?? [];

  return (
    <div
      data-testid="settings-harness-scorecard-root"
      className="h-full overflow-y-auto"
    >
      <SettingsSectionHeader
        icon={<TitleChip icon={ClipboardList} accent="var(--accent-mint)" />}
        title="Harness Scorecard"
      />
      <div className="mx-auto flex w-full max-w-content flex-col gap-3 px-4 pb-6">
        <p className="text-xs text-[var(--app-hint)]">
          Per-(skill × harness × model) evidence: runs, server-gate violations,
          conformance pass rate, and operator rating. A blank rate means not yet
          measured, never zero.
        </p>

        {scorecard.isLoading ? (
          <p
            className="py-6 text-sm text-[var(--app-hint)]"
            data-testid="scorecard-loading"
          >
            Loading scorecard…
          </p>
        ) : scorecard.isError ? (
          <p
            className="py-6 text-sm text-[var(--app-hint)]"
            data-testid="scorecard-error"
          >
            Scorecard is unavailable on this instance.
          </p>
        ) : rows.length === 0 ? (
          <p
            className="py-6 text-sm text-[var(--app-hint)]"
            data-testid="scorecard-empty"
          >
            No evidence recorded yet. Rows appear as provenance runs,
            gate-revert events, conformance reports, and ratings arrive.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table
              className="w-full border-collapse text-left text-xs"
              data-testid="scorecard-table"
            >
              <thead>
                <tr className="border-b border-[var(--app-hover)] text-[var(--app-hint)]">
                  <th className="px-2 py-1.5 font-medium">Harness</th>
                  <th className="px-2 py-1.5 font-medium">Model</th>
                  <th className="px-2 py-1.5 font-medium">Skill</th>
                  <th className="px-2 py-1.5 text-right font-medium">Runs</th>
                  <th className="px-2 py-1.5 text-right font-medium">
                    Gate viol.
                  </th>
                  <th className="px-2 py-1.5 text-right font-medium">
                    Conformance
                  </th>
                  <th className="px-2 py-1.5 text-right font-medium">Rating</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr
                    key={`${row.harness}|${row.model ?? ""}|${row.skill ?? ""}|${i}`}
                    className="border-b border-[var(--app-hover)]"
                    data-testid="scorecard-row"
                  >
                    <td className="px-2 py-1.5 font-medium text-[var(--app-fg)]">
                      {row.harness}
                    </td>
                    <td className="px-2 py-1.5 text-[var(--app-hint)]">
                      {row.model ?? "—"}
                    </td>
                    <td className="px-2 py-1.5">
                      {row.skill === null ? (
                        <span
                          className="rounded bg-[var(--app-hover)] px-1.5 py-0.5 text-[length:var(--text-caption-xs)] text-[var(--app-hint)]"
                          data-testid="scorecard-harness-level"
                        >
                          harness-level
                        </span>
                      ) : (
                        <span className="font-mono text-[var(--app-fg)]">
                          {row.skill}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {row.runs}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {row.gateViolations}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {fmtPct(row.conformanceRate)}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {fmtRating(row)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
