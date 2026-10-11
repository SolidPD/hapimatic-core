// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ApiClient, ScheduleChildDisposition } from "@/api/client";
import type {
  CreateScheduledTaskRequest,
  UpdateScheduledTaskRequest,
} from "@/types/api";
import { queryKeys } from "@/lib/query-keys";

export function useScheduleMutations(
  api: ApiClient | null,
  scheduleId?: string | null
): {
  createSchedule: (input: CreateScheduledTaskRequest) => Promise<void>;
  updateSchedule: (input: UpdateScheduledTaskRequest) => Promise<void>;
  /** #3172: `children` = what happens to the schedule's spawned sessions. */
  deleteSchedule: (children?: ScheduleChildDisposition) => Promise<void>;
  toggleSchedule: () => Promise<void>;
  runNow: () => Promise<void>;
  isPending: boolean;
} {
  const queryClient = useQueryClient();

  const invalidateAll = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.schedules });
    if (scheduleId) {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.schedule(scheduleId),
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.scheduleHistory(scheduleId),
      });
    }
  };

  const createMutation = useMutation({
    mutationFn: async (input: CreateScheduledTaskRequest) => {
      if (!api) throw new Error("API unavailable");
      await api.createSchedule(input);
    },
    onSuccess: () => void invalidateAll(),
  });

  const updateMutation = useMutation({
    mutationFn: async (input: UpdateScheduledTaskRequest) => {
      if (!api || !scheduleId) throw new Error("Schedule unavailable");
      await api.updateSchedule(scheduleId, input);
    },
    onSuccess: () => void invalidateAll(),
  });

  const deleteMutation = useMutation({
    mutationFn: async (children?: ScheduleChildDisposition) => {
      if (!api || !scheduleId) throw new Error("Schedule unavailable");
      await api.deleteSchedule(scheduleId, children);
    },
    onSuccess: async () => {
      if (scheduleId) {
        queryClient.removeQueries({
          queryKey: queryKeys.schedule(scheduleId),
        });
        queryClient.removeQueries({
          queryKey: queryKeys.scheduleHistory(scheduleId),
        });
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.schedules });
      // #3172: the delete also cascaded or dissolved the spawned sessions.
      await queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: async () => {
      if (!api || !scheduleId) throw new Error("Schedule unavailable");
      await api.toggleSchedule(scheduleId);
    },
    onSuccess: () => void invalidateAll(),
  });

  const runNowMutation = useMutation({
    mutationFn: async () => {
      if (!api || !scheduleId) throw new Error("Schedule unavailable");
      await api.runScheduleNow(scheduleId);
    },
    onSuccess: () => void invalidateAll(),
  });

  return {
    createSchedule: createMutation.mutateAsync,
    updateSchedule: updateMutation.mutateAsync,
    deleteSchedule: deleteMutation.mutateAsync,
    toggleSchedule: toggleMutation.mutateAsync,
    runNow: runNowMutation.mutateAsync,
    isPending:
      createMutation.isPending ||
      updateMutation.isPending ||
      deleteMutation.isPending ||
      toggleMutation.isPending ||
      runNowMutation.isPending,
  };
}
