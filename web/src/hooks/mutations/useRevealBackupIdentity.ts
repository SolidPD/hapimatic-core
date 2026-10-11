// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import type { BackupIdentityRevealResponse } from "@/types/backupIdentity";
import { queryKeys } from "@/lib/query-keys";

/**
 * The per-VM backup age identity reveal + acknowledge flow (issue #2507),
 * modelled as two explicit mutations mirroring #2343's porter import shape:
 *
 *   1. `reveal`      — `POST /api/backup/identity/reveal` → `{ identity }`, ONCE
 *      while pending. 404 (none) / 410 (gone, already acknowledged) throw an
 *      `ApiError` with `.status` the page branches on.
 *   2. `acknowledge` — `POST /api/backup/identity/acknowledge` → the VM shreds the
 *      identity and records the reveal marker. On success the status query is
 *      invalidated so the page re-renders in the "saved / no longer retrievable"
 *      state.
 *
 * 🔴 The revealed identity is returned to the caller but is DELIBERATELY NOT
 * written into the query cache — it is fire-once render-only data. Persisting it
 * in TanStack Query would leave the secret sitting in client memory after the
 * page unmounts and defeat the reveal-once/delete contract.
 */
export function useRevealBackupIdentity(api: ApiClient | null) {
  const queryClient = useQueryClient();

  const reveal = useMutation<BackupIdentityRevealResponse, Error, void>({
    mutationFn: async () => {
      if (!api) throw new Error("No API client");
      return await api.revealBackupIdentity();
    },
  });

  const acknowledge = useMutation<{ ok: boolean }, Error, void>({
    mutationFn: async () => {
      if (!api) throw new Error("No API client");
      return await api.acknowledgeBackupIdentity();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.backupIdentityStatus,
      });
    },
  });

  return { reveal, acknowledge };
}
