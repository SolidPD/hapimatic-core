// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, type ApiClient } from "@/api/client";
import type { SessionSummary } from "@/types/api";
import type {
  BulkSessionResult,
  BulkSessionResultItem,
} from "@hapi/protocol/bulkSessionResult";
import { queryKeys } from "@/lib/query-keys";

/**
 * Send ONE prompt to every selected session (#3818 Slice 1, epic #4406).
 *
 * A client-side fan-out over the per-session routes (ruling D-4406-1): there
 * is no server bulk route, so each request keeps its own per-request origin.
 * Each target is routed by its state (ruling D4 = A):
 *
 *   connected, idle      → `POST /sessions/:id/messages` (sent now)
 *   connected, mid-turn  → `POST /sessions/:id/queue/enqueue` ("queued"),
 *                          the composer's split, so the user's queue order holds
 *   disconnected         → no request, skipped (`session_inactive`) — nothing
 *                          is left to fire on a later reconnect
 *
 * A stale `thinking` flag is safe either way: the direct route injects at the
 * next turn boundary, and an enqueue to an idle session drains at once.
 */
export type SendTarget = Pick<SessionSummary, "id" | "active" | "thinking">;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function sendOne(
  api: ApiClient,
  target: SendTarget,
  text: string
): Promise<BulkSessionResultItem> {
  const { id } = target;
  if (!target.active) {
    return { id, ok: false, skipped: true, code: "session_inactive" };
  }
  try {
    if (target.thinking) {
      // A queued prompt carries no denial back to the caller — report it as
      // queued, never as sent.
      await api.enqueueQueuedMessage(id, text);
      return { id, ok: true, code: "queued" };
    }
    // `sendMessage` RESOLVES `{ ok: false, denied }` when a gate-class hook
    // refuses the prompt — "fulfilled" is not success. For a session on
    // another node this result is the only sign of the denial.
    const result = await api.sendMessage(id, text);
    if (result.ok) return { id, ok: true };
    return {
      id,
      ok: false,
      code: "denied",
      error: result.denied?.reason ?? "Refused by a message hook",
    };
  } catch (err) {
    // 409: the session went inactive between the list read and the send.
    if (err instanceof ApiError && err.status === 409) {
      return { id, ok: false, skipped: true, code: "session_inactive" };
    }
    return { id, ok: false, error: errorMessage(err) };
  }
}

/**
 * Deliver `text` to exactly `targets`, in parallel, and answer one result per
 * target in the order given. Never throws: a request that fails becomes that
 * target's `{ id, ok: false, error }`.
 */
export async function executeSendToSelected(
  api: ApiClient,
  targets: readonly SendTarget[],
  text: string
): Promise<BulkSessionResult> {
  const settled = await Promise.allSettled(
    targets.map(t => sendOne(api, t, text))
  );
  return settled.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : { id: targets[i]?.id ?? "", ok: false, error: errorMessage(r.reason) }
  );
}

export function useSendToSelected(api: ApiClient | null): {
  sendToSelected: (
    targets: readonly SendTarget[],
    text: string
  ) => Promise<BulkSessionResult>;
  isPending: boolean;
} {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: async (input: {
      targets: readonly SendTarget[];
      text: string;
    }): Promise<BulkSessionResult> => {
      if (!api) {
        throw new Error("API unavailable");
      }
      return executeSendToSelected(api, input.targets, input.text);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.federationAllSessions,
      });
    },
  });

  return {
    sendToSelected: (targets, text) => mutation.mutateAsync({ targets, text }),
    isPending: mutation.isPending,
  };
}
