// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo, useState } from "react";
import { Check } from "lucide-react";
import type { ApiClient } from "@/api/client";
import { useToast } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { HoverTooltipButton } from "@/components/ui/tooltip";
import {
  PinsSubmitDialog,
  type SubmitDialogSession,
} from "@/components/pins/PinsSubmitDialog";
import { usePins } from "@/hooks/queries/usePins";
import {
  canStageRecommendation,
  stageRecommendations,
  useStagedPins,
} from "@/lib/pins/staging";
import { countSubmittable } from "@/lib/pins/submission";
import { useStagingFailureToast } from "@/lib/pins/useStagingFailureToast";

const BUTTON_STYLE = { height: "28px", fontSize: "12px" } as const;

/**
 * #6450: the Pins tab's Submit bar (mockup v6 `renderSubmit()` :931-936), one
 * line pinned below the page's scroll box. Shown while anything is staged or an
 * open pin has a recommendation not yet chosen. E (#6451) owns the top toolbar.
 */
export function PinsSubmitBar(props: {
  api: ApiClient | null;
  session: SubmitDialogSession & { metadata?: { name?: string | null } | null };
}) {
  const { api, session } = props;
  const sessionId = session.id;
  const { data } = usePins(api, sessionId, true);
  const staged = useStagedPins(sessionId);
  const { showToast } = useToast();
  const [open, setOpen] = useState(false);
  useStagingFailureToast();

  const pins = data?.kind === "ready" ? data.pins : null;
  const recommendable = useMemo(
    () =>
      (pins ?? []).filter(pin => canStageRecommendation(pin, staged[pin.key])),
    [pins, staged]
  );
  // #6452: a pending automatic-pick change counts, so it can be sent alone.
  const count = useMemo(
    () => countSubmittable(staged, pins ?? []),
    [staged, pins]
  );
  // Kept while the dialog is open: a Submit that clears staging must still show
  // its result (a moot answer leaves nothing staged).
  if (!pins || (count === 0 && recommendable.length === 0 && !open)) {
    return null;
  }

  const inactive = session.active !== true;
  return (
    <div className="border-t border-[var(--app-divider)] bg-[var(--app-bg)] px-3 py-1.5">
      <div className="mx-auto flex w-full max-w-content items-center gap-2">
        {recommendable.length > 0 ? (
          <HoverTooltipButton
            type="button"
            content="Choose the recommended option on every open pin you have not answered"
            onClick={() => {
              const n = stageRecommendations(sessionId, pins, "pins");
              showToast(
                `Chose ${n} recommendation${n === 1 ? "" : "s"}. Check them, then Submit`,
                { type: "info" }
              );
            }}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-[var(--app-border)] px-2 font-semibold text-[var(--app-fg)] hover:bg-[var(--app-hover)]"
            style={BUTTON_STYLE}
          >
            <Check className="h-3 w-3" aria-hidden />
            Use all recommendations
          </HoverTooltipButton>
        ) : null}
        <span className="ml-auto min-w-0 truncate text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
          <b className="text-[var(--app-fg)]">{count}</b>{" "}
          {/* Short on a phone, where Use all recommendations shares the line. */}
          <span className="sm:hidden">ready</span>
          <span className="hidden sm:inline">
            {count === 1 ? "pin" : "pins"} with updates ready
          </span>
        </span>
        <Button
          type="button"
          variant="accent"
          size="sm"
          tooltipOnDisabled
          title={
            count === 0
              ? "Nothing staged to send"
              : inactive
                ? "The session is not running. Submit offers to resume it, or to send your answers to its Project Manager when one runs on this node"
                : "Review and send your answers to the session"
          }
          disabled={count === 0}
          onClick={() => setOpen(true)}
          className="shrink-0"
        >
          Submit
        </Button>
      </div>
      {open ? (
        <PinsSubmitDialog
          api={api}
          session={{
            ...session,
            name: session.name ?? session.metadata?.name ?? null,
          }}
          open={open}
          onOpenChange={setOpen}
        />
      ) : null}
    </div>
  );
}
