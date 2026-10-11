// SPDX-License-Identifier: AGPL-3.0-only
import { useState, useEffect } from "react";

/**
 * Staleness status for a session's thinking state.
 *
 * - "normal": Session heartbeats are arriving on schedule
 * - "stale": No heartbeat for >60s while thinking — may be unresponsive
 * - "unresponsive": No heartbeat for >180s while thinking — likely dead
 */
export type StalenessStatus = "normal" | "stale" | "unresponsive";

/** Threshold before showing "may be stale" indicator (ms) */
const STALE_THRESHOLD_MS = 60_000;

/** Threshold before showing "unresponsive" indicator (ms) */
const UNRESPONSIVE_THRESHOLD_MS = 180_000;

/** How often to re-check staleness (ms) */
const CHECK_INTERVAL_MS = 5_000;

/**
 * Detect whether a thinking session has gone stale (no heartbeats arriving).
 *
 * The CLI sends session-alive heartbeats every 2s, updating `activeAt` on the
 * server. When the CLI process dies or disconnects, `activeAt` freezes. This
 * hook periodically compares `Date.now() - activeAt` to detect the gap.
 *
 * Only triggers when the session is both `active` and `thinking`. Sessions
 * that are already inactive or idle return "normal" immediately.
 */
export function useSessionStaleness(
  thinking: boolean,
  activeAt: number,
  active: boolean
): StalenessStatus {
  const [status, setStatus] = useState<StalenessStatus>(() =>
    computeStaleness(thinking, activeAt, active)
  );

  useEffect(() => {
    // Only run the interval when the session is actively thinking
    if (!thinking || !active) {
      setStatus("normal");
      return;
    }

    // Immediate check on mount / prop change
    setStatus(computeStaleness(thinking, activeAt, active));

    const interval = setInterval(() => {
      setStatus(computeStaleness(thinking, activeAt, active));
    }, CHECK_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [thinking, activeAt, active]);

  return status;
}

/** Pure computation of staleness — extracted for testability */
export function computeStaleness(
  thinking: boolean,
  activeAt: number,
  active: boolean
): StalenessStatus {
  if (!thinking || !active) return "normal";

  const elapsed = Date.now() - activeAt;

  if (elapsed >= UNRESPONSIVE_THRESHOLD_MS) return "unresponsive";
  if (elapsed >= STALE_THRESHOLD_MS) return "stale";
  return "normal";
}

// Re-export thresholds for tests
export { STALE_THRESHOLD_MS, UNRESPONSIVE_THRESHOLD_MS, CHECK_INTERVAL_MS };
