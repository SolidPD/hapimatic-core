// SPDX-License-Identifier: AGPL-3.0-only
import type { FederationDeps } from "./shared";

/** The throttle key for this node's own reader (peer keys are their node ids). */
export const LOCAL_DEGRADED_LOG_KEY = "\u0000local";

/** How long a repeated, unchanged failure stays quiet in the log. */
export const DEGRADED_LOG_REPEAT_MS = 15 * 60_000;

/**
 * A per-node log throttle for degraded federation reads (issue #5420). The
 * aggregate is polled every 60 s by every open tab, and a peer receiver is hit by
 * every hub, so an unthrottled warning would write one row per poll. A failure is
 * logged when it first appears, again when its reason changes, and otherwise at
 * most once per {@link DEGRADED_LOG_REPEAT_MS}; a success clears the node so its
 * next failure logs at once. The map holds one entry per node, so it is bounded by
 * the mesh size.
 *
 * Shared by the account-health and provider-auth-state aggregators (#5417). Each
 * route factory makes its own instance, so their throttles stay independent.
 *
 * A failure counts as logged only once ErrorLogger took it: a warning its
 * per-category rate limit dropped wrote nothing, so the node stays unrecorded and
 * the next poll tries again (issue #5739).
 */
export function createDegradedLog(deps: Pick<FederationDeps, "errorLogger">) {
  const last = new Map<string, { reason: string; at: number }>();
  return {
    warn(
      key: string,
      reason: string,
      message: string,
      context: Record<string, unknown>
    ): void {
      const t = Date.now();
      const prev = last.get(key);
      if (
        prev &&
        prev.reason === reason &&
        t - prev.at < DEGRADED_LOG_REPEAT_MS
      ) {
        return;
      }
      // #5739: a warning the logger's per-category rate limit dropped wrote
      // nothing; leave the node unrecorded so the next poll tries again instead
      // of staying quiet for DEGRADED_LOG_REPEAT_MS. Only `false` means dropped:
      // no logger (or a test fake returning nothing) reads as recorded.
      const recorded = deps.errorLogger?.log("warn", message, {
        category: "federation",
        context,
      });
      if (recorded === false) return;
      last.set(key, { reason, at: t });
    },
    ok(key: string): void {
      last.delete(key);
    },
  };
}
