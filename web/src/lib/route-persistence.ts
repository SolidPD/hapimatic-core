// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Persist and restore the last active route for iOS PWA cold-start recovery.
 *
 * iOS terminates backgrounded PWA web views under memory pressure. On relaunch,
 * the PWA loads from `start_url` ("/") which redirects to /sessions. This module
 * saves the current route on every navigation and restores it on cold start so
 * the user returns to their last active view.
 *
 * @see https://github.com/MattStarfield/hapimatic-private/issues/518
 */

import { getStorageKey } from "./storage-keys";
import { safeSetItem } from "./localStorageCleanup";

const ROUTE_KEY = "hapi:lastRoute";

/**
 * Routes worth restoring (deeper than the default session list).
 *
 * Accepts ONLY the four defined session subroute shapes:
 *   /sessions/<id>, /sessions/<id>/files, /sessions/<id>/file, /sessions/<id>/terminal
 * and rejects /sessions/new plus any structurally malformed /sessions/<...> path
 * (e.g. /sessions/a/b/c). This guards against persisting a deep link that no
 * route can resolve, which on iOS PWA cold start would trap the user on a
 * "Not Found" view (issue #1257).
 *
 * NOTE: the suffix alternation (files|file|terminal) is coupled to the session
 * subroute definitions in `router.tsx`. Adding a new session subroute requires
 * updating BOTH the route tree there AND this regex.
 */
function isRestorableRoute(path: string): boolean {
  // The literal "new" matches the [^/]+ session-id segment, so guard it
  // explicitly BEFORE the regex test to preserve the /sessions/new reject.
  if (path === "/sessions/new") return false;
  return /^\/sessions\/[^/]+(\/(files|file|terminal))?$/.test(path);
}

/** Save the current route path to localStorage (port-scoped). */
export function saveLastRoute(path: string): void {
  const key = getStorageKey(ROUTE_KEY);
  if (isRestorableRoute(path)) {
    safeSetItem(key, path);
  } else {
    // On the session list or other non-restorable routes, clear the saved route
    // so the next cold start doesn't restore a stale deep link.
    localStorage.removeItem(key);
  }
}

/** Retrieve the last saved route, or null if none exists. */
export function getLastRoute(): string | null {
  const key = getStorageKey(ROUTE_KEY);
  const saved = localStorage.getItem(key);
  if (saved && isRestorableRoute(saved)) {
    return saved;
  }
  return null;
}

/** Clear the persisted route (e.g., after a failed restoration). */
export function clearLastRoute(): void {
  const key = getStorageKey(ROUTE_KEY);
  localStorage.removeItem(key);
}
