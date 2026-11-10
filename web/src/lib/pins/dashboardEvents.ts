// SPDX-License-Identifier: AGPL-3.0-only
import type { QueryClient } from "@tanstack/react-query";
import type { PinDashboardsResponse } from "@hapi/protocol";
import { queryKeys } from "@/lib/query-keys";

/**
 * #6454: how a `pin-changed` frame reaches the Project Managers section. Called
 * from useSSE.ts, so this module is in the main bundle: types only from
 * `@hapi/protocol`, no Zod and no schema (the snapshot is parsed in the
 * code-split Pins chunk, hooks/queries/usePinDashboards.ts).
 *
 * - A frame for a session the snapshot names patches that session's open-pin
 *   count in place, with no fetch.
 * - A dashboard change (any live pin, or a withdrawn or dismissed dashboard of
 *   a listed Project Manager) refetches the snapshot once the burst settles (at
 *   most 5 s after its first frame), never cancelling a fetch in flight: a peer can take its full proxy timeout
 *   to answer, so a cancelling refetch under a steady stream could starve the
 *   read. If one is in flight, the refetch waits for it to land.
 * - The session lists are never invalidated (#6208).
 */

/** The snapshot as the query caches it (`usePinDashboards`). */
export type PinDashboardsState =
  | { kind: "ok"; response: PinDashboardsResponse }
  | { kind: "unavailable" };

export type PinChangeFrame = {
  sessionId: string;
  key: string;
  change: string;
  status: string;
  openPinCount: number;
};

export const DASHBOARD_REFETCH_TRAILING_MS = 1_500;
/** A PM rewriting its dashboard faster than the debounce still refreshes this often. */
export const DASHBOARD_REFETCH_MAX_WAIT_MS = 5_000;

const timers = new WeakMap<QueryClient, ReturnType<typeof setTimeout>>();
const burstStart = new WeakMap<QueryClient, number>();

function scheduleRefetch(queryClient: QueryClient, delayMs: number): void {
  const prev = timers.get(queryClient);
  if (prev) clearTimeout(prev);
  const now = Date.now();
  const firstAt = burstStart.get(queryClient) ?? now;
  burstStart.set(queryClient, firstAt);
  const wait = Math.max(
    0,
    Math.min(delayMs, firstAt + DASHBOARD_REFETCH_MAX_WAIT_MS - now)
  );
  const fire = () => {
    if (queryClient.isFetching({ queryKey: queryKeys.pinDashboards }) > 0) {
      // A read already in flight may predate this change: refetch after it.
      timers.set(queryClient, setTimeout(fire, delayMs));
      return;
    }
    timers.delete(queryClient);
    burstStart.delete(queryClient);
    void queryClient.invalidateQueries(
      { queryKey: queryKeys.pinDashboards, exact: true },
      { cancelRefetch: false }
    );
  };
  timers.set(queryClient, setTimeout(fire, wait));
}

function patchCount(
  queryClient: QueryClient,
  state: Extract<PinDashboardsState, { kind: "ok" }>,
  sessionId: string,
  openPinCount: number
): void {
  const facts = state.response.sessions[sessionId];
  if (!facts || facts.openPinCount === openPinCount) return;
  const next: PinDashboardsState = {
    kind: "ok",
    response: {
      ...state.response,
      sessions: {
        ...state.response.sessions,
        [sessionId]: { ...facts, openPinCount },
      },
    },
  };
  // `data` only (the patchOpenPinCount route), so fetch status and the poll's
  // timing are untouched.
  queryClient
    .getQueryCache()
    .find({ queryKey: queryKeys.pinDashboards, exact: true })
    ?.setState({ data: next });
}

/** Route one `pin-changed` frame to the Project Managers snapshot. */
export function notePinChange(
  queryClient: QueryClient,
  event: PinChangeFrame,
  delayMs: number = DASHBOARD_REFETCH_TRAILING_MS
): void {
  const state = queryClient.getQueryData<PinDashboardsState>(
    queryKeys.pinDashboards
  );
  // Nothing loaded, or the section is unavailable: the next read is fresh.
  if (!state || state.kind !== "ok") return;

  patchCount(queryClient, state, event.sessionId, event.openPinCount);

  const isDashboardOf = state.response.dashboards.some(
    dashboard =>
      dashboard.sessionId === event.sessionId && dashboard.pin.key === event.key
  );
  if (
    event.status === "live" ||
    (isDashboardOf &&
      (event.change === "withdrawn" || event.change === "dismissed"))
  ) {
    scheduleRefetch(queryClient, delayMs);
  }
}

/**
 * A `session-updated` frame for a session the snapshot names: patch its running
 * and thinking state in place, so a lane or a Project Manager shows a resume or
 * a stop at once on any page, not at the next poll. The session lists hold the
 * same state, but a page opened straight to a session has not loaded them.
 */
export function noteSessionUpdate(
  queryClient: QueryClient,
  event: { sessionId: string; data?: unknown }
): void {
  const state = queryClient.getQueryData<PinDashboardsState>(
    queryKeys.pinDashboards
  );
  if (!state || state.kind !== "ok") return;
  const facts = state.response.sessions[event.sessionId];
  const data = event.data;
  if (!facts || !data || typeof data !== "object") return;
  const { active, thinking } = data as { active?: unknown; thinking?: unknown };
  const next = {
    active: typeof active === "boolean" ? active : facts.active,
    thinking: typeof thinking === "boolean" ? thinking : facts.thinking,
  };
  if (next.active === facts.active && next.thinking === facts.thinking) return;
  queryClient
    .getQueryCache()
    .find({ queryKey: queryKeys.pinDashboards, exact: true })
    ?.setState({
      data: {
        kind: "ok",
        response: {
          ...state.response,
          sessions: {
            ...state.response.sessions,
            [event.sessionId]: { ...facts, ...next },
          },
        },
      } satisfies PinDashboardsState,
    });
}

/** Drop a pending refetch (tests, sign-out). */
export function cancelDashboardRefetch(queryClient: QueryClient): void {
  const prev = timers.get(queryClient);
  if (prev) clearTimeout(prev);
  timers.delete(queryClient);
  burstStart.delete(queryClient);
}
