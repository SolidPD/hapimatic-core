// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/Spinner";

/**
 * Two-step confirmation for a bulk session action (#3815, R3) — Stop turn,
 * Disconnect, Delete — and #3818's Send. ONE dialog, ONE state machine: a
 * single-session action confirms once; a multi-session action asks again with
 * a confirm label that names the count and the action ("Stop 5 turns").
 *
 * Why not two `ConfirmDialog`s: it renders its confirm button in the same
 * place every time, so the second tap of a double tap would land on the next
 * dialog's confirm and pass both. Here step 2's confirm stays disabled — and
 * its handler ignores clicks — for `ARM_DELAY_MS` after step 1, so only a
 * fresh, deliberate press runs the action.
 */
export const ARM_DELAY_MS = 600;

export type BulkConfirmCopy = {
  title: string;
  description: string;
  confirmLabel: string;
};

type BulkActionConfirmProps = {
  isOpen: boolean;
  onClose: () => void;
  /** Sessions the action runs on; 1 → one step, more → two. */
  count: number;
  first: BulkConfirmCopy;
  /** Shown only when `count > 1`; its label names the count and the action. */
  second: BulkConfirmCopy;
  /** A line shown on every step (e.g. selected sessions the filter hides). */
  note?: string | null;
  confirmingLabel: string;
  onConfirm: () => Promise<void>;
  isPending: boolean;
  destructive?: boolean;
  /** Step-1 content (e.g. #3818 Send's prompt field); hidden on step 2. */
  children?: ReactNode;
  /** Keep the confirm disabled (e.g. an empty prompt). */
  confirmDisabled?: boolean;
};

export function BulkActionConfirm({
  isOpen,
  onClose,
  count,
  first,
  second,
  note,
  confirmingLabel,
  onConfirm,
  isPending,
  destructive = false,
  children,
  confirmDisabled = false,
}: BulkActionConfirmProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const [armed, setArmed] = useState(true);
  const armedRef = useRef(true);
  const [error, setError] = useState<string | null>(null);

  // Every opening starts at step 1.
  useEffect(() => {
    if (isOpen) {
      setStep(1);
      setArmed(true);
      armedRef.current = true;
      setError(null);
    }
  }, [isOpen]);

  // Step 2 arms after a delay; the ref closes the window between a click and
  // the re-render that disables the button.
  useEffect(() => {
    if (step !== 2) return;
    armedRef.current = false;
    setArmed(false);
    const t = setTimeout(() => {
      armedRef.current = true;
      setArmed(true);
    }, ARM_DELAY_MS);
    return () => clearTimeout(t);
  }, [step]);

  const twoStep = count > 1;
  const copy = step === 2 ? second : first;

  const handleConfirm = async () => {
    if (!armedRef.current || confirmDisabled) return;
    if (step === 1 && twoStep) {
      armedRef.current = false;
      setStep(2);
      return;
    }
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Operation failed. Please try again."
      );
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription className="mt-2">
            {copy.description}
          </DialogDescription>
        </DialogHeader>

        {step === 1 && children ? <div className="mt-3">{children}</div> : null}

        {note ? (
          <p
            className="mt-2 text-[length:var(--text-caption)] text-[var(--app-hint)]"
            data-testid="bulk-confirm-note"
          >
            {note}
          </p>
        ) : null}

        {twoStep ? (
          <p
            className="mt-2 text-[length:var(--text-caption)] text-[var(--app-hint)]"
            aria-live="polite"
          >
            Step {step} of 2
          </p>
        ) : null}

        {error ? (
          <div className="mt-3 rounded-md bg-red-900/20 p-3 text-sm text-red-400">
            {error}
          </div>
        ) : null}

        <div className="mt-4 flex gap-2 justify-end">
          <Button
            type="button"
            variant="secondary"
            onClick={onClose}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="secondary"
            data-testid="bulk-confirm-btn"
            className={
              destructive
                ? isPending
                  ? "disabled:opacity-100 text-red-500"
                  : "text-red-500"
                : isPending
                  ? "disabled:opacity-100"
                  : ""
            }
            onClick={handleConfirm}
            disabled={isPending || !armed || confirmDisabled}
          >
            {isPending ? (
              <span className="inline-flex items-center gap-1.5">
                <Spinner size="sm" label={null} className="!text-inherit" />
                {confirmingLabel}
              </span>
            ) : (
              copy.confirmLabel
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
