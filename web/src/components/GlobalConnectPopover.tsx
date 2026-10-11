// SPDX-License-Identifier: AGPL-3.0-only
import { useState, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { SessionSummary } from "@/types/api";
import type { ApiClient } from "@/api/client";
import { ChainIcon } from "@/components/icons";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/Toast";
import { queryKeys } from "@/lib/query-keys";

type GlobalConnectPopoverProps = {
  sessions: SessionSummary[];
  api: ApiClient | null;
};

export function GlobalConnectPopover({
  sessions,
  api,
}: GlobalConnectPopoverProps) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<
    "disconnect" | "reconnect" | null
  >(null);
  const [isPending, setIsPending] = useState(false);
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  // Filter out sessions on offline nodes
  const connectableSessions = useMemo(
    () => sessions.filter(s => s.active && s.nodeStatus !== "offline"),
    [sessions]
  );
  const reconnectableSessions = useMemo(
    () => sessions.filter(s => !s.active && s.nodeStatus !== "offline"),
    [sessions]
  );

  const handleDisconnectAll = async () => {
    if (!api) return;
    setIsPending(true);
    try {
      const results = await Promise.allSettled(
        connectableSessions.map(s => api.archiveSession(s.id))
      );
      const succeeded = results.filter(r => r.status === "fulfilled").length;
      const failed = results.filter(r => r.status === "rejected").length;
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.federationAllSessions,
      });
      if (failed > 0) {
        showToast(
          `Disconnected ${succeeded} of ${connectableSessions.length} sessions (${failed} failed)`,
          { type: "error" }
        );
      } else {
        showToast(`Disconnected ${succeeded} sessions`, { type: "success" });
      }
    } finally {
      setIsPending(false);
      setConfirmAction(null);
    }
  };

  const handleReconnectAll = async () => {
    if (!api) return;
    setIsPending(true);
    try {
      const results = await Promise.allSettled(
        reconnectableSessions.map(s => api.reconnectSession(s.id))
      );
      const succeeded = results.filter(r => r.status === "fulfilled").length;
      const failed = results.filter(r => r.status === "rejected").length;
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.federationAllSessions,
      });
      if (failed > 0) {
        showToast(
          `Reconnected ${succeeded} of ${reconnectableSessions.length} sessions (${failed} failed)`,
          { type: "error" }
        );
      } else {
        showToast(`Reconnected ${succeeded} sessions`, { type: "success" });
      }
    } finally {
      setIsPending(false);
      setConfirmAction(null);
    }
  };

  const hasConnected = connectableSessions.length > 0;
  const hasDisconnected = reconnectableSessions.length > 0;

  return (
    <>
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            className="h-auto rounded-full p-1.5 text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)]"
            title="Connect/Disconnect sessions"
          >
            <ChainIcon className="h-5 w-5" connected={false} />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className={
            /* design-tokens-allow: 160px popover menu min-width, no exact spacing token (scale tops at 32px) (L8 #3410) */ "w-auto min-w-[160px] p-0 bg-[var(--app-bg)]"
          }
        >
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              if (hasConnected) {
                setConfirmAction("disconnect");
                setPopoverOpen(false);
              }
            }}
            disabled={!hasConnected}
            className={`h-auto w-full justify-start whitespace-nowrap rounded-none px-3 py-2 text-left text-sm font-normal transition-colors ${
              hasConnected
                ? "text-[var(--app-fg)] hover:bg-[var(--app-hover)]"
                : "text-[var(--app-hint)] opacity-50 cursor-not-allowed"
            }`}
          >
            Disconnect all ({connectableSessions.length})
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              if (hasDisconnected) {
                setConfirmAction("reconnect");
                setPopoverOpen(false);
              }
            }}
            disabled={!hasDisconnected}
            className={`h-auto w-full justify-start whitespace-nowrap rounded-none border-t border-[var(--app-border)] px-3 py-2 text-left text-sm font-normal transition-colors ${
              hasDisconnected
                ? "text-[var(--app-fg)] hover:bg-[var(--app-hover)]"
                : "text-[var(--app-hint)] opacity-50 cursor-not-allowed"
            }`}
          >
            Reconnect all ({reconnectableSessions.length})
          </Button>
        </PopoverContent>
      </Popover>

      <ConfirmDialog
        isOpen={confirmAction === "disconnect"}
        onClose={() => setConfirmAction(null)}
        title="Disconnect All Sessions"
        description={`Disconnect all ${connectableSessions.length} active session${connectableSessions.length === 1 ? "" : "s"}?`}
        confirmLabel="Disconnect All"
        confirmingLabel="Disconnecting..."
        onConfirm={handleDisconnectAll}
        isPending={isPending}
      />

      <ConfirmDialog
        isOpen={confirmAction === "reconnect"}
        onClose={() => setConfirmAction(null)}
        title="Reconnect All Sessions"
        description={`Reconnect ${reconnectableSessions.length} disconnected session${reconnectableSessions.length === 1 ? "" : "s"}? Any that are still running will be safely re-attached, not restarted.`}
        confirmLabel="Reconnect All"
        confirmingLabel="Reconnecting..."
        onConfirm={handleReconnectAll}
        isPending={isPending}
      />
    </>
  );
}
