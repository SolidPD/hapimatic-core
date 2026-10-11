// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";
import { Download, Undo2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/Spinner";
import { useAppContext } from "@/lib/app-context";
import { ApiError } from "@/api/client";
import {
  useUpdateHarness,
  useRollbackHarness,
} from "@/hooks/mutations/useApplyHarnessUpdate";
import type {
  RedactedHarnessDescriptor,
  HarnessDetectionState,
} from "@/types/harnessUpdates";

/**
 * Update + Rollback actions for one harness (issue #1774, Sub-Issue E of epic
 * #1769). Renders "Update" (when an update is available) and "Roll back" (when a
 * prior version was captured), EACH behind a confirmation dialog (R1/R5):
 *
 *   - Update dialog states the version delta (installed → latest) and the
 *     eventual-consistency caveat (node-global install affects ALL sessions;
 *     in-flight sessions keep the old version), plus — when NO impact review
 *     exists for the range — a "no impact review run — proceed anyway?" nudge.
 *   - Rollback dialog states the restore delta (installed → prior) and the same
 *     caveat.
 *
 * The privileged command NEVER reaches this component: the mutations POST only
 * `{version}` / `{}` and the server resolves the command from the code-defined
 * registry (R11). Rendered by the page section BELOW the card (the card stays
 * presentational + untouched, minimizing #1775 Sub-F's follow-on rebase).
 */
export function HarnessUpdateActions({
  descriptor,
  state,
  hasImpactReview,
}: {
  descriptor: RedactedHarnessDescriptor;
  state: HarnessDetectionState | null;
  /** True when an impact-analysis artifact is READY for the pending range — when
   *  false, the update dialog shows the "no impact review run" nudge (R1). */
  hasImpactReview: boolean;
}) {
  const { api } = useAppContext();
  const { updateHarness, isPending: updating } = useUpdateHarness(api);
  const { rollbackHarness, isPending: rollingBack } = useRollbackHarness(api);

  const [dialog, setDialog] = useState<null | "update" | "rollback">(null);
  const [error, setError] = useState<string | null>(null);

  // Clear any prior error whenever a dialog (re)opens.
  useEffect(() => {
    if (dialog) setError(null);
  }, [dialog]);

  const installed = state?.installed_version ?? "unknown";
  const latest = state?.latest_version ?? null;
  const prior = state?.prior_version ?? null;
  const updateAvailable = state?.update_available === true && latest != null;
  const busy = updating || rollingBack;

  // Nothing to offer: no pending update and no captured rollback point.
  if (!updateAvailable && !prior) return null;

  const runUpdate = async () => {
    if (!latest) return;
    setError(null);
    try {
      await updateHarness({ harnessId: descriptor.id, version: latest });
      setDialog(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const runRollback = async () => {
    if (!prior) return;
    setError(null);
    try {
      await rollbackHarness({ harnessId: descriptor.id });
      setDialog(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <>
      <div
        className="flex flex-wrap items-center gap-2"
        data-testid={`harness-actions-${descriptor.id}`}
      >
        {updateAvailable && (
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={() => setDialog("update")}
            disabled={busy}
            data-testid={`harness-update-${descriptor.id}`}
          >
            <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            Update
          </Button>
        )}
        {prior && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setDialog("rollback")}
            disabled={busy}
            data-testid={`harness-rollback-${descriptor.id}`}
          >
            <Undo2 className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            Roll back to {prior}
          </Button>
        )}
      </div>

      {/* Update confirmation (R1) */}
      <Dialog
        open={dialog === "update"}
        onOpenChange={open => !open && !busy && setDialog(null)}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Update {descriptor.display_name}?</DialogTitle>
            <DialogDescription className="mt-2">
              This installs{" "}
              <strong className="text-[var(--app-fg)]">
                {installed} → {latest}
              </strong>{" "}
              on this node. It is a node-global install: it affects ALL sessions
              on this node, and any in-flight session keeps the old version
              until it exits (eventual consistency).
            </DialogDescription>
          </DialogHeader>

          {!hasImpactReview && (
            <div
              data-testid={`harness-update-no-review-nudge-${descriptor.id}`}
              className="mt-3 rounded-md bg-[var(--app-secondary-bg)]/40 p-3 text-[length:var(--text-body)] text-[var(--app-badge-warning-text)]"
            >
              No impact review has been run for this version. Consider running
              &ldquo;Review impact&rdquo; first — proceed anyway?
            </div>
          )}

          {error && (
            <div className="mt-3 rounded-md bg-red-900/20 p-3 text-sm text-red-400">
              {error}
            </div>
          )}

          <div className="mt-4 flex flex-col gap-2">
            <Button
              type="button"
              variant="default"
              onClick={() => void runUpdate()}
              disabled={busy}
              data-testid={`harness-update-confirm-${descriptor.id}`}
            >
              {updating ? (
                <span className="inline-flex items-center gap-1.5">
                  <Spinner size="sm" label={null} className="!text-inherit" />
                  Updating…
                </span>
              ) : (
                `Update to ${latest}`
              )}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setDialog(null)}
              disabled={busy}
            >
              Cancel
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Rollback confirmation (R5) */}
      <Dialog
        open={dialog === "rollback"}
        onOpenChange={open => !open && !busy && setDialog(null)}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Roll back {descriptor.display_name}?</DialogTitle>
            <DialogDescription className="mt-2">
              This restores{" "}
              <strong className="text-[var(--app-fg)]">
                {installed} → {prior}
              </strong>{" "}
              (the captured prior version) on this node. Like an update, it is a
              node-global install and any in-flight session keeps its current
              version until it exits.
            </DialogDescription>
          </DialogHeader>

          {error && (
            <div className="mt-3 rounded-md bg-red-900/20 p-3 text-sm text-red-400">
              {error}
            </div>
          )}

          <div className="mt-4 flex flex-col gap-2">
            <Button
              type="button"
              variant="destructive"
              onClick={() => void runRollback()}
              disabled={busy}
              data-testid={`harness-rollback-confirm-${descriptor.id}`}
            >
              {rollingBack ? (
                <span className="inline-flex items-center gap-1.5">
                  <Spinner size="sm" label={null} className="!text-inherit" />
                  Rolling back…
                </span>
              ) : (
                `Roll back to ${prior}`
              )}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setDialog(null)}
              disabled={busy}
            >
              Cancel
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Prefer the server's clean `error` message (from the thrown ApiError's body)
 *  over the raw `HTTP N …: {json}` message string (R11-safe — the server body
 *  never carries the command). */
function errorMessage(err: unknown): string {
  if (err instanceof ApiError && err.body) {
    try {
      const parsed = JSON.parse(err.body) as { error?: string };
      if (parsed.error) return parsed.error;
    } catch {
      // fall through to the Error message
    }
  }
  if (err instanceof Error) return err.message;
  return "The action failed. Please try again.";
}
