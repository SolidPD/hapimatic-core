// SPDX-License-Identifier: AGPL-3.0-only
import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/Spinner";

type ConfirmDialogProps = {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  description: string;
  confirmLabel: string;
  confirmingLabel: string;
  onConfirm: () => Promise<void>;
  isPending: boolean;
  destructive?: boolean;
  /**
   * Opt-in non-blocking mode (issue #1902). When true, confirming closes the
   * dialog IMMEDIATELY and runs `onConfirm()` in the background — failures are
   * routed to `onError` (typically a Toast) instead of holding the dialog open
   * with an inline error. Defaults to false, so the ~20 other ConfirmDialog
   * consumers keep their blocking + inline-error semantics unchanged.
   */
  nonBlocking?: boolean;
  /** Background-failure handler used only when `nonBlocking` is true. */
  onError?: (err: unknown) => void;
  /** Label for the dismiss button (default "Cancel"; issue #1006 uses "Later"). */
  cancelLabel?: string;
};

export function ConfirmDialog(props: ConfirmDialogProps) {
  const {
    isOpen,
    onClose,
    title,
    description,
    confirmLabel,
    confirmingLabel,
    onConfirm,
    isPending,
    destructive = false,
    nonBlocking = false,
    onError,
    cancelLabel = "Cancel",
  } = props;

  const [error, setError] = useState<string | null>(null);

  // Clear error when dialog opens/closes
  useEffect(() => {
    if (isOpen) {
      setError(null);
    }
  }, [isOpen]);

  const handleConfirm = async () => {
    setError(null);

    if (nonBlocking) {
      // Issue #1902: return control to the user immediately — close first, run
      // the mutation in the background, and route any rejection to onError
      // (Toast) rather than holding the modal open. The confirming spinner is
      // never shown because the dialog is already closing.
      onClose();
      void Promise.resolve()
        .then(onConfirm)
        .catch(err => onError?.(err));
      return;
    }

    try {
      await onConfirm();
      onClose();
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Operation failed. Please try again.";
      setError(message);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="mt-2">{description}</DialogDescription>
        </DialogHeader>

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
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant="secondary"
            className={
              isPending && destructive
                ? "disabled:opacity-100 text-red-500"
                : isPending
                  ? "disabled:opacity-100"
                  : destructive
                    ? "text-red-500"
                    : ""
            }
            onClick={handleConfirm}
            disabled={isPending}
          >
            {isPending ? (
              <span className="inline-flex items-center gap-1.5">
                <Spinner size="sm" label={null} className="!text-inherit" />
                {confirmingLabel}
              </span>
            ) : (
              confirmLabel
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
