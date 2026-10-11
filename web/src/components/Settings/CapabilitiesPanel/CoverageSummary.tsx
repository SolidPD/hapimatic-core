// SPDX-License-Identifier: AGPL-3.0-only
import type { AuditReport, SurfaceCoverage } from "@/types/capabilities";
import type { Surface } from "@hapi/protocol";

/**
 * CoverageSummary (issue #3752, Sub-Issue L / R5, R6) — the audit's coverage
 * headline (per surface) + drift tallies. READ-ONLY + SERVER-COMPUTED (KD2): every
 * number comes from `GET /api/capabilities/audit`; the panel recomputes nothing.
 * Extracted to clear the eslint `max-lines` cap (OR-4).
 */

const SURFACES: readonly Surface[] = ["rest", "rpc", "mcp", "cli", "ui"];

/** A short, TEXT-only coverage label for one surface. */
function coverageLabel(coverage: SurfaceCoverage | undefined): string {
  if (!coverage || coverage.status === "n/a") return "n/a";
  if (coverage.status === "unknown") return "unknown";
  return `${coverage.cataloged}/${coverage.observed}`;
}

export function CoverageSummary({ report }: { report: AuditReport }) {
  const drift = {
    forward: report.forwardDrift.length,
    reverse: report.reverseDrift.length,
    schema: report.schemaErrors.length,
  };

  return (
    <section data-testid="capability-coverage" className="mb-4">
      <h2 className="mb-1 text-[length:var(--text-label-strong)] font-semibold text-[var(--app-fg)]">
        Coverage
      </h2>
      <div className="flex flex-wrap gap-1.5">
        {SURFACES.map(surface => (
          <div
            key={surface}
            data-testid={`capability-coverage-${surface}`}
            className="rounded border border-[var(--app-border)] px-2 py-1 text-[length:var(--text-caption)]"
          >
            <span className="text-[var(--app-muted)]">{surface}</span>{" "}
            <span className="font-mono tabular-nums text-[var(--app-fg)]">
              {coverageLabel(report.coverage.bySurface[surface])}
            </span>
          </div>
        ))}
      </div>
      <div
        data-testid="capability-drift-counts"
        className="mt-2 flex flex-wrap gap-1.5 text-[length:var(--text-caption)]"
      >
        <span className="text-[var(--app-muted)]">
          Drift: forward{" "}
          <span
            className={
              drift.forward > 0 ? "text-amber-400" : "text-[var(--app-fg)]"
            }
          >
            {drift.forward}
          </span>
          {" · "}reverse{" "}
          <span
            className={
              drift.reverse > 0 ? "text-amber-400" : "text-[var(--app-fg)]"
            }
          >
            {drift.reverse}
          </span>
          {" · "}schema{" "}
          <span
            className={
              drift.schema > 0 ? "text-red-400" : "text-[var(--app-fg)]"
            }
          >
            {drift.schema}
          </span>
        </span>
      </div>
    </section>
  );
}
