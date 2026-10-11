// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { MoreVertical } from "lucide-react";
import type {
  SystemJob,
  SystemJobLiveState,
  JobStatus,
  OsCronRow,
} from "@/types/systemJobs";
import { useAppContext } from "@/lib/app-context";
import { useSystemJobActions } from "@/hooks/mutations/useSystemJobActions";
import { TouchButton } from "@/components/ui/TouchButton";
import { Button } from "@/components/ui/button";
import { IconExpandToggle } from "@/components/ui/IconExpandToggle";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatMessageTimestamp } from "@/utils/formatMessageTimestamp";

/** systemd timer times are MICROSECONDS since epoch — divide by 1000 for a JS Date. */
function formatMicros(micros: number | null): string {
  if (micros == null) return "—";
  return formatMessageTimestamp(new Date(micros / 1000));
}

type EditField = "name" | "schedule" | "description" | null;

/**
 * SystemJobCard — one job's expandable card (epic #1534 Sub-Issue D, issue #1538).
 *
 * Shows the live enabled state, next/last run, schedule, command, description, and
 * a journal tail; exposes enable/disable/delete/reschedule/rename/edit-description
 * controls wired to `useSystemJobActions` (proxied to this card's `nodeId` by #1537).
 * Delete is gated by `ConfirmDialog`; the three text mutations use an inline editor.
 *
 * Styling uses ONLY defined CSS vars (`--app-fg`/`--app-hint`/`--app-secondary-bg`/
 * `--app-link`) — it deliberately does NOT reuse `NodeBadge`, which depends on the
 * app-wide-missing `--app-hover`/`--app-muted` vars (bug #1659, out of scope).
 */
export function SystemJobCard({
  job,
  liveState,
  nodeId,
}: {
  job: SystemJob;
  liveState: SystemJobLiveState;
  nodeId: string;
}) {
  const { api } = useAppContext();
  const {
    enableJob,
    disableJob,
    deleteJob,
    rescheduleJob,
    renameJob,
    editDescription,
    isPending,
  } = useSystemJobActions(api);

  const [isExpanded, setIsExpanded] = useState(false);
  const [editing, setEditing] = useState<EditField>(null);
  const [editValue, setEditValue] = useState("");
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const isOk = liveState.code === "ok";
  const enabled = isOk ? liveState.enabled : job.enabled;

  const startEdit = (field: Exclude<EditField, null>) => {
    setActionError(null);
    setEditValue(
      field === "name"
        ? job.name
        : field === "schedule"
          ? job.schedule
          : job.description
    );
    setEditing(field);
    setIsExpanded(true);
  };

  const runAction = async (fn: () => Promise<void>) => {
    setActionError(null);
    try {
      await fn();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Action failed");
    }
  };

  const handleToggle = () =>
    runAction(() =>
      enabled ? disableJob(nodeId, job.name) : enableJob(nodeId, job.name)
    );

  const handleSave = () =>
    runAction(async () => {
      if (editing === "name") await renameJob(nodeId, job.name, editValue);
      else if (editing === "schedule")
        await rescheduleJob(nodeId, job.name, editValue);
      else if (editing === "description")
        await editDescription(nodeId, job.name, editValue);
      setEditing(null);
    });

  const editLabel =
    editing === "name"
      ? "New name"
      : editing === "schedule"
        ? "OnCalendar schedule"
        : "Description";

  return (
    <div
      data-testid={`system-job-card-${job.name}`}
      className="rounded-md border border-[var(--app-secondary-bg)] bg-[var(--app-secondary-bg)]/40"
    >
      {/* Header row */}
      <div className="flex items-center gap-2 px-3 py-2">
        <IconExpandToggle
          expanded={isExpanded}
          onToggle={() => setIsExpanded(v => !v)}
          aria-label={isExpanded ? "Collapse" : "Expand"}
          data-testid={`system-job-expand-${job.name}`}
        />

        <span className="min-w-0 flex-1 truncate text-[length:var(--text-label-strong)] font-medium text-[var(--app-fg)]">
          {job.name}
        </span>

        <span
          data-testid={`system-job-enabled-${job.name}`}
          className={`flex-shrink-0 rounded-full px-2 py-0.5 text-[length:var(--text-caption)] font-medium ${
            enabled
              ? "bg-[var(--app-link)]/15 text-[var(--app-link)]"
              : "bg-[var(--app-hint)]/15 text-[var(--app-hint)]"
          }`}
        >
          {enabled ? "Enabled" : "Disabled"}
        </span>

        <TouchButton
          onAction={handleToggle}
          disabled={isPending}
          data-testid={`system-job-toggle-${job.name}`}
          className="flex-shrink-0 rounded-md px-2 py-1 text-[length:var(--text-body-dense)] font-medium text-[var(--app-link)] disabled:opacity-50"
        >
          {enabled ? "Disable" : "Enable"}
        </TouchButton>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghostStatic"
              aria-label="More actions"
              data-testid={`system-job-menu-${job.name}`}
              className="h-8 w-8 flex-shrink-0 p-0 hover:text-[var(--app-hint)]"
            >
              <MoreVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => startEdit("name")}>
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => startEdit("schedule")}>
              Reschedule
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => startEdit("description")}>
              Edit description
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-red-400"
              onSelect={() => {
                setActionError(null);
                setConfirmDeleteOpen(true);
              }}
            >
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Expanded body */}
      {isExpanded && (
        <div className="flex flex-col gap-2 border-t border-[var(--app-secondary-bg)] px-3 py-2 text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
          {job.description && (
            <p className="text-[var(--app-fg)]">{job.description}</p>
          )}

          <div className="flex flex-col gap-1">
            <Detail label="Schedule" value={job.schedule} mono />
            <Detail label="Command" value={job.command} mono />
            {isOk ? (
              <>
                <Detail
                  label="Next run"
                  value={formatMicros(liveState.nextRun)}
                />
                <Detail
                  label="Last run"
                  value={formatMicros(liveState.lastRun)}
                />
              </>
            ) : (
              <p
                data-testid={`system-job-unsupported-${job.name}`}
                className="italic"
              >
                Timer state unavailable (non-systemd host)
              </p>
            )}
          </div>

          {isOk && (
            <div>
              <p className="mb-1 font-medium text-[var(--app-fg)]">Log tail</p>
              {liveState.journalTail ? (
                <div
                  data-testid={`system-job-journal-${job.name}`}
                  className="max-h-40 overflow-y-auto rounded-md bg-black/30 p-2"
                >
                  <pre className="whitespace-pre-wrap break-all font-mono text-[length:var(--text-caption)] text-[var(--app-fg)]">
                    {liveState.journalTail}
                  </pre>
                </div>
              ) : (
                <p className="italic">No recent logs</p>
              )}
            </div>
          )}

          {/* Inline editor for rename / reschedule / edit-description */}
          {editing && (
            <div className="flex flex-col gap-2 rounded-md bg-black/20 p-2">
              <label className="font-medium text-[var(--app-fg)]">
                {editLabel}
              </label>
              <input
                autoCapitalize="none"
                type="text"
                value={editValue}
                onChange={e => setEditValue(e.target.value)}
                data-testid={`system-job-edit-input-${job.name}`}
                className="rounded-md border border-[var(--app-secondary-bg)] bg-[var(--app-bg)] px-2 py-1 text-[length:var(--text-body)] text-[var(--app-fg)]"
              />
              <div className="flex gap-2">
                <TouchButton
                  onAction={handleSave}
                  disabled={isPending || editValue.trim().length === 0}
                  data-testid={`system-job-edit-save-${job.name}`}
                  className="rounded-md bg-[var(--app-link)]/20 px-3 py-1 font-medium text-[var(--app-link)] disabled:opacity-50"
                >
                  Save
                </TouchButton>
                <TouchButton
                  onAction={() => {
                    setEditing(null);
                    setActionError(null);
                  }}
                  className="rounded-md px-3 py-1 font-medium text-[var(--app-hint)]"
                >
                  Cancel
                </TouchButton>
              </div>
            </div>
          )}

          {actionError && (
            <p
              data-testid={`system-job-error-${job.name}`}
              className="text-red-400"
            >
              {actionError}
            </p>
          )}
        </div>
      )}

      <ConfirmDialog
        isOpen={confirmDeleteOpen}
        onClose={() => setConfirmDeleteOpen(false)}
        title="Delete system job"
        description={`Delete "${job.name}" on ${nodeId}? This removes the systemd timer + service units.`}
        confirmLabel="Delete"
        confirmingLabel="Deleting..."
        isPending={isPending}
        destructive
        onConfirm={async () => {
          await runAction(() => deleteJob(nodeId, job.name));
          setConfirmDeleteOpen(false);
        }}
      />
    </div>
  );
}

/** ms-since-epoch formatter — `JobStatus.lastTickAt` is MILLISECONDS, NOT the
 *  systemd microseconds that `formatMicros` divides by 1000 (issue #1964). */
function formatMillis(ms: number | null): string {
  if (ms == null) return "—";
  return formatMessageTimestamp(new Date(ms));
}

/** Status → pill label + classes. `stalled`/`dead` render red; `stopped` neutral. */
function loopStatusPill(status: JobStatus["status"]): {
  label: string;
  cls: string;
} {
  switch (status) {
    case "ok":
      return {
        label: "OK",
        cls: "bg-[var(--app-link)]/15 text-[var(--app-link)]",
      };
    case "stalled":
      return { label: "Stalled", cls: "bg-red-500/15 text-red-400" };
    case "dead":
      return { label: "Dead", cls: "bg-red-500/15 text-red-400" };
    case "stopped":
      return {
        label: "Stopped",
        cls: "bg-[var(--app-hint)]/15 text-[var(--app-hint)]",
      };
  }
}

/**
 * InProcessLoopCard — one supervised in-process loop's read-only card
 * (issue #1964, Sub-Issue D). Sourced from Sub-Issue C's (#1963) runtime job
 * registry. Read-only by design (R4): in-process loops are NOT systemctl-driven,
 * so there are no enable/disable/reschedule controls — only live status,
 * last-tick (ms), interval, and last-error.
 */
export function InProcessLoopCard({ loop }: { loop: JobStatus }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const pill = loopStatusPill(loop.status);

  return (
    <div
      data-testid={`in-process-loop-card-${loop.name}`}
      className="rounded-md border border-[var(--app-secondary-bg)] bg-[var(--app-secondary-bg)]/40"
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <IconExpandToggle
          expanded={isExpanded}
          onToggle={() => setIsExpanded(v => !v)}
          aria-label={isExpanded ? "Collapse" : "Expand"}
          data-testid={`in-process-loop-expand-${loop.name}`}
        />

        <span className="min-w-0 flex-1 truncate text-[length:var(--text-label-strong)] font-medium text-[var(--app-fg)]">
          {loop.name}
        </span>

        <span className="flex-shrink-0 text-[length:var(--text-caption)] text-[var(--app-hint)]">
          loop
        </span>

        <span
          data-testid={`in-process-loop-status-${loop.name}`}
          className={`flex-shrink-0 rounded-full px-2 py-0.5 text-[length:var(--text-caption)] font-medium ${pill.cls}`}
        >
          {pill.label}
        </span>
      </div>

      {isExpanded && (
        <div className="flex flex-col gap-1 border-t border-[var(--app-secondary-bg)] px-3 py-2 text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
          <Detail label="Node" value={loop.node} mono />
          <Detail label="Interval" value={`${loop.intervalMs} ms`} mono />
          <Detail label="Last tick" value={formatMillis(loop.lastTickAt)} />
          {loop.lastError && (
            <p
              data-testid={`in-process-loop-error-${loop.name}`}
              className="break-all text-red-400"
            >
              Last error: {loop.lastError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * OsCronCard — one read-only OS-cron row (#1964 PR3). Discovery only: no
 * controls and no status pill (crons are OS-scheduled, not stall-detected).
 */
export function OsCronCard({ cron }: { cron: OsCronRow }) {
  const [isExpanded, setIsExpanded] = useState(false);
  return (
    <div
      data-testid={`os-cron-card-${cron.command}`}
      className="rounded-md border border-[var(--app-secondary-bg)] bg-[var(--app-secondary-bg)]/40"
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <IconExpandToggle
          expanded={isExpanded}
          onToggle={() => setIsExpanded(v => !v)}
          aria-label={isExpanded ? "Collapse" : "Expand"}
        />
        <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--text-body)] text-[var(--app-fg)]">
          {cron.command}
        </span>
        <span className="flex-shrink-0 text-[length:var(--text-caption)] text-[var(--app-hint)]">
          cron
        </span>
        <span className="flex-shrink-0 rounded-full bg-[var(--app-hint)]/15 px-2 py-0.5 font-mono text-[length:var(--text-caption)] text-[var(--app-hint)]">
          {cron.schedule}
        </span>
      </div>
      {isExpanded && (
        <div className="flex flex-col gap-1 border-t border-[var(--app-secondary-bg)] px-3 py-2 text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
          <Detail label="Schedule" value={cron.schedule} mono />
          <Detail label="Command" value={cron.command} mono />
        </div>
      )}
    </div>
  );
}

function Detail({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex gap-2">
      <span className="flex-shrink-0 text-[var(--app-hint)]">{label}:</span>
      <span
        className={`min-w-0 break-all text-[var(--app-fg)] ${
          mono ? "font-mono" : ""
        }`}
      >
        {value}
      </span>
    </div>
  );
}
