// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import {
  isVmInventoryVerdict,
  type JobStatusResponse,
  type VmInventoryEntry,
  type VmInventoryVerdict,
} from "@hapi/protocol/adminVms";
import { ServerCog } from "lucide-react";
import {
  SettingsSectionHeader,
  TitleChip,
} from "@/components/settings/SettingsSectionHeader";
import { useAppContext } from "@/lib/app-context";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { useEmojiFavicon } from "@/hooks/useEmojiFavicon";
import {
  useVmInventory,
  useVmJobs,
  useVmParityHub,
  useVmPreflight,
} from "@/hooks/queries/useVmInventory";
import {
  InventoryTable,
  ParityHubTable,
} from "@/components/vms/InventoryTable";
import { JobLogViewer } from "@/components/vms/JobLogViewer";
import { NewVmForm } from "@/components/vms/NewVmForm";
import { HealthCard } from "@/components/vms/HealthCard";
import { ReconcilePanel } from "@/components/vms/ReconcilePanel";
import { Button } from "@/components/ui/button";

/**
 * AdminVmsPage — the `/settings/vms` route (issue #2470, epic #2467 Sub C).
 *
 * The operator-only VM provisioning panel: fleet inventory, a New VM form, a
 * live phase-by-phase job log, and a two-step deprovision confirm. Registered in
 * BOTH `router.tsx` (route) and `admin/index.tsx` (nav row) — the #2344 lesson:
 * an unregistered route is an invisible page.
 *
 * FAIL-CLOSED capability gate: the page renders its panels only when
 * `useVmPreflight().data?.enabled === true`. On a user-VM binary the preflight
 * route 404s (the server capability guard), so the query errors and `data` stays
 * undefined — loading, error, AND 404 all fall through to the disabled state.
 * This is defense-in-depth beyond the hidden nav row: even a direct URL visit on
 * a capability-closed instance shows no panel content, not a broken page.
 */
export default function AdminVmsPage() {
  useDocumentTitle("VMs - Hapimatic");
  useEmojiFavicon(null);
  const { api, token } = useAppContext();

  const preflight = useVmPreflight(api);
  const enabled = preflight.data?.enabled === true;

  const [activeJobId, setActiveJobId] = useState<string | null>(null);

  const inventory = useVmInventory(api, { enabled });
  // #3996: RP1's own parity record, rendered above the fleet (never a fleet row).
  const parityHub = useVmParityHub(api, { enabled });
  const jobs = useVmJobs(api, { enabled, refetchInterval: 5000 });

  if (!enabled) {
    return (
      <div data-testid="settings-vms-root" className="h-full overflow-y-auto">
        <SettingsSectionHeader
          icon={<TitleChip icon={ServerCog} accent="var(--accent-sky-400)" />}
          title="VMs"
        />
        <div className="mx-auto w-full max-w-content px-4 pb-6">
          <p
            className="py-6 text-sm text-[var(--app-hint)]"
            data-testid="vms-disabled"
          >
            VM provisioning is not available on this instance.
          </p>
        </div>
      </div>
    );
  }

  const jobList: JobStatusResponse[] = [...(jobs.data ?? [])].sort(
    (a, b) => b.createdAt - a.createdAt
  );

  // #2552: the inventory endpoint returns EITHER the fleet array OR a loud
  // divergence verdict object. Discriminate so a verdict never lands in
  // `entries` (which would make both `entries.length` guards false → a blank
  // panel, worse than the old silent-empty), and thread the verdict down for its
  // own rendered state.
  const inventoryData = inventory.data;
  const inventoryVerdict: VmInventoryVerdict | null =
    inventoryData !== undefined && isVmInventoryVerdict(inventoryData)
      ? inventoryData
      : null;
  const inventoryEntries: VmInventoryEntry[] =
    inventoryData !== undefined && !isVmInventoryVerdict(inventoryData)
      ? inventoryData
      : [];

  return (
    <div data-testid="settings-vms-root" className="h-full overflow-y-auto">
      <SettingsSectionHeader
        icon={<TitleChip icon={ServerCog} accent="var(--accent-sky-400)" />}
        title="VMs"
      />
      <div className="mx-auto flex w-full max-w-content flex-col gap-4 px-4 pb-6">
        <NewVmForm api={api} onJobCreated={setActiveJobId} />

        {activeJobId && (
          <section className="flex flex-col gap-1">
            <h2 className="text-[length:var(--text-caption)] font-medium uppercase tracking-wide text-[var(--app-hint)]">
              Job log
            </h2>
            <JobLogViewer api={api} token={token} jobId={activeJobId} />
          </section>
        )}

        {jobList.length > 0 && (
          <section className="flex flex-col gap-1">
            <h2 className="text-[length:var(--text-caption)] font-medium uppercase tracking-wide text-[var(--app-hint)]">
              Recent jobs
            </h2>
            <ul
              className="flex flex-col"
              role="list"
              data-testid="vm-jobs-list"
            >
              {jobList.slice(0, 10).map(job => (
                <li key={job.id}>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setActiveJobId(job.id)}
                    data-testid={`vm-job-${job.id}`}
                    className={`flex h-auto w-full items-center justify-start gap-2 rounded px-2 py-1.5 text-left text-xs font-normal hover:bg-[var(--app-secondary-bg)] ${
                      activeJobId === job.id
                        ? "bg-[var(--app-secondary-bg)]"
                        : ""
                    }`}
                  >
                    <span className="font-mono text-[var(--app-hint)]">
                      {job.id.slice(0, 8)}
                    </span>
                    <span className="font-medium text-[var(--app-fg)]">
                      {job.kind}
                    </span>
                    <span className="ml-auto text-[var(--app-hint)]">
                      {job.state}
                    </span>
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <ParityHubTable
          hub={parityHub.data}
          isLoading={parityHub.isLoading}
          isError={parityHub.isError}
        />

        <InventoryTable
          api={api}
          entries={inventoryEntries}
          verdict={inventoryVerdict}
          isLoading={inventory.isLoading}
          isError={inventory.isError}
          onDeprovisionApplied={setActiveJobId}
          renderRowExtra={entry => (
            <div className="flex flex-col gap-2 py-1">
              <HealthCard api={api} vmName={entry.name} jobs={jobList} />
              <ReconcilePanel api={api} vmName={entry.name} />
            </div>
          )}
        />
      </div>
    </div>
  );
}
