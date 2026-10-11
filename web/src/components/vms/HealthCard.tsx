// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo } from "react";
import type { JobStatusResponse } from "@hapi/protocol/adminVms";
import {
  HEALTH_CHECKS,
  HealthResultSchema,
  type HealthInstance,
} from "@hapi/protocol/adminVms";
import type { ApiClient } from "@/api/client";
import { useVmJobActions } from "@/hooks/mutations/useVmJobActions";
import { Button } from "@/components/ui/button";

/**
 * HealthCard — per-VM health summary (issue #2472 R1, epic #2467 Sub E).
 *
 * Reads the latest `health-check` job's parsed `result` from the shared job list
 * (`jobs`, already polled by the VMs page). `check-cloud-health.sh` is
 * fleet-scoped — one sweep covers EVERY instance (expert review R30) — so this
 * card just selects its own instance from `result.instances[]` by name; the
 * "Refresh" control runs ONE read-only fleet sweep that updates every card.
 *
 * The result shape is validated with `safeParse` (the server persists the
 * script's `--json` verbatim as `unknown`, #2468), so a shape drift degrades to
 * "unavailable" rather than crashing the page.
 */
export function HealthCard(props: {
  api: ApiClient | null;
  vmName: string;
  jobs: JobStatusResponse[];
}) {
  const { api, vmName, jobs } = props;
  const { runHealthCheck } = useVmJobActions(api);

  // Latest health-check job that carries a parsed result (terminal jobs only).
  const latestHealth = useMemo(() => {
    return jobs
      .filter(j => j.kind === "health-check" && j.result != null)
      .sort(
        (a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt)
      )[0];
  }, [jobs]);

  // A health sweep in flight (queued/running with no result yet) — drives the
  // "checking" affordance alongside the mutation's own pending state.
  const sweepInFlight =
    runHealthCheck.isPending ||
    jobs.some(
      j =>
        j.kind === "health-check" &&
        j.result == null &&
        (j.state === "queued" || j.state === "running")
    );

  const parsed = useMemo(() => {
    if (!latestHealth?.result) return null;
    const r = HealthResultSchema.safeParse(latestHealth.result);
    return r.success ? r.data : null;
  }, [latestHealth]);

  const instance: HealthInstance | undefined = parsed?.instances.find(
    i => i.name === vmName
  );

  const refresh = () => {
    if (!sweepInFlight) runHealthCheck.mutate();
  };

  return (
    <div
      className="rounded border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-2"
      data-testid={`health-card-${vmName}`}
    >
      <div className="flex items-center justify-between gap-2 pb-1">
        <span className="text-xs font-semibold uppercase tracking-wide text-[var(--app-hint)]">
          Health
        </span>
        <div className="flex items-center gap-2">
          {parsed && (
            <span
              className="text-[length:var(--text-caption-xs)] text-[var(--app-hint)]"
              data-testid={`health-freshness-${vmName}`}
            >
              Checked {parsed.generated_at}
            </span>
          )}
          <Button
            type="button"
            variant="outline"
            onClick={refresh}
            disabled={sweepInFlight}
            data-testid={`health-refresh-btn-${vmName}`}
            className="h-auto rounded px-2 py-0.5 text-xs font-normal text-[var(--app-fg)] hover:bg-[var(--app-bg)]"
          >
            {sweepInFlight ? "Checking…" : "Refresh"}
          </Button>
        </div>
      </div>

      {runHealthCheck.isError && (
        <p
          className="py-1 text-xs text-red-400"
          data-testid={`health-error-${vmName}`}
        >
          {runHealthCheck.error instanceof Error
            ? runHealthCheck.error.message
            : "Health check failed."}
        </p>
      )}

      {!latestHealth && !sweepInFlight && (
        <p
          className="py-1 text-xs text-[var(--app-hint)]"
          data-testid={`health-empty-${vmName}`}
        >
          No health data yet — run a check.
        </p>
      )}

      {latestHealth && !parsed && (
        <p
          className="py-1 text-xs text-amber-400"
          data-testid={`health-unparsable-${vmName}`}
        >
          Latest health result could not be read.
        </p>
      )}

      {parsed && !instance && (
        <p
          className="py-1 text-xs text-[var(--app-hint)]"
          data-testid={`health-noinstance-${vmName}`}
        >
          No health data for this VM in the last sweep.
        </p>
      )}

      {instance && (
        <ul className="flex flex-col gap-0.5" role="list">
          {HEALTH_CHECKS.map(checkName => {
            const check = instance.checks.find(c => c.check === checkName);
            const verdict = check?.verdict ?? "skipped";
            return (
              <li
                key={checkName}
                className="flex items-center gap-2 text-xs"
                data-testid={`health-check-${vmName}-${checkName}`}
              >
                <span
                  className={healthVerdictClass(verdict)}
                  data-testid={`health-verdict-${vmName}-${checkName}`}
                >
                  {healthVerdictLabel(verdict)}
                </span>
                <span className="text-[var(--app-fg)]">{checkName}</span>
                {check?.observed && check.observed !== "-" && (
                  <span className="ml-auto truncate text-[var(--app-hint)]">
                    {check.observed}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** ok → green · alert → red · skipped/unknown → muted. */
function healthVerdictClass(verdict: string): string {
  const base =
    "inline-block min-w-[3.2rem] rounded px-1 text-center text-[length:var(--text-caption-xs)] font-semibold uppercase";
  switch (verdict) {
    case "ok":
      return `${base} bg-emerald-500/15 text-emerald-400`;
    case "alert":
      return `${base} bg-red-500/15 text-red-400`;
    default:
      return `${base} bg-[var(--app-border)] text-[var(--app-hint)]`;
  }
}

function healthVerdictLabel(verdict: string): string {
  switch (verdict) {
    case "ok":
      return "OK";
    case "alert":
      return "ALERT";
    case "skipped":
      return "SKIP";
    default:
      return verdict.toUpperCase();
  }
}
