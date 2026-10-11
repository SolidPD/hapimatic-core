// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Schedule create/edit form component.
 * Extracted from SchedulesPage.tsx for reuse in the unified list view's dialog.
 *
 * Uses ScheduleSection for schedule settings (collapsible layers, badges)
 * to match the Create New Session layout.
 */
import { useState } from "react";
import type { ApiClient } from "@/api/client";
import type {
  ScheduledTask,
  UpdateScheduledTaskRequest,
  ScheduleKind,
} from "@/types/api";
import type { SessionType } from "@/components/NewSession/types";
import { useScheduleMutations } from "../hooks/useScheduleMutations";
import {
  IPAD_WINDOW_CONTROLS_INSET_X,
  useIPadMultitasking,
} from "@/hooks/useIPadMultitasking";
import { useSwipeBack } from "@/hooks/useSwipeBack";
import { BackIcon } from "@/components/icons";
import { EmojiPickerPopover } from "@/components/EmojiPickerPopover";
import { FormField } from "@/components/NewSession/FormField";
import { SessionTypeSelector } from "@/components/NewSession/SessionTypeSelector";
import {
  ScheduleSection,
  defaultScheduleState,
  type ScheduleState,
} from "@/components/NewSession/ScheduleSection";
import {
  scheduledTaskToScheduleState,
  scheduleStateToUpdateRequest,
} from "@/lib/scheduleConverters";

// ── Schedule Form ────────────────────────────────────────

export type ScheduleFormProps = {
  api: ApiClient | null;
  existing?: ScheduledTask | null;
  onBack: () => void;
  onSaved: () => void;
};

export function ScheduleForm({
  api,
  existing,
  onBack,
  onSaved,
}: ScheduleFormProps) {
  const isIPadMultitasking = useIPadMultitasking();
  const { handlers: swipeBackHandlers } = useSwipeBack({
    onSwipeBack: onBack,
  });

  // Identity fields (outside ScheduleSection)
  const [name, setName] = useState(existing?.name ?? "");
  const [emoji, setEmoji] = useState<string | null>(existing?.emoji ?? null);
  const [projectDirectory, setProjectDirectory] = useState(
    existing?.projectDirectory ?? ""
  );

  // Session type (Simple / Worktree)
  const [sessionType, setSessionType] = useState<SessionType>(
    existing?.sessionType ?? "simple"
  );
  const [worktreeBranchName, setWorktreeBranchName] = useState(
    existing?.worktreeBranchName ?? ""
  );

  // Schedule type — preserved internally for backward compat with cron/at tasks
  const scheduleType: ScheduleKind = existing?.scheduleType ?? "every";
  const [cronExpression, setCronExpression] = useState(
    existing?.cronExpression ?? ""
  );
  const [scheduledAtStr, setScheduledAtStr] = useState(() => {
    if (!existing?.scheduledAt) return "";
    return new Date(existing.scheduledAt).toISOString().slice(0, 16);
  });

  // ScheduleSection state — initialized from existing task or defaults
  const [scheduleState, setScheduleState] = useState<ScheduleState>(() =>
    existing ? scheduledTaskToScheduleState(existing) : defaultScheduleState
  );

  const [formError, setFormError] = useState<string | null>(null);

  const { createSchedule, updateSchedule, isPending } = useScheduleMutations(
    api,
    existing?.id
  );

  const handleSubmit = async () => {
    setFormError(null);

    if (!name.trim()) {
      setFormError("Name is required");
      return;
    }
    if (!scheduleState.prompt.trim()) {
      setFormError("Prompt is required");
      return;
    }
    if (!projectDirectory.trim()) {
      setFormError("Project directory is required");
      return;
    }

    if (scheduleType === "cron" && !cronExpression.trim()) {
      setFormError("Cron expression is required");
      return;
    }
    if (scheduleType === "at" && !scheduledAtStr) {
      setFormError("Scheduled time is required");
      return;
    }

    try {
      if (existing) {
        // Build update request from ScheduleSection state
        const update: UpdateScheduledTaskRequest =
          scheduleStateToUpdateRequest(scheduleState);

        // Override with identity fields
        update.name = name.trim();
        update.emoji = emoji ?? undefined;
        update.projectDirectory = projectDirectory.trim();

        // Preserve deleteAfterRun from existing task
        update.deleteAfterRun = existing.deleteAfterRun;

        // Session type fields
        update.sessionType = sessionType;
        update.worktreeBranchName =
          sessionType === "worktree"
            ? worktreeBranchName.trim() || undefined
            : undefined;

        // Handle cron/at schedule types (backward compat for existing tasks)
        if (scheduleType === "cron") {
          update.scheduleType = "cron";
          update.cronExpression = cronExpression.trim();
        } else if (scheduleType === "at") {
          update.scheduleType = "at";
          update.scheduledAt = new Date(scheduledAtStr).getTime();
        }

        await updateSchedule(update);
      } else {
        // Create flow — build from ScheduleSection state
        const base = scheduleStateToUpdateRequest(scheduleState);
        const createReq = {
          ...base,
          name: name.trim(),
          emoji: emoji ?? undefined,
          prompt: scheduleState.prompt.trim(),
          projectDirectory: projectDirectory.trim(),
          scheduleType: scheduleType as ScheduleKind,
          deleteAfterRun: false,
          // CreateScheduledTaskRequest doesn't accept null for maxRuntimeMs
          maxRuntimeMs: base.maxRuntimeMs ?? undefined,
          sessionType,
          worktreeBranchName:
            sessionType === "worktree"
              ? worktreeBranchName.trim() || undefined
              : undefined,
        };

        if (scheduleType === "cron") {
          createReq.cronExpression = cronExpression.trim();
        }
        if (scheduleType === "at") {
          createReq.scheduledAt = new Date(scheduledAtStr).getTime();
        }

        await createSchedule(createReq);
      }
      onSaved();
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : "Failed to save schedule"
      );
    }
  };

  const inputClass =
    "w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-2 text-sm text-[var(--app-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)]";

  return (
    <div
      className="flex flex-col divide-y divide-[var(--app-divider)]"
      {...swipeBackHandlers}
    >
      {/* Header */}
      <div
        className="flex items-center gap-2 px-3 py-2.5"
        style={{
          paddingLeft: isIPadMultitasking
            ? IPAD_WINDOW_CONTROLS_INSET_X
            : undefined,
        }}
      >
        <button
          type="button"
          onClick={onBack}
          title="Go back"
          aria-label="Go back to previous page"
          className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)]"
        >
          <BackIcon className="h-5 w-5" />
        </button>
        <h2 className="flex-1 text-base font-semibold text-[var(--app-fg)]">
          {existing ? "Edit Schedule" : "New Schedule"}
        </h2>
      </div>

      {/* Error banner */}
      {formError && (
        <div className="mx-3 rounded-lg bg-red-500/10 p-2 text-xs text-red-400">
          {formError}
        </div>
      )}

      {/* Identity: Name + Emoji */}
      <div className="px-3 py-2.5">
        <FormField label="Name">
          <div className="flex items-center gap-2">
            <EmojiPickerPopover emoji={emoji} onEmojiSelect={setEmoji} />
            <input
              autoCapitalize="none"
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Daily health check"
              className={`flex-1 ${inputClass}`}
            />
          </div>
        </FormField>
      </div>

      {/* Project Directory */}
      <div className="px-3 py-2.5">
        <FormField label="Project Directory">
          <input
            autoCapitalize="none"
            type="text"
            value={projectDirectory}
            onChange={e => setProjectDirectory(e.target.value)}
            placeholder="/home/matt/projects/myproject"
            className={inputClass}
          />
        </FormField>
      </div>

      {/* Git Type selector (Simple / Worktree) */}
      <div className="px-3 py-2.5">
        <SessionTypeSelector
          sessionType={sessionType}
          isDisabled={false}
          onSessionTypeChange={setSessionType}
        />
      </div>

      {/* Branch Name (visible when Worktree is selected) */}
      {sessionType === "worktree" && (
        <div className="px-3 py-2.5">
          <FormField
            label="Branch Name"
            hint="Optional — auto-generated if empty"
          >
            <input
              autoCapitalize="none"
              type="text"
              value={worktreeBranchName}
              onChange={e => setWorktreeBranchName(e.target.value)}
              placeholder="feature/my-branch"
              className={inputClass}
            />
          </FormField>
        </div>
      )}

      {/* Cron/At fields (backward compat for existing cron/at schedules) */}
      {scheduleType === "cron" && (
        <div className="px-3 py-2.5">
          <FormField
            label="Cron Expression"
            hint="e.g. */30 * * * * (every 30 min)"
          >
            <input
              autoCapitalize="none"
              type="text"
              value={cronExpression}
              onChange={e => setCronExpression(e.target.value)}
              placeholder="0 9 * * *"
              className={`${inputClass} font-mono`}
            />
          </FormField>
        </div>
      )}

      {scheduleType === "at" && (
        <div className="px-3 py-2.5">
          <FormField label="Run At">
            <input
              type="datetime-local"
              value={scheduledAtStr}
              onChange={e => setScheduledAtStr(e.target.value)}
              className={inputClass}
            />
          </FormField>
        </div>
      )}

      {/* ScheduleSection — collapsible layers matching Create screen */}
      <ScheduleSection state={scheduleState} onChange={setScheduleState} />

      {/* Action buttons */}
      <div className="flex justify-end gap-2 px-3 py-2.5">
        <button
          type="button"
          onClick={onBack}
          className="rounded-lg px-3 py-1.5 text-sm text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)]"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={isPending}
          className="rounded-lg bg-[var(--brand-accent)] px-4 py-1.5 text-sm font-medium text-[var(--brand-primary)] transition-opacity hover:opacity-80 disabled:opacity-50"
        >
          {isPending ? "Saving…" : existing ? "Update" : "Create"}
        </button>
      </div>
    </div>
  );
}
