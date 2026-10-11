// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import type {
  FederationAllSessionsResponse,
  SessionResponse,
  SessionsResponse,
} from "@/types/api";
import type { CurrentIssue } from "@/types/github";
import type { LinkedIssue } from "@hapi/protocol/types";
import { queryKeys } from "@/lib/query-keys";
import {
  setFederationOverride,
  clearFederationOverride,
} from "@/lib/federation-mutation-overrides";

// Default repo for Hapimatic sessions (exported for fallback use)
export const DEFAULT_REPO = "MattStarfield/hapimatic-private";

/**
 * Convert LinkedIssue from server to full CurrentIssue with URL
 */
function toCurrentIssue(linked: LinkedIssue): CurrentIssue {
  return {
    number: linked.number,
    title: linked.title,
    repo: linked.repo,
    url: `https://github.com/${linked.repo}/issues/${linked.number}`,
    state: linked.state ?? "open",
  };
}

/**
 * Hook to manage the current GitHub issue for a session.
 *
 * Now uses server-side storage via the linkedIssue field on sessions.
 * The SSE system automatically propagates updates across all clients.
 *
 * @param sessionId - The session ID
 * @param linkedIssue - The linked issue from session data (server-side source of truth)
 * @param api - The API client for mutations
 */
export function useCurrentIssue(
  sessionId: string,
  linkedIssue: LinkedIssue | null | undefined,
  api: ApiClient | null
) {
  const queryClient = useQueryClient();

  // Convert server linkedIssue to CurrentIssue format
  const currentIssue: CurrentIssue | null = linkedIssue
    ? toCurrentIssue(linkedIssue)
    : null;

  // Mutation to set the linked issue
  const setMutation = useMutation({
    mutationFn: async (issue: {
      number: number;
      title: string;
      repo?: string;
      state?: "open" | "closed";
    }) => {
      if (!api) {
        throw new Error("API client not available");
      }
      await api.updateSessionLinkedIssue(sessionId, {
        number: issue.number,
        title: issue.title,
        repo: issue.repo ?? DEFAULT_REPO,
        state: issue.state,
      });
    },
    onMutate: async (issue: {
      number: number;
      title: string;
      repo?: string;
      state?: "open" | "closed";
    }) => {
      // Cancel outgoing refetches so they don't overwrite our optimistic update
      await queryClient.cancelQueries({
        queryKey: queryKeys.session(sessionId),
      });
      await queryClient.cancelQueries({ queryKey: queryKeys.sessions });
      await queryClient.cancelQueries({
        queryKey: queryKeys.federationAllSessions,
      });

      // Snapshot previous values for rollback
      const prevSession = queryClient.getQueryData<SessionResponse>(
        queryKeys.session(sessionId)
      );
      const prevSessions = queryClient.getQueryData<SessionsResponse>(
        queryKeys.sessions
      );
      const prevFederation =
        queryClient.getQueryData<FederationAllSessionsResponse>(
          queryKeys.federationAllSessions
        );

      // Build the LinkedIssue object for optimistic update
      const newLinkedIssue: LinkedIssue = {
        number: issue.number,
        title: issue.title,
        repo: issue.repo ?? DEFAULT_REPO,
        state: issue.state,
      };

      // Register override so the 10s federation poll doesn't revert our optimistic value
      setFederationOverride(sessionId, { linkedIssue: newLinkedIssue });

      // Optimistically update session detail cache
      if (prevSession?.session) {
        queryClient.setQueryData<SessionResponse>(
          queryKeys.session(sessionId),
          {
            ...prevSession,
            session: {
              ...prevSession.session,
              linkedIssue: newLinkedIssue,
            },
          }
        );
      }

      // Optimistically update sessions list cache
      if (prevSessions) {
        queryClient.setQueryData<SessionsResponse>(queryKeys.sessions, {
          ...prevSessions,
          sessions: prevSessions.sessions.map(s =>
            s.id === sessionId ? { ...s, linkedIssue: newLinkedIssue } : s
          ),
        });
      }

      // Optimistically update federation all-sessions cache
      if (prevFederation) {
        queryClient.setQueryData<FederationAllSessionsResponse>(
          queryKeys.federationAllSessions,
          {
            ...prevFederation,
            sessions: prevFederation.sessions.map(s =>
              s.id === sessionId ? { ...s, linkedIssue: newLinkedIssue } : s
            ),
          }
        );
      }

      return { prevSession, prevSessions, prevFederation };
    },
    onError: (_err, _issue, context) => {
      // Rollback to previous values on error
      if (!context) return;
      clearFederationOverride(sessionId);
      if (context.prevSession) {
        queryClient.setQueryData(
          queryKeys.session(sessionId),
          context.prevSession
        );
      }
      if (context.prevSessions) {
        queryClient.setQueryData(queryKeys.sessions, context.prevSessions);
      }
      if (context.prevFederation) {
        queryClient.setQueryData(
          queryKeys.federationAllSessions,
          context.prevFederation
        );
      }
    },
    onSettled: () => {
      // Re-sync with server truth
      void queryClient.invalidateQueries({
        queryKey: queryKeys.session(sessionId),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
      // Mark federation cache stale WITHOUT immediate refetch — the NodeRegistry
      // cache on the hub may still hold stale data for up to 10s. Letting the
      // regular 10s poll pick up fresh data avoids overwriting our optimistic value.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.federationAllSessions,
        refetchType: "none",
      });
    },
  });

  // Mutation to clear the linked issue
  const clearMutation = useMutation({
    mutationFn: async () => {
      if (!api) {
        throw new Error("API client not available");
      }
      await api.updateSessionLinkedIssue(sessionId, null);
    },
    onMutate: async () => {
      // Cancel outgoing refetches so they don't overwrite our optimistic update
      await queryClient.cancelQueries({
        queryKey: queryKeys.session(sessionId),
      });
      await queryClient.cancelQueries({ queryKey: queryKeys.sessions });
      await queryClient.cancelQueries({
        queryKey: queryKeys.federationAllSessions,
      });

      // Snapshot previous values for rollback
      const prevSession = queryClient.getQueryData<SessionResponse>(
        queryKeys.session(sessionId)
      );
      const prevSessions = queryClient.getQueryData<SessionsResponse>(
        queryKeys.sessions
      );
      const prevFederation =
        queryClient.getQueryData<FederationAllSessionsResponse>(
          queryKeys.federationAllSessions
        );

      // Register override so the 10s federation poll doesn't revert our optimistic value
      setFederationOverride(sessionId, { linkedIssue: null });

      // Optimistically clear linkedIssue in session detail cache
      if (prevSession?.session) {
        queryClient.setQueryData<SessionResponse>(
          queryKeys.session(sessionId),
          {
            ...prevSession,
            session: {
              ...prevSession.session,
              linkedIssue: null,
            },
          }
        );
      }

      // Optimistically clear linkedIssue in sessions list cache
      if (prevSessions) {
        queryClient.setQueryData<SessionsResponse>(queryKeys.sessions, {
          ...prevSessions,
          sessions: prevSessions.sessions.map(s =>
            s.id === sessionId ? { ...s, linkedIssue: null } : s
          ),
        });
      }

      // Optimistically clear linkedIssue in federation all-sessions cache
      if (prevFederation) {
        queryClient.setQueryData<FederationAllSessionsResponse>(
          queryKeys.federationAllSessions,
          {
            ...prevFederation,
            sessions: prevFederation.sessions.map(s =>
              s.id === sessionId ? { ...s, linkedIssue: null } : s
            ),
          }
        );
      }

      return { prevSession, prevSessions, prevFederation };
    },
    onError: (_err, _vars, context) => {
      // Rollback to previous values on error
      if (!context) return;
      clearFederationOverride(sessionId);
      if (context.prevSession) {
        queryClient.setQueryData(
          queryKeys.session(sessionId),
          context.prevSession
        );
      }
      if (context.prevSessions) {
        queryClient.setQueryData(queryKeys.sessions, context.prevSessions);
      }
      if (context.prevFederation) {
        queryClient.setQueryData(
          queryKeys.federationAllSessions,
          context.prevFederation
        );
      }
    },
    onSettled: () => {
      // Re-sync with server truth
      void queryClient.invalidateQueries({
        queryKey: queryKeys.session(sessionId),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.federationAllSessions,
        refetchType: "none",
      });
    },
  });

  /**
   * Set the current issue for this session
   */
  const setCurrentIssue = useCallback(
    (issue: {
      number: number;
      title: string;
      repo?: string;
      state?: "open" | "closed";
    }) => {
      setMutation.mutate(issue);
    },
    [setMutation]
  );

  /**
   * Clear the current issue for this session
   */
  const clearCurrentIssue = useCallback(() => {
    clearMutation.mutate();
  }, [clearMutation]);

  return {
    currentIssue,
    setCurrentIssue,
    clearCurrentIssue,
    defaultRepo: DEFAULT_REPO,
    isPending: setMutation.isPending || clearMutation.isPending,
  };
}
