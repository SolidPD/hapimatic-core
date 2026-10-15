// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import type { SessionSummary } from "@/types/api";
import type { BulkSessionResult } from "@hapi/protocol/bulkSessionResult";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/Toast";
import { queryKeys } from "@/lib/query-keys";
import {
  summarizeBulkSessionResult,
  type BulkToastAction,
} from "@/lib/bulkSessionToast";
import { useBulkSessionAction } from "@/hooks/mutations/useBulkSessionAction";
import { BulkActionConfirm, type BulkConfirmCopy } from "./BulkActionConfirm";

/**
 * Select-Mode Chip Row (#3292, epic #3285 S7) — the ephemeral bulk-action bar that
 * appears below the Control Bar while Select Mode is active. Plain clickable text
 * (no pills/bubbles), right-justified, minimal height (taxonomy `.chiprow`):
 *
 *   All · None · Connect · Disconnect · Stop turn · Delete
 *   (Stop turn in the warning tone, Delete red)
 *
 * The retired global Connect/Disconnect-All + Delete-All-Disconnected toolbar
 * actions fold into these chips (directive Task 3 dispositions 1 & 2). Since
 * #3815 they are also the fleet-wide stop: filter, select All, Stop turn.
 *
 * - **Connect** reconnects the selected disconnected sessions. `reconnectSession`
 *   returns a NEW session id, so every selected id goes stale → we EXIT Select Mode
 *   on completion (directive Task 5).
 * - **Disconnect** archives the selected connected sessions on their owning nodes
 *   (`POST /api/sessions/bulk-archive`); ids are stable, so we stay in Select Mode.
 * - **Stop turn** (#3815) interrupts the current turn of every selected session
 *   that is mid-turn (`POST /api/sessions/bulk-abort`); the sessions stay
 *   connected, so we stay in Select Mode.
 * - **Delete** is "disconnect and delete": the connected selection is disconnected
 *   first and ONLY the sessions that are disconnected afterwards are deleted.
 *
 * Stop turn, Disconnect and Delete confirm through `BulkActionConfirm` — one step
 * for one session, two for more (#3815 R3). Every action reports through ONE
 * per-session summary toast (`summarizeBulkSessionResult`).
 */
type SelectModeChipRowProps = {
  /**
   * The FILTERED sessions in view (#3815 / D-4406-2): "All" selects these and
   * every chip acts only on selected sessions in this list, so a session the
   * filter hides is never acted on — it stays selected and the confirm names it.
   */
  sessions: SessionSummary[];
  selectedIds: ReadonlySet<string>;
  api: ApiClient | null;
  onSelectAll: (ids: string[]) => void;
  onSelectNone: () => void;
  /** Exit Select Mode (called after Connect / Delete — the selection is stale). */
  onExit: () => void;
  onRefresh: () => void;
};

type ConfirmKind = "abort" | "archive" | "delete";

const CHIP_CLASS =
  "text-[length:var(--text-caption)] font-semibold text-[var(--app-fg)] hover:text-[var(--app-accent)] disabled:text-[var(--app-hint)] disabled:opacity-50";
const CHIP_WARNING_CLASS =
  "text-[length:var(--text-caption)] font-semibold text-[var(--app-badge-warning-text)] hover:opacity-80 disabled:opacity-50";
const CHIP_DANGER_CLASS =
  "text-[length:var(--text-caption)] font-semibold text-[var(--app-badge-error-text)] hover:opacity-80 disabled:opacity-50";

/** One Select-Mode chip: plain clickable text (no bubble), in a tone. */
function Chip({
  label,
  onClick,
  disabled = false,
  tone = "routine",
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: "routine" | "warning" | "danger";
}) {
  return (
    <Button
      type="button"
      variant="ghostStatic"
      size="bare"
      className={
        tone === "danger"
          ? CHIP_DANGER_CLASS
          : tone === "warning"
            ? CHIP_WARNING_CLASS
            : CHIP_CLASS
      }
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </Button>
  );
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

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
  const { runBulkAction } = useBulkSessionAction(api);
  const [isPending, setIsPending] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmKind | null>(null);

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
  // Stop turn acts only on sessions that are mid-turn (the server skips the rest).
  const thinkingSelected = useMemo(
    () => selected.filter(s => s.active && s.thinking),
    [selected]
  );
  // Selected ids the current filter hides — left out of every action.
  const hiddenCount = selectedIds.size - selected.length;

  const report = (action: BulkToastAction, results: BulkSessionResult) => {
    const { message, type } = summarizeBulkSessionResult(action, results);
    showToast(message, { type });
  };

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
      const settled = await Promise.allSettled(
        disconnectedSelected.map(s => api.reconnectSession(s.id))
      );
      invalidate();
      report(
        "connect",
        settled.map((r, i) => {
          const id = disconnectedSelected[i]?.id ?? "";
          return r.status === "fulfilled"
            ? { id, ok: true }
            : {
                id,
                ok: false,
                error:
                  r.reason instanceof Error
                    ? r.reason.message
                    : String(r.reason),
              };
        })
      );
    } finally {
      setIsPending(false);
      // reconnect mints new session ids — the selection is now stale (Task 5).
      onExit();
    }
  };

  const handleStopTurn = async () => {
    if (!api || thinkingSelected.length === 0) return;
    setIsPending(true);
    try {
      const results = await runBulkAction(
        "abort",
        thinkingSelected.map(s => s.id)
      );
      onRefresh();
      report("abort", results);
    } finally {
      setIsPending(false);
      // Sessions stay connected and keep their ids — stay in Select Mode.
    }
  };

  const handleDisconnect = async () => {
    if (!api || connectedSelected.length === 0) return;
    setIsPending(true);
    try {
      const results = await runBulkAction(
        "archive",
        connectedSelected.map(s => s.id)
      );
      onRefresh();
      report("archive", results);
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
      // Disconnect first; a session whose disconnect failed or was refused is
      // still running and is NEVER sent to delete (#3815-17).
      let refused: BulkSessionResult = [];
      const deletable = disconnectedSelected.map(s => s.id);
      if (connectedSelected.length > 0) {
        const archived = await runBulkAction(
          "archive",
          connectedSelected.map(s => s.id)
        );
        // `session_inactive` = it was already disconnected (the list had not
        // caught up), so it is as deletable as a fresh disconnect.
        const nowDisconnected = (r: BulkSessionResult[number]) =>
          r.ok || r.code === "session_inactive";
        deletable.push(...archived.filter(nowDisconnected).map(r => r.id));
        refused = archived.filter(r => !nowDisconnected(r));
      }
      const deleted =
        deletable.length > 0 ? await runBulkAction("delete", deletable) : [];
      onRefresh();
      report("delete", [...deleted, ...refused]);
    } finally {
      setIsPending(false);
      // records are gone — the selection is stale (Task 5 rationale extends to Delete).
      onExit();
    }
  };

  const hasSelection = selected.length > 0;
  const someConnected = connectedSelected.length > 0;

  // Task 0 step 3: the honest count, on every confirm, when the filter hides
  // part of the selection.
  const hiddenNote =
    hiddenCount > 0
      ? `${selected.length} in the current view, ${hiddenCount} selected but hidden — left out.`
      : null;

  const confirmProps = ((): {
    count: number;
    first: BulkConfirmCopy;
    second: BulkConfirmCopy;
    confirmingLabel: string;
    onConfirm: () => Promise<void>;
    destructive: boolean;
  } | null => {
    if (confirm === "abort") {
      const n = thinkingSelected.length;
      const idle = selected.length - n;
      return {
        count: n,
        first: {
          title:
            n === 1
              ? "Stop this session's turn?"
              : `Stop the current turn in ${n} sessions?`,
          description:
            `${plural(n, "The session stays", "The sessions stay")} connected and ${plural(n, "keeps its", "keep their")} history, so you can open ${plural(n, "it", "any of them")} and continue. A session with queued prompts starts the next one as soon as its turn stops.` +
            (idle > 0
              ? ` ${idle} selected ${plural(idle, "session is", "sessions are")} not working and left alone.`
              : ""),
          confirmLabel: n === 1 ? "Stop turn" : "Continue",
        },
        second: {
          title: "Confirm the stop",
          description: `This interrupts ${n} running turns, each on the node that runs it.`,
          confirmLabel: `Stop ${n} turns`,
        },
        confirmingLabel: "Stopping...",
        onConfirm: handleStopTurn,
        destructive: false,
      };
    }
    if (confirm === "archive") {
      const n = connectedSelected.length;
      return {
        count: n,
        first: {
          title:
            n === 1 ? "Disconnect this session?" : `Disconnect ${n} sessions?`,
          description: `${plural(n, "Its process stops", "Their processes stop")}. You can reconnect ${plural(n, "it", "each one")} later from the session list.`,
          confirmLabel: n === 1 ? "Disconnect" : "Continue",
        },
        second: {
          title: "Confirm the disconnect",
          description: `This disconnects ${n} sessions, each on the node that runs it.`,
          confirmLabel: `Disconnect ${n} sessions`,
        },
        confirmingLabel: "Disconnecting...",
        onConfirm: handleDisconnect,
        destructive: false,
      };
    }
    if (confirm === "delete") {
      const n = selected.length;
      return {
        count: n,
        first: {
          title: someConnected
            ? `${connectedSelected.length} of ${n} selected session${n === 1 ? " is" : "s are"} still connected`
            : "Delete Selected Sessions",
          description: someConnected
            ? `Disconnect ${connectedSelected.length === 1 ? "it" : "them"} automatically and delete all ${n} selected session${n === 1 ? "" : "s"}? This action cannot be undone.`
            : `Delete ${n} disconnected session${n === 1 ? "" : "s"}? This action cannot be undone.`,
          confirmLabel: n === 1 ? "Delete" : "Continue",
        },
        second: {
          title: "Confirm the delete",
          description: `This permanently deletes ${n} sessions with their message history and queued prompts. A session that cannot be disconnected is left in place.`,
          confirmLabel: `Delete ${n} sessions`,
        },
        confirmingLabel: "Deleting...",
        onConfirm: handleDelete,
        destructive: true,
      };
    }
    return null;
  })();

  return (
    <div className="flex items-center justify-end gap-4 px-3.5 py-0.5 bg-[var(--app-bg)] border-b border-[var(--app-divider)]">
      <Chip label="All" onClick={() => onSelectAll(sessions.map(s => s.id))} />
      {/* Enabled for ANY selected id, including ones the filter hides — otherwise
          they could not be cleared and would reappear selected (#3815-16). */}
      <Chip
        label="None"
        onClick={onSelectNone}
        disabled={selectedIds.size === 0}
      />
      <Chip
        label="Connect"
        onClick={handleConnect}
        disabled={disconnectedSelected.length === 0 || isPending}
      />
      <Chip
        label="Disconnect"
        onClick={() => setConfirm("archive")}
        disabled={connectedSelected.length === 0 || isPending}
      />
      <Chip
        label="Stop turn"
        tone="warning"
        onClick={() => setConfirm("abort")}
        disabled={thinkingSelected.length === 0 || isPending}
      />
      <Chip
        label="Delete"
        tone="danger"
        onClick={() => setConfirm("delete")}
        disabled={!hasSelection || isPending}
      />

      {confirmProps ? (
        <BulkActionConfirm
          isOpen
          onClose={() => setConfirm(null)}
          note={hiddenNote}
          isPending={isPending}
          {...confirmProps}
        />
      ) : null}
    </div>
  );
}
