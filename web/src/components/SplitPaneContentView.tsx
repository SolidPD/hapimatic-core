// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import { SplitPaneSessionView } from "@/components/SplitPaneSessionView";
import {
  NewSession,
  type NewSessionHandle,
  type ExpandState,
} from "@/components/NewSession";
import { ChevronIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { useMachines } from "@/hooks/queries/useMachines";
import { useFederatedSessions } from "@/hooks/queries/useFederatedSessions";
import { useToast } from "@/components/Toast";
import { queryKeys } from "@/lib/query-keys";

export type PaneView =
  | { type: "list" }
  | { type: "session"; sessionId: string }
  | { type: "new-session" };

/**
 * Renders the appropriate view inside a split pane based on PaneView type.
 * Acts as a pane-level "router" — renders content inline without TanStack Router navigation.
 */
export function SplitPaneContentView(props: {
  view: PaneView;
  api: ApiClient;
  onBack: () => void;
  onNavigate: (view: PaneView) => void;
}): React.ReactElement {
  const { view, api, onBack, onNavigate } = props;

  if (view.type === "session") {
    return (
      <SplitPaneSessionView
        sessionId={view.sessionId}
        api={api}
        onBack={onBack}
      />
    );
  }

  if (view.type === "new-session") {
    return (
      <SplitPaneNewSession api={api} onBack={onBack} onNavigate={onNavigate} />
    );
  }

  // type === "list" — should never reach here (parent handles list rendering)
  return <></>;
}

/**
 * NewSession wrapper for split-pane context.
 * Mirrors the data-fetching from NewSessionPage (router.tsx) but navigates
 * within the pane instead of using TanStack Router.
 */
function SplitPaneNewSession(props: {
  api: ApiClient;
  onBack: () => void;
  onNavigate: (view: PaneView) => void;
}): React.ReactElement {
  const { api, onBack, onNavigate } = props;
  const newSessionRef = useRef<NewSessionHandle>(null);
  const [expandState, setExpandState] = useState<ExpandState>("none");
  const queryClient = useQueryClient();
  const {
    machines,
    isLoading: machinesLoading,
    error: machinesError,
  } = useMachines(api, true);
  const { remoteNodes, remoteSessions } = useFederatedSessions(api);
  const { showToast } = useToast();

  const enrichedRemoteNodes = useMemo(() => {
    return remoteNodes.map(node => {
      const nodeSessions = remoteSessions.filter(s => s.nodeId === node.nodeId);
      return {
        ...node,
        connectedCount: nodeSessions.filter(s => s.active).length,
        disconnectedCount: nodeSessions.filter(s => !s.active).length,
      };
    });
  }, [remoteNodes, remoteSessions]);

  const handleSuccess = useCallback(
    (sessionId: string, isRemote: boolean) => {
      if (!isRemote) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
      }

      if (!sessionId) {
        // Issue #2150: an in-progress notice, not a success (see router.tsx).
        showToast("Session is being created on the remote node…", {
          type: "info",
        });
        onBack();
        return;
      }

      if (isRemote) {
        showToast("Session created on remote node", { type: "success" });
      }

      // Navigate to the new session within this pane
      onNavigate({ type: "session", sessionId });
    },
    [queryClient, showToast, onBack, onNavigate]
  );

  const handleScheduleCreated = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.schedules });
    onBack();
  }, [queryClient, onBack]);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-content flex items-center gap-2 border-b border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-1.5">
        <span
          className="grid h-8 w-8 place-items-center text-[var(--app-link)]"
          aria-hidden="true"
        >
          <svg
            className="h-5 w-5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v8M8 12h8" />
          </svg>
        </span>
        <div className="flex-1 font-semibold">Create</div>
        <Button
          type="button"
          variant="ghost"
          onClick={() => newSessionRef.current?.toggleAll()}
          title="Expand / collapse all sections"
          aria-label="Expand or collapse all sections"
          className="flex h-8 w-8 items-center justify-center rounded-full p-0 font-normal hover:bg-[var(--app-secondary-bg)]"
        >
          {expandState === "mixed" ? (
            <svg
              className="h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m7 9 5-5 5 5M7 15l5 5 5-5" />
            </svg>
          ) : (
            <ChevronIcon
              className="h-4 w-4"
              collapsed={expandState === "none"}
            />
          )}
        </Button>
      </div>

      {machinesError ? (
        <div className="mx-auto w-full max-w-content p-3 text-sm text-red-600">
          {machinesError}
        </div>
      ) : null}

      <div className="mx-auto w-full max-w-content">
        <NewSession
          ref={newSessionRef}
          onExpandStateChange={setExpandState}
          api={api}
          machines={machines}
          remoteNodes={enrichedRemoteNodes}
          isLoading={machinesLoading}
          onCancel={onBack}
          onSuccess={handleSuccess}
          onScheduleCreated={handleScheduleCreated}
        />
      </div>
    </div>
  );
}
