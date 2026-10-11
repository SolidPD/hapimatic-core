// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Play, Pencil, Trash2, ExternalLink } from "lucide-react";
import { LOCAL_NODE_ID } from "@hapi/protocol";
import { useAppContext } from "@/lib/app-context";
import { useSessionLoopSummaries } from "@/hooks/queries/useSessionLoopSummaries";
import { useLoopCronActions } from "@/hooks/mutations/useLoopCronActions";
import type {
  LoopCronState,
  LoopCronVerdict,
  SessionLoopSummaryRow,
} from "@/types/systemJobs";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { StatusDot, type StatusDotVariant } from "@/components/ui/StatusDot";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { formatFireRelative, formatFireTime } from "@/lib/loopCronTime";

/** loop-cron state → StatusDot variant (mint/amber/red). */
function dotFor(state: LoopCronState): StatusDotVariant {
  return state === "live" ? "ok" : state === "paused" ? "warn" : "hot";
}

/** Per-loop transient feedback tone. */
type FeedbackTone = "ok" | "warn" | "err";
type LoopFeedback = { tone: FeedbackTone; text: string };

/**
 * Compact, HONEST Run-now verdict → feedback (issue #3291, R3). Mirrors
 * `LoopCronCard`'s `verdictDisplay` intent: a failed send / auth error / skip is
 * NEVER dressed as success — only `sent`/`done` read as `ok`.
 */
function runVerdictFeedback(v: LoopCronVerdict): LoopFeedback {
  if (v === "sent") return { tone: "ok", text: "Tick sent" };
  if (v === "done") return { tone: "ok", text: "Done — loop self-terminated" };
  if (v === "send-failed") return { tone: "err", text: "Send failed" };
  if (v.startsWith("skipped:")) {
    return { tone: "warn", text: `Skipped — ${v.slice("skipped:".length)}` };
  }
  if (v.startsWith("error:")) {
    return { tone: "err", text: `Error — ${v.slice("error:".length)}` };
  }
  return { tone: "warn", text: "Unknown outcome" };
}

const TONE_CLASS: Record<FeedbackTone, string> = {
  ok: "text-[var(--app-badge-success-text)]",
  warn: "text-[var(--app-badge-warning-text)]",
  err: "text-[var(--app-badge-error-text)]",
};

/**
 * LoopCronModal — the modal opened from the always-shown Loop-Cron Badge
 * (issue #3291, S6 of the Session-UI Redesign epic #3285). Replaces the badge's
 * former dropdown (#3287 deliberately kept the click TARGET intact for this swap).
 *
 * Surface (operator ruling, epic round 10, 2026-09-07): the app's standard
 * CENTERED modal (`DialogContent`) — the same chrome as every other modal. S6
 * shipped it as a bottom sheet because the E5/E6 mockups drew it that way and
 * the taxonomy carried that as an UNRATIFIED "open flag" (bottom sheet vs
 * popover) that the S6 directive then hard-coded as R1; the operator never
 * chose the sheet, and it was the only bottom-anchored surface in the app.
 *
 * Lists the session's own-instance loop-crons (data from `useSessionLoopSummaries`,
 * the same query the badge reads). Per loop, ONE row of four controls — an
 * icon/toggle with its text label directly beneath (R3/R5, never a second row):
 * **Run Now** (`runNow`) · **Enable/Disable** (a single toggle → `resume` when
 * disabled, `pause` when enabled) · **Edit** (deep-links to the loop's card in
 * System Jobs — the surface #3293/#3294 enhance) · **Delete** (red trash → a
 * confirmation dialog that names the loop and states the irreversible purge
 * semantics before calling `delete`, R4).
 *
 * The heading carries an "Open in System Jobs" deep link, pre-filtered to this
 * session's Loop-Crons via `?session=` + the new transient `?kind=` override
 * (R2, Task 4). Every `useLoopCronActions` verb is `(nodeId, id)`; the summary is
 * own-instance-only by construction (`useSessionLoopSummaries` queries only
 * `LOCAL_NODE_ID`) and `SessionLoopSummaryRow` carries no nodeId — so all four
 * verbs pass `LOCAL_NODE_ID`.
 */
export function LoopCronModal({
  sessionId,
  open,
  onOpenChange,
}: {
  sessionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { api } = useAppContext();
  const navigate = useNavigate();
  const { bySession } = useSessionLoopSummaries(api);
  const actions = useLoopCronActions(api);

  const summary = bySession.get(sessionId);
  const loops = summary?.loops ?? [];
  // Render-time "now" for the next-fire relative hint (no ticking timer — the
  // summary itself re-polls every 30 s, which re-renders this).
  const now = Date.now();

  // The row whose Delete was tapped (drives the confirmation dialog), or null.
  const [pendingDelete, setPendingDelete] =
    useState<SessionLoopSummaryRow | null>(null);
  // Per-loop transient feedback (Run-now verdict / action error), keyed by id.
  const [feedback, setFeedback] = useState<Record<string, LoopFeedback>>({});

  // Clear transient state when the modal closes so a reopen starts clean.
  useEffect(() => {
    if (!open) {
      setFeedback({});
      setPendingDelete(null);
    }
  }, [open]);

  const setLoopFeedback = (id: string, fb: LoopFeedback) =>
    setFeedback(prev => ({ ...prev, [id]: fb }));

  const handleRunNow = async (row: SessionLoopSummaryRow) => {
    try {
      const verdict = await actions.runNow(LOCAL_NODE_ID, row.id);
      setLoopFeedback(row.id, runVerdictFeedback(verdict));
    } catch (e) {
      setLoopFeedback(row.id, {
        tone: "err",
        text: e instanceof Error ? e.message : "Run failed",
      });
    }
  };

  const handleToggle = async (row: SessionLoopSummaryRow) => {
    const enabled = row.state !== "paused";
    try {
      if (enabled) await actions.pause(LOCAL_NODE_ID, row.id);
      else await actions.resume(LOCAL_NODE_ID, row.id);
    } catch (e) {
      setLoopFeedback(row.id, {
        tone: "err",
        text: e instanceof Error ? e.message : "Toggle failed",
      });
    }
  };

  const handleEdit = (row: SessionLoopSummaryRow) =>
    void navigate({
      to: "/settings/system-jobs",
      search: { highlight: row.id },
    });

  const handleDelete = async () => {
    if (!pendingDelete) return;
    await actions.delete(LOCAL_NODE_ID, pendingDelete.id);
    setPendingDelete(null);
  };

  const openSystemJobs = () =>
    void navigate({
      to: "/settings/system-jobs",
      search: { session: sessionId, kind: "loop-cron" },
    });

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          data-testid={`loop-cron-modal-${sessionId}`}
          description="Loop-crons owned by this session, with per-loop controls"
          className="flex flex-col overflow-hidden p-0"
          style={{ maxHeight: "85vh" }}
        >
          {/* Header — `pr-12` clears the primitive's absolute close button. */}
          <div className="flex items-center gap-2 border-b border-[var(--app-border)] px-4 py-3 pr-12">
            <DialogTitle className="text-[length:var(--text-body)] font-semibold leading-tight tracking-normal text-[var(--app-fg)]">
              Loop-Crons{" "}
              <span className="text-[length:var(--text-caption)] font-medium text-[var(--app-hint)]">
                · this session
              </span>
            </DialogTitle>
          </div>

          {/* Body: the loop rows (or the empty state) + the control legend. */}
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {loops.length === 0 ? (
              <p
                data-testid={`loop-cron-modal-empty-${sessionId}`}
                className="px-1 py-6 text-center text-[length:var(--text-body-dense)] text-[var(--app-hint)]"
              >
                This session has no loop-crons.
              </p>
            ) : (
              <div className="flex flex-col gap-2 py-1">
                {loops.map(loop => {
                  const enabled = loop.state !== "paused";
                  const fb = feedback[loop.id];
                  return (
                    <div
                      key={loop.id}
                      data-testid={`loop-cron-modal-row-${loop.id}`}
                      className="rounded-md border border-[var(--app-secondary-bg)] bg-[var(--app-secondary-bg)]/40 px-3 py-2.5"
                    >
                      {/* Name + schedule. */}
                      <div className="flex items-center gap-2">
                        <StatusDot
                          status={dotFor(loop.state)}
                          className="flex-shrink-0"
                        />
                        <span className="min-w-0 flex-1 truncate text-[length:var(--text-label-strong)] font-medium text-[var(--app-fg)]">
                          {loop.label}
                        </span>
                        <span className="flex-shrink-0 truncate text-[length:var(--text-caption)] text-[var(--app-hint)]">
                          {loop.scheduleHuman}
                        </span>
                      </div>

                      {/* Epic #3285 round 15: the ABSOLUTE next firing, right in
                          the modal — the operator should not have to open System
                          Jobs to learn when the loop fires next. Same formatters
                          as the System Jobs card (lib/loopCronTime). A paused
                          loop has no next fire → "—". */}
                      <p
                        data-testid={`loop-cron-modal-next-${loop.id}`}
                        className="mt-1 pl-4 text-[length:var(--text-caption)] text-[var(--app-hint)]"
                      >
                        Next fire{" "}
                        <span className="font-medium text-[var(--app-fg)]">
                          {formatFireTime(loop.nextFireAtMs)}
                        </span>
                        {loop.nextFireAtMs != null && (
                          <> · {formatFireRelative(loop.nextFireAtMs, now)}</>
                        )}
                      </p>

                      {/* Four controls — ONE row, label beneath (R3/R5). */}
                      <div
                        data-testid={`loop-cron-modal-controls-${loop.id}`}
                        className="mt-2.5 flex gap-1.5"
                      >
                        {/* Run Now */}
                        <div className="flex flex-1 flex-col items-center gap-1.5">
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => void handleRunNow(loop)}
                            disabled={actions.isPending}
                            aria-label={`Run ${loop.label} now`}
                            data-testid={`loop-cron-modal-run-${loop.id}`}
                            className="h-9 w-full rounded-lg px-0 text-[var(--app-badge-success-text)]"
                          >
                            <Play className="h-4 w-4 fill-current" />
                          </Button>
                          <span className="text-[length:var(--text-caption-xs)] font-semibold text-[var(--app-hint)]">
                            Run Now
                          </span>
                        </div>

                        {/* Enable / Disable — a single toggle. */}
                        <div className="flex flex-1 flex-col items-center gap-1.5">
                          <Button
                            type="button"
                            variant="outline"
                            role="switch"
                            aria-checked={enabled}
                            onClick={() => void handleToggle(loop)}
                            disabled={actions.isPending}
                            aria-label={
                              enabled
                                ? `Disable ${loop.label}`
                                : `Enable ${loop.label}`
                            }
                            data-testid={`loop-cron-modal-toggle-${loop.id}`}
                            className="h-9 w-full rounded-lg px-0"
                          >
                            <span
                              className={`relative h-4 w-7 flex-shrink-0 rounded-full transition-colors ${
                                enabled
                                  ? "bg-[var(--app-badge-success-text)]/70"
                                  : "bg-[var(--app-hint)]/30"
                              }`}
                            >
                              <span
                                className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform ${
                                  enabled
                                    ? "left-0.5 translate-x-3"
                                    : "left-0.5"
                                }`}
                              />
                            </span>
                          </Button>
                          <span
                            className={`text-[length:var(--text-caption-xs)] font-semibold ${
                              enabled
                                ? "text-[var(--app-badge-success-text)]"
                                : "text-[var(--app-hint)]"
                            }`}
                          >
                            {enabled ? "Enabled" : "Disabled"}
                          </span>
                        </div>

                        {/* Edit — deep-links to the loop's card in System Jobs. */}
                        <div className="flex flex-1 flex-col items-center gap-1.5">
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => handleEdit(loop)}
                            aria-label={`Edit ${loop.label} in System Jobs`}
                            data-testid={`loop-cron-modal-edit-${loop.id}`}
                            className="h-9 w-full rounded-lg px-0 text-[var(--app-fg)]"
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <span className="text-[length:var(--text-caption-xs)] font-semibold text-[var(--app-hint)]">
                            Edit
                          </span>
                        </div>

                        {/* Delete — confirmation-gated purge (R4). */}
                        <div className="flex flex-1 flex-col items-center gap-1.5">
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => setPendingDelete(loop)}
                            disabled={actions.isPending}
                            aria-label={`Delete ${loop.label}`}
                            data-testid={`loop-cron-modal-delete-${loop.id}`}
                            className="h-9 w-full rounded-lg border-[var(--app-badge-error-text)]/30 bg-[var(--app-badge-error-text)]/10 px-0 text-[var(--app-badge-error-text)]"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                          <span className="text-[length:var(--text-caption-xs)] font-semibold text-[var(--app-badge-error-text)]">
                            Delete
                          </span>
                        </div>
                      </div>

                      {/* Transient feedback — honest Run-now verdict / error. */}
                      {fb && (
                        <p
                          data-testid={`loop-cron-modal-feedback-${loop.id}`}
                          className={`mt-2 text-[length:var(--text-caption)] ${TONE_CLASS[fb.tone]}`}
                        >
                          {fb.text}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Control legend (matches the E6 mockup's `.lchelp`). */}
            <p className="px-1 pb-1 pt-1 text-center text-[length:var(--text-caption-xs)] leading-relaxed text-[var(--app-hint)]">
              <b className="text-[var(--app-fg)]">Run Now</b> fires one run now
              · <b className="text-[var(--app-fg)]">Enable/Disable</b> pauses or
              resumes the schedule ·{" "}
              <b className="text-[var(--app-fg)]">Edit</b> opens it in System
              Jobs · <b className="text-[var(--app-fg)]">Delete</b> purges it
              (with confirmation)
            </p>
          </div>

          {/* Footer: the System Jobs deep link, pre-filtered to this session's
              Loop-Crons (R2). */}
          <div className="flex items-center justify-end border-t border-[var(--app-border)] px-4 py-3">
            <Button
              type="button"
              variant="ghostStatic"
              size="bare"
              onClick={openSystemJobs}
              data-testid={`loop-cron-modal-open-system-jobs-${sessionId}`}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--app-badge-success-text)]/25 bg-[var(--app-badge-success-text)]/10 px-2.5 py-1.5 text-[length:var(--text-caption)] font-semibold text-[var(--app-badge-success-text)]"
            >
              Open in System Jobs
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation (R4) — names the loop AND states the real purge
          semantics (crontab line + config/action/tick-log state, irreversible).
          Copy reused from `LoopCronCard`'s delete confirm, NOT the softer
          "removes it from System Jobs" framing. */}
      <ConfirmDialog
        isOpen={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title="Delete loop?"
        description={
          pendingDelete
            ? `This purges "${pendingDelete.label}" — it removes the crontab line AND permanently deletes its state (config, action, tick log). This cannot be undone.`
            : ""
        }
        confirmLabel="Delete"
        confirmingLabel="Deleting…"
        isPending={actions.isPending}
        destructive
        onConfirm={handleDelete}
      />
    </>
  );
}
