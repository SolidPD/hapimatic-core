// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useMemo, useState } from "react";
import type { JobState } from "@hapi/protocol/adminVms";
import {
  RECONCILE_SURFACES,
  ReconcileDetectResultSchema,
  type ReconcileSurface,
  type ReconcileSurfaceName,
} from "@hapi/protocol/adminVms";
import type { ApiClient } from "@/api/client";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { useVmJob } from "@/hooks/queries/useVmInventory";
import { useVmJobActions } from "@/hooks/mutations/useVmJobActions";

const TERMINAL_STATES = new Set<JobState>([
  "succeeded",
  "failed",
  "capacity-waiting",
]);

/** Poll a job every 1.5s until it reaches a terminal state (then stop). */
function pollUntilTerminal(query: {
  state: { data?: { state: JobState } };
}): number | false {
  const st = query.state.data?.state;
  return st && TERMINAL_STATES.has(st) ? false : 1500;
}

/**
 * ReconcilePanel — per-VM contract-drift detection + gated repair (issue #2472
 * R2/R3/R4, epic #2467 Sub E).
 *
 * "Detect" runs a read-only `reconcile-detect` (all six surfaces); the panel
 * polls that job until terminal, then renders each surface's verdict
 * (match / diverged / absent / error — `error` rendered DISTINCTLY from drift).
 *
 * Repairs are per-surface and confirmation-gated — there is NO blanket
 * repair-all control in the DOM. `age-recipient`'s confirm explicitly names the
 * surface (R3). `handoff-secret` is detection-only (#2316): it shows the rotate
 * procedure and NO repair button (the server also rejects a handoff-secret
 * repair). A `--surface X --apply` repair job's own result carries ONLY surface
 * X, so on repair completion the panel re-runs a full detect rather than
 * blanking the other five surfaces.
 *
 * The result is validated with `safeParse` (the server persists the script's
 * `--json` verbatim as `unknown`, #2468), degrading to "unavailable" on drift.
 */
export function ReconcilePanel(props: {
  api: ApiClient | null;
  vmName: string;
}) {
  const { api, vmName } = props;
  const { reconcileDetect, reconcileRepair } = useVmJobActions(api);

  // detectJobId drives the six-surface display; repairJobId tracks an in-flight
  // repair and, on completion, triggers a fresh full detect.
  const [detectJobId, setDetectJobId] = useState<string | null>(null);
  const [repairJobId, setRepairJobId] = useState<string | null>(null);
  const [confirmSurface, setConfirmSurface] =
    useState<ReconcileSurfaceName | null>(null);

  const detectJob = useVmJob(api, detectJobId, {
    refetchInterval: pollUntilTerminal,
  });
  const repairJob = useVmJob(api, repairJobId, {
    refetchInterval: pollUntilTerminal,
  });

  // When a repair reaches terminal, re-run a FULL detect (a --surface repair's
  // own result carries only that one surface). Clearing repairJobId first makes
  // this fire exactly once per repair.
  const repairState = repairJob.data?.state;
  useEffect(() => {
    if (repairJobId && repairState && TERMINAL_STATES.has(repairState)) {
      setRepairJobId(null);
      reconcileDetect.mutate(vmName, {
        onSuccess: res => setDetectJobId(res.job.id),
      });
    }
    // reconcileDetect is a stable react-query handle; keying on the repair state
    // + id alone is intentional (avoid a re-fire loop).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repairState, repairJobId, vmName]);

  const detectDone = detectJob.data
    ? TERMINAL_STATES.has(detectJob.data.state)
    : false;
  const detectRunning =
    reconcileDetect.isPending || (detectJobId !== null && !detectDone);
  const repairRunning = reconcileRepair.isPending || repairJobId !== null;
  const busy = detectRunning || repairRunning;

  const result = useMemo(() => {
    if (!detectJob.data?.result) return null;
    const r = ReconcileDetectResultSchema.safeParse(detectJob.data.result);
    return r.success ? r.data : null;
  }, [detectJob.data]);

  const vm = result
    ? (result.vms.find(v => v.name === vmName) ?? result.vms[0])
    : undefined;

  const detect = () => {
    reconcileDetect.mutate(vmName, {
      onSuccess: res => setDetectJobId(res.job.id),
    });
  };

  return (
    <div
      className="rounded border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-2"
      data-testid={`reconcile-panel-${vmName}`}
    >
      <div className="flex items-center justify-between gap-2 pb-1">
        <span className="text-xs font-semibold uppercase tracking-wide text-[var(--app-hint)]">
          Reconcile
        </span>
        <div className="flex items-center gap-2">
          {result && (
            <span
              className={
                result.all_match
                  ? "text-[length:var(--text-caption-xs)] text-emerald-400"
                  : "text-[length:var(--text-caption-xs)] text-amber-400"
              }
              data-testid={`reconcile-summary-${vmName}`}
            >
              {result.all_match ? "all match" : "drift detected"}
            </span>
          )}
          <Button
            type="button"
            variant="outline"
            onClick={detect}
            disabled={busy}
            data-testid={`reconcile-detect-btn-${vmName}`}
            className="h-auto rounded px-2 py-0.5 text-xs font-normal text-[var(--app-fg)] hover:bg-[var(--app-bg)]"
          >
            {repairRunning
              ? "Repairing…"
              : detectRunning
                ? "Detecting…"
                : "Detect"}
          </Button>
        </div>
      </div>

      {reconcileDetect.isError && (
        <p
          className="py-1 text-xs text-red-400"
          data-testid={`reconcile-error-${vmName}`}
        >
          {reconcileDetect.error instanceof Error
            ? reconcileDetect.error.message
            : "Detection failed."}
        </p>
      )}

      {detectJobId === null && !detectRunning && (
        <p
          className="py-1 text-xs text-[var(--app-hint)]"
          data-testid={`reconcile-empty-${vmName}`}
        >
          Not yet detected — run detection.
        </p>
      )}

      {detectJobId !== null && detectDone && !result && (
        <p
          className="py-1 text-xs text-amber-400"
          data-testid={`reconcile-unparsable-${vmName}`}
        >
          Detection result could not be read.
        </p>
      )}

      {vm && (
        <ul className="flex flex-col gap-0.5" role="list">
          {RECONCILE_SURFACES.map(name => (
            <SurfaceRow
              key={name}
              vmName={vmName}
              name={name}
              surface={vm.surfaces.find(x => x.name === name)}
              onRepair={() => setConfirmSurface(name)}
            />
          ))}
        </ul>
      )}

      <ConfirmDialog
        isOpen={confirmSurface !== null}
        onClose={() => setConfirmSurface(null)}
        title={
          confirmSurface
            ? `Repair ${confirmSurface} on ${vmName}`
            : "Repair surface"
        }
        description={
          confirmSurface
            ? `This runs reconcile-vm.sh --surface ${confirmSurface} --apply against the live host ${vmName}, rewriting the reference artifact for the ${confirmSurface} surface only. It does not touch any other surface.`
            : ""
        }
        confirmLabel="Repair"
        confirmingLabel="Repairing…"
        isPending={reconcileRepair.isPending}
        destructive
        onConfirm={async () => {
          if (!confirmSurface) return;
          const res = await reconcileRepair.mutateAsync({
            name: vmName,
            surface: confirmSurface,
          });
          setRepairJobId(res.job.id);
        }}
      />
    </div>
  );
}

/** One surface row: verdict badge + a gated repair affordance (or rotate note). */
function SurfaceRow(props: {
  vmName: string;
  name: ReconcileSurfaceName;
  surface: ReconcileSurface | undefined;
  onRepair: () => void;
}) {
  const { vmName, name, surface, onRepair } = props;
  const verdict = surface?.verdict ?? "unknown";
  const drifted = verdict === "diverged" || verdict === "absent";
  const isHandoffSecret = name === "handoff-secret";

  return (
    <li
      className="flex flex-col gap-0.5 text-xs"
      data-testid={`reconcile-surface-${vmName}-${name}`}
    >
      <div className="flex items-center gap-2">
        <span
          className={reconcileVerdictClass(verdict)}
          data-testid={`reconcile-verdict-${vmName}-${name}`}
        >
          {verdict.toUpperCase()}
        </span>
        <span className="text-[var(--app-fg)]">{name}</span>
        {/* handoff-secret is detection-only — never a repair button (#2316, R4). */}
        {drifted && !isHandoffSecret && (
          <Button
            type="button"
            variant="outline"
            onClick={onRepair}
            data-testid={`reconcile-repair-btn-${vmName}-${name}`}
            className="ml-auto h-auto rounded border-amber-500/40 px-1.5 py-0.5 text-[length:var(--text-caption-xs)] text-amber-300 hover:bg-amber-500/10"
          >
            Repair…
          </Button>
        )}
      </div>
      {isHandoffSecret && drifted && (
        <p
          className="rounded bg-[var(--app-bg)] p-1.5 text-[length:var(--text-caption-xs)] leading-relaxed text-[var(--app-hint)]"
          data-testid={`reconcile-rotate-${vmName}`}
        >
          handoff-secret has no automated repair — it never transports key
          material. To re-key: from the gateway host run{" "}
          <code>hapimatic-gateway rotate-secret {vmName}</code>, set{" "}
          <code>HAPI_GOOGLE_HANDOFF_SECRET</code> in the VM&apos;s handoff
          drop-in, run <code>systemctl --user daemon-reload</code> on the VM,
          then re-detect.
        </p>
      )}
    </li>
  );
}

/** match → green · diverged/absent → amber · error → distinct red · else muted. */
function reconcileVerdictClass(verdict: string): string {
  const base =
    "inline-block min-w-[4.5rem] rounded px-1 text-center text-[length:var(--text-caption-xs)] font-semibold uppercase";
  switch (verdict) {
    case "match":
      return `${base} bg-emerald-500/15 text-emerald-400`;
    case "diverged":
    case "absent":
      return `${base} bg-amber-500/15 text-amber-400`;
    case "error":
      // DISTINCT from drift (R2): a hard red with a ring, not the amber tone.
      return `${base} bg-red-500/20 text-red-300 ring-1 ring-red-500/40`;
    default:
      return `${base} bg-[var(--app-border)] text-[var(--app-hint)]`;
  }
}
