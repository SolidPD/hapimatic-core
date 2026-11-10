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
  pins: "Pins",
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
  /**
   * #6449: whether this instance's pins gate is open (`GET /api/version`
   * `pinsEnabled: true`). Default-CLOSED: anything but a literal `true` keeps
   * the Pins view unavailable, because the gate opens only on `true`
   * (server/src/web/middleware/pinsGate.ts).
   */
  pinsEnabled?: boolean;
  /**
   * #6449: whether the session's detail response carried a numeric
   * `openPinCount` — the owning node's gate is open and it serves pins. `0` is a
   * known count. Absent means the node cannot serve pins (R19).
   */
  pinCountKnown?: boolean;
};

/**
 * #6449: the availability options plus whether the inputs have arrived, from
 * `useSessionViewOptions`. `settled` is true once the version has been read
 * successfully and the session detail query has answered.
 */
export type SessionViewOptions = SessionViewAvailabilityOptions & {
  settled: boolean;
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
 * - **pins** (#6449) requires the pins gate open on this instance AND a known
 *   open-pin count for the session. Pins records live on the server, so an
 *   inactive session's Pins view still works (no `session.active` test).
 *
 * A view this build does not know (a newer or older peer's value) is
 * unavailable (R20).
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
    case "pins":
      return opts.pinsEnabled === true && opts.pinCountKnown === true;
    default:
      return false;
  }
}

/**
 * #6449: whether a view's tab is rendered at all. Every view but Pins always
 * renders (an unavailable one greys out); Pins renders only while its gate is
 * open and the count is known — or while it is the active view, so a later
 * poll that lacks the count does not pull the tab out from under the page.
 */
export function isSessionViewVisible(
  view: SessionView,
  opts: SessionViewAvailabilityOptions,
  activeView: SessionView | null
): boolean {
  if (view !== "pins") return true;
  if (opts.pinsEnabled !== true) return false;
  return opts.pinCountKnown === true || activeView === "pins";
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
  const persisted = session.persistedView;
  // R20: a persisted value this build does not know resolves like no value.
  const known =
    persisted && (SESSION_VIEWS as readonly string[]).includes(persisted)
      ? persisted
      : null;
  return known ?? readCachedSessionView(sessionId) ?? DEFAULT_SESSION_VIEW;
}

/** #6453: the Pins link a session URL carries: `?at=` (`"at"`) or `?pin=` (`"pin"`). */
export type OpenRedirectLink = "at" | "pin" | null;

export type OpenRedirectDecision =
  | { kind: "none" }
  | { kind: "pending" }
  | { kind: "jump" }
  | { kind: "reveal" }
  | { kind: "redirect"; view: SessionView };

/**
 * #6449: the open-redirect decision, shared by the `SessionChat` redirect and
 * the full-screen restore so they never disagree.
 * A persisted Pins view waits ("pending", do not mark consumed) until the
 * version has been read successfully and the detail query has answered,
 * because Pins availability depends on both; every other view keeps its
 * pre-#6449 behavior.
 * #6453 (R13): a Pins link works only while the Pins gate is open, so it waits
 * for the same inputs. A `?pin=` link opens the Pins tab ("reveal") and a
 * `?at=` link keeps the chat ("jump"); with the gate closed either is ignored
 * and the persisted view wins, as before G.
 */
export function pendingOpenRedirect(
  session: Session,
  sessionId: string,
  opts: SessionViewOptions,
  link: OpenRedirectLink = null
): OpenRedirectDecision {
  if (link === "pin" && !opts.settled) return { kind: "pending" };
  if (link === "pin" && opts.pinsEnabled === true) return { kind: "reveal" };
  const view = computeEffectiveSessionView(session, sessionId);
  if (view === "chat") return { kind: "none" };
  if (link === "at" && !opts.settled) return { kind: "pending" };
  if (link === "at" && opts.pinsEnabled === true) return { kind: "jump" };
  if (view === "pins" && !opts.settled) return { kind: "pending" };
  return isSessionViewAvailable(view, session, opts)
    ? { kind: "redirect", view }
    : { kind: "none" };
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
