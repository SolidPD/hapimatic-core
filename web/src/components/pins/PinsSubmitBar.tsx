// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo, useRef, useState, type ReactNode } from "react";
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
  ACTION_COLLAPSE_RANK,
  ACTION_ICON_ONLY_PADDING_PX,
  ACTION_LABEL_ATTR,
  ACTION_RANK_ATTR,
  ACTION_WHOLE_ATTR,
  useActionRowFit,
} from "@/lib/pins/actionRowFit";
import {
  canStageRecommendation,
  stageRecommendations,
  useStagedPins,
} from "@/lib/pins/staging";
import { countSubmittable } from "@/lib/pins/submission";
import { useStagingFailureToast } from "@/lib/pins/useStagingFailureToast";

const BUTTON_STYLE = { height: "28px", fontSize: "12px" } as const;
const ICON_ONLY_STYLE = {
  ...BUTTON_STYLE,
  paddingLeft: `${ACTION_ICON_ONLY_PADDING_PX}px`,
  paddingRight: `${ACTION_ICON_ONLY_PADDING_PX}px`,
} as const;
const USE_ALL = "Use all recommendations";

/**
 * The bar's one line, in a component of its own so the row exists whenever the
 * fit is measured (the bar itself renders nothing while there is nothing to
 * send). `children` is told when Use all recommendations shows only its icon.
 */
function BarRow(props: { children: (iconOnly: boolean) => ReactNode }) {
  const row = useRef<HTMLDivElement>(null);
  const iconOnly = useActionRowFit(row) >= ACTION_COLLAPSE_RANK.use;
  return (
    <div
      ref={row}
      className="mx-auto flex w-full max-w-content items-center gap-2"
    >
      {props.children(iconOnly)}
    </div>
  );
}

/**
 * #6450: the Pins tab's Submit bar (mockup v6 `renderSubmit()` :931-936), one
 * line pinned below the page's scroll box. Shown while anything is staged or an
 * open pin has a recommendation not yet chosen. E (#6451) owns the top toolbar.
 * #6539 (R13): when the bar is short of room, Use all recommendations gives way
 * to its check icon before the count ("1 ready") is cut.
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
      <BarRow>
        {iconOnly => (
          <>
            {recommendable.length > 0 ? (
              <HoverTooltipButton
                type="button"
                aria-label={USE_ALL}
                {...{ [ACTION_RANK_ATTR]: ACTION_COLLAPSE_RANK.use }}
                content="Choose the recommended option on every open pin you have not answered"
                onClick={() => {
                  const n = stageRecommendations(sessionId, pins, "pins");
                  showToast(
                    `Chose ${n} recommendation${n === 1 ? "" : "s"}. Check them, then Submit`,
                    { type: "info" }
                  );
                }}
                className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-[var(--app-border)] px-2 font-semibold text-[var(--app-fg)] hover:bg-[var(--app-hover)]"
                style={iconOnly ? ICON_ONLY_STYLE : BUTTON_STYLE}
              >
                <Check className="h-3 w-3" aria-hidden />
                <span
                  {...{ [ACTION_LABEL_ATTR]: "" }}
                  className={iconOnly ? "hidden" : undefined}
                >
                  {USE_ALL}
                </span>
              </HoverTooltipButton>
            ) : null}
            <span
              {...{ [ACTION_WHOLE_ATTR]: "" }}
              className="ml-auto min-w-0 truncate text-[length:var(--text-body-dense)] text-[var(--app-hint)]"
            >
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
          </>
        )}
      </BarRow>
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
