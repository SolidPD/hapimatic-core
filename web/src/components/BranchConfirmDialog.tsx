// SPDX-License-Identifier: AGPL-3.0-only
import { useState, useEffect, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/Spinner";

type BranchConfirmDialogProps = {
  isOpen: boolean;
  onClose: () => void;
  parentName: string;
  onConfirm: (branchName: string) => Promise<void>;
  isPending: boolean;
  /**
   * Opt-in non-blocking mode (issue #1902). When true, a valid confirm closes
   * the dialog immediately and runs the branch mutation in the background;
   * failures route to `onError` (Toast). The navigate-to-new-session on success
   * is unaffected — it lives in the mutation's onSuccess, not this dialog.
   * Defaults to false (blocking + inline error).
   */
  nonBlocking?: boolean;
  /** Background-failure handler used only when `nonBlocking` is true. */
  onError?: (err: unknown) => void;
};

export function BranchConfirmDialog(props: BranchConfirmDialogProps) {
  const {
    isOpen,
    onClose,
    parentName,
    onConfirm,
    isPending,
    nonBlocking = false,
    onError,
  } = props;

  const defaultName = `(b) ${parentName}`;
  const [name, setName] = useState(defaultName);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset name when dialog opens with a new parent
  useEffect(() => {
    if (isOpen) {
      setName(`(b) ${parentName}`);
      setError(null);
    }
  }, [isOpen, parentName]);

  // Focus and select the input when dialog opens
  useEffect(() => {
    if (!isOpen) return;
    // Delay to let the dialog animation complete
    const timer = setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 100);
    return () => clearTimeout(timer);
  }, [isOpen]);

  const handleConfirm = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Branch name cannot be empty");
      return;
    }
    setError(null);

    if (nonBlocking) {
      // Issue #1902: close immediately, branch in the background, toast errors.
      onClose();
      void Promise.resolve()
        .then(() => onConfirm(trimmed))
        .catch(err => onError?.(err));
      return;
    }

    try {
      await onConfirm(trimmed);
      onClose();
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Failed to branch. Please try again.";
      setError(message);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void handleConfirm();
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Branch Conversation</DialogTitle>
          <DialogDescription className="mt-2">
            Create a new session that inherits the full conversation history
            from this session.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-3 flex flex-col gap-1.5">
          <label
            htmlFor="branch-name"
            className="text-sm font-medium text-[var(--app-fg)]"
          >
            Branch name
          </label>
          <input
            autoCapitalize="none"
            ref={inputRef}
            id="branch-name"
            type="text"
            value={name}
            onChange={e => {
              setName(e.target.value);
              setError(null);
            }}
            onKeyDown={handleKeyDown}
            className={`w-full rounded-md bg-[var(--app-hover)] text-[var(--app-fg)] px-3 py-2 text-sm outline-none border ${
              error
                ? "border-red-500"
                : "border-[var(--app-divider)] focus:border-[var(--app-link)]"
            } transition-colors`}
            disabled={isPending}
          />
        </div>

        {error ? (
          <div className="mt-2 rounded-md bg-red-900/20 p-3 text-sm text-red-400">
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
            className={isPending ? "disabled:opacity-100" : ""}
            onClick={() => void handleConfirm()}
            disabled={isPending}
          >
            {isPending ? (
              <span className="inline-flex items-center gap-1.5">
                <Spinner size="sm" label={null} className="!text-inherit" />
                Branching...
              </span>
            ) : (
              "Branch"
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
