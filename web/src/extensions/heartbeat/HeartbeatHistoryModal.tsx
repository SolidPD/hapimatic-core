// SPDX-License-Identifier: AGPL-3.0-only
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import type { ApiClient } from "@/api/client";
import { useHeartbeatHistory } from "@/extensions/heartbeat/useHeartbeat";

export function HeartbeatHistoryModal(props: {
  api: ApiClient;
  isOpen: boolean;
  onClose: () => void;
}) {
  const { api, isOpen, onClose } = props;
  const { history, isLoading } = useHeartbeatHistory(api, isOpen);

  return (
    <Dialog open={isOpen} onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-w-sm max-h-[80vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-4 py-3 border-b border-[var(--app-divider)] shrink-0">
          <div className="flex items-center justify-between">
            <DialogTitle className="text-base font-semibold">
              Heartbeat History
            </DialogTitle>
            <DialogDescription className="sr-only">
              Recent heartbeat tick results
            </DialogDescription>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto p-3">
          {isLoading ? (
            <div className="flex items-center justify-center py-8 text-sm text-[var(--app-hint)]">
              Loading...
            </div>
          ) : history.length === 0 ? (
            <div className="flex items-center justify-center py-8 text-sm text-[var(--app-hint)]">
              No heartbeat history yet
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {history.map((entry, i) => (
                <div
                  key={`${entry.timestamp}-${i}`}
                  className="rounded-lg bg-[var(--app-secondary-bg)] p-2.5 text-xs"
                >
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`h-2 w-2 rounded-full ${
                          entry.skipped
                            ? "bg-yellow-400"
                            : entry.success
                              ? "bg-green-400"
                              : "bg-red-400"
                        }`}
                      />
                      <span className="font-medium text-[var(--app-fg)]">
                        #{entry.beatNumber}
                      </span>
                    </div>
                    <span className="text-[var(--app-hint)]">
                      {new Date(entry.timestamp).toLocaleString()}
                    </span>
                  </div>

                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[var(--app-hint)]">
                    <span>
                      Status:{" "}
                      <span className="text-[var(--app-fg)]">
                        {entry.skipped
                          ? `Skipped (${entry.skipReason ?? "unknown"})`
                          : entry.success
                            ? "Success"
                            : "Failed"}
                      </span>
                    </span>
                    <span>
                      Duration:{" "}
                      <span className="text-[var(--app-fg)]">
                        {(entry.durationMs / 1000).toFixed(1)}s
                      </span>
                    </span>
                    {entry.responseLength !== undefined && (
                      <span>
                        Response:{" "}
                        <span className="text-[var(--app-fg)]">
                          {entry.responseLength} chars
                          {entry.suppressed && " (suppressed)"}
                        </span>
                      </span>
                    )}
                    {entry.error && (
                      <span className="basis-full">
                        Error:{" "}
                        <span className="text-red-400 break-all">
                          {entry.error}
                        </span>
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
