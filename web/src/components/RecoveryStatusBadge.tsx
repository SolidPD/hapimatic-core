// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Recovery Status Badge Component
 *
 * Displays the recovery status of a session with appropriate styling
 * and animations for recovering sessions.
 */

import type { RecoveryStatus } from "@/types/api";
import type { StalenessStatus } from "@/hooks/useSessionStaleness";

interface RecoveryStatusBadgeProps {
  status: RecoveryStatus | undefined;
  className?: string;
}

export function RecoveryStatusBadge({
  status,
  className = "",
}: RecoveryStatusBadgeProps) {
  if (!status || status === "none" || status === "recovered") {
    return null;
  }

  if (status === "recovering") {
    return (
      <span
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-xs rounded-md bg-[var(--app-badge-warning-bg)] text-[var(--app-badge-warning-text)] ${className}`}
      >
        <RecoveringSpinner />
        Recovering
      </span>
    );
  }

  if (status === "failed") {
    return (
      <span
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-xs rounded-md bg-[var(--app-badge-error-bg)] text-[var(--app-badge-error-text)] ${className}`}
      >
        <WarningIcon />
        Recovery Failed
      </span>
    );
  }

  return null;
}

function RecoveringSpinner() {
  return (
    <svg
      className="animate-spin h-3 w-3"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}

function WarningIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      className="h-3 w-3"
    >
      <path
        fillRule="evenodd"
        d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z"
        clipRule="evenodd"
      />
    </svg>
  );
}

/**
 * Helper to get status dot color based on session state and recovery status
 *
 * Status priority (highest to lowest):
 * 1. Recovery status (recovering, failed)
 * 2. Active + Waiting for user question = Orange (Claude blocked on user input)
 * 3. Active + Thinking + Unresponsive = Gray pulsing (likely dead)
 * 4. Active + Thinking + Stale = Orange pulsing (may be unresponsive)
 * 5. Active + Thinking = Blue (Claude working)
 * 6. Active + Needs Review = Orange (Claude finished, user hasn't viewed)
 * 7. Active + Idle = Green (connected, nothing new)
 * 8. Inactive = Gray (disconnected)
 */
export function getStatusDotClass(
  active: boolean,
  thinking: boolean,
  needsReview: boolean,
  recoveryStatus?: RecoveryStatus,
  isWaitingForUserQuestion?: boolean,
  staleness?: StalenessStatus,
  // Issue #1647: a session that hit the 429 session limit and is waiting for the
  // quota window to reset.
  rateLimited?: boolean
): string {
  // Recovery status takes precedence
  if (recoveryStatus === "recovering") {
    return "bg-[var(--app-badge-warning-text)] animate-pulse";
  }
  if (recoveryStatus === "failed") {
    return "bg-[var(--app-badge-error-text)]";
  }

  // Normal status
  if (active) {
    // Issue #1647: rate-limited ranks above thinking/review — a rate-limited
    // session is neither working nor idle; it is stuck until the quota resets.
    // Violet distinguishes it from blue (working) / green (idle) / orange
    // (review). Pulses to read as "blocked, will self-resume".
    // Violet - rate-limited (429 session limit). Tokenized in #3393 as
    // --status-cat-rate-limited, extending the landed #3334 session-status quad.
    if (rateLimited) return "bg-[var(--status-cat-rate-limited)] animate-pulse"; // rate-limited violet (was #AF52DE → --status-cat-rate-limited, #3393)
    if (isWaitingForUserQuestion) return "bg-[var(--status-cat-attention)]"; // waiting for user input (was #FF9500 → --status-cat-attention, #3356)
    if (thinking) {
      if (staleness === "unresponsive")
        return "bg-[var(--app-hint)] animate-pulse"; // Gray pulsing - likely dead
      if (staleness === "stale")
        return "bg-[var(--status-cat-attention)] animate-pulse"; // may be stale (was #FF9500 — not a real amber → --status-cat-attention, #3356)
      return "bg-[var(--status-cat-working)] animate-pulse"; // Claude working (was #007AFF → --status-cat-working; breathes in sync with the timer, #2505; #3356)
    }
    if (needsReview) return "bg-[var(--status-cat-attention)]"; // awaiting review (was #FF9500 → --status-cat-attention, #3356)
    return "bg-[var(--app-badge-success-text)]"; // Green - idle
  }
  return "bg-[var(--app-hint)]"; // Gray - disconnected
}
