// SPDX-License-Identifier: AGPL-3.0-only
import type { Store } from "../../../store";

/**
 * #4682 (R15): the highest message seq each session had when it was first
 * attached in this server process — its first `/cli` socket connection, or an
 * earlier re-attach by `SessionCache.reactivate`.
 *
 * A session wrapper that started before #4682 keeps its old binary through a
 * server restart. With no last-seen cursor it reconnects and asks for
 * `GET /cli/sessions/:id/messages?afterSeq=0`, which replays the session's
 * whole user history as new input. `GET /cli/sessions/:id/messages` serves
 * such a request from this floor instead. A wrapper built with #4682 that got
 * a floor from `POST /cli/sessions` declares `exactCursor=1` and is served
 * exactly as asked.
 *
 * Why first attach: a restarted server loads sessions inactive, its web send
 * route refuses a send to an inactive session, and nothing could be sent while
 * it was down. A session becomes active again either through its wrapper's reconnect
 * or through a re-attach (the server re-activates it after the daemon reports
 * its pane alive), which can happen in the seconds before an old wrapper's
 * socket returns. Recording at whichever comes first puts every send accepted
 * after it above the floor. On a reconnect without a restart, the older floor
 * lets messages sent during the disconnect through.
 *
 * Keyed by the `Store` instance so the socket handler and the route (which
 * receive the same instance) share one table, and each test gets its own.
 * In memory only; a restart starts it empty.
 */
const floorsByStore = new WeakMap<Store, Map<string, number>>();

/**
 * Record the session's floor if it has none yet. Never throws: it runs inside
 * a socket.io `connection` listener, where a synchronous throw would end the
 * server, and inside `SessionCache.reactivate`, where the force-kill watchdog
 * would treat a throw as a dead session. On a failed read the session has no
 * floor yet; the next attach records one (a from-zero read before that is
 * served from 0, as before #4682).
 */
export function recordFirstCliConnect(store: Store, sessionId: string): void {
  let floors = floorsByStore.get(store);
  if (!floors) {
    floors = new Map<string, number>();
    floorsByStore.set(store, floors);
  }
  if (floors.has(sessionId)) {
    return;
  }
  try {
    floors.set(sessionId, store.messages.getMaxSeq(sessionId));
  } catch (error) {
    console.warn(
      `[cli] #4682 could not read the delivery floor for session ${sessionId}:`,
      error instanceof Error ? error.message : String(error)
    );
  }
}

/** The session's first-connect floor, or `undefined` when none is recorded. */
export function getCliConnectFloor(
  store: Store,
  sessionId: string
): number | undefined {
  return floorsByStore.get(store)?.get(sessionId);
}
