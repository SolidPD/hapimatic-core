// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The context-watermark boundary gate (issue #2158) — the heart of R2.
 *
 * A PURE function: zero I/O, fully table-testable. It answers "may the armed
 * session begin its successor handoff at THIS finalize?" so the fire decision is
 * a truth table, not an integration test.
 *
 * 🔴 Explicit boundary markers only (the issue's Technical Note: "prefer explicit
 * boundary markers over inference"). The gate NEVER infers a boundary from
 * message content, elapsed time, or token deltas — its inputs are all explicit
 * signals the caller resolves from concrete sources (the turn-finalize seam,
 * `session.thinking`, an explicit open-transaction marker, the live session
 * count, the configured cap).
 */

import type { WatermarkDeferReason } from "@hapi/protocol";

export interface BoundaryGateInput {
  /** The session has crossed the watermark and been armed by the monitor. */
  armed: boolean;
  /** The feature kill-switch (config.enabled). */
  enabled: boolean;
  /**
   * The POSITIVE boundary signal: we are running inside the turn-finalize seam
   * for this session (a `FinalizeStep` fired). A `FinalizeStep` runs strictly
   * BETWEEN turns, never inside one — this is the explicit marker.
   */
  atTurnFinalize: boolean;
  /** Belt-and-suspenders: the session is mid-turn (thinking). */
  sessionThinking: boolean;
  /**
   * Belt-and-suspenders: an EXPLICIT open-transaction marker (a `🔒 locked:`
   * workflow label, or a non-`complete` `pm_spawn_roster` row) — never inferred.
   */
  hasOpenTransaction: boolean;
  /** Live session count on this node (for the capacity pre-check, R6). */
  activeSessionCount: number;
  /** The configured/clamped concurrency cap (R6). */
  maxConcurrent: number;
}

export interface BoundaryGateResult {
  fire: boolean;
  /** Non-null when the handoff is deferred to a later finalize; null on fire. */
  defer: WatermarkDeferReason | null;
}

/**
 * Evaluate the gate. Rules apply IN ORDER — the first that matches wins:
 *   1. `!enabled`               → defer "disabled"
 *   2. `!armed`                 → no fire (not an error, not a defer reason)
 *   3. boundary not clean       → defer "mid_transaction"
 *   4. no free slot (R6)        → defer "capacity"
 *   5. otherwise                → fire
 */
export function evaluateBoundary(input: BoundaryGateInput): BoundaryGateResult {
  if (!input.enabled) return { fire: false, defer: "disabled" };

  // Not armed is the overwhelmingly common case and is NOT an error — the gate
  // simply does nothing (no defer reason to record).
  if (!input.armed) return { fire: false, defer: null };

  // Boundary test: fire ONLY at the finalize seam, with the session idle and no
  // open transaction. Anything else is mid-transaction — defer.
  const atCleanBoundary =
    input.atTurnFinalize && !input.sessionThinking && !input.hasOpenTransaction;
  if (!atCleanBoundary) return { fire: false, defer: "mid_transaction" };

  // Capacity test (R6): a successor needs one free slot. Deferring is correct —
  // the predecessor keeps working and the gate re-evaluates next finalize.
  if (input.activeSessionCount + 1 > input.maxConcurrent) {
    return { fire: false, defer: "capacity" };
  }

  return { fire: true, defer: null };
}
