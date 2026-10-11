// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  CreateJobRequest,
  CreateJobResponse,
  DeprovisionApplyRequest,
  DeprovisionDryRunRequest,
  DeprovisionDryRunResponse,
  ReconcileSurfaceName,
} from "@hapi/protocol/adminVms";
import { type ApiClient } from "@/api/client";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import { queryKeys } from "@/lib/query-keys";

/**
 * Mutation hooks for the Admin → VMs page (issue #2470, epic #2467 Sub C):
 *
 * - `createJob` — `POST /api/admin-vms/jobs`. Backs the New VM form (kind
 *   `provision`). The server's `buildJob` allowlist is the security seam; an
 *   out-of-allowlist flag / bad value returns a 400 with a `{ error }` body
 *   surfaced here.
 * - `deprovisionDryRun` — `POST /api/admin-vms/deprovision/dry-run`. Returns the
 *   read-only transcript + a single-use `confirmationToken` bound to the exact
 *   previewed argv.
 * - `deprovisionApply` — `POST /api/admin-vms/deprovision/apply`. Requires that
 *   token AND a `typedSubdomain` matching exactly (the two-step gate).
 *
 * All route through `api.extensionRequest` (Bearer + 401 auto-refresh). On
 * success the relevant queries are invalidated so the job list / inventory
 * reflect the change.
 */
export function useVmJobActions(api: ApiClient | null) {
  const queryClient = useQueryClient();

  const createJob = useMutation({
    mutationFn: async (input: CreateJobRequest): Promise<CreateJobResponse> => {
      if (!api) throw new Error("API unavailable");
      try {
        return await api.extensionRequest<CreateJobResponse>(
          "/api/admin-vms/jobs",
          { method: "POST", body: JSON.stringify(input) }
        );
      } catch (err) {
        throw new Error(apiErrorMessage(err));
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.vmJobs });
    },
  });

  const deprovisionDryRun = useMutation({
    mutationFn: async (
      input: DeprovisionDryRunRequest
    ): Promise<DeprovisionDryRunResponse> => {
      if (!api) throw new Error("API unavailable");
      try {
        return await api.extensionRequest<DeprovisionDryRunResponse>(
          "/api/admin-vms/deprovision/dry-run",
          { method: "POST", body: JSON.stringify(input) }
        );
      } catch (err) {
        throw new Error(apiErrorMessage(err));
      }
    },
  });

  const deprovisionApply = useMutation({
    mutationFn: async (
      input: DeprovisionApplyRequest
    ): Promise<CreateJobResponse> => {
      if (!api) throw new Error("API unavailable");
      try {
        return await api.extensionRequest<CreateJobResponse>(
          "/api/admin-vms/deprovision/apply",
          { method: "POST", body: JSON.stringify(input) }
        );
      } catch (err) {
        throw new Error(apiErrorMessage(err));
      }
    },
    onSuccess: () => {
      // The apply spawns a mutating teardown — refresh both the job list and the
      // inventory (the VM will disappear from the fleet once it completes).
      queryClient.invalidateQueries({ queryKey: queryKeys.vmJobs });
      queryClient.invalidateQueries({ queryKey: queryKeys.vmInventory });
    },
  });

  // ── #2472 (Sub E): health + reconcile job-creating mutations ────────────────
  // Each hits a dedicated Sub-E endpoint (all reuse the server's shared job-rate
  // cap + audit hook) and returns the same CreateJobResponse shape as createJob.
  // The caller polls the returned job via useVmJob until terminal, then reads its
  // parsed `result`. On success we invalidate the job list so the new job (and,
  // for health, the fleet-wide result every HealthCard reads) surfaces.

  /** Fleet-scoped read-only health sweep. One job covers every instance (R30). */
  const runHealthCheck = useMutation({
    mutationFn: async (): Promise<CreateJobResponse> => {
      if (!api) throw new Error("API unavailable");
      try {
        return await api.extensionRequest<CreateJobResponse>(
          "/api/admin-vms/health",
          { method: "POST", body: "{}" }
        );
      } catch (err) {
        throw new Error(apiErrorMessage(err));
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.vmJobs });
    },
  });

  /** Read-only per-VM drift detection (all six surfaces). */
  const reconcileDetect = useMutation({
    mutationFn: async (name: string): Promise<CreateJobResponse> => {
      if (!api) throw new Error("API unavailable");
      try {
        return await api.extensionRequest<CreateJobResponse>(
          `/api/admin-vms/reconcile/${encodeURIComponent(name)}/detect`,
          { method: "POST", body: "{}" }
        );
      } catch (err) {
        throw new Error(apiErrorMessage(err));
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.vmJobs });
    },
  });

  /**
   * Per-surface mutating repair. The server rejects a blanket repair and
   * `handoff-secret` (detection-only, #2316); the UI never offers those. `surface`
   * is a `ReconcileSurfaceName`, so a typo is a compile error, not a 400.
   */
  const reconcileRepair = useMutation({
    mutationFn: async (input: {
      name: string;
      surface: ReconcileSurfaceName;
    }): Promise<CreateJobResponse> => {
      if (!api) throw new Error("API unavailable");
      try {
        return await api.extensionRequest<CreateJobResponse>(
          `/api/admin-vms/reconcile/${encodeURIComponent(input.name)}/repair`,
          { method: "POST", body: JSON.stringify({ surface: input.surface }) }
        );
      } catch (err) {
        throw new Error(apiErrorMessage(err));
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.vmJobs });
    },
  });

  return {
    createJob,
    deprovisionDryRun,
    deprovisionApply,
    runHealthCheck,
    reconcileDetect,
    reconcileRepair,
  };
}
