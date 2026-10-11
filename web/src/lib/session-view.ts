// SPDX-License-Identifier: AGPL-3.0-only
import {
  DEFAULT_SESSION_VIEW,
  SESSION_VIEWS,
  type SessionView,
} from "@hapi/protocol/schemas";
import type { Session } from "@hapi/protocol/types";
import { getStorageKey } from "@/lib/storage-keys";

/**
 * View Picker (issue #3286) shared helpers: view↔route mapping, availability
 * (R6), the no-flash localStorage cache (R7), and the one-shot open-redirect
 * guard (R2 / Back-loop). Kept in one module so the pure helpers and the two
 * small state machines are unit-testable together.
 *
 * claude-pty is deliberately NOT a `SessionView` (D5(a)) — it stays a secondary
 * affordance with no tab; on that surface the picker renders with no active tab.
 */

export const SESSION_VIEW_LABELS: Record<SessionView, string> = {
  chat: "Chat",
  terminal: "Terminal",
  desktop: "Desktop",
  files: "Files",
};

/** The route path for a view surface of a given session. */
export function sessionViewToPath(
  view: SessionView,
  sessionId: string
): string {
  return view === "chat"
    ? `/sessions/${sessionId}`
    : `/sessions/${sessionId}/${view}`;
}

/**
 * Reverse mapping: which tab (if any) a pathname represents for this session.
 * Returns null for a non-session path, the claude-pty surface, or the single-file
 * viewer — none of which is a tab (D5(a)).
 */
export function sessionViewFromPath(
  pathname: string,
  sessionId: string
): SessionView | null {
  const base = `/sessions/${sessionId}`;
  if (pathname === base) return "chat";
  for (const view of SESSION_VIEWS) {
    if (view !== "chat" && pathname === `${base}/${view}`) return view;
  }
  return null;
}

export type SessionViewAvailabilityOptions = {
  /**
   * Whether THIS instance can serve a web desktop at all (server-reported via
   * `GET /api/version` `desktopEligible` — true only on a desktop-eligible cloud
   * VM tier, #2693 Decision A). `undefined` (older server / fetch pending) keeps
   * the pre-correction active-only gate so the tab never flashes disabled while
   * the version query is in flight.
   */
  desktopEligible?: boolean;
};

/**
 * R6: whether a view is available for a session, so an unavailable view's tab
 * renders disabled/greyed and non-selectable.
 *
 * Epic #3285 correction pass 1:
 * - **files** requires an ACTIVE session (not just a path): the Files views ride
 *   session RPC handlers that exist only while the CLI process is alive, so an
 *   offline session would surface raw "RPC handler not registered" errors.
 * - **desktop** additionally requires the instance to be desktop-eligible
 *   (`opts.desktopEligible !== false`) — the server only proxies a desktop on
 *   Pro-and-up cloud VMs, so on a home instance (RP1/RP2/SL7) the tab is greyed
 *   instead of erroring.
 */
export function isSessionViewAvailable(
  view: SessionView,
  session: Session,
  opts: SessionViewAvailabilityOptions = {}
): boolean {
  switch (view) {
    case "chat":
      return true;
    case "terminal":
      return session.active === true;
    case "desktop":
      return session.active === true && opts.desktopEligible !== false;
    case "files":
      return session.active === true && Boolean(session.metadata?.path);
  }
}

// ── No-flash localStorage cache (R7) ────────────────────────────────────────
// Port-scoped key (storage-keys.ts) so concurrent instances on different ports
// stay isolated. The cache is a synchronous no-flash seed only; the server value
// (session.persistedView) is authoritative and reconciles it on load.

function viewCacheKey(sessionId: string): string {
  return getStorageKey(`hapi:session-view:${sessionId}`);
}

export function readCachedSessionView(sessionId: string): SessionView | null {
  try {
    const raw = window.localStorage.getItem(viewCacheKey(sessionId));
    return raw && (SESSION_VIEWS as readonly string[]).includes(raw)
      ? (raw as SessionView)
      : null;
  } catch {
    return null;
  }
}

export function writeCachedSessionView(
  sessionId: string,
  view: SessionView
): void {
  try {
    window.localStorage.setItem(viewCacheKey(sessionId), view);
  } catch {
    // localStorage disabled/full — the server value remains authoritative.
  }
}

/**
 * The effective view for a session at open time: server value wins, then the
 * synchronous no-flash cache, then the shared default. Used by the open-redirect.
 */
export function computeEffectiveSessionView(
  session: Session,
  sessionId: string
): SessionView {
  return (
    session.persistedView ??
    readCachedSessionView(sessionId) ??
    DEFAULT_SESSION_VIEW
  );
}

// ── One-shot open-redirect guard (Back-loop-safe) ───────────────────────────
// Module-level: survives component remounts within the SPA session. A sessionId
// is added when its open-redirect fires (or on an explicit tab tap), and cleared
// when navigation leaves the session (reconcile). So Back (`useAppGoBack` strips
// the last segment → chat) never re-loops, yet a genuine reopen re-arms (R2).

const consumedOpenRedirect = new Set<string>();

export function hasConsumedOpenRedirect(sessionId: string): boolean {
  return consumedOpenRedirect.has(sessionId);
}

export function markOpenRedirectConsumed(sessionId: string): void {
  consumedOpenRedirect.add(sessionId);
}

/**
 * Called on every navigation (from the router root): drop the consumed flag for
 * any session we are no longer inside, so reopening it redirects again (R2).
 */
export function reconcileSessionViewOpenRedirects(pathname: string): void {
  for (const id of consumedOpenRedirect) {
    if (!pathname.startsWith(`/sessions/${id}`)) {
      consumedOpenRedirect.delete(id);
    }
  }
}

/** Test-only: reset the module-level open-redirect guard state. */
export function __resetSessionViewOpenRedirects(): void {
  consumedOpenRedirect.clear();
}
