// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import type { SessionSummary } from "@/types/api";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { queryKeys } from "@/lib/query-keys";

/**
 * Select-Mode Chip Row (#3292, epic #3285 S7) — the ephemeral bulk-action bar that
 * appears below the Control Bar while Select Mode is active. Plain clickable text
 * (no pills/bubbles), right-justified, minimal height (taxonomy `.chiprow`):
 *
 *   All · None · Connect · Disconnect · Delete   (Delete red)
 *
 * Bulk ops mirror `GlobalConnectPopover` (`Promise.allSettled` + toast + query
 * invalidation) — the retired global Connect/Disconnect-All + Delete-All-Disconnected
 * toolbar actions fold into these chips (directive Task 3 dispositions 1 & 2).
 *
 * - **Connect** reconnects the selected disconnected sessions. `reconnectSession`
 *   returns a NEW session id, so every selected id goes stale → we EXIT Select Mode
 *   on completion (directive Task 5).
 * - **Disconnect** archives the selected connected sessions; ids are stable, so we
 *   stay in Select Mode (lets the user chain disconnect → delete).
 * - **Delete** confirms by selection composition (Task 6): all-disconnected → a count
 *   confirm; some-connected → a disconnect-then-delete warning. Connected sessions are
 *   disconnected first, then all selected records are bulk-deleted.
 */
type SelectModeChipRowProps = {
  /** All sessions currently in view (the "All" chip selects these). */
  sessions: SessionSummary[];
  selectedIds: ReadonlySet<string>;
  api: ApiClient | null;
  onSelectAll: (ids: string[]) => void;
  onSelectNone: () => void;
  /** Exit Select Mode (called after Connect / Delete — the selection is stale). */
  onExit: () => void;
  onRefresh: () => void;
};

const CHIP_CLASS =
  "text-[length:var(--text-caption)] font-semibold text-[var(--app-fg)] hover:text-[var(--app-accent)] disabled:text-[var(--app-hint)] disabled:opacity-50";
const CHIP_DANGER_CLASS =
  "text-[length:var(--text-caption)] font-semibold text-[var(--app-badge-error-text)] hover:opacity-80 disabled:opacity-50";

/** One Select-Mode chip: plain clickable text (no bubble); `danger` renders it red (Delete). */
function Chip({
  label,
  onClick,
  disabled = false,
  danger = false,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <Button
      type="button"
      variant="ghostStatic"
      size="bare"
      className={danger ? CHIP_DANGER_CLASS : CHIP_CLASS}
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </Button>
  );
}

export function SelectModeChipRow({
  sessions,
  selectedIds,
  api,
  onSelectAll,
  onSelectNone,
  onExit,
  onRefresh,
}: SelectModeChipRowProps) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [isPending, setIsPending] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  const selected = useMemo(
    () => sessions.filter(s => selectedIds.has(s.id)),
    [sessions, selectedIds]
  );
  const connectedSelected = useMemo(
    () => selected.filter(s => s.active),
    [selected]
  );
  const disconnectedSelected = useMemo(
    () => selected.filter(s => !s.active),
    [selected]
  );

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.federationAllSessions,
    });
    onRefresh();
  };

  const handleConnect = async () => {
    if (!api || disconnectedSelected.length === 0) return;
    setIsPending(true);
    try {
      const results = await Promise.allSettled(
        disconnectedSelected.map(s => api.reconnectSession(s.id))
      );
      const succeeded = results.filter(r => r.status === "fulfilled").length;
      const failed = results.length - succeeded;
      invalidate();
      showToast(
        failed > 0
          ? `Reconnected ${succeeded} of ${disconnectedSelected.length} sessions (${failed} failed)`
          : `Reconnected ${succeeded} session${succeeded === 1 ? "" : "s"}`,
        { type: failed > 0 ? "error" : "success" }
      );
    } finally {
      setIsPending(false);
      // reconnect mints new session ids — the selection is now stale (Task 5).
      onExit();
    }
  };

  const handleDisconnect = async () => {
    if (!api || connectedSelected.length === 0) return;
    setIsPending(true);
    try {
      const results = await Promise.allSettled(
        connectedSelected.map(s => api.archiveSession(s.id))
      );
      const succeeded = results.filter(r => r.status === "fulfilled").length;
      const failed = results.length - succeeded;
      invalidate();
      showToast(
        failed > 0
          ? `Disconnected ${succeeded} of ${connectedSelected.length} sessions (${failed} failed)`
          : `Disconnected ${succeeded} session${succeeded === 1 ? "" : "s"}`,
        { type: failed > 0 ? "error" : "success" }
      );
    } finally {
      setIsPending(false);
      // ids are stable after archive — stay in Select Mode so the user can chain
      // disconnect → delete on the same selection.
    }
  };

  const handleDelete = async () => {
    if (!api || selected.length === 0) return;
    setIsPending(true);
    try {
      // Some-connected variant: disconnect first, then bulk-delete every selection.
      if (connectedSelected.length > 0) {
        await Promise.allSettled(
          connectedSelected.map(s => api.archiveSession(s.id))
        );
      }
      await api.bulkDeleteSessions(selected.map(s => s.id));
      invalidate();
      showToast(
        `Deleted ${selected.length} session${selected.length === 1 ? "" : "s"}`,
        { type: "success" }
      );
    } finally {
      setIsPending(false);
      setDeleteConfirmOpen(false);
      // records are gone — the selection is stale (Task 5 rationale extends to Delete).
      onExit();
    }
  };

  const hasSelection = selected.length > 0;
  const someConnected = connectedSelected.length > 0;

  return (
    <div className="flex items-center justify-end gap-4 px-3.5 py-0.5 bg-[var(--app-bg)] border-b border-[var(--app-divider)]">
      <Chip label="All" onClick={() => onSelectAll(sessions.map(s => s.id))} />
      <Chip label="None" onClick={onSelectNone} disabled={!hasSelection} />
      <Chip
        label="Connect"
        onClick={handleConnect}
        disabled={disconnectedSelected.length === 0 || isPending}
      />
      <Chip
        label="Disconnect"
        onClick={handleDisconnect}
        disabled={connectedSelected.length === 0 || isPending}
      />
      <Chip
        label="Delete"
        danger
        onClick={() => setDeleteConfirmOpen(true)}
        disabled={!hasSelection || isPending}
      />

      <ConfirmDialog
        isOpen={deleteConfirmOpen}
        onClose={() => setDeleteConfirmOpen(false)}
        title={
          someConnected
            ? `${connectedSelected.length} of ${selected.length} selected session${selected.length === 1 ? " is" : "s are"} still connected`
            : "Delete Selected Sessions"
        }
        description={
          someConnected
            ? `Disconnect ${connectedSelected.length === 1 ? "it" : "them"} automatically and delete all ${selected.length} selected session${selected.length === 1 ? "" : "s"}? This action cannot be undone.`
            : `Delete ${selected.length} disconnected session${selected.length === 1 ? "" : "s"}? This action cannot be undone.`
        }
        confirmLabel="Delete"
        confirmingLabel="Deleting..."
        onConfirm={handleDelete}
        isPending={isPending}
        destructive
      />
    </div>
  );
}
