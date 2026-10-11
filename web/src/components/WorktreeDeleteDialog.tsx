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

// #2480: non-cascading delete. The DEFAULT action is now a single-session delete
// that DISSOLVES the group server-side — the children survive as independent
// top-level sessions (their parent link is nulled). "Delete all (N)" is the
// demoted secondary/destructive action that removes the whole group (the cascade
// that used to be implicit). `childCount` counts peer + branch descendants — the
// same set "Delete all" removes — so it is no longer branch-only.
type WorktreeDeleteDialogProps = {
  isOpen: boolean;
  onClose: () => void;
  sessionName: string;
  /** Peer + branch descendants of this session (what "Delete all" removes). */
  childCount: number;
  /** Default action: delete ONLY this session; children are dissolved (survive). */
  onDeleteThis: () => Promise<void>;
  /** Secondary/destructive action: remove the whole group (cascade). */
  onDeleteAll: () => Promise<void>;
  isPending: boolean;
};

export function WorktreeDeleteDialog(props: WorktreeDeleteDialogProps) {
  const {
    isOpen,
    onClose,
    sessionName,
    childCount,
    onDeleteThis,
    onDeleteAll,
    isPending,
  } = props;

  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<
    "deleteThis" | "deleteAll" | null
  >(null);

  useEffect(() => {
    if (isOpen) {
      setError(null);
      setPendingAction(null);
    }
  }, [isOpen]);

  const handleAction = async (
    action: "deleteThis" | "deleteAll",
    handler: () => Promise<void>
  ) => {
    setError(null);
    setPendingAction(action);
    try {
      await handler();
      onClose();
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Operation failed. Please try again.";
      setError(message);
      setPendingAction(null);
    }
  };

  const childLabel =
    childCount === 1
      ? "1 managed or branched session"
      : `${childCount} managed or branched sessions`;
  const themPronoun = childCount === 1 ? "it" : "them";

  return (
    <Dialog open={isOpen} onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Delete session</DialogTitle>
          <DialogDescription className="mt-2">
            <strong className="text-[var(--app-fg)]">
              &ldquo;{sessionName}&rdquo;
            </strong>{" "}
            has {childLabel}. Deleting only this session leaves {themPronoun} as
            independent, top-level {childCount === 1 ? "session" : "sessions"}.
            Choose <strong className="text-[var(--app-fg)]">Delete all</strong>{" "}
            to remove the whole group instead.
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <div className="mt-3 rounded-md bg-red-900/20 p-3 text-sm text-red-400">
            {error}
          </div>
        ) : null}

        <div className="mt-4 flex flex-col gap-2">
          {/* Primary — single delete (dissolve): children survive as top-level. */}
          <Button
            type="button"
            variant="default"
            onClick={() => void handleAction("deleteThis", onDeleteThis)}
            disabled={isPending}
          >
            {isPending && pendingAction === "deleteThis" ? (
              <span className="inline-flex items-center gap-1.5">
                <Spinner size="sm" label={null} className="!text-inherit" />
                Deleting session...
              </span>
            ) : (
              "Delete this session"
            )}
          </Button>

          {/* Secondary/destructive — remove the whole group (cascade). */}
          <Button
            type="button"
            variant="destructive"
            onClick={() => void handleAction("deleteAll", onDeleteAll)}
            disabled={isPending}
          >
            {isPending && pendingAction === "deleteAll" ? (
              <span className="inline-flex items-center gap-1.5">
                <Spinner size="sm" label={null} className="!text-inherit" />
                Deleting all...
              </span>
            ) : (
              `Delete all (${childCount + 1} sessions)`
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
