// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Pure decision function for the daemon orphan-check.
 *
 * Inputs: a probe result + the tracked session's expected window.
 *  - A session with a persisted `@N` (`expected.id`) is checked by ID: the
 *    caller runs `resolveOwnedWindow` on that id and passes an
 *    {@link OrphanIdCheckResult} (issue #4218).
 *  - A legacy session (no `@N`) keeps the name compare: the caller passes the
 *    `getWindowNameByIndex` result at the tracked index ({@link OrphanCheckResult}).
 * Output: a discriminated decision the daemon loop can act on.
 *
 * Pulling this out of the inline `for (const [pid, session] of ...)` loop
 * in `daemon/run.ts` makes the logic unit-testable without spinning up
 * a real daemon. See issue #1329 for context.
 */
export type OrphanCheckResult =
  | { ok: true; name: string | null }
  | { ok: false; error: Error };

/**
 * Issue #4218: the id-keyed probe — is the tracked `@N` still a window this
 * session owns? `owned: false` covers "gone", "a recycled `@N` now held by
 * another session", and "unverifiable" — an identity-less window whose process
 * tree carries no `HAPI_SESSION_ID` (`reason` says which). All three deregister
 * the tracked PID. A tmux fault is `ok: false` and skips the check this pass.
 */
export type OrphanIdCheckResult =
  | { ok: true; owned: true }
  | { ok: true; owned: false; reason: string }
  | { ok: false; error: Error };

export type OrphanDecision =
  | { action: "deregister"; reason: string }
  | { action: "skip"; reason: string }
  | { action: "retain" };

export function decideOrphanAction(
  result: OrphanCheckResult | OrphanIdCheckResult,
  expected: { name: string; id?: string | null },
  pid: number,
  windowIndex: number
): OrphanDecision {
  void pid;
  if (!result.ok) {
    // Transient tmux fault — do NOT de-register; defer to next tick (#1329).
    const subject = expected.id
      ? `window ${expected.id}`
      : `window index ${windowIndex}`;
    return {
      action: "skip",
      reason: `tmux query for ${subject} failed: ${result.error.message}`,
    };
  }

  if (expected.id) {
    // #4218: id-keyed. Never compare the NAME (a rename of a live session
    // would deregister it) and never the id found at the tracked INDEX (index
    // keying depends on `renumber-windows off`; a move-window would break it).
    if (!("owned" in result)) {
      return {
        action: "skip",
        reason: `window ${expected.id} needs an ownership probe, got a name read`,
      };
    }
    if (result.owned) return { action: "retain" };
    return {
      action: "deregister",
      reason: `tracked window ${expected.id} is no longer this session's (${result.reason})`,
    };
  }

  if (!("name" in result)) {
    return {
      action: "skip",
      reason: `window index ${windowIndex} needs a name read, got an ownership probe`,
    };
  }
  if (result.name !== expected.name) {
    return {
      action: "deregister",
      reason: `tmux window index ${windowIndex} no longer holds '${expected.name}' (currentName=${result.name})`,
    };
  }
  return { action: "retain" };
}
