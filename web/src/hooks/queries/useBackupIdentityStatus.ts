// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import type { BackupIdentityStatus } from "@/types/backupIdentity";
import { queryKeys } from "@/lib/query-keys";

/**
 * Fetch the non-secret status of the per-VM backup age identity
 * (`GET /api/backup/identity/status`, issue #2507) — backs the Admin → Backup Key
 * page. Carries `{ present, revealed, recipient }` only; the secret identity is
 * NEVER in this response (it is served once by {@link useRevealBackupIdentity}).
 *
 * Not cached long — the status transitions (present → revealed) when the user
 * acknowledges, so we refetch on mount rather than pinning `staleTime`.
 */
export function useBackupIdentityStatus(
  api: ApiClient | null,
  options?: { enabled?: boolean }
) {
  return useQuery<BackupIdentityStatus>({
    queryKey: queryKeys.backupIdentityStatus,
    queryFn: () => {
      if (!api) throw new Error("No API client");
      return api.getBackupIdentityStatus();
    },
    enabled: (options?.enabled ?? true) && Boolean(api),
    retry: false,
  });
}

/**
 * #3059 rounds 3-4: backup-key custody exists only on gateway-provisioned
 * cloud VMs. A node with NO pending identity, NO revealed marker, and NO
 * recipient has never been backup-provisioned (every physical node's state);
 * any artifact present marks a cloud VM. No hostname guessing — provisioning
 * artifacts ARE the signal. Fail-closed: an unloaded or errored status hides
 * the surface. Shared by the keys page (section visibility) and the settings
 * sidebar (sub-row visibility) so the two can never disagree — a divergence
 * would deep-link the sidebar to a section the page doesn't render.
 */
export function isBackupProvisioned(
  status: BackupIdentityStatus | undefined
): boolean {
  return (
    !!status && (status.present || status.revealed || status.recipient !== null)
  );
}
