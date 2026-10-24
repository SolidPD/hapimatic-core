// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ApiClient } from "@/api/client";
import { useVmJobActions } from "@/hooks/mutations/useVmJobActions";
import { Button } from "@/components/ui/button";

/**
 * DeprovisionDialog — the two-step teardown confirm (issue #2470 R5).
 *
 * Built on the `@/components/ui/dialog` primitives rather than `ConfirmDialog`
 * because the flow needs a body slot (the dry-run transcript), a text input, and
 * an Apply button whose disabled state is externally driven — none of which
 * `ConfirmDialog` exposes (expert review R24).
 *
 * Flow: the operator first enters the effective service end E (#5257 F9, D2):
 * the date dates the backup retention record, and the confirmation token binds
 * the previewed argv, so E has to be in the preview. "Preview teardown" then runs
 * the read-only `deprovision` dry-run with `--service-end`, shows the
 * (secret-masked) transcript, the delete-eligible date (E + 30 days) and the
 * gateway host, and keeps Apply DISABLED until the operator types the subdomain
 * EXACTLY. Changing the date after a preview discards that preview and its token.
 * Apply replays the previewed argv + `--apply` via the single-use
 * `confirmationToken` (the server-side two-step gate; this UI is friction, not
 * enforcement).
 */

/** The value a `<input type="date">` holds once a full date is entered. */
const DATE_VALUE = /^\d{4}-\d{2}-\d{2}$/;
export function DeprovisionDialog(props: {
  api: ApiClient | null;
  subdomain: string | null;
  onClose: () => void;
  onApplied?: (jobId: string) => void;
}) {
  const { api, subdomain, onClose, onApplied } = props;
  const { deprovisionDryRun, deprovisionApply } = useVmJobActions(api);
  const [typed, setTyped] = useState("");
  const [serviceEnd, setServiceEnd] = useState("");

  const open = subdomain !== null;

  // On open, reset. The preview waits for the service end (D2).
  useEffect(() => {
    if (!subdomain) return;
    setTyped("");
    setServiceEnd("");
    deprovisionDryRun.reset();
    deprovisionApply.reset();
    // deprovisionDryRun/deprovisionApply are stable react-query handles; keying
    // this effect on `subdomain` alone is intentional (avoid a re-fire loop).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subdomain]);

  const canPreview =
    subdomain !== null &&
    DATE_VALUE.test(serviceEnd) &&
    !deprovisionDryRun.isPending &&
    !deprovisionApply.isPending;

  const handlePreview = () => {
    if (!canPreview || subdomain === null) return;
    setTyped("");
    deprovisionApply.reset();
    deprovisionDryRun.mutate({ subdomain, serviceEnd });
  };

  // A preview's token is bound to the argv it ran with, so a different date
  // discards it: Apply must never replay a teardown dated with the old E.
  const handleServiceEndChange = (value: string) => {
    setServiceEnd(value);
    if (deprovisionDryRun.data || deprovisionDryRun.isError) {
      deprovisionDryRun.reset();
      setTyped("");
    }
  };

  const dry = deprovisionDryRun.data;
  const token = dry?.confirmationToken;
  const typedMatches = subdomain !== null && typed === subdomain;
  // The token is bound to the argv the preview ran with, so Apply also needs that
  // preview's E to be the date the form shows now (#5257 R-1).
  const canApply =
    typedMatches &&
    Boolean(token) &&
    dry?.serviceEnd === serviceEnd &&
    !deprovisionApply.isPending;

  const handleApply = () => {
    if (!canApply || !token || subdomain === null) return;
    deprovisionApply.mutate(
      { confirmationToken: token, typedSubdomain: typed },
      {
        onSuccess: res => {
          onApplied?.(res.job.id);
          onClose();
        },
      }
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!next) onClose();
      }}
    >
      <DialogContent data-testid="deprovision-dialog">
        <DialogHeader>
          <DialogTitle>Deprovision {subdomain}</DialogTitle>
          <DialogDescription>
            This tears down the VM and its gateway mapping. Its backups are kept
            for 30 days after the service end, then removed by a separate purge.
            Enter the service end, preview the teardown, then type the subdomain
            to confirm.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-xs font-medium text-[var(--app-hint)]">
                Service end (E)
              </span>
              <input
                type="date"
                className="w-full rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-sm text-[var(--app-fg)] focus:border-[var(--app-accent)] focus:outline-none"
                value={serviceEnd}
                onChange={e => handleServiceEndChange(e.target.value)}
                data-testid="deprovision-service-end"
                disabled={
                  deprovisionDryRun.isPending || deprovisionApply.isPending
                }
              />
            </label>
            <Button
              type="button"
              variant="outline"
              onClick={handlePreview}
              disabled={!canPreview}
              data-testid="deprovision-preview"
              className="h-auto rounded px-3 py-1.5 font-normal disabled:opacity-40"
            >
              Preview teardown
            </Button>
          </div>
          <p className="text-xs text-[var(--app-hint)]">
            The end of the paid period, or the confirmed termination date.
            Backups are kept 30 days after it. A date more than 30 days ago is
            refused here; use the CLI for that case.
          </p>

          {deprovisionDryRun.isPending && (
            <p className="text-sm text-[var(--app-hint)]">
              Running dry-run preview…
            </p>
          )}

          {deprovisionDryRun.isError && (
            <p className="text-sm text-red-400" data-testid="deprovision-error">
              {deprovisionDryRun.error instanceof Error
                ? deprovisionDryRun.error.message
                : "Dry-run failed."}
            </p>
          )}

          {dry && (
            <div
              className="flex flex-col gap-0.5 rounded border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-2 text-xs text-[var(--app-fg)]"
              data-testid="deprovision-retention-summary"
            >
              <span>
                Backups retained until{" "}
                <span className="font-mono">
                  {dry.deleteEligibleAt
                    ? dry.deleteEligibleAt.slice(0, 10)
                    : "not dated"}
                </span>{" "}
                (service end{" "}
                <span className="font-mono">{dry.serviceEnd ?? "none"}</span>)
              </span>
              <span>
                Gateway host:{" "}
                {dry.gatewayHost ? (
                  <span className="font-mono">{dry.gatewayHost}</span>
                ) : (
                  // deprovision.sh still reads GATEWAY_HOST from the provision env
                  // file when the job passes none (RP1's sets one), so the record
                  // is not certain to be skipped (#5257).
                  <span className="text-amber-400">
                    none from this server — the teardown uses the provision env
                    file&apos;s GATEWAY_HOST if it sets one; otherwise the
                    retention record is not written
                  </span>
                )}
              </span>
            </div>
          )}

          {dry && (
            <pre
              className="max-h-56 overflow-auto rounded border border-[var(--app-border)] bg-[var(--app-bg)] p-2 font-mono text-[length:var(--text-caption)] leading-relaxed text-[var(--app-fg)]"
              data-testid="deprovision-transcript"
            >
              {dry.transcript || "(empty transcript)"}
            </pre>
          )}

          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-[var(--app-hint)]">
              Type{" "}
              <span className="font-mono text-[var(--app-fg)]">
                {subdomain}
              </span>{" "}
              to confirm
            </span>
            <input
              autoCapitalize="none"
              className="w-full rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-sm text-[var(--app-fg)] focus:border-red-500 focus:outline-none"
              value={typed}
              onChange={e => setTyped(e.target.value)}
              placeholder={subdomain ?? ""}
              data-testid="deprovision-typed-input"
              autoComplete="off"
              disabled={!dry}
            />
          </label>

          {deprovisionApply.isError && (
            <p
              className="text-sm text-red-400"
              data-testid="deprovision-apply-error"
            >
              {deprovisionApply.error instanceof Error
                ? deprovisionApply.error.message
                : "Apply failed."}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              data-testid="deprovision-cancel"
              className="h-auto rounded px-3 py-1.5 font-normal text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)]"
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={handleApply}
              disabled={!canApply}
              data-testid="deprovision-apply"
              className="h-auto rounded px-3 py-1.5 hover:bg-destructive disabled:opacity-40"
            >
              {deprovisionApply.isPending ? "Tearing down…" : "Deprovision"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
