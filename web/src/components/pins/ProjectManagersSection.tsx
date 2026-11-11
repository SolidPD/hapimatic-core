// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { hashKey, useQueryClient } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import { ProjectManagerBlock } from "@/components/pins/ProjectManagerBlock";
import { PinsSection } from "@/components/pins/PinsSection";
import { useMinuteClock } from "@/components/pins/pinsShared";
import {
  useLiveSessionStatus,
  usePinDashboards,
} from "@/hooks/queries/usePinDashboards";
import {
  dashboardSessionIds,
  missingNodesNote,
  toDashboardModels,
  type CurrentSession,
} from "@/lib/pins/dashboards";
import { queryKeys } from "@/lib/query-keys";
import type { SessionResponse } from "@/types/api";

/**
 * The open session's spawn link, read from its detail cache without fetching
 * (the page already keeps it live), as one string so an unrelated change to
 * the session never re-renders the section.
 */
function useCurrentSession(sessionId: string): CurrentSession {
  const queryClient = useQueryClient();
  const key = queryKeys.session(sessionId);
  const hash = hashKey(key);
  const subscribe = useCallback(
    (onChange: () => void) =>
      queryClient.getQueryCache().subscribe(event => {
        if (event.query.queryHash === hash) onChange();
      }),
    [queryClient, hash]
  );
  const read = () => {
    const session = queryClient.getQueryData<SessionResponse>(key)?.session;
    return `${session?.parentSessionId ?? ""}\n${session?.parentRelationship ?? ""}`;
  };
  const link = useSyncExternalStore(subscribe, read, read);
  return useMemo(() => {
    const [parentSessionId, parentRelationship] = link.split("\n");
    return {
      id: sessionId,
      parentSessionId: parentSessionId || null,
      parentRelationship: parentRelationship || null,
    };
  }, [sessionId, link]);
}

/**
 * #6454: the Project Managers section of the Pins tab (mockup v6, between
 * Action Items and Completed): every Project Manager dashboard in the
 * namespace, across nodes, the one managing this session first. Nothing while
 * none is listed and every node answered, the Pins gate is closed, or the node
 * is older; a node that did not answer, or a failed read, is said in one line.
 * Dashboards are not pins, so the toolbar's facets and search do not apply here.
 */
export function ProjectManagersSection(props: {
  api: ApiClient | null;
  sessionId: string;
  open: boolean;
  onToggle: (id: string) => void;
  scrollRoot?: Element | null;
}) {
  const query = usePinDashboards(props.api, true);
  const current = useCurrentSession(props.sessionId);
  const response = query.data?.kind === "ok" ? query.data.response : null;
  const ids = useMemo(
    () => (response ? dashboardSessionIds(response) : []),
    [response]
  );
  const live = useLiveSessionStatus(ids);
  const models = useMemo(
    () => (response ? toDashboardModels(response, current, live) : []),
    [response, current, live]
  );
  // A failed read of this node's own answer is a query error, not a partial
  // answer: say so, rather than hiding every PM (#6454 review SFH-2).
  const missing = query.isError
    ? response
      ? "The latest read failed, so this list may be out of date"
      : "The Project Managers could not be read"
    : response
      ? missingNodesNote(response)
      : null;
  const now = useMinuteClock();
  if (models.length === 0 && missing === null) return null;
  return (
    <PinsSection
      id="pm"
      look="pm"
      title="Project Managers"
      count={models.length}
      open={props.open}
      onToggle={props.onToggle}
    >
      {/* #6555: no inset of its own. The section body already insets its
          children, and a second inset here left a lane's pin too narrow for
          its action row on a 320px screen. */}
      <div>
        {missing ? (
          <p
            className="truncate px-1 py-0.5 text-[length:var(--text-caption)] text-[var(--status-warn)]"
            title={missing}
          >
            {missing}
          </p>
        ) : null}
        {models.map(pm => (
          <ProjectManagerBlock
            key={pm.key}
            api={props.api}
            pm={pm}
            now={now}
            scrollRoot={props.scrollRoot ?? null}
          />
        ))}
      </div>
    </PinsSection>
  );
}
