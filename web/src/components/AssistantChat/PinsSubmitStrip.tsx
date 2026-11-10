// SPDX-License-Identifier: AGPL-3.0-only
import { Suspense, useEffect, useRef, useState } from "react";
import type { ApiClient } from "@/api/client";
import { useToast } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { lazyWithLoadError } from "@/lib/lazyWithPreload";
import { useVersion } from "@/hooks/useVersion";
import { useStagedCount } from "@/lib/pins/staging";
import { useStagingFailureToast } from "@/lib/pins/useStagingFailureToast";
// Types only: the dialog itself loads lazily, in the Pins chunk.
import type { SubmitDialogSession } from "@/components/pins/PinsSubmitDialog";

type SubmitDialogProps = {
  api: ApiClient | null;
  session: SubmitDialogSession;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** A dialog whose chunk cannot load says so once and closes. */
function SubmitDialogLoadError(props: SubmitDialogProps): null {
  const { showToast } = useToast();
  const said = useRef(false);
  const { onOpenChange } = props;
  useEffect(() => {
    if (said.current) return;
    said.current = true;
    showToast("Could not load Submit. Reload the app and try again", {
      type: "error",
    });
    onOpenChange(false);
  }, [onOpenChange, showToast]);
  return null;
}

// The dialog loads its schemas, so it lives in the Pins chunk.
const LazyPinsSubmitDialog = lazyWithLoadError<SubmitDialogProps>(
  () =>
    import("@/components/pins/PinsSubmitDialog").then(m => ({
      default: m.PinsSubmitDialog,
    })),
  SubmitDialogLoadError
);

/**
 * #6450: Submit from the chat (KD10), one compact row above the composer beside
 * the rate-limit and terminal-prompt banners. Nothing while the Pins gate is
 * closed or nothing is staged. Main bundle, so it reads only the Zod-free
 * staging store and lazy-loads the dialog.
 */
export function PinsSubmitStrip(props: {
  api: ApiClient | null;
  session: SubmitDialogSession & { metadata?: { name?: string | null } | null };
  /**
   * #6454: name the session on the line, where one page shows several Submit
   * surfaces (a Project Manager's lane boxes), so none reads as the page's own.
   */
  forName?: string;
}) {
  const { api, session } = props;
  const pinsEnabled = useVersion().data?.pinsEnabled === true;
  const count = useStagedCount(session.id);
  const [open, setOpen] = useState(false);
  useStagingFailureToast();
  if (!pinsEnabled || (count === 0 && !open)) return null;
  const inactive = session.active !== true;
  return (
    <div className="px-3 pb-1">
      <div className="mx-auto flex w-full max-w-content items-center gap-2 rounded-md border border-[var(--app-border)] px-2.5 py-1">
        <span className="min-w-0 flex-1 truncate text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
          <span aria-hidden>📌 </span>
          <b className="text-[var(--app-fg)]">{count}</b>{" "}
          {/* Inside a lane box the name matters most: kept short so it shows. */}
          {props.forName
            ? `${count === 1 ? "pin" : "pins"} ready for ${props.forName}`
            : `${count === 1 ? "pin" : "pins"} with updates ready`}
        </span>
        <Button
          type="button"
          variant="accent"
          size="sm"
          tooltipOnDisabled
          title={
            inactive
              ? "The session is not running. Submit offers to resume it, or to send your answers to its Project Manager when one runs on this node"
              : "Review and send your pin answers to the session"
          }
          disabled={count === 0}
          onClick={() => setOpen(true)}
          className="h-7 shrink-0"
        >
          Submit
        </Button>
      </div>
      {open ? (
        <Suspense fallback={null}>
          <LazyPinsSubmitDialog
            api={api}
            session={{
              ...session,
              name: session.name ?? session.metadata?.name ?? null,
            }}
            open={open}
            onOpenChange={setOpen}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
