// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";

/**
 * System Jobs per-job mutation hook (epic #1534 Sub-Issue D, issue #1538).
 *
 * One `useMutation` per verb mapping to the #1537 node-scoped routes
 * (`POST/DELETE /api/nodes/:nodeId/system-jobs/:name/...`). Unlike
 * `useScheduleMutations` (whose target id is fixed at hook construction), one
 * instance of this hook services EVERY card — so each action takes `nodeId` +
 * `name` per call. Every success invalidates the `systemJobs` query so the
 * affected card re-renders with fresh live state.
 */
export function useSystemJobActions(api: ApiClient | null): {
  enableJob: (nodeId: string, name: string) => Promise<void>;
  disableJob: (nodeId: string, name: string) => Promise<void>;
  deleteJob: (nodeId: string, name: string) => Promise<void>;
  rescheduleJob: (
    nodeId: string,
    name: string,
    schedule: string
  ) => Promise<void>;
  renameJob: (nodeId: string, name: string, newName: string) => Promise<void>;
  editDescription: (
    nodeId: string,
    name: string,
    description: string
  ) => Promise<void>;
  isPending: boolean;
} {
  const queryClient = useQueryClient();

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.systemJobs });

  const enableMutation = useMutation({
    mutationFn: async (v: { nodeId: string; name: string }) => {
      if (!api) throw new Error("API unavailable");
      await api.enableSystemJob(v.nodeId, v.name);
    },
    onSuccess: () => void invalidate(),
  });

  const disableMutation = useMutation({
    mutationFn: async (v: { nodeId: string; name: string }) => {
      if (!api) throw new Error("API unavailable");
      await api.disableSystemJob(v.nodeId, v.name);
    },
    onSuccess: () => void invalidate(),
  });

  const deleteMutation = useMutation({
    mutationFn: async (v: { nodeId: string; name: string }) => {
      if (!api) throw new Error("API unavailable");
      await api.deleteSystemJob(v.nodeId, v.name);
    },
    onSuccess: () => void invalidate(),
  });

  const rescheduleMutation = useMutation({
    mutationFn: async (v: {
      nodeId: string;
      name: string;
      schedule: string;
    }) => {
      if (!api) throw new Error("API unavailable");
      await api.rescheduleSystemJob(v.nodeId, v.name, v.schedule);
    },
    onSuccess: () => void invalidate(),
  });

  const renameMutation = useMutation({
    mutationFn: async (v: {
      nodeId: string;
      name: string;
      newName: string;
    }) => {
      if (!api) throw new Error("API unavailable");
      await api.renameSystemJob(v.nodeId, v.name, v.newName);
    },
    onSuccess: () => void invalidate(),
  });

  const descriptionMutation = useMutation({
    mutationFn: async (v: {
      nodeId: string;
      name: string;
      description: string;
    }) => {
      if (!api) throw new Error("API unavailable");
      await api.editSystemJobDescription(v.nodeId, v.name, v.description);
    },
    onSuccess: () => void invalidate(),
  });

  return {
    enableJob: (nodeId, name) => enableMutation.mutateAsync({ nodeId, name }),
    disableJob: (nodeId, name) => disableMutation.mutateAsync({ nodeId, name }),
    deleteJob: (nodeId, name) => deleteMutation.mutateAsync({ nodeId, name }),
    rescheduleJob: (nodeId, name, schedule) =>
      rescheduleMutation.mutateAsync({ nodeId, name, schedule }),
    renameJob: (nodeId, name, newName) =>
      renameMutation.mutateAsync({ nodeId, name, newName }),
    editDescription: (nodeId, name, description) =>
      descriptionMutation.mutateAsync({ nodeId, name, description }),
    isPending:
      enableMutation.isPending ||
      disableMutation.isPending ||
      deleteMutation.isPending ||
      rescheduleMutation.isPending ||
      renameMutation.isPending ||
      descriptionMutation.isPending,
  };
}
