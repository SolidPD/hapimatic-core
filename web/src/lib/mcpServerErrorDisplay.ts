// SPDX-License-Identifier: AGPL-3.0-only
import type { McpBatchOutcome } from "@hapi/protocol/types";

/**
 * Per-server error display info (issue #1103).
 *
 * The MCP modal renders TWO failure surfaces for each server:
 *   1. Transient toggle errors from {@link useMcpStatus} (per-toggle RPC
 *      errors — easy to dismiss, easy to retry).
 *   2. Abandoned-batch outcomes from {@link useMcpBatch}
 *      (`done[name].abandoned === true`) — the batch coordinator gave
 *      up after MAX_FAILURES_PER_SERVER consecutive failures and will
 *      NOT retry until the user re-issues a desired-state change.
 *
 * Abandoned MUST take render priority over transient — its message
 * ("Failed after N attempts — manual retry required") is fundamentally
 * different from a transient toggle error ("ECONNREFUSED, will retry"),
 * and showing the latter while the coordinator has actually given up
 * is the silent-failure UX gap this issue fixes.
 *
 * Pure function — no React, no hooks. Test it in isolation.
 */
export interface ServerErrorDisplay {
  /**
   * Stable kind tag so the renderer can pick distinct styling /
   * dismiss behavior for terminal vs transient errors.
   */
  kind: "abandoned" | "transient";
  /** Short error code, shown as the prefix in the small text under the row. */
  code: string;
  /** Full human-readable message. */
  message: string;
  /**
   * Whether the row should show the dismissable "✕" button. Transient
   * errors are dismissable (the worker will retry on the next iteration
   * anyway). Abandoned errors are NOT dismissable: the only way to clear
   * them is for the user to re-issue {@link useMcpBatch.setDesired},
   * which triggers `state.failures.delete(name)` server-side.
   */
  dismissable: boolean;
}

export interface TransientServerError {
  message: string;
  code: string;
}

/**
 * Pick the display data for a server's error row, given the latest
 * batch outcome (from `useMcpBatch().snapshot.done[name]`) and the
 * latest transient toggle error (from `useMcpStatus().perServerErrors`).
 *
 * Returns `null` when there is nothing to display.
 *
 * Render priority (highest first):
 *   1. abandoned batch outcome  → "Failed after N attempts" (terminal)
 *   2. transient toggle error    → "<code>: <message>"     (retryable)
 *   3. nothing                   → null                     (clean state)
 */
export function selectMcpServerErrorDisplay(
  batchOutcome: McpBatchOutcome | undefined,
  transientError: TransientServerError | undefined
): ServerErrorDisplay | null {
  if (
    batchOutcome &&
    !batchOutcome.ok &&
    "abandoned" in batchOutcome &&
    batchOutcome.abandoned === true
  ) {
    return {
      kind: "abandoned",
      code: batchOutcome.code,
      message: `Failed after ${batchOutcome.attempts} attempts — manual retry required`,
      dismissable: false,
    };
  }
  if (transientError) {
    return {
      kind: "transient",
      code: transientError.code,
      message: transientError.message,
      dismissable: true,
    };
  }
  return null;
}
