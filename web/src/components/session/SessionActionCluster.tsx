// SPDX-License-Identifier: AGPL-3.0-only
/**
 * SessionActionCluster — the shared horizontal Session Action Cluster (issue
 * #3288, S3, R2/R5/R7). Rendered BY `SessionExpandedDetails` for BOTH the
 * Session Card (list) and the Instance header, so the two surfaces are
 * byte-identical except the ONE R3 divergence (kebab-hover Notes Preview, which
 * lives in `SessionKebabMenu`). This REPLACES the per-container `actions`
 * ReactNode injection that made R7 parity impossible.
 *
 * **Row 1** = Chain (connect/disconnect) · Trash · Kebab, plus the interim
 * prop-gated Desktop (#2693) + Files buttons appended AFTER the kebab — those
 * retire when #3286's View Picker unwires `onDesktop`/`onViewFiles` via
 * SessionChat props, with no further work here. Beneath this cluster
 * `SessionExpandedDetails` composes the Session ID row (`SessionIdDisplay`) and
 * then the one-line `[terminal] Harness | Launcher` row (`SessionModelInfo`)
 * (#4479).
 *
 * This is a plain flex row, NOT the old `.icon-col-N` absolutely-positioned grid
 * — so DOM order == painted order and the #2377 WCAG-focus-order guard is
 * structurally moot for this row.
 *
 * Dialog ownership (deliberate split): this cluster owns ONLY the NEW R5
 * disconnect-and-delete confirm (built once, so both surfaces share it). Every
 * EXISTING dialog (disconnect / reconnect / delete / worktree-delete / branch)
 * stays in the container and is reached via a callback prop — their tested
 * semantics are preserved verbatim through the reflow. The kebab's Copy Session
 * Info entry (#4480) is a callback too; the container owns the copy hook.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Spinner } from "@/components/Spinner";
import {
  BranchIcon,
  ChainIcon,
  CopyIcon,
  DesktopIcon,
  FilesIcon,
  TrashIcon,
} from "@/components/icons";
import { SessionKebabMenu, type SessionKebabEntry } from "./SessionKebabMenu";

export type SessionActionClusterProps = {
  surface: "list" | "instance";
  /** session.active (instance) / online (list). Drives chain direction + R5. */
  isActive: boolean;

  // Chain (connect/disconnect) — the container owns the confirm dialogs.
  onDisconnect: () => void;
  onReconnect: () => void;
  showReconnectSpinner: boolean;
  showArchiveSpinner: boolean;

  // Trash — always clickable (R5). Inactive → the container's existing delete
  // flow; active → this cluster's NEW disconnect-and-delete confirm.
  onDelete: () => void;
  onDisconnectAndDelete: () => Promise<void>;

  // Kebab entries (D2(a)) — thin pointers into the container's handlers.
  onBranch: () => void;
  isBranching: boolean;
  isBranchDisabled: boolean;
  /** #4480: writes the `HAPImatic Session Info v1` block to the clipboard. */
  onCopySessionInfo: () => void;
  /** #4480: kebab open/close — the container prefetches on open. */
  onKebabOpenChange?: (open: boolean) => void;

  // Interim prop-gated view buttons (instance surface only, retire with #3286).
  onDesktop?: () => void;
  onViewFiles?: () => void;

  // Dialog copy + pending state for the R5 confirm.
  sessionName: string;
  isPending: boolean;

  // List-surface kebab hover Notes Preview (R3).
  notesValue?: string;
  sessionTitle?: string;
};

export function SessionActionCluster({
  surface,
  isActive,
  onDisconnect,
  onReconnect,
  showReconnectSpinner,
  showArchiveSpinner,
  onDelete,
  onDisconnectAndDelete,
  onBranch,
  isBranching,
  isBranchDisabled,
  onCopySessionInfo,
  onKebabOpenChange,
  onDesktop,
  onViewFiles,
  sessionName,
  isPending,
  notesValue,
  sessionTitle,
}: SessionActionClusterProps) {
  const [disconnectAndDeleteOpen, setDisconnectAndDeleteOpen] = useState(false);
  const isList = surface === "list";

  // List card row-navigation fires from up-handlers, so a tap on any control
  // must stop here or it would ALSO open the session. Instance surface has no
  // clickable wrapper → no isolation needed.
  const guard = (fn: () => void) => (e: React.MouseEvent) => {
    if (isList) {
      e.stopPropagation();
      e.preventDefault();
    }
    fn();
  };
  const rowIsolation = isList
    ? {
        onClick: (e: React.MouseEvent) => e.stopPropagation(),
        onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
        onMouseUp: (e: React.MouseEvent) => e.stopPropagation(),
        onTouchStart: (e: React.TouchEvent) => e.stopPropagation(),
        onTouchEnd: (e: React.TouchEvent) => e.stopPropagation(),
      }
    : {};

  const chainSpinning = showReconnectSpinner || showArchiveSpinner;

  const kebabEntries: SessionKebabEntry[] = [
    {
      key: "branch",
      label: "Branch",
      icon: <BranchIcon className="h-4 w-4" />,
      onSelect: onBranch,
      disabled: isBranchDisabled,
    },
    {
      // #4480: replaces the "Session Configuration" entry — that modal still
      // opens from the Account Badge and the composer config cluster.
      key: "copy-session-info",
      label: "Copy Session Info",
      icon: <CopyIcon className="h-4 w-4" />,
      onSelect: onCopySessionInfo,
    },
  ];

  return (
    <div className="flex items-center gap-0.5" {...rowIsolation}>
      {/* Chain — connect/disconnect */}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        data-testid="session-cluster-chain"
        disabled={chainSpinning}
        onClick={guard(isActive ? onDisconnect : onReconnect)}
        className={`disabled:opacity-100 ${
          isActive
            ? "text-[var(--app-badge-error-text)] hover:text-[var(--app-badge-error-text)]"
            : "text-[var(--app-badge-success-text)] hover:text-[var(--app-badge-success-text)]"
        }`}
        title={
          showArchiveSpinner
            ? "Disconnecting..."
            : isActive
              ? "Disconnect session"
              : showReconnectSpinner
                ? "Reconnecting..."
                : "Reconnect session"
        }
        aria-label={isActive ? "Disconnect session" : "Reconnect session"}
      >
        {chainSpinning ? (
          <Spinner
            size="md"
            label={showArchiveSpinner ? "Disconnecting" : "Reconnecting"}
            className={
              showArchiveSpinner
                ? "text-[var(--app-badge-error-text)]"
                : "text-[var(--app-badge-success-text)]"
            }
          />
        ) : (
          <ChainIcon className="h-5 w-5" connected={!isActive} />
        )}
      </Button>

      {/* Trash — always clickable (R5). Active → disconnect-and-delete confirm. */}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        data-testid="session-cluster-trash"
        onClick={guard(() => {
          if (isActive) setDisconnectAndDeleteOpen(true);
          else onDelete();
        })}
        className="text-[var(--app-badge-error-text)] hover:text-[var(--app-badge-error-text)]"
        title={isActive ? "Disconnect and delete session" : "Delete session"}
        aria-label={
          isActive ? "Disconnect and delete session" : "Delete session"
        }
      >
        <TrashIcon className="h-5 w-5" />
      </Button>

      {/* Kebab — Branch + Copy Session Info (extensible); list-hover Notes Preview. */}
      <SessionKebabMenu
        surface={surface}
        entries={kebabEntries}
        onOpenChange={onKebabOpenChange}
        notesValue={notesValue}
        sessionTitle={sessionTitle}
        isolatePointerEvents={isList}
      />

      {/* Interim view buttons (instance only) — retire with #3286's View Picker. */}
      {onDesktop && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-testid="session-cluster-desktop"
          onClick={guard(onDesktop)}
          title="Open desktop"
          aria-label="Open desktop"
        >
          <DesktopIcon className="h-5 w-5" />
        </Button>
      )}
      {onViewFiles && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-testid="session-cluster-files"
          onClick={guard(onViewFiles)}
          title="View files"
          aria-label="View files"
        >
          <FilesIcon className="h-5 w-5" />
        </Button>
      )}

      {/* R5 (NEW) — the connected-session disconnect-and-delete confirm, built
          once here so both surfaces share it. Preserves the container's separate
          Disconnect and inactive-path Delete confirms untouched. */}
      <ConfirmDialog
        isOpen={disconnectAndDeleteOpen}
        onClose={() => setDisconnectAndDeleteOpen(false)}
        title="Disconnect and Delete Session"
        description={`"${sessionName}" is still connected. Disconnect it and delete? This action cannot be undone.`}
        confirmLabel="Disconnect & Delete"
        confirmingLabel="Deleting..."
        onConfirm={onDisconnectAndDelete}
        isPending={isPending}
        destructive
        nonBlocking
      />
    </div>
  );
}
