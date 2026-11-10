// SPDX-License-Identifier: AGPL-3.0-only
import { useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  applyScrollRecorderUrlParam,
  clearScrollLog,
  formatScrollLog,
  getScrollLogSize,
  isScrollRecorderEnabled,
  subscribeScrollLog,
} from "@/lib/scrollCauseRecorder";

// Apply `?scrollrec=` before reading the switch: the panel renders before the thread's layout
// effect would apply it, so a first visit with `?scrollrec=1` recorded but showed no pill.
function readRecorderSwitch(): boolean {
  if (typeof window !== "undefined") {
    applyScrollRecorderUrlParam(window.location.search);
  }
  return isScrollRecorderEnabled();
}

/**
 * In-thread control for the #6122 scroll-cause recorder. Renders nothing unless the recorder
 * is switched on (Settings → Preferences → Diagnostics, or `?scrollrec=1`). It shows the
 * entry count, Copy and Clear. Copy uses the clipboard when the browser allows it. Otherwise (an insecure origin
 * such as a worktree instance over plain http, or iOS refusing) it opens the log in a dialog,
 * already selected, so it can be copied by hand.
 */
export function ScrollRecorderPanel() {
  const [enabled] = useState(readRecorderSwitch);
  const size = useSyncExternalStore(
    subscribeScrollLog,
    getScrollLogSize,
    getScrollLogSize
  );
  const [copied, setCopied] = useState(false);
  const [fallbackText, setFallbackText] = useState<string | null>(null);

  if (!enabled) return null;

  const copy = () => {
    const text = formatScrollLog();
    const clipboard =
      typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (!clipboard?.writeText) {
      setFallbackText(text);
      return;
    }
    clipboard.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => setFallbackText(text)
    );
  };

  return (
    <>
      <div
        className="absolute left-1 top-1 z-20 flex items-center gap-1 rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-1.5 py-0.5 text-xs text-[var(--app-hint)]"
        data-testid="scroll-recorder-panel"
      >
        <span aria-label={`Scroll recorder on, ${size} entries`}>
          REC {size}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 text-xs"
          onClick={copy}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 text-xs"
          onClick={() => clearScrollLog()}
        >
          Clear
        </Button>
      </div>
      <Dialog
        open={fallbackText !== null}
        onOpenChange={open => {
          if (!open) setFallbackText(null);
        }}
      >
        <DialogContent heightVariant="threeQuarter">
          <DialogHeader>
            <DialogTitle>Scroll recorder log</DialogTitle>
            <DialogDescription>
              The clipboard is not available here. Select the text below and
              copy it.
            </DialogDescription>
          </DialogHeader>
          <textarea
            readOnly
            aria-label="Scroll recorder log text"
            className="mt-2 min-h-0 w-full flex-1 resize-none rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-2 font-mono text-xs text-[var(--app-fg)]"
            value={fallbackText ?? ""}
            onFocus={event => event.currentTarget.select()}
            autoFocus
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
