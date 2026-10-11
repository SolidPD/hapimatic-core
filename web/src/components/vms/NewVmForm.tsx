// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo, useState } from "react";
import type { CreateJobRequest } from "@hapi/protocol/adminVms";
import type { ApiClient } from "@/api/client";
import { useVmJobActions } from "@/hooks/mutations/useVmJobActions";
import {
  checkBudget,
  DEFAULT_TIER_ID,
  getTier,
  VM_TIERS,
  type VmShape,
  type VmTierId,
} from "@/lib/vmTiers";
import { Button } from "@/components/ui/button";
import { SegmentedToggle } from "@/components/ui/SegmentedToggle";

/**
 * NewVmForm — the operator's provision request surface (issue #2470 R3).
 *
 * Submits a `provision` job (`scripts/provision.sh`) with `[subdomain, email]`
 * positionals and a flag set drawn EXACTLY from the server's `buildJob`
 * allowlist (jobModel.ts). Two shape modes:
 *   - Tier — pick Ultra/Pro/Standard/Lite; submits `--tier <id>` and shows the
 *     tier's `est_monthly_usd` (from `scripts/lib/vm-tiers.json`).
 *   - Custom — explicit `--ocpus` / `--memory-gb` / `--boot-volume-gb`.
 *
 * `--create-vm` is always injected UNLESS `--from-image` is chosen. An explicit
 * dry-run toggle adds `--dry-run` (AC-3 needs the dry-run path drivable through
 * the UI). The budget guard (v1, absolute-caps-only) blocks submit when the
 * REQUESTED shape exceeds the OCI free-tier caps.
 */

/** One flag value the server accepts (bool | string | number | array) — derived
 * from the inferred request type so web never depends on zod directly. */
type FlagValue = NonNullable<CreateJobRequest["flags"]>[string];

export function NewVmForm(props: {
  api: ApiClient | null;
  onJobCreated: (jobId: string) => void;
}) {
  const { api, onJobCreated } = props;
  const { createJob } = useVmJobActions(api);

  const [subdomain, setSubdomain] = useState("");
  const [email, setEmail] = useState("");
  const [vmName, setVmName] = useState("");
  const [mode, setMode] = useState<"tier" | "custom">("tier");
  const [tierId, setTierId] = useState<VmTierId>(DEFAULT_TIER_ID);
  const defaultTier = getTier(DEFAULT_TIER_ID);
  const [ocpus, setOcpus] = useState<number>(defaultTier.ocpus);
  const [memoryGb, setMemoryGb] = useState<number>(defaultTier.memoryGb);
  const [bootVolumeGb, setBootVolumeGb] = useState<number>(
    defaultTier.bootVolumeGb
  );
  const [noTailscale, setNoTailscale] = useState(false);
  const [dryRun, setDryRun] = useState(false);
  const [fromImage, setFromImage] = useState("");

  // The requested compute shape drives the budget guard.
  const shape: VmShape = useMemo(
    () =>
      mode === "tier"
        ? {
            ocpus: getTier(tierId).ocpus,
            memoryGb: getTier(tierId).memoryGb,
            bootVolumeGb: getTier(tierId).bootVolumeGb,
          }
        : { ocpus, memoryGb, bootVolumeGb },
    [mode, tierId, ocpus, memoryGb, bootVolumeGb]
  );
  const budget = useMemo(() => checkBudget(shape), [shape]);

  const subdomainValid = /^[a-z0-9][a-z0-9-]*$/.test(subdomain);
  const emailValid = email.includes("@") && !email.startsWith("-");
  const canSubmit =
    budget.ok &&
    subdomainValid &&
    emailValid &&
    !createJob.isPending &&
    Boolean(api);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;

    const flags: Record<string, FlagValue> = {};
    // `--create-vm` unless `--from-image` selects an existing image.
    if (fromImage.trim()) flags["--from-image"] = fromImage.trim();
    else flags["--create-vm"] = true;

    if (mode === "tier") {
      flags["--tier"] = tierId;
    } else {
      flags["--ocpus"] = ocpus;
      flags["--memory-gb"] = memoryGb;
      flags["--boot-volume-gb"] = bootVolumeGb;
    }
    if (vmName.trim()) flags["--vm-name"] = vmName.trim();
    if (noTailscale) flags["--no-tailscale"] = true;
    if (dryRun) flags["--dry-run"] = true;

    const request: CreateJobRequest = {
      kind: "provision",
      positionals: [subdomain.trim(), email.trim()],
      flags,
    };

    createJob.mutate(request, {
      onSuccess: res => onJobCreated(res.job.id),
    });
  };

  const inputClass =
    "w-full rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-sm text-[var(--app-fg)] focus:border-[var(--app-link)] focus:outline-none";
  const labelClass = "text-xs font-medium text-[var(--app-hint)]";

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-3 rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-3"
      data-testid="new-vm-form"
    >
      <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--app-fg)]">
        New VM
      </h2>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Subdomain</span>
          <input
            autoCapitalize="none"
            className={inputClass}
            value={subdomain}
            onChange={e => setSubdomain(e.target.value)}
            placeholder="alpha"
            data-testid="vm-subdomain"
            autoComplete="off"
          />
          {subdomain && !subdomainValid && (
            <span className="text-[length:var(--text-caption)] text-red-400">
              Lowercase letters, digits, and hyphens only.
            </span>
          )}
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>User email</span>
          <input
            autoCapitalize="none"
            className={inputClass}
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="user@example.com"
            data-testid="vm-email"
            autoComplete="off"
          />
        </label>
      </div>

      {/* Shape mode toggle (#3510: SegmentedToggle outline variant, formerly two raw pills) */}
      <SegmentedToggle
        variant="outline"
        fullWidth
        options={[
          { value: "tier", label: "Tier" },
          { value: "custom", label: "Custom" },
        ]}
        value={mode}
        onChange={setMode}
        ariaLabel="VM shape mode"
        testIdPrefix="vm-mode"
      />

      {mode === "tier" ? (
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Tier</span>
          <select
            className={inputClass}
            value={tierId}
            onChange={e => setTierId(e.target.value as VmTierId)}
            data-testid="vm-tier-select"
          >
            {VM_TIERS.map(t => (
              <option key={t.id} value={t.id}>
                {t.label} — {t.ocpus} OCPU / {t.memoryGb} GB / {t.bootVolumeGb}{" "}
                GB · ~${t.estMonthlyUsd}/mo
              </option>
            ))}
          </select>
        </label>
      ) : (
        <div className="grid grid-cols-3 gap-2">
          <label className="flex flex-col gap-1">
            <span className={labelClass}>OCPUs</span>
            <input
              type="number"
              min={1}
              max={64}
              className={inputClass}
              value={ocpus}
              onChange={e => setOcpus(Number(e.target.value))}
              data-testid="vm-ocpus"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className={labelClass}>Memory (GB)</span>
            <input
              type="number"
              min={1}
              max={1024}
              className={inputClass}
              value={memoryGb}
              onChange={e => setMemoryGb(Number(e.target.value))}
              data-testid="vm-memory"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className={labelClass}>Boot (GB)</span>
            <input
              type="number"
              min={50}
              max={2048}
              className={inputClass}
              value={bootVolumeGb}
              onChange={e => setBootVolumeGb(Number(e.target.value))}
              data-testid="vm-boot"
            />
          </label>
        </div>
      )}

      {/* Optional advanced fields */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className={labelClass}>VM name (optional)</span>
          <input
            autoCapitalize="none"
            className={inputClass}
            value={vmName}
            onChange={e => setVmName(e.target.value)}
            placeholder="auto"
            data-testid="vm-vm-name"
            autoComplete="off"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>From image OCID (optional)</span>
          <input
            autoCapitalize="none"
            className={inputClass}
            value={fromImage}
            onChange={e => setFromImage(e.target.value)}
            placeholder="ocid1.image…"
            data-testid="vm-from-image"
            autoComplete="off"
          />
        </label>
      </div>

      {/* --no-tailscale — prominent, security-explained (R3) */}
      <label
        className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5"
        data-testid="vm-no-tailscale-block"
      >
        <input
          type="checkbox"
          checked={noTailscale}
          onChange={e => setNoTailscale(e.target.checked)}
          data-testid="vm-no-tailscale"
          className="mt-0.5 h-4 w-4 accent-amber-500"
        />
        <span className="text-xs text-amber-100">
          <span className="font-semibold">
            No Tailscale (<code>--no-tailscale</code>)
          </span>{" "}
          — the VM joins NO tailnet. Required for non-operator users: it keeps
          an external user's VM off the operator tailnet. Leave unchecked for
          your own operator VMs.
        </span>
      </label>

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={dryRun}
          onChange={e => setDryRun(e.target.checked)}
          data-testid="vm-dry-run"
          className="h-4 w-4 accent-[var(--app-link)]"
        />
        <span className="text-xs text-[var(--app-hint)]">
          Dry run (<code>--dry-run</code>) — preview the phases without creating
          anything.
        </span>
      </label>

      {!budget.ok && (
        <div
          className="rounded-md border border-red-500/40 bg-red-500/10 p-2.5"
          data-testid="vm-budget-hint"
        >
          <p className="text-xs font-semibold text-red-300">
            Exceeds the OCI free-tier budget
          </p>
          <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-5 text-[length:var(--text-caption)] text-red-200">
            {budget.violations.map((v, i) => (
              <li key={i}>{v}</li>
            ))}
          </ul>
        </div>
      )}

      {createJob.isError && (
        <p className="text-xs text-red-400" data-testid="vm-form-error">
          {createJob.error instanceof Error
            ? createJob.error.message
            : "Failed to create the job."}
        </p>
      )}

      <Button
        type="submit"
        variant="accent"
        disabled={!canSubmit}
        data-testid="vm-submit"
        className="h-auto px-3 py-2 text-[var(--app-bg)] hover:opacity-100 disabled:opacity-40"
      >
        {createJob.isPending
          ? "Submitting…"
          : dryRun
            ? "Preview (dry run)"
            : "Provision VM"}
      </Button>
    </form>
  );
}
