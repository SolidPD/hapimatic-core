// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { useAppContext } from "@/lib/app-context";
import { useSessionLoopSummaries } from "@/hooks/queries/useSessionLoopSummaries";
import { Button } from "@/components/ui/button";
import { StopwatchIcon } from "@/components/icons";
import {
  bestLoopCronState,
  clampCount,
  formatLoopCron,
  loopCronColor,
  loopCronColorForState,
  worstLoopCronState,
} from "@/components/session/badgeFormat";
import { LoopCronModal } from "@/components/LoopCronModal";

/**
 * SessionLoopCronBadge — the per-session **Loop-Cron Badge** chip (issue #2453;
 * #3287 tri-count; #3291 → modal; epic #3285 E6 bounded box + SVG stopwatch).
 *
 * Issue #4383 (Task 6): the fixed 76px anchor SLOT moved OUT of this component
 * into `SessionRightMetaRow` (which now composes the slot from this loop badge
 * and/or the agents badge). This component renders ONLY the chip; the row decides
 * whether it appears and in which form:
 *  - **full** (S1, default) — today's bounded box with the `live·paused·stalled`
 *    tri-count, byte-identical to before (the V2 snapshot is taken at the row).
 *  - **compact** (S3) — a narrower box sharing the slot with the agents badge:
 *    the stopwatch in the WORST state's color + the loop TOTAL in the BEST state's
 *    color (DD-E9), so the two side-by-side boxes fit the 76px slot.
 *
 * It still owns its own data (useSessionLoopSummaries — cached) and modal. Pointer
 * events stop here so a press never arms the row's press-and-hold drag [ER 4383-8].
 */
export function SessionLoopCronBadge({
  sessionId,
  compact = false,
}: {
  sessionId: string;
  compact?: boolean;
}) {
  const { api } = useAppContext();
  const { bySession } = useSessionLoopSummaries(api);
  const [modalOpen, setModalOpen] = useState(false);

  const summary = bySession.get(sessionId);
  const loops = summary?.loops ?? [];

  let live = 0;
  let paused = 0;
  let stalled = 0;
  for (const loop of loops) {
    if (loop.state === "live") live++;
    else if (loop.state === "paused") paused++;
    else stalled++;
  }
  const label = formatLoopCron(live, paused, stalled);
  const worstColor = loopCronColor(live, paused, stalled);
  const worst = worstLoopCronState(live, paused, stalled);
  const count = loops.length;
  const gray = "text-[var(--app-hint)]";

  // The row gates rendering when empty; keep a defensive self-hide so the chip
  // never renders a `0·0·0` box on its own.
  if (count === 0) return null;

  // Shared pointer-event guards ([ER 4383-8]): never arm the row's drag.
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

  const bestColor = loopCronColorForState(
    bestLoopCronState(live, paused, stalled)
  );

  return (
    <>
      <Button
        type="button"
        variant="ghostStatic"
        size="bare"
        onClick={() => setModalOpen(true)}
        onPointerDown={stop}
        onMouseDown={stop}
        onTouchStart={stop}
        onPointerUp={stop}
        onMouseUp={stop}
        onTouchEnd={stop}
        data-testid={`loop-cron-badge-${sessionId}`}
        data-worst-state={worst ?? "none"}
        data-compact={compact ? "true" : undefined}
        aria-label={`${count} scheduled loop${count === 1 ? "" : "s"}${worst ? ` (${worst})` : ""}: ${label}`}
        title={`Loop-crons — ${label} (live·paused·stalled)`}
        className={`inline-flex items-center justify-center gap-0.5 whitespace-nowrap rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-1 py-px font-semibold tabular-nums leading-none text-[length:var(--text-caption-xs)] text-[var(--app-hint)] hover:opacity-80 ${compact ? "" : "w-full"}`}
      >
        <StopwatchIcon className={`h-3 w-3 shrink-0 ${worstColor}`} />
        {compact ? (
          // S3 compact: the total only, in the best (most-alive) state's color.
          <b className={`font-bold leading-none ${bestColor}`}>
            {clampCount(count)}
          </b>
        ) : (
          // S1 full: the live·paused·stalled tri-count (byte-identical to today).
          <span className="flex items-center leading-none">
            <b
              className={`inline-block w-[2ch] text-center font-bold ${live > 0 ? "text-[var(--app-badge-success-text)]" : gray}`}
            >
              {live}
            </b>
            <span className={gray}>·</span>
            <b
              className={`inline-block w-[2ch] text-center font-bold ${paused > 0 ? "text-[var(--app-badge-warning-text)]" : gray}`}
            >
              {paused}
            </b>
            <span className={gray}>·</span>
            <b
              className={`inline-block w-[2ch] text-center font-bold ${stalled > 0 ? "text-[var(--app-badge-error-text)]" : gray}`}
            >
              {stalled}
            </b>
          </span>
        )}
      </Button>
      {/* Mount the modal ONLY when open (unchanged). */}
      {modalOpen && (
        <LoopCronModal
          sessionId={sessionId}
          open={modalOpen}
          onOpenChange={setModalOpen}
        />
      )}
    </>
  );
}
