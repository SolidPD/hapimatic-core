// SPDX-License-Identifier: AGPL-3.0-only
import { useState, useEffect, useRef, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import type { ApiClient } from "@/api/client";
import { useHeartbeatInstructions } from "@/extensions/heartbeat/useHeartbeat";
import { useHeartbeatMutations } from "@/extensions/heartbeat/useHeartbeatActions";
import { CloseIcon } from "@/components/ui/icons";

export function InstructionsEditorModal(props: {
  api: ApiClient;
  isOpen: boolean;
  onClose: () => void;
}) {
  const { api, isOpen, onClose } = props;
  const { content, isLoading } = useHeartbeatInstructions(api, isOpen);
  const { updateInstructions, isPending } = useHeartbeatMutations(api);
  const [localContent, setLocalContent] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Sync local state when content loads or modal opens
  useEffect(() => {
    if (isOpen) {
      setLocalContent(content);
      setSaveError(null);
    }
  }, [isOpen, content]);

  // Focus textarea when modal opens
  useEffect(() => {
    if (isOpen && !isLoading && textareaRef.current) {
      const timer = setTimeout(() => {
        textareaRef.current?.focus();
      }, 100);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [isOpen, isLoading]);

  const handleSave = useCallback(async () => {
    setSaveError(null);
    try {
      await updateInstructions(localContent);
      onClose();
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : "Failed to save instructions"
      );
    }
  }, [localContent, updateInstructions, onClose]);

  return (
    <Dialog open={isOpen} onOpenChange={open => !open && onClose()}>
      <DialogContent fullscreen className="flex flex-col p-0 gap-0">
        <DialogHeader className="px-4 py-3 border-b border-[var(--app-divider)] shrink-0">
          <div className="flex items-center justify-between">
            <DialogTitle className="text-base font-semibold">
              Heartbeat Instructions
            </DialogTitle>
            <DialogDescription className="sr-only">
              Edit heartbeat standing orders file
            </DialogDescription>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-full transition-colors text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-hover)]"
              title="Close"
            >
              <CloseIcon className="h-4 w-4" />
            </button>
          </div>
        </DialogHeader>

        <div className="flex-1 p-4 overflow-hidden">
          {isLoading ? (
            <div className="flex h-full items-center justify-center text-sm text-[var(--app-hint)]">
              Loading...
            </div>
          ) : (
            <textarea
              autoCapitalize="none"
              ref={textareaRef}
              value={localContent}
              onChange={e => setLocalContent(e.target.value)}
              placeholder="Enter standing orders / instructions for the heartbeat agent..."
              className="w-full h-full resize-none rounded-lg bg-[var(--app-secondary-bg)] border border-[var(--app-divider)] px-4 py-3 text-sm leading-snug text-[var(--app-fg)] placeholder-[var(--app-hint)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)]"
              style={{ fontSize: "16px" }}
            />
          )}
        </div>

        {/* Footer with save/cancel */}
        <div className="px-4 py-3 border-t border-[var(--app-divider)] shrink-0">
          {saveError && (
            <div className="mb-2 text-xs text-red-400">{saveError}</div>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-3 py-1.5 text-sm text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={isPending}
              className="rounded-lg bg-[var(--brand-accent)] px-4 py-1.5 text-sm font-medium text-[var(--brand-primary)] transition-opacity hover:opacity-80 disabled:opacity-50"
            >
              {isPending ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
