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
 * 🔴 The revealed identity is never written into the QUERY cache, but like every
 * mutation result it IS held in TanStack's MutationCache (`mutation.state.data`)
 * while the mutation's observer is attached — clearing component state does not
 * remove it. `gcTime: 0` evicts the entry on the next macrotask once the observer
 * detaches, so every caller MUST detach on close: call `reveal.reset()` after
 * acknowledge, skip or dismissal (unmounting also detaches). Without `gcTime: 0`
 * the secret would stay in client memory for the default 5 minutes after close
 * (#4791 R9, expert-review finding 4791-2).
 */
export function useRevealBackupIdentity(api: ApiClient | null) {
  const queryClient = useQueryClient();

  const reveal = useMutation<BackupIdentityRevealResponse, Error, void>({
    mutationFn: async () => {
      if (!api) throw new Error("No API client");
      return await api.revealBackupIdentity();
    },
    gcTime: 0,
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
