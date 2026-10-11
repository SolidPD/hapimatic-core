// SPDX-License-Identifier: AGPL-3.0-only
/**
 * SessionRightMetaRow — the shared Row-2 "Status Icon Cluster" of the Session
 * Basic Info Bar, rendered IDENTICALLY by the Session List card and the Session
 * Instance header (issue #1050 extraction; #3287 S2 redesign — the shared
 * foundation the epic #3285 set builds on).
 *
 * Fixed-slot order (R2, E9): [Loop-Cron Badge 76px] → [Message Count 31px] →
 * [Notification Bell 16px], `gap-1` between — exactly the width of the Row-1
 * right cluster ([Account Chip] · [Node Badge], `ROW1_RIGHT_CLUSTER_PX`), so the
 * two rows form two aligned BLOCKS: Account Chip over Loop-Cron Chip (one left
 * edge) and Node Badge over [Count · Bell] (one right edge).
 *
 * E9 (operator round 11, 2026-09-06): the reserved conditional-icon slot that
 * used to lead this row is GONE. The waiting-for-input `?` was dropped outright
 * (the Row-1 status dot already carries that state), and the queued-message icon
 * is replaced by the Message Count's bubble turning YELLOW while the session's
 * server-backed queue (`useQueuedMessages`, authoritative since #1325) is
 * non-empty. Queue MANAGEMENT lives in the composer's queue icon; this row only
 * signals.
 *
 * Per D3(a) the federation NodeBadge no longer lives here — it moved to the Row-1
 * right cluster (its sole render site per surface); see SessionItem/SessionHeader.
 *
 * The badge is its own data-fetching leaf (own-instance loop summary) and the
 * queued signal reads the per-session queue query, so the row is not a pure
 * prop-passthrough.
 */
import { BellIcon, BellOffIcon, MessageSquareIcon } from "@/components/icons";
import { SessionLoopCronBadge } from "@/components/session/SessionLoopCronBadge";
import { SessionAgentsBadge } from "@/components/session/SessionAgentsBadge";
import {
  agentCompactForm,
  formatMessageCount,
  shellBadgeForm,
} from "@/components/session/badgeFormat";
import { NODE_BADGE_RADIUS_CSS } from "@/components/session/rowAnchors";
import { useAppContext } from "@/lib/app-context";
import { useSessionLoopSummaries } from "@/hooks/queries/useSessionLoopSummaries";
import type { BackgroundAgentsSummary } from "@hapi/protocol";
import { useQueuedMessages } from "@/hooks/queries/useQueuedMessages";
import { useMutedSessions } from "@/hooks/useMutedSessions";
import { useGlobalNotificationsEnabled } from "@/hooks/useGlobalNotificationsEnabled";
import { useToast } from "@/components/Toast";
import { Button } from "@/components/ui/button";

type SessionRightMetaRowProps = {
  sessionId: string;
  messageCount: number | undefined;
  /**
   * Issue #4383: background-agent counts for the slot's agents badge. Passed by
   * SessionItem from the session SUMMARY and by SessionHeader from the SESSION
   * record (both expose the same counts). `null`/absent = no background agents.
   */
  backgroundAgents?: BackgroundAgentsSummary | null;
};

/** E9 queued signal: the bubble turns yellow (warning token, tinted fill). Kept
 *  as a constant so the icon's className stays on ONE line with its
 *  `design-tokens-allow` marker — the gate only honors a same-line suppression. */
const QUEUED_BUBBLE_CLASS =
  "text-[var(--app-badge-warning-text)] fill-[var(--app-badge-warning-bg)]";

export function SessionRightMetaRow({
  sessionId,
  messageCount,
  backgroundAgents,
}: SessionRightMetaRowProps) {
  const { api } = useAppContext();
  const { isMuted, toggleMuted } = useMutedSessions();
  const globalEnabled = useGlobalNotificationsEnabled();
  const { showToast } = useToast();
  // E9: the queued signal. Server-backed queue (#1325); non-empty ⇒ yellow bubble.
  const { length: queuedCount } = useQueuedMessages(api, sessionId);
  const queued = queuedCount > 0;
  const muted = isMuted(sessionId);

  // Issue #4383: the slot composes the loop badge and/or the agents badge. Read
  // the loop summary (cached — the badge reads the same query) only to decide
  // whether a loop box is present and, in S3, to weigh the compact C1/C3 fit.
  const { bySession } = useSessionLoopSummaries(api);
  const loopTotal = bySession.get(sessionId)?.loops.length ?? 0;
  const hasLoops = loopTotal > 0;
  const agents = backgroundAgents ?? null;
  const hasAgents = !!agents && agents.total > 0;
  // #4388 R3 (C1): background Bash shell counts ride the SAME summary. The slot
  // shows a shell cell (pill/dot) whenever shells exist — even with 0 agents, in
  // which case the agent box stays absent (DD4) and the shell cell stands alone.
  const hasShells = !!agents?.shells && agents.shells.total > 0;

  return (
    <div className="flex items-center gap-1">
      {/* Issue #4383: the fixed 76px anchor slot (moved here from
          SessionLoopCronBadge). It composes up to four states: S0 empty · S1 full
          loop badge (byte-identical) · S2 full agents badge · S3 the compact loop
          + compact agents boxes side by side. The slot's testid + data-empty are
          preserved so rowAnchors alignment is unchanged. */}
      <span
        className="flex w-[76px] shrink-0 items-center justify-center gap-0.5" /* design-tokens-allow: 76px fixed anchor slot (= the Account Chip cell, E9 `--chip-w`); no --space token exceeds 32px */
        data-testid={`loop-cron-slot-${sessionId}`}
        data-empty={!hasLoops && !hasAgents && !hasShells ? "true" : undefined}
      >
        {hasLoops && (
          <SessionLoopCronBadge
            sessionId={sessionId}
            compact={hasAgents || hasShells}
          />
        )}
        {(hasAgents || hasShells) && agents && (
          <SessionAgentsBadge
            sessionId={sessionId}
            counts={agents}
            // #4388 R3: a shell cell also forces the agents badge compact (not
            // w-full) so the ">_" cell has room beside it (DD7).
            compact={hasLoops || hasShells}
            // #4388 R3 (DD7): the triple case (loop + agents + shells) crowds the
            // 76px slot, so the agents badge takes its tighter C3 form (active
            // only) — the same anti-overflow lever agentCompactForm applies for
            // multi-digit counts, extended to the extra shell cell.
            form={
              hasLoops && hasShells
                ? "C3"
                : agentCompactForm(loopTotal, agents.running, agents.total)
            }
            // #4388 R3 (C1): the ">_" pill degrades to a dot only when the slot
            // already holds BOTH the loop badge AND the agents badge (DD7).
            shellForm={shellBadgeForm(hasLoops, hasAgents)}
          />
        )}
      </span>
      {/* #3287 R4: Message Count — fixed 31px slot holding an SVG line-icon chat
          bubble (`MessageSquareIcon`, the exact E6 path — NEVER the 💬 emoji) and
          the tabular count with NO space between them (formatMessageCount →
          `999` / `1k+`). Operator ruling (2026-09-07, round 10): the content is
          LEFT-justified and the slot is padded left by the Node Badge's corner
          RADIUS (`NODE_BADGE_RADIUS_CSS`, box-content so the 31px stays the
          content width), so the bubble's left edge sits where the badge's
          straight top/bottom edge begins one row above — not on its rounded
          corner. The Node Badge cell above grows by the same radius
          (`plusNodeBadgeRadius(NODE_BADGE_CELL_PX)`), so the E9 right block
          still shares both edges — and the slot still reserves the worst-case
          `999` width so the cluster never reflows.
          The icon + count ALWAYS render (a zero/undefined count shows `0`, gray)
          — operator ruling 2026-09-05: no dead cell where the count will appear
          once the user starts messaging. E9: while ≥1 message is queued the
          bubble turns yellow (warning token, tinted fill) — the queued signal
          that replaced the dedicated queued icon. */}
      <span
        className="box-content flex w-[31px] shrink-0 items-center justify-start gap-px whitespace-nowrap tabular-nums text-[length:var(--text-caption)] text-[var(--app-hint)]" /* design-tokens-allow: 31px fixed anchor slot for worst-case `999` + icon (#3287 R4); no --space token is 31px */
        style={{ paddingLeft: NODE_BADGE_RADIUS_CSS }}
        data-testid={`message-count-${sessionId}`}
        data-queued={queued ? "true" : undefined}
        title={
          queued
            ? `${queuedCount} queued message${queuedCount > 1 ? "s" : ""}`
            : undefined
        }
      >
        <MessageSquareIcon
          className={`h-[11px] w-[11px] shrink-0 ${queued ? QUEUED_BUBBLE_CLASS : ""}`} /* design-tokens-allow: 11px E6 message-bubble glyph (mockup-pinned); no icon-size token at 11px */
        />
        <span className="leading-none">
          {formatMessageCount(messageCount ?? 0)}
        </span>
      </span>
      {/* #87 feedback (#2745 round): per-session mute bell — ONE shared site
          rendered identically by the session list AND the session-instance
          header (this placement also delivers #3076's dedupe). Tri-state
          (#3150): global-off (push not subscribed on this device) dominates as
          a gray inert bell whose tap only hints; enabled + unmuted = muted-mint
          accent; enabled + muted = red + strike. Pointer events stop here so
          the row's select/long-press never fires from a bell tap. */}
      <Button
        type="button"
        variant="ghost"
        onClick={e => {
          e.stopPropagation();
          e.preventDefault();
          if (!globalEnabled) {
            // #3150 Q3 ruling: inert under global-off — hint, never toggle.
            showToast("Notifications globally disabled", { type: "info" });
            return;
          }
          toggleMuted(sessionId);
        }}
        onPointerDown={e => e.stopPropagation()}
        onMouseDown={e => e.stopPropagation()}
        onTouchStart={e => e.stopPropagation()}
        // 🔴 The UP events too: SessionItem's row navigation runs on
        // useLongPress's onMouseUp/onTouchEnd, and its click detection fires on
        // a bare up-event even when the down was stopped here — a bell tap
        // navigated into the session until these were stopped (round-2 #87).
        onMouseUp={e => e.stopPropagation()}
        onTouchEnd={e => e.stopPropagation()}
        onPointerUp={e => e.stopPropagation()}
        aria-pressed={globalEnabled ? muted : undefined}
        aria-label={
          !globalEnabled
            ? "Notifications globally disabled"
            : muted
              ? "Unmute notifications"
              : "Mute notifications"
        }
        title={
          !globalEnabled
            ? "Notifications globally disabled"
            : muted
              ? "Notifications muted — tap to unmute"
              : "Mute notifications for this session"
        }
        className={`shrink-0 h-auto rounded-md p-0.5 font-normal hover:bg-[var(--app-hover)] ${
          !globalEnabled
            ? "text-[var(--app-hint)] hover:text-[var(--app-hint)]"
            : muted
              ? "text-red-400/80 hover:text-red-400"
              : "text-[var(--app-accent)]/70 hover:text-[var(--app-accent)]"
        }`}
      >
        {globalEnabled && muted ? (
          <BellOffIcon className="h-3 w-3" />
        ) : (
          <BellIcon className="h-3 w-3" />
        )}
      </Button>
    </div>
  );
}
