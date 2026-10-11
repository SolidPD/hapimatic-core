// SPDX-License-Identifier: AGPL-3.0-only
// App-load push subscription reconcile (issue #4836).
//
// App.tsx runs this once per signed-in page load. Before #4836 it subscribed
// whenever the browser permission was `granted` — and the permission stays
// `granted` after Settings → Disable, so every load undid the Disable. Now the
// per-origin opt-out (`readGlobalOptOut`) wins: while it is set the app never
// subscribes or prompts, and drops any subscription that is still live.
//
// The opt-out is re-read after the awaits that decide the outcome, because the
// user can press Disable or Enable in Settings while this is still running.
// Two presses inside one in-flight call can still leave a stale state; the
// next load reconciles again.

/** The push operations the reconcile needs (`usePushNotifications` supplies them). */
export type PushReconcileDeps = {
  /** The browser notification permission when the reconcile starts. */
  permission: NotificationPermission;
  /** Reads the per-origin opt-out at call time. */
  readOptOut: () => boolean;
  requestPermission: () => Promise<boolean>;
  subscribe: () => Promise<boolean>;
  unsubscribe: () => Promise<boolean>;
};

/** What the reconcile did (for tests and debugging). */
export type PushReconcileResult =
  | "unsubscribed"
  | "subscribed"
  | "not-subscribed";

async function unsubscribeQuietly(deps: PushReconcileDeps): Promise<void> {
  try {
    await deps.unsubscribe();
  } catch {
    // Fail soft — the service worker unsubscribes on the next push.
  }
}

export async function reconcilePushOnLoad(
  deps: PushReconcileDeps
): Promise<PushReconcileResult> {
  if (deps.readOptOut()) {
    await unsubscribeQuietly(deps);
    // Enable was pressed while the unsubscribe ran: it may have removed the
    // subscription Enable just made, so subscribe again. subscribe() itself
    // returns false unless the permission is granted.
    if (!deps.readOptOut() && (await deps.subscribe())) {
      return "subscribed";
    }
    return "unsubscribed";
  }

  let subscribed = false;
  if (deps.permission === "granted") {
    subscribed = await deps.subscribe();
  } else if (deps.permission === "default") {
    const granted = await deps.requestPermission();
    // Disable may have been pressed while the permission prompt was open.
    if (granted && !deps.readOptOut()) {
      subscribed = await deps.subscribe();
    }
  }

  // Disable was pressed while subscribe() ran: the subscription it created
  // would outlive the opt-out, so drop it.
  if (subscribed && deps.readOptOut()) {
    await unsubscribeQuietly(deps);
    return "unsubscribed";
  }
  return subscribed ? "subscribed" : "not-subscribed";
}
