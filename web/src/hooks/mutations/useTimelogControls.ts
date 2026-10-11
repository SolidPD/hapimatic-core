// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import type {
  TimelogAdjustmentRequest,
  TimelogAdjustmentRow,
} from "@/types/api";

/**
 * Issue #1670 (Sub H1, PR-2): the six clock controls as ledger-write mutations.
 *
 * Each control (Adjust / Set / Reset / Undo / Disable / Enable) appends a
 * `timelog_adjustments` row via `POST /api/timelogs/adjustments`. On success it
 * invalidates every query whose key starts with `"time-log"` — that covers the
 * legacy summaries, the derived read, and the adjustments ledger, so the modal
 * + clock display refresh once the cutover gate is green.
 *
 * DORMANT until the gate opens: the `SessionTimer` clock menu only renders these
 * controls when `useTimelogCutoverStatus().ready` is true, so this hook has no
 * user-visible effect on the legacy path.
 */
export function useTimelogControls(api: ApiClient | null): {
  submit: (req: TimelogAdjustmentRequest) => Promise<TimelogAdjustmentRow>;
  isPending: boolean;
} {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async (
      req: TimelogAdjustmentRequest
    ): Promise<TimelogAdjustmentRow> => {
      if (!api) throw new Error("API unavailable");
      const res = await api.postTimelogAdjustment(req);
      return res.adjustment;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        predicate: query => {
          const key = query.queryKey;
          return (
            Array.isArray(key) &&
            typeof key[0] === "string" &&
            key[0].startsWith("time-log")
          );
        },
      });
    },
  });

  return { submit: mutation.mutateAsync, isPending: mutation.isPending };
}
