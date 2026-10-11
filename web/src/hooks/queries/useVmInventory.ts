// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery, type UseQueryOptions } from "@tanstack/react-query";
import {
  VmInventoryResponseSchema,
  type JobStatusResponse,
  type PreflightResponse,
  type VmInventoryResponse,
} from "@hapi/protocol/adminVms";

/** TanStack's own `refetchInterval` shape (number | false | (query) => …). */
type JobsRefetchInterval = UseQueryOptions<
  JobStatusResponse[]
>["refetchInterval"];
type JobRefetchInterval = UseQueryOptions<JobStatusResponse>["refetchInterval"];
import type { ApiClient } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";

/**
 * Query hooks for the Admin → VMs page (issue #2470, epic #2467 Sub C). All read
 * Sub B's operator-only `/api/admin-vms/*` routes through `api.extensionRequest`
 * (the authenticated passthrough that inherits Bearer auth + 401 auto-refresh),
 * and every one uses `retry: false` so a transient failure — or a capability-
 * closed 404 — resolves immediately to a safe empty/disabled state rather than
 * retrying. Response shapes come from `@hapi/protocol/adminVms`; never re-declare
 * them here.
 */

/**
 * The LIVE capability verdict + fleet-lock status. FAIL-CLOSED: on a
 * capability-closed instance the `/api/admin-vms/preflight` route itself 404s
 * (the capability guard), so the query errors and `data` stays undefined — the
 * caller gates on `data?.enabled === true`, which treats loading, error, AND
 * 404 as "gate closed". `retry: false` is load-bearing: a retry storm on the
 * 404 would delay that closed verdict. Note the TanStack result object has no
 * `.enabled` field of its own — always read `data?.enabled`.
 */
export function useVmPreflight(
  api: ApiClient | null,
  options?: { enabled?: boolean }
) {
  return useQuery({
    queryKey: queryKeys.vmPreflight,
    queryFn: async (): Promise<PreflightResponse> => {
      if (!api) throw new Error("API unavailable");
      return await api.extensionRequest<PreflightResponse>(
        "/api/admin-vms/preflight"
      );
    },
    enabled: (options?.enabled ?? true) && Boolean(api),
    retry: false,
  });
}

/** The sanitized fleet inventory (no token ever reaches the client — server allowlist). */
export function useVmInventory(
  api: ApiClient | null,
  options?: { enabled?: boolean }
) {
  return useQuery({
    queryKey: queryKeys.vmInventory,
    queryFn: async (): Promise<VmInventoryResponse> => {
      if (!api) return [];
      // #2552: runtime-parse the union — the endpoint can now return a loud
      // verdict OBJECT (missing/stale/schema-drift), not only a fleet array, so
      // the shape must be VALIDATED, not asserted. A malformed payload throws
      // here → the query `isError`s → the panel's error branch (fail-loud).
      return VmInventoryResponseSchema.parse(
        await api.extensionRequest<unknown>("/api/admin-vms/inventory")
      );
    },
    enabled: (options?.enabled ?? true) && Boolean(api),
    retry: false,
  });
}

/** The provisioning job list (create/dry-run/apply records), newest-first at the UI. */
export function useVmJobs(
  api: ApiClient | null,
  options?: { enabled?: boolean; refetchInterval?: JobsRefetchInterval }
) {
  return useQuery({
    queryKey: queryKeys.vmJobs,
    queryFn: async (): Promise<JobStatusResponse[]> => {
      if (!api) return [];
      return await api.extensionRequest<JobStatusResponse[]>(
        "/api/admin-vms/jobs"
      );
    },
    enabled: (options?.enabled ?? true) && Boolean(api),
    retry: false,
    refetchInterval: options?.refetchInterval,
  });
}

/**
 * One job's authoritative status. This is BOTH the detail source and the SSE
 * poll-fallback for `JobLogViewer` (Fallback-Preservation): pass a
 * `refetchInterval` while the job is non-terminal so the terminal state,
 * `actionItems`, and `result` resolve even if the log SSE drops.
 */
export function useVmJob(
  api: ApiClient | null,
  jobId: string | null,
  options?: { enabled?: boolean; refetchInterval?: JobRefetchInterval }
) {
  return useQuery({
    queryKey: queryKeys.vmJob(jobId ?? ""),
    queryFn: async (): Promise<JobStatusResponse> => {
      if (!api || !jobId) throw new Error("no job id");
      return await api.extensionRequest<JobStatusResponse>(
        `/api/admin-vms/jobs/${encodeURIComponent(jobId)}`
      );
    },
    enabled: (options?.enabled ?? true) && Boolean(api) && Boolean(jobId),
    retry: false,
    refetchInterval: options?.refetchInterval,
  });
}
