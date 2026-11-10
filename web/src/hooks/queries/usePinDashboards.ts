// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { hashKey, useQuery, useQueryClient } from "@tanstack/react-query";
import { PinDashboardsResponseSchema } from "@hapi/protocol";
import { ApiError, type ApiClient } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";
import type { PinDashboardsState } from "@/lib/pins/dashboardEvents";
import type { LiveStatus } from "@/lib/pins/dashboards";
import type { SessionSummary } from "@/types/api";

/**
 * #6454: the Project Manager dashboards across the federation, for the Pins
 * tab's Project Managers section. Parsed here, in the code-split Pins chunk, so
 * the schemas stay out of the main bundle. A 404 (a closed gate or an older
 * node) is data, `unavailable`, which hides the section.
 *
 * Fresh by `pin-changed` frames (lib/pins/dashboardEvents.ts) and a 30 s poll
 * while the page is visible: the poll catches what no frame names, such as a
 * stopped Project Manager listed again because a lane now waits on you.
 */
export const PIN_DASHBOARDS_REFETCH_MS = 30_000;

async function fetchDashboards(
  api: ApiClient,
  signal?: AbortSignal
): Promise<PinDashboardsState> {
  try {
    return {
      kind: "ok",
      response: PinDashboardsResponseSchema.parse(
        await api.getPinDashboards({ signal })
      ),
    };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return { kind: "unavailable" };
    }
    throw error;
  }
}

export function usePinDashboards(api: ApiClient | null, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.pinDashboards,
    queryFn: ({ signal }) => fetchDashboards(api as ApiClient, signal),
    enabled: enabled && api !== null,
    refetchInterval: PIN_DASHBOARDS_REFETCH_MS,
    staleTime: 5_000,
  });
}

const LIVE_KEYS = [queryKeys.sessions, queryKeys.federationAllSessions];
const LIVE_HASHES = new Set(LIVE_KEYS.map(key => hashKey(key)));

type CachedSessions = { sessions: SessionSummary[] } | undefined;

/**
 * Running and thinking for `ids`, from the session lists the app already keeps
 * live by SSE, while they are fresh; nothing for a session only an invalidated
 * list names. It subscribes to the query cache rather than calling `useQuery`,
 * which would write its options onto the list page's query (#4469), and its
 * snapshot is one string, so an unrelated session's change never re-renders.
 */
export function useLiveSessionStatus(
  ids: readonly string[]
): (id: string) => LiveStatus | undefined {
  const queryClient = useQueryClient();
  const idsKey = [...ids].sort().join("\n");
  const subscribe = useCallback(
    (onChange: () => void) =>
      queryClient.getQueryCache().subscribe(event => {
        if (LIVE_HASHES.has(event.query.queryHash)) onChange();
      }),
    [queryClient]
  );
  const read = useCallback(() => {
    if (!idsKey) return "";
    const wanted = new Set(idsKey.split("\n"));
    const parts = new Map<string, string>();
    for (const key of LIVE_KEYS) {
      // A list invalidated by a `session-updated` frame is refetched only while
      // something observes it. On a phone's Pins tab nothing does, so it would
      // keep showing a resumed lane as stopped: until it is fresh again, the
      // snapshot's own facts (patched by that same frame) are used (#6454).
      if (queryClient.getQueryState(key)?.isInvalidated) continue;
      for (const session of queryClient.getQueryData<CachedSessions>(key)
        ?.sessions ?? []) {
        if (wanted.has(session.id) && !parts.has(session.id)) {
          parts.set(
            session.id,
            `${session.id}\t${session.active ? 1 : 0}${session.thinking ? 1 : 0}`
          );
        }
      }
    }
    return [...parts.values()].sort().join("\n");
  }, [queryClient, idsKey]);
  const snapshot = useSyncExternalStore(subscribe, read, read);
  return useMemo(() => {
    const byId = new Map<string, LiveStatus>();
    for (const line of snapshot ? snapshot.split("\n") : []) {
      const [id, flags] = line.split("\t");
      if (id && flags) {
        byId.set(id, { active: flags[0] === "1", thinking: flags[1] === "1" });
      }
    }
    return (id: string) => byId.get(id);
  }, [snapshot]);
}

/** The Project Manager a Submit can relay a stopped session's answers to. */
export type SessionProjectManager = {
  id: string;
  name: string;
  nodeLabel: string | null;
  /** On the session's own node, which a relay requires (ruling D4). */
  sameNode: boolean;
};

function findCached(
  queryClient: ReturnType<typeof useQueryClient>,
  id: string
): SessionSummary | undefined {
  for (const key of LIVE_KEYS) {
    const hit = queryClient
      .getQueryData<CachedSessions>(key)
      ?.sessions.find(session => session.id === id);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * The running Project Manager of `session`: the first running PM, newest
 * dashboard first, whose dashboard names it in a lane or that is its spawn
 * parent. Null when it has none running. It shares the Project Managers
 * section's query.
 */
export function useSessionProjectManager(
  api: ApiClient | null,
  session: {
    id: string;
    parentSessionId?: string | null;
    parentRelationship?: string | null;
  },
  enabled: boolean
): SessionProjectManager | null {
  const queryClient = useQueryClient();
  const dashboards = usePinDashboards(api, enabled).data;
  return useMemo(() => {
    if (!enabled) return null;
    if (dashboards?.kind === "ok") {
      const { response } = dashboards;
      const lane = response.sessions[session.id];
      const named = response.dashboards.filter(
        dashboard =>
          Object.values(dashboard.refs).includes(session.id) ||
          (session.parentRelationship === "spawn" &&
            session.parentSessionId === dashboard.sessionId)
      );
      const running = named.find(
        dashboard => response.sessions[dashboard.sessionId]?.active === true
      );
      if (running) {
        const pm = response.sessions[running.sessionId];
        return {
          id: running.sessionId,
          name: pm?.name?.trim() || pm?.tag || running.sessionId,
          nodeLabel: running.nodeLabel ?? pm?.nodeLabel ?? null,
          sameNode:
            !lane?.nodeId || !running.nodeId || lane.nodeId === running.nodeId,
        };
      }
    }
    if (session.parentRelationship !== "spawn" || !session.parentSessionId) {
      return null;
    }
    const parent = findCached(queryClient, session.parentSessionId);
    if (!parent?.active) return null;
    const own = findCached(queryClient, session.id);
    return {
      id: parent.id,
      name: parent.metadata?.name?.trim() || parent.tag || parent.id,
      nodeLabel: parent.nodeLabel ?? null,
      // A list row with no nodeId is this hub's own session.
      sameNode: (parent.nodeId ?? null) === (own?.nodeId ?? null),
    };
  }, [
    dashboards,
    enabled,
    queryClient,
    session.id,
    session.parentSessionId,
    session.parentRelationship,
  ]);
}
