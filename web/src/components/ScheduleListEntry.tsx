// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Schedule list entry components for the unified session/schedule list view.
 * Extracted from SchedulesPage.tsx for reuse in SessionList.
 */
import { useState, useEffect, useCallback } from "react";
import type { ApiClient, ScheduleChildDisposition } from "@/api/client";
import type {
  ScheduledTask,
  HeartbeatConfig,
  HeartbeatStatus,
} from "@/types/api";
import type { StatusBreakdown } from "@/lib/sessionHelpers";
import { SessionCountBadge } from "./SessionList/SessionCountBadge";
import { SubheadingBar } from "./SessionList/SubheadingBar";
import { useScheduleMutations } from "@/extensions/scheduler/hooks/useScheduleMutations";
import { useScheduleHistory } from "@/extensions/scheduler/hooks/useSchedules";
import { useHeartbeatMutations } from "@/extensions/heartbeat/useHeartbeatActions";
import { formatInterval } from "@/components/NewSession/IntervalPicker";
import { LoadingState } from "@/components/LoadingState";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/Spinner";
import {
  ChevronIcon,
  TrashIcon,
  PlayIcon,
  PowerIcon,
  HistoryIcon,
  CalendarClockIcon,
} from "@/components/icons";
import { EmojiPickerPopover } from "@/components/EmojiPickerPopover";
import { SCHEDULE_LIST_ITEM_TYPE_INFO } from "@/lib/sessionHelpers";
import { useToast } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { BareButton } from "@/components/ui/BareButton";
import {
  formatScheduleRelativeTime,
  formatDateTime,
  formatDuration,
  scheduleDescription,
  statusColor,
  statusBgColor,
} from "@/components/schedule-helpers";

// ── Expand/Collapse State ─────────────────────────────────────────────

const SCHEDULE_EXPANDED_KEY = "hapi:expandedSchedules";

export function useExpandedSchedules(
  initialExpanded?: Set<string>
): [Set<string>, (id: string) => void] {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => {
    if (initialExpanded && initialExpanded.size > 0) return initialExpanded;
    try {
      const stored = localStorage.getItem(SCHEDULE_EXPANDED_KEY);
      if (stored) {
        const ids = JSON.parse(stored) as string[];
        return new Set(ids);
      }
    } catch {
      // Ignore parse errors
    }
    return new Set();
  });

  const toggleExpanded = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      try {
        localStorage.setItem(SCHEDULE_EXPANDED_KEY, JSON.stringify([...next]));
      } catch {
        // Ignore localStorage errors
      }
      return next;
    });
  };

  return [expandedIds, toggleExpanded];
}

// ── Spawned Sessions Collapse State ─────────────────────────────────────

const SPAWNED_SESSIONS_COLLAPSED_KEY = "hapi:collapsedSpawnedSessions";

/**
 * Tracks which scheduler tasks have their spawned sessions collapsed.
 * Default: collapsed (in the set). Persists to localStorage.
 */
export function useSpawnedSessionsCollapsed(): [
  Set<string>,
  (taskId: string) => void,
] {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem(SPAWNED_SESSIONS_COLLAPSED_KEY);
      if (stored) return new Set(JSON.parse(stored) as string[]);
    } catch {
      /* ignore */
    }
    // Default: all collapsed (empty set means nothing explicitly toggled yet)
    return new Set();
  });

  const toggle = useCallback((taskId: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      try {
        localStorage.setItem(
          SPAWNED_SESSIONS_COLLAPSED_KEY,
          JSON.stringify([...next])
        );
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  return [collapsed, toggle];
}

// ── Scheduler Subheader Collapse State ─────────────────────────────────

const SCHEDULER_SUBHEADER_KEY = "hapi:schedulerSubheaderCollapsed";

/**
 * Tracks which project groups have their scheduler subheader collapsed.
 * Default: expanded (not in the set). Persists to localStorage.
 */
export function useSchedulerSubheaderCollapsed(): [
  Set<string>,
  (groupKey: string) => void,
] {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem(SCHEDULER_SUBHEADER_KEY);
      if (stored) return new Set(JSON.parse(stored) as string[]);
    } catch {
      /* ignore */
    }
    return new Set();
  });

  const toggleCollapsed = useCallback((groupKey: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      try {
        localStorage.setItem(
          SCHEDULER_SUBHEADER_KEY,
          JSON.stringify([...next])
        );
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  return [collapsedGroups, toggleCollapsed];
}

// ── Shared Sub-Components ──────────────────────────────────────────────

export function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-2">
      <span className="w-24 shrink-0 text-xs text-[var(--app-hint)]">
        {label}
      </span>
      <span className="min-w-0 text-xs text-[var(--app-fg)] break-all">
        {value}
      </span>
    </div>
  );
}

export function ActionButton({
  onClick,
  disabled,
  icon,
  label,
  variant,
  size,
}: {
  onClick: () => void;
  disabled?: boolean;
  icon?: React.ReactNode;
  label: string;
  variant?: "accent" | "danger" | "warning";
  /** Use "sm" for compact inline list buttons */
  size?: "sm";
}) {
  const colorClass =
    variant === "accent"
      ? "bg-[var(--brand-accent)]/10 text-[var(--brand-accent)] hover:bg-[var(--brand-accent)]/20"
      : variant === "danger"
        ? "bg-red-500/10 text-red-400 hover:bg-red-500/20"
        : variant === "warning"
          ? "bg-yellow-500/10 text-yellow-400 hover:bg-yellow-500/20"
          : "bg-[var(--app-secondary-bg)] text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)]/80";

  const sizeClass =
    size === "sm"
      ? "gap-1 rounded-md px-1.5 py-1 text-[length:var(--text-caption-xs)]"
      : "gap-1.5 rounded-lg px-2.5 py-1.5 text-xs";

  return (
    <BareButton
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`flex items-center font-medium transition-colors disabled:opacity-50 ${sizeClass} ${colorClass}`}
    >
      {icon}
      {label}
    </BareButton>
  );
}

// ── Execution History ─────────────────────────────────────────────────

export function ExecutionHistory({
  api,
  scheduleId,
}: {
  api: ApiClient | null;
  scheduleId: string;
}) {
  const { history, isLoading, error } = useScheduleHistory(api, scheduleId);

  if (isLoading) {
    return (
      <div className="flex justify-center p-4">
        <LoadingState label="Loading history…" className="text-xs" />
      </div>
    );
  }

  if (error) {
    return <div className="p-2 text-xs text-red-400">{error}</div>;
  }

  if (history.length === 0) {
    return (
      <div className="p-3 text-center text-xs text-[var(--app-hint)]">
        No execution history
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-[var(--app-hint)]">
        Recent Executions
      </div>
      <div className="max-h-60 overflow-y-auto space-y-1.5">
        {history.map(exec => (
          <div
            key={exec.id}
            className={`rounded-lg p-2 ${statusBgColor(exec.status)}`}
          >
            <div className="flex items-center justify-between gap-2">
              <span
                className={`text-xs font-medium capitalize ${statusColor(exec.status)}`}
              >
                {exec.status.replaceAll("_", " ")}
              </span>
              <span className="text-[length:var(--text-caption-xs)] text-[var(--app-hint)]">
                {formatDateTime(exec.scheduledFor)}
              </span>
            </div>
            {exec.startedAt && exec.completedAt && (
              <div className="mt-0.5 text-[length:var(--text-caption-xs)] text-[var(--app-hint)]">
                Duration: {formatDuration(exec.completedAt - exec.startedAt)}
              </div>
            )}
            {exec.errorMessage && (
              <div className="mt-1 text-[length:var(--text-caption-xs)] text-red-400 break-all">
                {exec.errorMessage}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Heartbeat History ─────────────────────────────────────────────────

export function HeartbeatHistory({ api }: { api: ApiClient | null }) {
  const [history, setHistory] = useState<
    { timestamp: number; success: boolean; skipped: boolean; error?: string }[]
  >([]);
  const [isLoading, setIsLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    if (!api) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setFetchError(null);
    void api
      .getHeartbeatHistory()
      .then(res => {
        setHistory(res.history ?? []);
      })
      .catch((err: unknown) => {
        setFetchError(
          err instanceof Error ? err.message : "Failed to load history"
        );
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, [api]);

  if (isLoading) {
    return (
      <div className="flex justify-center p-4">
        <LoadingState label="Loading history…" className="text-xs" />
      </div>
    );
  }

  if (fetchError) {
    return <div className="p-2 text-xs text-red-400">{fetchError}</div>;
  }

  if (history.length === 0) {
    return (
      <div className="p-3 text-center text-xs text-[var(--app-hint)]">
        No heartbeat history
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-[var(--app-hint)]">
        Recent Heartbeats
      </div>
      <div className="max-h-60 overflow-y-auto space-y-1.5">
        {history.slice(0, 20).map((entry, i) => (
          <div
            key={`${entry.timestamp}-${i}`}
            className={`rounded-lg p-2 ${
              entry.skipped
                ? "bg-[var(--app-secondary-bg)]"
                : entry.success
                  ? "bg-green-500/10"
                  : "bg-red-500/10"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span
                className={`text-xs font-medium ${
                  entry.skipped
                    ? "text-[var(--app-hint)]"
                    : entry.success
                      ? "text-green-400"
                      : "text-red-400"
                }`}
              >
                {entry.skipped
                  ? "Skipped"
                  : entry.success
                    ? "Success"
                    : "Failed"}
              </span>
              <span className="text-[length:var(--text-caption-xs)] text-[var(--app-hint)]">
                {formatDateTime(entry.timestamp)}
              </span>
            </div>
            {entry.error && (
              <div className="mt-1 text-[length:var(--text-caption-xs)] text-red-400 break-all">
                {entry.error}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Schedule List Row ─────────────────────────────────────────────────

/**
 * #3172: two-choice delete for a schedule that has spawned sessions — the
 * schedule analogue of `WorktreeDeleteDialog` (#2480). The DEFAULT action keeps
 * the sessions as independent top-level sessions (their schedule link is
 * dissolved server-side); deleting them too is the demoted destructive action.
 * The handler resolves on success and throws on failure (the row toasts), so
 * the dialog closes only via the row.
 */
export function ScheduleDeleteDialog({
  isOpen,
  onClose,
  scheduleName,
  childCount,
  onDelete,
  isPending,
}: {
  isOpen: boolean;
  onClose: () => void;
  scheduleName: string;
  /** Sessions this schedule spawned (what "Delete schedule and sessions" removes). */
  childCount: number;
  onDelete: (children: ScheduleChildDisposition) => Promise<void>;
  isPending: boolean;
}) {
  const [pendingAction, setPendingAction] =
    useState<ScheduleChildDisposition | null>(null);

  useEffect(() => {
    if (isOpen) setPendingAction(null);
  }, [isOpen]);

  const handleAction = async (children: ScheduleChildDisposition) => {
    setPendingAction(children);
    try {
      await onDelete(children);
    } finally {
      setPendingAction(null);
    }
  };

  const sessionNoun = childCount === 1 ? "session" : "sessions";

  return (
    <Dialog open={isOpen} onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Delete schedule</DialogTitle>
          <DialogDescription className="mt-2">
            <strong className="text-[var(--app-fg)]">
              &ldquo;{scheduleName}&rdquo;
            </strong>{" "}
            has {childCount} spawned {sessionNoun}. Deleting only the schedule
            keeps {childCount === 1 ? "it as an" : "them as"} independent,
            top-level {sessionNoun}. Its execution history is removed either
            way.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-4 flex flex-col gap-2">
          {/* Primary — orphan (dissolve): the spawned sessions survive top-level. */}
          <Button
            type="button"
            variant="default"
            onClick={() => void handleAction("orphan")}
            disabled={isPending}
          >
            {isPending && pendingAction === "orphan" ? (
              <span className="inline-flex items-center gap-1.5">
                <Spinner size="sm" label={null} className="!text-inherit" />
                Deleting schedule...
              </span>
            ) : (
              `Delete schedule, keep ${sessionNoun}`
            )}
          </Button>

          {/* Secondary/destructive — cascade: archive + delete the spawned sessions. */}
          <Button
            type="button"
            variant="destructive"
            onClick={() => void handleAction("cascade")}
            disabled={isPending}
          >
            {isPending && pendingAction === "cascade" ? (
              <span className="inline-flex items-center gap-1.5">
                <Spinner size="sm" label={null} className="!text-inherit" />
                Deleting all...
              </span>
            ) : (
              `Delete schedule and ${childCount} ${sessionNoun}`
            )}
          </Button>

          {/* Cancel — safe option */}
          <Button
            type="button"
            variant="secondary"
            onClick={onClose}
            disabled={isPending}
          >
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ScheduleListRow({
  api,
  task,
  onEdit,
  isExpanded,
  onToggleExpanded,
  spawnedSessionCount,
  isSpawnedCollapsed,
  onToggleSpawnedCollapsed,
  renderSpawnedSessions,
  statusBreakdown,
}: {
  api: ApiClient | null;
  task: ScheduledTask;
  onEdit: (task: ScheduledTask) => void;
  isExpanded: boolean;
  onToggleExpanded: () => void;
  spawnedSessionCount?: number;
  isSpawnedCollapsed?: boolean;
  onToggleSpawnedCollapsed?: () => void;
  renderSpawnedSessions?: () => React.ReactNode;
  /**
   * Status breakdown of the scheduler-spawned sessions for this row. Rendered as
   * an always-on SessionCountBadge (#3133; was the collapsed-only #2900
   * HiddenStatusHint) so those counted sessions reconcile with the toolbar total.
   */
  statusBreakdown?: StatusBreakdown;
}) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const { updateSchedule, toggleSchedule, runNow, deleteSchedule, isPending } =
    useScheduleMutations(api, task.id);
  const typeInfo = SCHEDULE_LIST_ITEM_TYPE_INFO;
  const { showToast } = useToast();

  const handleRunNow = async () => {
    try {
      await runNow();
      showToast("Schedule triggered", { type: "success" });
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : "Failed to trigger schedule",
        { type: "error" }
      );
    }
  };

  const handleToggle = async () => {
    try {
      await toggleSchedule();
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : "Failed to toggle schedule",
        { type: "error" }
      );
    }
  };

  const handleRowClick = () => onEdit(task);
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onEdit(task);
    }
  };
  const handleEmojiSelect = (emoji: string | null) => {
    void updateSchedule({ emoji: emoji ?? undefined });
  };

  const handleDelete = async (children?: ScheduleChildDisposition) => {
    try {
      await deleteSchedule(children);
      setDeleteOpen(false);
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : "Failed to delete schedule",
        { type: "error" }
      );
    }
  };

  return (
    <>
      <div
        className={`session-list-item border-l-4 pl-2 pr-2 py-1.5 transition-colors ${typeInfo.borderLeftClass} ${typeInfo.headerTintClass}`}
        style={{ "--item-hover-bg": typeInfo.hoverBg } as React.CSSProperties}
      >
        {/* Row header — unified layout matching session items */}
        <div className="flex gap-2 min-w-0">
          {/* Left side: Two rows of content */}
          <div
            role="button"
            tabIndex={0}
            onClick={handleRowClick}
            onKeyDown={handleKeyDown}
            className="flex flex-col gap-0.5 min-w-0 flex-1 cursor-pointer text-left transition-colors hover:opacity-80"
          >
            {/* Row 1: Status dot + Emoji + Schedule name */}
            <div className="flex items-center gap-1 min-w-0">
              <div
                className={`h-2 w-2 shrink-0 rounded-full ${
                  task.enabled ? "bg-green-400" : "bg-[var(--app-hint)]"
                }`}
              />
              <EmojiPickerPopover
                emoji={task.emoji || null}
                onEmojiSelect={handleEmojiSelect}
                disabled={!api}
              />
              <span className="truncate text-[length:var(--text-label-strong)] font-medium leading-tight max-w-full">
                {task.name}
              </span>
              {task.consecutiveErrors > 0 && (
                <span className="shrink-0 rounded-full bg-red-500/20 px-1.5 py-0.5 text-[length:var(--text-caption-xs)] font-medium text-red-400">
                  {task.consecutiveErrors} err
                </span>
              )}
            </div>
            {/* Row 2: Schedule description — aligned under status dot */}
            <div className="flex items-center gap-2 min-w-0">
              <span className="flex h-3 w-3 items-center justify-center shrink-0">
                <CalendarClockIcon className="h-3 w-3 text-[var(--app-hint)]" />
              </span>
              <div className="flex flex-wrap items-center gap-x-1 text-[length:var(--text-body-dense)] text-[var(--app-hint)] min-w-0">
                <span className="shrink-0">{scheduleDescription(task)}</span>
                {task.nextExecutionAt && (
                  <span className="shrink-0">
                    · next {formatScheduleRelativeTime(task.nextExecutionAt)}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Right side: type badge — self-center with spacer to match session badge column */}
          <div className="flex flex-col items-end gap-0.5 shrink-0 self-center">
            <span
              className={`flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[length:var(--text-caption-xs)] font-medium leading-none ${typeInfo.badgeBgClass} ${typeInfo.badgeTextClass}`}
            >
              {typeInfo.label}
              <span className="text-[length:var(--text-caption-xs)] leading-none">
                {typeInfo.emoji}
              </span>
            </span>
            {/* Spacer matches session badge column's 2nd row height so self-center aligns badge with row 1 */}
            <span className="h-2.5" aria-hidden="true" />
          </div>

          {/* Chevron spanning full height */}
          <Button
            type="button"
            variant="ghost"
            onClick={e => {
              e.stopPropagation();
              onToggleExpanded();
            }}
            className="flex h-auto items-center justify-center shrink-0 self-stretch rounded-md bg-[var(--app-secondary-bg)] px-1 text-[var(--app-hint)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-fg)] active:bg-[var(--app-hover)]"
            title={isExpanded ? "Hide details" : "Show details"}
            aria-label={
              isExpanded ? "Hide schedule details" : "Show schedule details"
            }
          >
            <ChevronIcon className="h-3.5 w-3.5" collapsed={!isExpanded} />
          </Button>
        </div>

        {/* Expandable section */}
        <div
          className={`overflow-hidden transition-all duration-200 ease-in-out ${
            isExpanded
              ? "max-h-[800px] opacity-100" /* design-tokens-allow: 800px expandable-section scroll-cap sentinel, off the spacing scale (L8 #3410) */
              : "max-h-0 opacity-0"
          }`}
        >
          <div className="mx-3 mb-3 rounded-lg bg-[var(--app-secondary-bg)] p-2.5">
            {/* Action buttons */}
            <div className="flex flex-wrap items-center gap-1 mb-2.5">
              <ActionButton
                onClick={() => void handleToggle()}
                disabled={isPending}
                icon={<PowerIcon className="h-3 w-3" />}
                label={task.enabled ? "Enabled" : "Disabled"}
                variant={task.enabled ? "accent" : undefined}
                size="sm"
              />
              <ActionButton
                onClick={() => void handleRunNow()}
                disabled={isPending}
                icon={<PlayIcon className="h-3 w-3" />}
                label="Run"
                variant="accent"
                size="sm"
              />
              <ActionButton
                onClick={() => setShowHistory(!showHistory)}
                icon={<HistoryIcon className="h-3 w-3" />}
                label={showHistory ? "Hide" : "History"}
                size="sm"
              />
              <ActionButton
                onClick={() => setDeleteOpen(true)}
                disabled={isPending}
                icon={<TrashIcon className="h-3 w-3" />}
                label="Delete"
                variant="danger"
                size="sm"
              />
            </div>

            {/* Detail fields */}
            <div className="space-y-1.5 text-sm">
              <InfoRow label="Schedule" value={scheduleDescription(task)} />
              <InfoRow label="Timezone" value={task.timezone} />
              <InfoRow label="Overlap" value={task.overlapPolicy} />
              <InfoRow label="Notify" value={task.notifyOn} />
              {task.maxRuntimeMs && (
                <InfoRow
                  label="Max Runtime"
                  value={formatDuration(task.maxRuntimeMs)}
                />
              )}
              {task.deleteAfterRun && (
                <InfoRow label="Auto-delete" value="Yes (one-shot)" />
              )}
              {task.nextExecutionAt && (
                <InfoRow
                  label="Next Run"
                  value={`${formatDateTime(task.nextExecutionAt)} (${formatScheduleRelativeTime(task.nextExecutionAt)})`}
                />
              )}
              {task.lastExecutedAt && (
                <InfoRow
                  label="Last Run"
                  value={formatDateTime(task.lastExecutedAt)}
                />
              )}
              {task.lastSessionId && (
                <div className="flex items-start gap-2">
                  <span className="w-24 shrink-0 text-xs text-[var(--app-hint)]">
                    Session
                  </span>
                  <button /* design-tokens-allow: bare-inline tap-to-copy session-ID link (break-all wrapping text-link, no box); Button chrome breaks the inline link (L2 bare-inline #3404) (L8 #3410) */
                    type="button"
                    className="min-w-0 text-xs text-[var(--app-link)] break-all text-left active:opacity-60"
                    onClick={() => {
                      void navigator.clipboard.writeText(task.lastSessionId!);
                    }}
                    title="Tap to copy session ID"
                  >
                    {task.lastSessionId}
                  </button>
                </div>
              )}
              {task.consecutiveErrors > 0 && (
                <InfoRow
                  label="Errors"
                  value={`${task.consecutiveErrors} consecutive`}
                />
              )}
              <InfoRow label="Directory" value={task.projectDirectory} />
            </div>

            {/* Prompt preview */}
            <div className="mt-2">
              <div className="mb-1 text-xs font-medium text-[var(--app-hint)]">
                Prompt
              </div>
              <div className="max-h-32 overflow-y-auto rounded-lg bg-[var(--app-bg)] p-2 text-xs text-[var(--app-fg)]">
                <pre className="whitespace-pre-wrap font-mono">
                  {task.prompt}
                </pre>
              </div>
            </div>

            {/* Execution history */}
            {showHistory && (
              <div className="mt-2">
                <ExecutionHistory api={api} scheduleId={task.id} />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* #3172: a schedule with spawned sessions asks what happens to them
          (mirrors #2479/#2480's managed-peer delete); a childless one keeps the
          plain confirm — there is nothing to decide. */}
      {(spawnedSessionCount ?? 0) > 0 ? (
        <ScheduleDeleteDialog
          isOpen={deleteOpen}
          onClose={() => setDeleteOpen(false)}
          scheduleName={task.name}
          childCount={spawnedSessionCount ?? 0}
          onDelete={handleDelete}
          isPending={isPending}
        />
      ) : (
        <ConfirmDialog
          isOpen={deleteOpen}
          onClose={() => setDeleteOpen(false)}
          title="Delete Schedule"
          description={`Delete "${task.name}"? This will also remove all execution history. This cannot be undone.`}
          confirmLabel="Delete"
          confirmingLabel="Deleting..."
          onConfirm={() => handleDelete()}
          isPending={isPending}
          destructive
        />
      )}

      {/* Scheduled Peers — collapsible section beneath the schedule row.
          Thin blue border around the whole section mirrors the branched
          conversations mint border pattern. Re-enable session-list-item
          left border (SchedulerSubheader strips it with border-l-0).
          #3264 R1: the SOLID --session-rel-schedule top border is the
          parent→children separator between the scheduler-event row and its
          scheduled peers (mirrors the PM cluster's darker-gold separator). */}
      {(spawnedSessionCount ?? 0) > 0 && (
        <div className="border border-[var(--session-rel-schedule)]/30 border-t-[color:var(--session-rel-schedule)] rounded-sm [&_.session-list-item]:border-l-4">
          {/* #3484: shared SubheadingBar — status cluster far left (aligned
              columns under the toolbar accumulator), label + count to its right,
              chevron far right. Layout is owned by SubheadingBar; this tint string
              carries only the scheduler hue.
              #2479 (Task 14): the scheduler cluster's accent chrome — the solid
              accents AND the alpha fill/hover/text/border — compose on the
              --session-rel-schedule token (post-#3382). */}
          <SubheadingBar
            collapsed={isSpawnedCollapsed ?? true}
            onToggle={() => onToggleSpawnedCollapsed?.()}
            label="scheduled peers"
            count={`(${spawnedSessionCount})`}
            // #3484 Option 2: this card sits inside the SchedulerSubheader's
            // outer dark-blue RAIL (4px) → pl-1 so the status cluster starts at
            // the same x as the branched / managed bars (see SubheadingBar).
            nestedInRail
            className="border-l-4 border-l-[color:var(--session-rel-schedule)] bg-[var(--session-rel-schedule)]/10 text-[color:var(--session-rel-schedule)]/70 hover:bg-[var(--session-rel-schedule)]/15 hover:text-[color:var(--session-rel-schedule)]"
            // #3133: always-on session-count badge for the spawned-sessions
            // section — reconciles these counted sessions with the toolbar total.
            cluster={
              statusBreakdown ? (
                <SessionCountBadge
                  variant="aligned"
                  breakdown={statusBreakdown}
                />
              ) : undefined
            }
          />
          {!isSpawnedCollapsed && (
            <div className="divide-y divide-[var(--session-rel-schedule)]/30">
              {renderSpawnedSessions?.()}
            </div>
          )}
        </div>
      )}
    </>
  );
}

// ── Heartbeat List Entry ─────────────────────────────────────────────

export function HeartbeatListEntry(props: {
  api: ApiClient | null;
  config: HeartbeatConfig;
  status: HeartbeatStatus | null;
  onCreate: () => void;
  onEdit?: () => void;
  isExpanded: boolean;
  onToggleExpanded: () => void;
}) {
  const { api, config, status, isExpanded, onToggleExpanded } = props;
  const isRunning = status?.running ?? false;
  const nextTick = status?.nextTickAt;
  const typeInfo = SCHEDULE_LIST_ITEM_TYPE_INFO;
  const { updateConfig, deleteConfig, isPending } = useHeartbeatMutations(api);
  const [triggerPending, setTriggerPending] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const { showToast } = useToast();

  const handleToggle = async () => {
    try {
      await updateConfig({ enabled: !config.enabled });
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : "Failed to toggle heartbeat",
        { type: "error" }
      );
    }
  };

  const handleTrigger = async () => {
    if (!api) return;
    setTriggerPending(true);
    try {
      await api.triggerHeartbeat();
      showToast("Heartbeat triggered", { type: "success" });
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : "Failed to trigger heartbeat",
        { type: "error" }
      );
    } finally {
      setTriggerPending(false);
    }
  };

  const handleDelete = async () => {
    try {
      await deleteConfig();
      setDeleteOpen(false);
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : "Failed to delete heartbeat",
        { type: "error" }
      );
    }
  };

  const handleRowClick = () => props.onEdit?.();
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      props.onEdit?.();
    }
  };

  const actionsPending = isPending || triggerPending;

  const handleEmojiSelect = (emoji: string | null) => {
    void updateConfig({ sessionEmoji: emoji ?? undefined });
  };

  return (
    <>
      <div
        className={`session-list-item border-l-4 pl-2 pr-2 py-1.5 transition-colors ${typeInfo.borderLeftClass} ${typeInfo.headerTintClass}`}
        style={{ "--item-hover-bg": typeInfo.hoverBg } as React.CSSProperties}
      >
        {/* Row header — unified layout matching session items */}
        <div className="flex gap-2 min-w-0">
          {/* Left side: Two rows of content */}
          <div
            role="button"
            tabIndex={0}
            onClick={handleRowClick}
            onKeyDown={handleKeyDown}
            className="flex flex-col gap-0.5 min-w-0 flex-1 cursor-pointer text-left transition-colors hover:opacity-80"
          >
            {/* Row 1: Status dot + Emoji + Heartbeat name */}
            <div className="flex items-center gap-1 min-w-0">
              <div
                className={`h-2 w-2 shrink-0 rounded-full ${
                  isRunning
                    ? "bg-green-400 animate-pulse"
                    : "bg-[var(--app-hint)]"
                }`}
              />
              <EmojiPickerPopover
                emoji={config.sessionEmoji ?? "💓"}
                onEmojiSelect={handleEmojiSelect}
                disabled={!api}
              />
              <span className="truncate text-[length:var(--text-label-strong)] font-medium leading-tight max-w-full">
                {config.sessionName ?? "HEARTBEAT"}
              </span>
              {status && status.consecutiveFailures > 0 && (
                <span className="shrink-0 rounded-full bg-red-500/20 px-1.5 py-0.5 text-[length:var(--text-caption-xs)] font-medium text-red-400">
                  {status.consecutiveFailures} err
                </span>
              )}
            </div>
            {/* Row 2: Heartbeat interval — aligned under status dot */}
            <div className="flex items-center gap-2 min-w-0">
              <span className="flex h-3 w-3 items-center justify-center shrink-0">
                <CalendarClockIcon className="h-3 w-3 text-[var(--app-hint)]" />
              </span>
              <div className="flex flex-wrap items-center gap-x-1 text-[length:var(--text-body-dense)] text-[var(--app-hint)] min-w-0">
                <span className="shrink-0">
                  Every {formatInterval(config.every)}
                </span>
                {nextTick && (
                  <span className="shrink-0">
                    · next {formatScheduleRelativeTime(nextTick)}
                  </span>
                )}
                {status && (
                  <span className="shrink-0">
                    · {status.beatsSinceRotation}/{config.rotateAfterBeats}{" "}
                    beats
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Right side: type badge — self-center with spacer to match session badge column */}
          <div className="flex flex-col items-end gap-0.5 shrink-0 self-center">
            <span
              className={`flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[length:var(--text-caption-xs)] font-medium leading-none ${typeInfo.badgeBgClass} ${typeInfo.badgeTextClass}`}
            >
              {typeInfo.label}
              <span className="text-[length:var(--text-caption-xs)] leading-none">
                {typeInfo.emoji}
              </span>
            </span>
            {/* Spacer matches session badge column's 2nd row height so self-center aligns badge with row 1 */}
            <span className="h-2.5" aria-hidden="true" />
          </div>

          {/* Chevron spanning full height */}
          <Button
            type="button"
            variant="ghost"
            onClick={e => {
              e.stopPropagation();
              onToggleExpanded();
            }}
            className="flex h-auto items-center justify-center shrink-0 self-stretch rounded-md bg-[var(--app-secondary-bg)] px-1 text-[var(--app-hint)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-fg)] active:bg-[var(--app-hover)]"
            title={isExpanded ? "Hide details" : "Show details"}
            aria-label={
              isExpanded ? "Hide heartbeat details" : "Show heartbeat details"
            }
          >
            <ChevronIcon className="h-3.5 w-3.5" collapsed={!isExpanded} />
          </Button>
        </div>

        {/* Expandable section */}
        <div
          className={`overflow-hidden transition-all duration-200 ease-in-out ${
            isExpanded
              ? "max-h-[800px] opacity-100" /* design-tokens-allow: 800px expandable-section scroll-cap sentinel, off the spacing scale (L8 #3410) */
              : "max-h-0 opacity-0"
          }`}
        >
          <div className="mx-3 mb-3 rounded-lg bg-[var(--app-secondary-bg)] p-2.5">
            {/* Action buttons */}
            <div className="flex flex-wrap items-center gap-1 mb-2.5">
              <ActionButton
                onClick={handleToggle}
                disabled={actionsPending}
                icon={<PowerIcon className="h-3 w-3" />}
                label={config.enabled ? "Enabled" : "Disabled"}
                variant={config.enabled ? "accent" : undefined}
                size="sm"
              />
              <ActionButton
                onClick={handleTrigger}
                disabled={actionsPending}
                icon={<PlayIcon className="h-3 w-3" />}
                label="Run"
                variant="accent"
                size="sm"
              />
              <ActionButton
                onClick={() => setShowHistory(!showHistory)}
                icon={<HistoryIcon className="h-3 w-3" />}
                label={showHistory ? "Hide" : "History"}
                size="sm"
              />
              <ActionButton
                onClick={() => setDeleteOpen(true)}
                disabled={actionsPending}
                icon={<TrashIcon className="h-3 w-3" />}
                label="Delete"
                variant="danger"
                size="sm"
              />
            </div>

            {/* Detail fields */}
            <div className="space-y-1.5 text-sm">
              <InfoRow label="Interval" value={formatInterval(config.every)} />
              <InfoRow
                label="Active Hours"
                value={`${config.activeHours.start}:00 – ${config.activeHours.end}:00 (${config.activeHours.timezone})`}
              />
              <InfoRow label="Directory" value={config.sessionDirectory} />
              <InfoRow
                label="Rotate After"
                value={`${config.rotateAfterBeats} beats`}
              />
              {status && (
                <>
                  <InfoRow
                    label="Beats"
                    value={`${status.beatsSinceRotation} / ${config.rotateAfterBeats}`}
                  />
                  {status.lastTickAt && (
                    <InfoRow
                      label="Last Tick"
                      value={formatDateTime(status.lastTickAt)}
                    />
                  )}
                  {status.nextTickAt && (
                    <InfoRow
                      label="Next Tick"
                      value={`${formatDateTime(status.nextTickAt)} (${formatScheduleRelativeTime(status.nextTickAt)})`}
                    />
                  )}
                  {status.sessionId && (
                    <div className="flex items-start gap-2">
                      <span className="w-24 shrink-0 text-xs text-[var(--app-hint)]">
                        Session
                      </span>
                      <button /* design-tokens-allow: bare-inline tap-to-copy session-ID link (break-all wrapping text-link, no box); Button chrome breaks the inline link (L2 bare-inline #3404) (L8 #3410) */
                        type="button"
                        className="min-w-0 text-xs text-[var(--app-link)] break-all text-left active:opacity-60"
                        onClick={() => {
                          void navigator.clipboard.writeText(status.sessionId!);
                        }}
                        title="Tap to copy session ID"
                      >
                        {status.sessionId}
                      </button>
                    </div>
                  )}
                  {status.consecutiveFailures > 0 && (
                    <InfoRow
                      label="Errors"
                      value={`${status.consecutiveFailures} consecutive`}
                    />
                  )}
                  <InfoRow
                    label="Active Hours"
                    value={
                      status.activeHoursActive ? "In window" : "Outside window"
                    }
                  />
                </>
              )}
            </div>

            {/* Heartbeat history */}
            {showHistory && (
              <div className="mt-2">
                <HeartbeatHistory api={api} />
              </div>
            )}
          </div>
        </div>
      </div>

      <ConfirmDialog
        isOpen={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="Delete Heartbeat"
        description="Delete the heartbeat configuration? The heartbeat service will be stopped. This cannot be undone."
        confirmLabel="Delete"
        confirmingLabel="Deleting..."
        onConfirm={handleDelete}
        isPending={isPending}
        destructive
      />
    </>
  );
}
