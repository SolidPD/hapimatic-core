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
 * Flow: opening for a subdomain runs the read-only `deprovision --dry-run`, shows
 * the (secret-masked) transcript, and keeps Apply DISABLED until the operator
 * types the subdomain EXACTLY. Apply replays the previewed argv + `--apply` via
 * the single-use `confirmationToken` (the server-side two-step gate; this UI is
 * friction, not enforcement).
 */
export function DeprovisionDialog(props: {
  api: ApiClient | null;
  subdomain: string | null;
  onClose: () => void;
  onApplied?: (jobId: string) => void;
}) {
  const { api, subdomain, onClose, onApplied } = props;
  const { deprovisionDryRun, deprovisionApply } = useVmJobActions(api);
  const [typed, setTyped] = useState("");

  const open = subdomain !== null;

  // On open, reset and kick off the read-only dry-run preview.
  useEffect(() => {
    if (!subdomain) return;
    setTyped("");
    deprovisionDryRun.reset();
    deprovisionApply.reset();
    deprovisionDryRun.mutate({ subdomain });
    // deprovisionDryRun/deprovisionApply are stable react-query handles; keying
    // this effect on `subdomain` alone is intentional (avoid a re-fire loop).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subdomain]);

  const dry = deprovisionDryRun.data;
  const token = dry?.confirmationToken;
  const typedMatches = subdomain !== null && typed === subdomain;
  const canApply =
    typedMatches && Boolean(token) && !deprovisionApply.isPending;

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
            This tears down the VM and its gateway mapping. Review the dry-run
            transcript below, then type the subdomain to confirm.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
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
