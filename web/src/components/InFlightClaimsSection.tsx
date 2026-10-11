// SPDX-License-Identifier: AGPL-3.0-only
import type { InFlightSessionGroup } from "@/lib/fileConflicts";
import { ClaimBadge } from "@/components/FileConflictTable";

// #2815 — the in-flight claims inventory: every live claim grouped by owning
// session, rendered below the conflict table so the page is informative even
// at zero conflicts. Purely presentational (props in, markup out — the same R6
// discipline as FileConflictTable): no data fetching, no state mutation.
// Tokens only, never a hardcoded hex (web/CLAUDE.md Styling).

interface InFlightClaimsSectionProps {
  groups: InFlightSessionGroup[];
  isLoading: boolean;
}

function NodeChip({ nodeLabel }: { nodeLabel?: string }) {
  if (!nodeLabel) return null;
  return (
    <span className="ml-1 rounded-full bg-[var(--app-hint)]/15 px-1.5 py-0.5 text-[length:var(--text-caption-xs)] text-[var(--app-hint)]">
      {nodeLabel}
    </span>
  );
}

export function InFlightClaimsSection({
  groups,
  isLoading,
}: InFlightClaimsSectionProps) {
  const claimCount = groups.reduce((n, g) => n + g.claims.length, 0);
  return (
    <section data-testid="in-flight-claims-section" className="mt-6">
      <h2 className="mb-1 text-[length:var(--text-label-strong)] font-semibold text-[var(--app-fg)]">
        In-flight claims{claimCount > 0 ? ` (${claimCount})` : ""}
      </h2>
      <p className="mb-2 text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
        Every file live sessions have declared (expected) or edited (active) —
        this node only.
      </p>
      {isLoading && groups.length === 0 && (
        <p
          data-testid="in-flight-loading"
          className="py-4 text-center text-[length:var(--text-body)] text-[var(--app-muted)]"
        >
          Loading…
        </p>
      )}
      {!isLoading && groups.length === 0 && (
        <p
          data-testid="in-flight-empty-state"
          className="py-4 text-center text-[length:var(--text-body)] text-[var(--app-muted)]"
        >
          No live claims.
        </p>
      )}
      <div className="flex flex-col gap-3">
        {groups.map(group => (
          <div
            key={group.sessionId}
            data-testid="in-flight-session-group"
            className="rounded border border-[var(--app-border)] px-3 py-2"
          >
            <div className="mb-1 flex items-baseline gap-1 text-[length:var(--text-body)]">
              <span
                className="font-medium text-[var(--app-fg)]"
                title={group.sessionId}
              >
                {group.label}
              </span>
              <NodeChip nodeLabel={group.nodeLabel} />
              <span className="ml-auto text-[length:var(--text-caption)] text-[var(--app-hint)] tabular-nums">
                {group.claims.length} file
                {group.claims.length === 1 ? "" : "s"}
              </span>
            </div>
            <ul className="flex flex-col gap-0.5">
              {group.claims.map(claim => (
                <li
                  key={`${claim.repo}:${claim.path}:${claim.claimType}`}
                  data-testid="in-flight-claim-row"
                  className="flex items-center gap-2 text-[length:var(--text-body-dense)]"
                >
                  <span
                    className="min-w-0 flex-1 truncate text-[var(--app-fg)]"
                    title={`${claim.repo} · ${claim.path}`}
                  >
                    <span className="text-[var(--app-hint)]">
                      {claim.repo.split("/").pop()} ·{" "}
                    </span>
                    {claim.path}
                  </span>
                  <span className="text-[var(--app-muted)]">
                    {claim.changeKind}
                  </span>
                  <ClaimBadge claimType={claim.claimType} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
