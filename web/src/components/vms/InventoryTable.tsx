// SPDX-License-Identifier: AGPL-3.0-only
import { Fragment, type ReactNode, useState } from "react";
import type {
  VmInventoryEntry,
  VmInventoryVerdict,
  VmParityHub,
  VmParitySummary,
} from "@hapi/protocol/adminVms";
import type { ApiClient } from "@/api/client";
import { DeprovisionDialog } from "@/components/vms/DeprovisionDialog";
import { Button } from "@/components/ui/button";
import { formatRelativeTime } from "@/lib/sessionHelpers";

const VM_PARITY_BADGE_BASE =
  "rounded border px-1.5 py-0.5 text-[length:var(--text-caption)] font-medium";
const VM_PARITY_OK = "border-emerald-500/40 bg-emerald-500/10 text-emerald-300";
const VM_PARITY_BAD = "border-red-500/40 bg-red-500/10 text-red-300";
const VM_PARITY_WARN = "border-amber-500/40 bg-amber-500/10 text-amber-300";
const VM_PARITY_NEUTRAL =
  "border-[var(--app-border)] bg-[var(--app-secondary-bg)] text-[var(--app-hint)]";

/**
 * The verdict badge for a recorded parity status. Exhaustive over Sub F's
 * verdicts (the `JobLogViewer` `stateStyle` shape): a verdict added to
 * `VM_PARITY_VERDICTS` is a compile error here, never a silent "Skipped".
 */
function vmParityBadge(
  vmParity: Extract<VmParitySummary, { state: "recorded" }>
): { label: string; className: string } {
  switch (vmParity.verdict) {
    case "pass":
      // A stale pass is not current evidence of parity — never green.
      return {
        label: "Pass",
        className: vmParity.stale ? VM_PARITY_NEUTRAL : VM_PARITY_OK,
      };
    case "drift":
      return { label: `Drift (${vmParity.drift})`, className: VM_PARITY_BAD };
    case "error":
      return { label: "Error", className: VM_PARITY_BAD };
    case "skipped":
      return { label: "Skipped", className: VM_PARITY_WARN };
  }
}

/**
 * The parity cell (#3557, epic #3550 Sub G1): one VM's Sub F parity status as
 * the server projected it. `data-vm-parity-state` names the state the operator
 * should act on — `stale` outranks the verdict, because a stale pass is not
 * evidence of parity. A VM with no `vmParity` has no status file: never checked.
 */
function VmParityCell(props: {
  name: string;
  vmParity: VmParitySummary | undefined;
}) {
  const { name, vmParity } = props;
  const testId = `inventory-vm-parity-${name}`;

  if (!vmParity) {
    return (
      <td
        className="py-2 pr-3 text-[var(--app-hint)]"
        data-testid={testId}
        data-vm-parity-state="never-checked"
      >
        Never checked
      </td>
    );
  }

  if (vmParity.state === "unreadable") {
    return (
      <td
        className="py-2 pr-3"
        data-testid={testId}
        data-vm-parity-state="unreadable"
      >
        <span
          className={`${VM_PARITY_BADGE_BASE} ${VM_PARITY_WARN}`}
          title="A parity status file exists but is not a valid record"
        >
          Unreadable
        </span>
      </td>
    );
  }

  const badge = vmParityBadge(vmParity);
  const checkedAgo = formatRelativeTime(Date.parse(vmParity.checkedAt));

  return (
    <td
      className="py-2 pr-3"
      data-testid={testId}
      data-vm-parity-state={vmParity.stale ? "stale" : vmParity.verdict}
    >
      <div className="flex flex-wrap items-center gap-1">
        <span
          className={`${VM_PARITY_BADGE_BASE} ${badge.className}`}
          title={`Manifest ${vmParity.manifestVersion}`}
        >
          {badge.label}
        </span>
        {vmParity.stale && (
          <span className={`${VM_PARITY_BADGE_BASE} ${VM_PARITY_WARN}`}>
            Stale
          </span>
        )}
      </div>
      {checkedAgo && (
        <div
          className="pt-0.5 text-[length:var(--text-caption)] text-[var(--app-hint)]"
          title={vmParity.checkedAt}
        >
          {checkedAgo}
        </div>
      )}
    </td>
  );
}

/**
 * ParityHubTable — RP1's own parity row (#3996). RP1 is the declared profile's
 * verify-only source node: it checks itself nightly and the record is served by
 * `/api/admin-vms/parity-hub`, OUTSIDE the fleet inventory, so this row has no
 * URL, health card, reconcile panel or deprovision action. It renders on its
 * own, above the fleet table, so an empty or failed inventory never hides it,
 * and a failed hub read never hides the fleet.
 */
export function ParityHubTable(props: {
  hub: VmParityHub | undefined;
  isLoading: boolean;
  isError: boolean;
}) {
  const { hub, isLoading, isError } = props;
  return (
    <div data-testid="parity-hub" className="pb-3">
      <h2 className="flex items-center gap-2 pb-1 text-xs font-semibold uppercase tracking-wide text-[var(--app-hint)]">
        RP1 (hub)
      </h2>
      {isError && (
        <p
          className="py-2 text-sm text-[var(--app-hint)]"
          data-testid="parity-hub-error"
        >
          RP1 hub parity is unavailable.
        </p>
      )}
      {isLoading && !isError && (
        <p
          className="py-2 text-sm text-[var(--app-hint)]"
          data-testid="parity-hub-loading"
        >
          Loading RP1 hub parity…
        </p>
      )}
      {hub && !isLoading && !isError && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-[var(--app-border)] text-left text-xs text-[var(--app-hint)]">
                <th className="py-1.5 pr-3 font-medium">Name</th>
                <th className="py-1.5 pr-3 font-medium">Role</th>
                <th className="py-1.5 pr-3 font-medium">Parity</th>
              </tr>
            </thead>
            <tbody>
              <tr
                className="align-top"
                data-testid={`parity-hub-row-${hub.name}`}
              >
                <td className="py-2 pr-3 font-medium text-[var(--app-fg)]">
                  {hub.name}
                </td>
                <td className="py-2 pr-3 text-[var(--app-hint)]">
                  Profile source node, checked against the declared profile
                  (never repaired)
                </td>
                <VmParityCell
                  name={`hub-${hub.name}`}
                  vmParity={hub.vmParity}
                />
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * InventoryTable — the sanitized fleet inventory (issue #2470 R2).
 *
 * Binds ONLY `{name, url}` + a health-summary column (the `—` placeholder; the
 * live health lives in the per-row HealthCard) + a parity column (#3557 — the
 * server's projection of Sub F's per-VM status file). There is deliberately no email
 * column (the gateway user-map is write-only — no server-readable email source,
 * expert review D4-A) and no token field (the server's `.strict()` allowlist
 * means one cannot exist in the typed payload).
 *
 * Each row has an EXPANDABLE full-width detail row that hosts `renderRowExtra`
 * (#2472's HealthCard + ReconcilePanel), plus a Deprovision action that opens the
 * two-step confirm. The detail row is collapsed by default — the cards only mount
 * (and only issue their reads) once the operator expands the row.
 */
export function InventoryTable(props: {
  api: ApiClient | null;
  entries: VmInventoryEntry[];
  isLoading: boolean;
  isError: boolean;
  /**
   * #2552: a loud read-path divergence verdict (missing/stale/schema-drift) when
   * the endpoint could not serve a healthy fleet array. Mutually exclusive with a
   * non-empty `entries` — rendered as its own DISTINCT state, never a blank panel.
   */
  verdict?: VmInventoryVerdict | null;
  renderRowExtra?: (entry: VmInventoryEntry) => ReactNode;
  onDeprovisionApplied?: (jobId: string) => void;
}) {
  const {
    api,
    entries,
    isLoading,
    isError,
    verdict,
    renderRowExtra,
    onDeprovisionApplied,
  } = props;
  const [deprovisionTarget, setDeprovisionTarget] = useState<string | null>(
    null
  );
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpanded = (name: string) =>
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  return (
    <div data-testid="inventory-table">
      <h2 className="flex items-center gap-2 pb-1 text-xs font-semibold uppercase tracking-wide text-[var(--app-hint)]">
        Fleet inventory
      </h2>

      {isLoading && (
        <p
          className="py-3 text-sm text-[var(--app-hint)]"
          data-testid="inventory-loading"
        >
          Loading inventory…
        </p>
      )}

      {isError && !isLoading && (
        <p className="py-3 text-sm text-red-400" data-testid="inventory-error">
          Failed to load the fleet inventory.
        </p>
      )}

      {/* #2552: a loud read-path divergence verdict — a DISTINCT state per
          status, so a missing/stale/schema-drifted inventory renders an explicit
          reason instead of the old silent "0 VMs" empty state. */}
      {!isLoading && !isError && verdict && (
        <div
          className="flex flex-col gap-1 py-3"
          data-testid={`inventory-verdict-${verdict.status}`}
          role="alert"
        >
          <p className="text-sm font-medium text-amber-400">
            {verdict.status === "missing"
              ? "Fleet inventory missing"
              : verdict.status === "stale"
                ? "Fleet inventory stale"
                : "Fleet inventory schema drift"}
          </p>
          <p className="text-sm text-[var(--app-hint)]">{verdict.message}</p>
        </div>
      )}

      {!isLoading && !isError && !verdict && entries.length === 0 && (
        <p
          className="py-3 text-sm text-[var(--app-hint)]"
          data-testid="inventory-empty"
        >
          No VMs in the fleet yet.
        </p>
      )}

      {entries.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-[var(--app-border)] text-left text-xs text-[var(--app-hint)]">
                <th className="py-1.5 pr-3 font-medium">Name</th>
                <th className="py-1.5 pr-3 font-medium">URL</th>
                <th className="py-1.5 pr-3 font-medium">Health</th>
                <th className="py-1.5 pr-3 font-medium">Parity</th>
                <th className="py-1.5 font-medium" />
              </tr>
            </thead>
            <tbody>
              {entries.map(entry => {
                const isExpanded = expanded.has(entry.name);
                return (
                  <Fragment key={entry.name}>
                    <tr
                      className="border-b border-[var(--app-border)] last:border-b-0 align-top"
                      data-testid={`inventory-row-${entry.name}`}
                    >
                      <td className="py-2 pr-3 font-medium text-[var(--app-fg)]">
                        {entry.name}
                      </td>
                      <td className="max-w-[10rem] truncate py-2 pr-3 text-[var(--app-hint)]">
                        {entry.url ? (
                          <a
                            href={entry.url}
                            target="_blank"
                            rel="noreferrer"
                            title={entry.url}
                            className="text-[var(--app-link)] hover:underline"
                          >
                            {entry.url}
                          </a>
                        ) : (
                          "—"
                        )}
                      </td>
                      {/* Health summary column: the live per-check result lives in
                          the expandable HealthCard below (#2472). */}
                      <td
                        className="py-2 pr-3 text-[var(--app-hint)]"
                        data-testid={`inventory-health-${entry.name}`}
                      >
                        —
                      </td>
                      <VmParityCell
                        name={entry.name}
                        vmParity={entry.vmParity}
                      />
                      <td className="py-2 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          {renderRowExtra && (
                            <Button
                              type="button"
                              variant="outline"
                              onClick={() => toggleExpanded(entry.name)}
                              aria-expanded={isExpanded}
                              data-testid={`inventory-expand-${entry.name}`}
                              className="h-auto rounded px-2 py-1 text-xs font-normal text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)]"
                            >
                              {isExpanded ? "Hide" : "Health & reconcile"}
                            </Button>
                          )}
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => setDeprovisionTarget(entry.name)}
                            data-testid={`inventory-deprovision-${entry.name}`}
                            className="h-auto rounded border-red-500/40 px-2 py-1 text-xs text-red-300 hover:bg-red-500/10"
                          >
                            Deprovision
                          </Button>
                        </div>
                      </td>
                    </tr>
                    {renderRowExtra && isExpanded && (
                      <tr
                        className="border-b border-[var(--app-border)] last:border-b-0"
                        data-testid={`inventory-detail-${entry.name}`}
                      >
                        <td colSpan={5} className="pb-3">
                          {renderRowExtra(entry)}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <DeprovisionDialog
        api={api}
        subdomain={deprovisionTarget}
        onClose={() => setDeprovisionTarget(null)}
        onApplied={onDeprovisionApplied}
      />
    </div>
  );
}
