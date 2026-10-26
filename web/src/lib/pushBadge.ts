// SPDX-License-Identifier: AGPL-3.0-only
// App-badge decisions for the service worker's push handler and the open
// page's unread-count mirror (issue #4921). Pure and window-free so sw.ts can
// bundle it and vitest can test it (sw.ts itself has no test harness), the
// same split as `pushDisplayGate.ts`.

export type BadgeAction = { kind: "set"; count: number } | { kind: "clear" };

/** The subset of `Navigator` / `WorkerNavigator` the badge API needs. */
export type BadgeNavigator = {
  setAppBadge?: (contents?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

/**
 * The badge for a push the service worker DISPLAYS. The server stamps
 * `unreadCount` (its inbox count at send time, #4921 R5); the badge never shows
 * less than 1, because the banner just shown is itself not yet addressed — the
 * live ready / permission / question pushes are not inbox rows (D14). Only the
 * open app's mirror clears the badge. An absent or invalid count (an older
 * server) keeps the previous `setAppBadge(1)` behaviour.
 */
export function decidePushBadge(unreadCount: unknown): BadgeAction {
  if (
    typeof unreadCount === "number" &&
    Number.isInteger(unreadCount) &&
    unreadCount >= 0
  ) {
    return { kind: "set", count: Math.max(unreadCount, 1) };
  }
  return { kind: "set", count: 1 };
}

/** The badge for the open app: the server unread count, cleared at zero. */
export function decideMirrorBadge(unreadCount: number): BadgeAction {
  return unreadCount > 0
    ? { kind: "set", count: unreadCount }
    : { kind: "clear" };
}

/**
 * Apply a badge action. Feature-detected: a browser tab without the Badging
 * API, or a context that rejects the call, is a silent no-op — a badge is
 * cosmetic and must never break a push or a render.
 */
export async function applyBadge(
  nav: BadgeNavigator | null | undefined,
  action: BadgeAction
): Promise<void> {
  if (!nav) return;
  try {
    if (action.kind === "set") {
      if (typeof nav.setAppBadge === "function") {
        await nav.setAppBadge(action.count);
      }
    } else if (typeof nav.clearAppBadge === "function") {
      await nav.clearAppBadge();
    }
  } catch {
    // Badge API unavailable in this context — ignore.
  }
}
