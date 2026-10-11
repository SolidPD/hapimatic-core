// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Play, Pencil, Trash2, ArrowRight } from "lucide-react";
import type {
  LoopCronInfo,
  LoopCronState,
  LoopCronVerdict,
} from "@/types/systemJobs";
import { useAppContext } from "@/lib/app-context";
import { useLoopCronActions } from "@/hooks/mutations/useLoopCronActions";
import { StatusDot, type StatusDotVariant } from "@/components/ui/StatusDot";
import { KVGrid } from "@/components/ui/KVGrid";
import { CollapsibleSection } from "@/components/ui/CollapsibleSection";
import { IconExpandToggle } from "@/components/ui/IconExpandToggle";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { TouchButton } from "@/components/ui/TouchButton";
import { formatFireRelative, formatFireTime } from "@/lib/loopCronTime";
import { IntervalSelector } from "./IntervalSelector";
import { parseInterval } from "./loopCronInterval";

// Epic #3285 round 15: the fire-time formatters moved to `lib/loopCronTime.ts`
// so the per-session LoopCronModal prints the next firing exactly as this card.

/**
 * loop-cron state → pill (issue #2453). Uses the StatusDot token triad
 * (`--app-badge-{success,warning,error}-text`), NOT the shared-protocol
 * `loopStatusPill` (which is typed over `JobStatus["status"]` and must not be
 * widened). mint=live, amber=paused, red=stalled/orphaned.
 */
function loopCronStatePill(
  state: LoopCronState,
  orphaned: boolean
): { label: string; dot: StatusDotVariant; cls: string } {
  if (orphaned) {
    return {
      label: "Orphaned",
      dot: "hot",
      cls: "bg-[var(--app-badge-error-text)]/15 text-[var(--app-badge-error-text)]",
    };
  }
  switch (state) {
    case "live":
      return {
        label: "Live",
        dot: "ok",
        cls: "bg-[var(--app-badge-success-text)]/15 text-[var(--app-badge-success-text)]",
      };
    case "paused":
      return {
        label: "Paused",
        dot: "warn",
        cls: "bg-[var(--app-badge-warning-text)]/15 text-[var(--app-badge-warning-text)]",
      };
    case "stalled":
      return {
        label: "Stalled",
        dot: "hot",
        cls: "bg-[var(--app-badge-error-text)]/15 text-[var(--app-badge-error-text)]",
      };
  }
}

/** R4 verdict → human label + tone. Honest — an error/skip is never dressed as success. */
function verdictDisplay(v: LoopCronVerdict): { label: string; tone: string } {
  const err = "text-[var(--app-badge-error-text)]";
  const warn = "text-[var(--app-badge-warning-text)]";
  const ok = "text-[var(--app-badge-success-text)]";
  switch (v) {
    case "sent":
      return { label: "Tick sent", tone: ok };
    case "send-failed":
      return { label: "Send failed", tone: err };
    case "skipped:paused":
      return { label: "Skipped — paused", tone: warn };
    case "skipped:gate":
      return { label: "Skipped — gate no-op", tone: warn };
    case "skipped:backoff":
      return { label: "Skipped — user backoff", tone: warn };
    case "skipped:concurrent":
      return { label: "Skipped — prior tick running", tone: warn };
    case "done":
      return { label: "Done — loop self-terminated", tone: ok };
    case "error:token":
      return { label: "Error — token unreadable", tone: err };
    case "error:auth":
      return { label: "Error — auth failed", tone: err };
    case "error:session-state":
      return { label: "Error — session unreadable", tone: err };
    case "error:action-empty":
      return { label: "Error — action.txt empty", tone: err };
    case "unknown":
      return { label: "Unknown outcome", tone: warn };
  }
}

/**
 * LoopCronCard — one `loop-cron.sh` recurring session prompt's card
 * (issue #2453, Task 9). Node-scoped: `nodeId` threads every mutation to this
 * loop's owning node. Renders the approved anatomy — status dot + label +
 * LOOP-CRON kind chip + instance chip + state pill + Enabled toggle + stats grid
 * + bound-session row (Open session →) + read-only Action accordion with
 * provenance + honest run history + footer (Run now · Edit schedule · Delete).
 *
 * `orphaned` (bound session gone, computed by the panel) collapses the card to a
 * red Delete-only variant (R6). `highlighted` serves Task 10's `?highlight=` deep
 * link. Styling uses ONLY the StatusDot token triad — mint/amber/red — never the
 * `--app-link`/`red-400` of the older pills.
 */
export function LoopCronCard({
  loop,
  nodeId,
  highlighted = false,
  orphaned = false,
}: {
  loop: LoopCronInfo;
  nodeId: string;
  highlighted?: boolean;
  orphaned?: boolean;
}) {
  const { api } = useAppContext();
  const navigate = useNavigate();
  const actions = useLoopCronActions(api);

  const cardRef = useRef<HTMLDivElement>(null);
  const [isExpanded, setIsExpanded] = useState(highlighted);
  const [actionError, setActionError] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<LoopCronVerdict | null>(null);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState(false);
  const [intervalValue, setIntervalValue] = useState(loop.intervalHuman ?? "");
  const [confirmRescheduleOpen, setConfirmRescheduleOpen] = useState(false);
  // #3293: editable Action/Prompt state (mirrors the schedule-edit machine).
  const [editingAction, setEditingAction] = useState(false);
  const [actionValue, setActionValue] = useState(loop.action ?? "");
  const [confirmActionOpen, setConfirmActionOpen] = useState(false);

  // The `?highlight=` deep link (#2453) already marks + auto-expands this card,
  // but the page stayed scrolled at the top so the target job was left off-screen
  // — the user had to hunt for it. Scroll the highlighted card into view (centred,
  // so the surrounding jobs stay visible for context) once it mounts or becomes
  // the highlight target. Matches the codebase's deep-link-scroll pattern
  // (Autocomplete.tsx / LinkIssueField.tsx).
  useEffect(() => {
    if (highlighted) {
      cardRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [highlighted]);

  const now = Date.now();
  const pill = loopCronStatePill(loop.state, orphaned);

  /** Run a mutation, capturing any error into the inline error row. */
  const runAction = async <T,>(
    fn: () => Promise<T>
  ): Promise<T | undefined> => {
    setActionError(null);
    try {
      return await fn();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Action failed");
      return undefined;
    }
  };

  const handleToggle = () =>
    runAction(() =>
      loop.paused
        ? actions.resume(nodeId, loop.id)
        : actions.pause(nodeId, loop.id)
    );

  const handleRunNow = () =>
    runAction(async () => {
      setVerdict(null);
      const v = await actions.runNow(nodeId, loop.id);
      setVerdict(v);
    });

  const handleReschedule = () =>
    runAction(async () => {
      await actions.reschedule(nodeId, loop.id, intervalValue.trim());
      setEditingSchedule(false);
      setConfirmRescheduleOpen(false);
    });

  const handleUpdateAction = () =>
    runAction(async () => {
      await actions.updateAction(nodeId, loop.id, actionValue);
      setEditingAction(false);
      setConfirmActionOpen(false);
    });

  const handleDelete = () =>
    runAction(async () => {
      await actions.delete(nodeId, loop.id);
      setConfirmDeleteOpen(false);
    });

  const stats = [
    { key: "Schedule", value: loop.intervalHuman ?? loop.intervalCron ?? "—" },
    {
      key: "Next fire",
      value: `${formatFireTime(loop.nextFireAtMs)} (${formatFireRelative(loop.nextFireAtMs, now)})`,
    },
    {
      key: "Last tick",
      value: formatFireTime(loop.newestTickLogAtMs ?? loop.lastTickAtMs),
    },
    { key: "Ticks", value: loop.ticks == null ? "—" : String(loop.ticks) },
    {
      key: "Gate no-op streak",
      value:
        loop.consecutiveNoops == null ? "—" : String(loop.consecutiveNoops),
    },
    { key: "Backoff window", value: `${loop.effectiveBackoffS}s` },
  ];

  return (
    <div
      ref={cardRef}
      data-testid={`loop-cron-card-${loop.id}`}
      data-highlighted={highlighted || undefined}
      className={`rounded-md border bg-[var(--app-secondary-bg)]/40 ${
        highlighted
          ? "border-[var(--app-badge-success-text)] ring-1 ring-[var(--app-badge-success-text)]"
          : orphaned
            ? "border-[var(--app-badge-error-text)]/50"
            : "border-[var(--app-secondary-bg)]"
      }`}
    >
      {/* Header row */}
      <div className="flex items-center gap-2 px-3 py-2">
        <IconExpandToggle
          expanded={isExpanded}
          onToggle={() => setIsExpanded(v => !v)}
          aria-label={isExpanded ? "Collapse" : "Expand"}
          data-testid={`loop-cron-expand-${loop.id}`}
        />

        <StatusDot status={pill.dot} className="flex-shrink-0" />

        <span className="min-w-0 flex-1 truncate text-[length:var(--text-label-strong)] font-medium text-[var(--app-fg)]">
          {loop.label}
        </span>

        {/* LOOP-CRON kind chip */}
        <span className="flex-shrink-0 rounded-full bg-[var(--app-hint)]/15 px-2 py-0.5 text-[length:var(--text-caption-xs)] font-medium uppercase tracking-wide text-[var(--app-hint)]">
          loop-cron
        </span>

        {/* Instance chip */}
        <span
          className="hidden flex-shrink-0 rounded-full bg-[var(--app-hint)]/10 px-2 py-0.5 text-[length:var(--text-caption-xs)] text-[var(--app-hint)] sm:inline"
          title={loop.apiBase ?? undefined}
        >
          {loop.instanceLabel}
        </span>

        {/* State pill */}
        <span
          data-testid={`loop-cron-state-${loop.id}`}
          className={`flex-shrink-0 rounded-full px-2 py-0.5 text-[length:var(--text-caption)] font-medium ${pill.cls}`}
        >
          {pill.label}
        </span>
      </div>

      {isExpanded && (
        <div className="flex flex-col gap-3 border-t border-[var(--app-secondary-bg)] px-3 py-3">
          {loop.degraded && !orphaned && (
            <p
              data-testid={`loop-cron-degraded-${loop.id}`}
              className="text-[length:var(--text-body-dense)] text-[var(--app-badge-warning-text)]"
            >
              ⚠ Degraded — the last send failed (last_status: {loop.lastStatus}
              ).
            </p>
          )}

          {!orphaned && (
            <>
              {/* Enabled toggle (off → pause, on → resume) */}
              <div className="flex items-center justify-between">
                <span className="text-[length:var(--text-body)] text-[var(--app-fg)]">
                  Enabled
                </span>
                <button /* design-tokens-allow: bespoke role="switch" toggle (sliding-knob widget with per-state track fill) — no Switch primitive exists in the design system to adopt; a <Button> box would break the switch UI */
                  type="button"
                  role="switch"
                  aria-checked={!loop.paused}
                  disabled={actions.isPending}
                  onClick={handleToggle}
                  data-testid={`loop-cron-toggle-${loop.id}`}
                  className={`relative h-6 w-11 flex-shrink-0 rounded-full transition-colors disabled:opacity-50 ${
                    loop.paused
                      ? "bg-[var(--app-hint)]/30"
                      : "bg-[var(--app-badge-success-text)]/70"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
                      loop.paused ? "left-0.5" : "left-0.5 translate-x-5"
                    }`}
                  />
                </button>
              </div>

              {/* Stats grid */}
              <KVGrid items={stats} />

              {/* Bound-session row */}
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
                  Session: {loop.sessionTag ?? loop.sessionUuid ?? "—"}
                </span>
                {loop.sessionUuid && (
                  <button /* design-tokens-allow: bare-inline text link (colored text + inline arrow glyph, no box) — <Button>'s box model breaks the inline link; D2 bare-text-link exception precedent (#3358) */
                    type="button"
                    onClick={() =>
                      void navigate({
                        to: "/sessions/$sessionId",
                        params: { sessionId: loop.sessionUuid as string },
                      })
                    }
                    data-testid={`loop-cron-open-session-${loop.id}`}
                    className="flex flex-shrink-0 items-center gap-1 text-[length:var(--text-body-dense)] text-[var(--app-badge-success-text)]"
                  >
                    Open session <ArrowRight className="h-3 w-3" />
                  </button>
                )}
              </div>

              {/* Action accordion — editable action/prompt (#3293) + provenance */}
              <CollapsibleSection
                title="Action"
                data-testid={`loop-cron-action-${loop.id}`}
              >
                {editingAction ? (
                  <div className="flex flex-col gap-2">
                    <textarea
                      autoCapitalize="none"
                      value={actionValue}
                      onChange={e => setActionValue(e.target.value)}
                      rows={4}
                      placeholder="The prompt/command this loop sends each tick"
                      data-testid={`loop-cron-action-input-${loop.id}`}
                      className="min-h-[5rem] w-full resize-y rounded-md border border-[var(--app-secondary-bg)] bg-transparent px-2 py-1 text-[length:var(--text-body-dense)] text-[var(--app-fg)]"
                    />
                    <div className="flex items-center gap-2">
                      <TouchButton
                        onAction={() => setConfirmActionOpen(true)}
                        disabled={!actionValue.trim() || actions.isPending}
                        data-testid={`loop-cron-action-save-${loop.id}`}
                      >
                        Save
                      </TouchButton>
                      <TouchButton
                        onAction={() => setEditingAction(false)}
                        data-testid={`loop-cron-action-cancel-${loop.id}`}
                      >
                        Cancel
                      </TouchButton>
                    </div>
                  </div>
                ) : (
                  <>
                    <p className="whitespace-pre-wrap break-words text-[length:var(--text-body-dense)] text-[var(--app-fg)]">
                      {loop.action ?? "(no action text)"}
                    </p>
                    <div className="mt-1 flex items-center justify-between gap-2">
                      <span className="min-w-0 text-[length:var(--text-caption)] text-[var(--app-hint)]">
                        From ~/.claude/state/loop-cron/{loop.id}/action.txt
                      </span>
                      <TouchButton
                        onAction={() => {
                          setActionValue(loop.action ?? "");
                          setEditingAction(true);
                        }}
                        disabled={actions.isPending}
                        data-testid={`loop-cron-action-edit-${loop.id}`}
                      >
                        <Pencil className="mr-1 h-3 w-3" /> Edit
                      </TouchButton>
                    </div>
                  </>
                )}
              </CollapsibleSection>

              {/* Run history (honest verdicts) */}
              {loop.runHistory.length > 0 && (
                <CollapsibleSection
                  title={`Run history (${loop.runHistory.length})`}
                  data-testid={`loop-cron-history-${loop.id}`}
                >
                  <ul className="flex flex-col gap-1">
                    {loop.runHistory.map((entry, i) => {
                      const d = verdictDisplay(entry.verdict);
                      return (
                        <li
                          key={i}
                          className="flex items-center gap-2 text-[length:var(--text-body-dense)]"
                        >
                          <span className={`flex-shrink-0 ${d.tone}`}>
                            {d.label}
                          </span>
                          <span className="flex-shrink-0 text-[var(--app-hint)]">
                            {formatFireTime(entry.atMs)}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </CollapsibleSection>
              )}

              {/* Edit-schedule inline editor — #3294: a constrained interval
                  selector (numeric field + m/h dropdown) replaces the old
                  free-text field, so it cannot emit a value the backend grammar
                  `1-59m | 1-23h` rejects. */}
              {editingSchedule && (
                <div className="flex flex-col gap-2">
                  {parseInterval(intervalValue) === null &&
                    (loop.intervalCron || loop.intervalHuman) && (
                      <p
                        data-testid={`loop-cron-interval-degraded-${loop.id}`}
                        className="text-[length:var(--text-caption)] text-[var(--app-hint)]"
                      >
                        Current schedule{" "}
                        <span className="text-[var(--app-fg)]">
                          {loop.intervalCron ?? loop.intervalHuman}
                        </span>{" "}
                        isn&apos;t a simple interval — pick minutes or hours to
                        replace it.
                      </p>
                    )}
                  <div className="flex items-center gap-2">
                    <IntervalSelector
                      value={intervalValue}
                      onChange={setIntervalValue}
                      disabled={actions.isPending}
                      testIdPrefix={`loop-cron-interval-${loop.id}`}
                    />
                    <TouchButton
                      onAction={() => setConfirmRescheduleOpen(true)}
                      disabled={
                        parseInterval(intervalValue) === null ||
                        actions.isPending
                      }
                    >
                      Apply
                    </TouchButton>
                    <TouchButton onAction={() => setEditingSchedule(false)}>
                      Cancel
                    </TouchButton>
                  </div>
                </div>
              )}
            </>
          )}

          {/* Run-now verdict display (R4) */}
          {verdict && (
            <p
              data-testid={`loop-cron-verdict-${loop.id}`}
              className={`text-[length:var(--text-body-dense)] ${verdictDisplay(verdict).tone}`}
            >
              Run now: {verdictDisplay(verdict).label}
            </p>
          )}

          {actionError && (
            <p
              data-testid={`loop-cron-error-${loop.id}`}
              className="break-all text-[length:var(--text-body-dense)] text-[var(--app-badge-error-text)]"
            >
              {actionError}
            </p>
          )}

          {/* Footer actions */}
          <div className="flex flex-wrap items-center gap-2">
            {!orphaned && (
              <>
                <TouchButton
                  onAction={handleRunNow}
                  disabled={actions.isPending}
                  data-testid={`loop-cron-run-${loop.id}`}
                >
                  <Play className="mr-1 h-3 w-3" /> Run now
                </TouchButton>
                <TouchButton
                  onAction={() => setEditingSchedule(v => !v)}
                  disabled={actions.isPending}
                  data-testid={`loop-cron-edit-${loop.id}`}
                >
                  <Pencil className="mr-1 h-3 w-3" /> Edit schedule
                </TouchButton>
              </>
            )}
            <TouchButton
              onAction={() => setConfirmDeleteOpen(true)}
              disabled={actions.isPending}
              data-testid={`loop-cron-delete-${loop.id}`}
            >
              <Trash2 className="mr-1 h-3 w-3" /> Delete
            </TouchButton>
          </div>
        </div>
      )}

      <ConfirmDialog
        isOpen={confirmDeleteOpen}
        onClose={() => setConfirmDeleteOpen(false)}
        title="Delete loop?"
        description={`This purges "${loop.label}" — it removes the crontab line AND permanently deletes its state (config, action, tick log). This cannot be undone.`}
        confirmLabel="Delete"
        confirmingLabel="Deleting…"
        isPending={actions.isPending}
        destructive
        onConfirm={handleDelete}
      />

      <ConfirmDialog
        isOpen={confirmRescheduleOpen}
        onClose={() => setConfirmRescheduleOpen(false)}
        title="Change schedule?"
        description={`Re-schedule "${loop.label}" from ${loop.intervalHuman ?? "?"} to ${intervalValue.trim()}. This stops and re-arms the loop in place (the id, deep links, and tick history are preserved).`}
        confirmLabel="Change"
        confirmingLabel="Changing…"
        isPending={actions.isPending}
        onConfirm={handleReschedule}
      />

      <ConfirmDialog
        isOpen={confirmActionOpen}
        onClose={() => setConfirmActionOpen(false)}
        title="Change action?"
        description={`Update what "${loop.label}" runs on each tick. The new action text takes effect on the next scheduled tick (the schedule is unchanged).`}
        confirmLabel="Change"
        confirmingLabel="Changing…"
        isPending={actions.isPending}
        onConfirm={handleUpdateAction}
      />
    </div>
  );
}
