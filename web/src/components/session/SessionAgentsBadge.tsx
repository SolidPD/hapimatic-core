// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { RobotIcon, TerminalIcon } from "@/components/icons";
import {
  agentRobotColor,
  clampCount,
  AGENT_SUCCESS_COLOR,
  AGENT_ERROR_COLOR,
} from "@/components/session/badgeFormat";
import { BackgroundAgentsModal } from "@/components/BackgroundAgentsModal";
import type { BackgroundShellCounts } from "@hapi/protocol/schemas";

/**
 * SessionAgentsBadge — the per-session **background-agents badge** (issue #4383,
 * DD4–DD8), PLUS the #4388 (R3, C1) background-shell indicator. Renders inside the
 * shared 76px slot owned by `SessionRightMetaRow`.
 *
 * Agents (DD4–DD8):
 *  - **S2 (full)** — alone in the slot (no loops): a bounded box with a GREEN
 *    `RobotIcon` and the bold `active·done·error` tri-count (each cell colored only
 *    when > 0).
 *  - **S3 (compact)** — side by side with the compact loop badge: the robot turns
 *    RED when any agent errored (DD8 R2); the count is `C1` (`active / total`) or
 *    `C3` (`active` only), chosen by digit count (DD7) and passed as `form`.
 *  The agent box renders ONLY when `counts.total > 0` (DD4).
 *
 * Shells (#4388 R3, operator pick C1): a SEPARATE `>_` (TerminalIcon) element
 * BESIDE the robot badge — never folded into the agent cells (DD5). It shows the
 * running count (the "pill" form) unless the slot already holds BOTH the loop
 * badge AND the agents badge, in which case it degrades to a presence DOT
 * (`shellBadgeForm`) so the 76px slot never overflows (DD7). When there are 0
 * agents but > 0 shells, the agent box stays absent (DD4) and the shell element
 * stands alone — and (2026-10-05) when NOTHING else shares the slot it takes
 * the "full" form: `w-full` with the `running·done·error` tri-count, the same
 * shape as the agents badge's S2 form, so the slot is used, not left empty.
 *
 * Tapping either element opens the `BackgroundAgentsModal` (DD10). Pointer
 * events stop here so a press never arms the row's press-and-hold drag [ER 4383-8].
 */
export function SessionAgentsBadge({
  sessionId,
  counts,
  compact = false,
  form = "C1",
  shellForm = "pill",
}: {
  sessionId: string;
  counts: {
    running: number;
    done: number;
    error: number;
    total: number;
    /** #4388 (R3): background Bash shell counts (ride the summary, D-4388-D1 = A). */
    shells?: BackgroundShellCounts;
  };
  compact?: boolean;
  form?: "C1" | "C3";
  /** #4388 (R3): the shell cell's DD7 form, decided by the slot owner
   *  (`shellBadgeForm(hasLoops, hasAgents)`): `full` when shells stand ALONE
   *  (w-full + the running·done·error tri-count, 2026-10-05), the `>_ N` pill
   *  beside one neighbour, or a presence dot when the slot is too crowded. */
  shellForm?: "full" | "pill" | "dot";
}) {
  const [modalOpen, setModalOpen] = useState(false);
  const gray = "text-[var(--app-hint)]";
  const robotColor = agentRobotColor(counts, compact);
  const active = clampCount(counts.running);
  const done = clampCount(counts.done);
  const error = clampCount(counts.error);
  const total = clampCount(counts.total);

  const label = `${active}·${done}·${error}`;
  const aria = `${counts.running} running, ${counts.done} done, ${counts.error} error background agent${counts.total === 1 ? "" : "s"}`;

  const hasAgents = counts.total > 0;
  const shells = counts.shells;
  const hasShells = !!shells && shells.total > 0;
  // #4388 R3 (C1): `shellForm` ("pill" | "dot") is decided by the slot owner.
  const shellColor =
    hasShells && shells.error > 0
      ? AGENT_ERROR_COLOR
      : hasShells && shells.running > 0
        ? AGENT_SUCCESS_COLOR
        : gray;
  const shellTitle = hasShells
    ? `Background shells — ${clampCount(shells.running)}·${clampCount(shells.done)}·${clampCount(shells.error)} (running·done·error)`
    : "";
  const shellAria = hasShells
    ? `${shells.running} running, ${shells.done} done, ${shells.error} error background shell${shells.total === 1 ? "" : "s"}`
    : "";

  // [ER 4383-8]: stop the press from arming the row's drag/press-and-hold. One
  // handler set shared by both cells — the structural param type is compatible
  // with every React synthetic pointer/mouse/touch event.
  const stopEvt = (e: { stopPropagation: () => void }) => e.stopPropagation();
  const stopPress = {
    onPointerDown: stopEvt,
    onMouseDown: stopEvt,
    onTouchStart: stopEvt,
    onPointerUp: stopEvt,
    onMouseUp: stopEvt,
    onTouchEnd: stopEvt,
  };
  const cellClass =
    "inline-flex items-center justify-center gap-0.5 whitespace-nowrap rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-1 py-px font-semibold tabular-nums leading-none text-[length:var(--text-caption-xs)] text-[var(--app-hint)] hover:opacity-80";
  // #4388 R3 (DD7): the degraded shell DOT sheds the bordered-pill chrome
  // (border/bg/px) to a tight ">_ ●" presence mark so the triple case fits 76px.
  const shellDotClass =
    "inline-flex items-center justify-center gap-0.5 whitespace-nowrap leading-none text-[length:var(--text-caption-xs)] text-[var(--app-hint)] hover:opacity-80";

  return (
    <>
      {hasAgents && (
        <Button
          type="button"
          variant="ghostStatic"
          size="bare"
          onClick={() => setModalOpen(true)}
          {...stopPress}
          data-testid={`agents-badge-${sessionId}`}
          data-form={compact ? form : "full"}
          aria-label={aria}
          title={`Background agents — ${label} (running·done·error)`}
          className={`${cellClass} ${compact ? "" : "w-full"}`}
        >
          <RobotIcon className={`h-3 w-3 shrink-0 ${robotColor}`} />
          {!compact ? (
            // S2 full: active·done·error, 2ch cells (colored only when > 0).
            <span className="flex items-center leading-none">
              <b
                className={`inline-block w-[2ch] text-center font-bold ${active > 0 ? AGENT_SUCCESS_COLOR : gray}`}
              >
                {active}
              </b>
              <span className={gray}>·</span>
              <b
                className={`inline-block w-[2ch] text-center font-bold ${gray}`}
              >
                {done}
              </b>
              <span className={gray}>·</span>
              <b
                className={`inline-block w-[2ch] text-center font-bold ${error > 0 ? "text-[var(--app-badge-error-text)]" : gray}`}
              >
                {error}
              </b>
            </span>
          ) : form === "C1" ? (
            // S3 C1: active / total (both single digit).
            <span className="flex items-center leading-none">
              <b className={`font-bold ${AGENT_SUCCESS_COLOR}`}>{active}</b>
              <span className={gray}>/</span>
              <b className={`font-bold ${gray}`}>{total}</b>
            </span>
          ) : (
            // S3 C3: active only (a two-digit number present in the slot).
            <b className={`font-bold leading-none ${AGENT_SUCCESS_COLOR}`}>
              {active}
            </b>
          )}
        </Button>
      )}
      {hasShells && (
        // #4388 R3 (C1): the separate ">_" shell cell — agents-only cells above
        // are untouched (DD5). Pill shows the running count; dot (degraded) shows
        // presence only, with the counts in the title + the modal.
        <Button
          type="button"
          variant="ghostStatic"
          size="bare"
          onClick={() => setModalOpen(true)}
          {...stopPress}
          data-testid={`shells-badge-${sessionId}`}
          data-shell-form={shellForm}
          aria-label={shellAria}
          title={shellTitle}
          // #4388 R3 (DD7): the PILL is a full bordered cell; the degraded DOT
          // sheds the pill chrome (border/bg/padding) to a tight ">_ ●" presence
          // mark, so the triple case (loop + agents + shells) fits the 76px slot.
          // The counts live in the title + the modal.
          className={
            shellForm === "dot"
              ? shellDotClass
              : `${cellClass} ${shellForm === "full" ? "w-full" : ""}`
          }
        >
          {shellForm === "full" ? (
            // Shells ALONE in the slot (no loop, no agents): fill the 76px cell
            // with running·done·error — the agents badge's S2 full form, cell
            // for cell (2ch, colored only when > 0).
            <>
              <TerminalIcon className={`h-3 w-3 shrink-0 ${shellColor}`} />
              <span className="flex items-center leading-none">
                <b
                  className={`inline-block w-[2ch] text-center font-bold ${shells.running > 0 ? AGENT_SUCCESS_COLOR : gray}`}
                >
                  {clampCount(shells.running)}
                </b>
                <span className={gray}>·</span>
                <b
                  className={`inline-block w-[2ch] text-center font-bold ${gray}`}
                >
                  {clampCount(shells.done)}
                </b>
                <span className={gray}>·</span>
                <b
                  className={`inline-block w-[2ch] text-center font-bold ${shells.error > 0 ? "text-[var(--app-badge-error-text)]" : gray}`}
                >
                  {clampCount(shells.error)}
                </b>
              </span>
            </>
          ) : shellForm === "pill" ? (
            <>
              <TerminalIcon className={`h-3 w-3 shrink-0 ${shellColor}`} />
              <b className={`font-bold leading-none ${shellColor}`}>
                {clampCount(shells.running)}
              </b>
            </>
          ) : (
            // DD7 degraded: a bare presence dot (the ">_" + counts live in the
            // title + modal) — the only shell mark that fits beside a compact
            // loop + agents in the 76px slot.
            <span
              className={`h-1.5 w-1.5 rounded-full ${shells.error > 0 ? "bg-[var(--app-badge-error-text)]" : "bg-[var(--app-badge-success-text)]"}`}
              aria-hidden="true"
            />
          )}
        </Button>
      )}
      {/* Mount the modal ONLY when open (the loop badge's rule). */}
      {modalOpen && (
        <BackgroundAgentsModal
          sessionId={sessionId}
          open={modalOpen}
          onOpenChange={setModalOpen}
        />
      )}
    </>
  );
}
