// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import type {
  ImportPlanSummary,
  ImportResult,
  SecretOverlay,
} from "@/types/porter";
import { queryKeys } from "@/lib/query-keys";

/**
 * The two-phase Configuration Porter import (issue #2344 R4), mirroring #2343's
 * server model as two explicit mutations:
 *
 *   1. `plan`   — upload the archive → `POST /api/porter/import/plan` → a
 *      reviewable {@link ImportPlanSummary}. Writes NOTHING to `~/.claude`.
 *   2. `commit` — `POST /api/porter/import/commit` with the staging handle and
 *      the user's per-conflict overwrite opt-ins → the {@link ImportResult}.
 *
 * The panel gates the commit button on the plan summary having rendered (R4 is
 * a UI obligation, not only the server's), so this hook deliberately does NOT
 * auto-commit after a successful plan. A committed import mutates `~/.claude`,
 * so the installed-config read surface is invalidated on success.
 */
export function usePorterImport(api: ApiClient | null) {
  const queryClient = useQueryClient();

  const plan = useMutation<
    ImportPlanSummary,
    Error,
    { file: File; isolatedDest?: string }
  >({
    // #3299: the plan can carry a per-request isolated destination.
    mutationFn: async ({ file, isolatedDest }) => {
      if (!api) throw new Error("No API client");
      return await api.planPorterImport(file, { isolatedDest });
    },
  });

  const commit = useMutation<
    ImportResult,
    Error,
    {
      stagingHandle: string;
      overwrite: string[];
      excluded?: string[];
      secretOverlay?: SecretOverlay;
      acknowledgeMissingHooks?: string[];
      keepModes?: string[];
      acknowledgeSymlinkedSettings?: string;
    }
  >({
    mutationFn: async ({
      stagingHandle,
      overwrite,
      excluded,
      secretOverlay,
      acknowledgeMissingHooks,
      keepModes,
      acknowledgeSymlinkedSettings,
    }) => {
      if (!api) throw new Error("No API client");
      // #3247: thread the operator's pre-import deselection to the commit;
      // #3546: the recipient-side re-auth secret overlay (ADR-0006 Fork A);
      // #3590: the registry-missing-hooks acknowledgement (K4/D9);
      // #4129: the File-modes rows whose current mode the operator keeps;
      // #4277: the symlinked settings.json target a 409 echoed, acknowledged.
      return await api.commitPorterImport(
        stagingHandle,
        overwrite,
        excluded,
        secretOverlay,
        acknowledgeMissingHooks,
        keepModes,
        acknowledgeSymlinkedSettings
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.porterInstalled,
      });
    },
  });

  return { plan, commit };
}
