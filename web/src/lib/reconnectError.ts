// SPDX-License-Identifier: AGPL-3.0-only
import { ApiError } from "@/api/client";
import { reloginToastFromError } from "@/lib/reloginLink";

/**
 * Shared re-login toast copy for an account whose login expired and could not
 * be refreshed. Issue #1531 introduced this string as an inline literal in
 * `App.tsx`'s `AccountUnrefreshableToastListener`; issue #1835 hoisted it here
 * (#4915: the SSE side is now the `account-unrefreshable` notification, whose
 * title Sub B #4914 must set to this exact text / `buildReloginToast`'s message)
 * so the SSE-driven listener and the HTTP-catch reconnect branch (below) emit
 * the BYTE-IDENTICAL text. ToastProvider dedups on message text within a 2s
 * window (`Toast.tsx`, `DEDUP_WINDOW_MS`), so the identical string collapses the
 * SSE+HTTP toast pair into ONE when both fire — and the HTTP branch is the sole
 * toast when the SSE emit is skipped (a session with no `metadata.accountUuid`;
 * see `sessionRespawn.ts`), which is the specific silent gap #1835 closes.
 */
export const ACCOUNT_UNREFRESHABLE_TOAST_MESSAGE =
  "An account's login expired and the session couldn't refresh. " +
  "Re-login via the account menu in the session header.";

/**
 * Issue #1778 / #1835: classify a reconnect failure into a user-facing toast
 * message. As of #1835 this ALWAYS returns a non-empty string — every reconnect
 * failure surfaces a toast, so callers no longer guard on `null`:
 *
 *   - `cwd_missing` (502) → actionable "worktree deleted" terminal message.
 *   - `at_capacity` (409, #2300) → actionable "node full — free a slot" message.
 *   - `account_unrefreshable` (409) → the shared re-login message above, or
 *     "Re-login required on <node>" when the 409 names its node (#4461; see
 *     {@link getReconnectErrorToastOptions}, which also carries the action).
 *   - anything else (a code-less 500, a thrown network/timeout error, a plain
 *     `Error`, or a non-error value) → a generic "try again" fallback.
 *
 * The `cwd_missing` case: when a session's working directory (its git worktree)
 * was deleted out from under it — e.g. an external stale-worktree cleanup tool
 * ran `git worktree remove` — the server returns HTTP 502 with `code:
 * "cwd_missing"` from BOTH the local reconnect route (`sessions.ts`) and the
 * federated node-to-node path (`federation/sessionLifecycle.ts`). The session
 * is permanently unrecoverable, so the UI surfaces an actionable terminal
 * message rather than spinning until the 90s safety timeout. Mirrors the
 * text-only "actionable" toast convention of the #1531 / #1532 listeners.
 */
export function getReconnectErrorToast(err: unknown): string {
  return getReconnectErrorToastOptions(err).message;
}

/**
 * Issue #4461 (R8): the reconnect toast's message AND its optional action. An
 * `account_unrefreshable` 409 that names its node gets "Re-login required on
 * <node>" plus a "Log in" action from {@link buildReloginToast}. The refusal's
 * twin, the `account-unrefreshable` notification, carries the same text as its
 * title (written by the server with the shared `formatReloginMessage`, #4914) and
 * gets the same builder's action from `formatNotificationToast` (#4915), so the
 * pair stays byte-identical and collapses into ONE toast carrying the action
 * whichever side fires first. A 409 without a node (a pre-#4461 node) keeps the
 * shared message and no action, as an unstamped notification does. Every other
 * failure maps exactly as {@link getReconnectErrorToast}.
 */
export function getReconnectErrorToastOptions(err: unknown): {
  message: string;
  action?: { label: string; onClick: () => void };
} {
  return reloginToastFromError(err) ?? { message: reconnectErrorMessage(err) };
}

function reconnectErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.code === "cwd_missing") {
    return (
      "This session's working directory (worktree) was deleted and can't be " +
      "reconnected. Spawn a fresh session, or archive/delete this one."
    );
  }
  // Issue #2300 (Task 3, R2): a reconnect refused because the node is at
  // capacity carries code "at_capacity" — minted at the daemon gate (#1772) and
  // threaded through the reconnect route as a 409 by #2300 (Task 2). Ends the
  // spinner (the SessionHeader/SessionItem handlers clear it on any non-null
  // toast) and surfaces an actionable "node full — free a slot" message instead
  // of spinning until the 90s safety timeout. Mirrors the cwd_missing branch.
  if (err instanceof ApiError && err.code === "at_capacity") {
    return "This node is full — free a session (disconnect or delete one) and retry the reconnect.";
  }
  // Issue #1835 (R2): a reconnect refused by the pre-spawn account-health gate
  // carries code "account_unrefreshable" → 409 (`sessions.ts`). The server ALSO
  // emits a session-scoped `account-unrefreshable` SSE event just before the 409
  // (`sessionRespawn.ts`), which `NotificationListener` (#4915) shows as a
  // re-login toast using the notification's title — Sub B (#4914) sets that
  // title to this same string so the pair still dedups (only while the row's
  // count is 1: a coalesced row appends " (×N)"). Return the BYTE-IDENTICAL shared string
  // so ToastProvider's 2s identical-text dedup (`Toast.tsx`) collapses the
  // SSE+HTTP pair into ONE toast. The SSE emit is skipped when the session has
  // no `metadata.accountUuid`, so this HTTP-catch branch is the sole toast for
  // that gap — the specific silent case #1835 exists to close.
  if (err instanceof ApiError && err.code === "account_unrefreshable") {
    return ACCOUNT_UNREFRESHABLE_TOAST_MESSAGE;
  }
  // Issue #1835 (R3): every other reconnect failure (a code-less 500, a thrown
  // network/timeout error, a plain Error, or a non-error value) now gets a
  // generic fallback toast instead of silently clearing the spinner.
  return "Couldn't reconnect this session. Please try again.";
}
