// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SessionView } from "@hapi/protocol/types";
import type { ApiClient } from "@/api/client";
import type {
  FederationAllSessionsResponse,
  SessionResponse,
  SessionsResponse,
} from "@/types/api";
import { queryKeys } from "@/lib/query-keys";
import {
  setFederationOverride,
  clearFederationOverride,
} from "@/lib/federation-mutation-overrides";

/**
 * Optimistic session-view mutation (issue #3286 · View Picker).
 *
 * Mirrors `useUpdateSessionNotes` — the metadata-field optimistic template — but
 * carries a plain `SessionView` enum, so there is NO envelope/serialization step.
 *
 * NOTE the cache-shape asymmetry (same as notes): `persistedView` is a TOP-LEVEL
 * field on the detail `Session` (`session.persistedView`, read by the ViewPicker)
 * but lives INSIDE `metadata` on the list/federation `SessionSummary`. Each cache
 * is updated in its own correct location. The federation override wraps the FULL
 * `metadata` object because `applyFederationOverrides` spreads overrides at the
 * TOP level and `persistedView` lives under `metadata` on `SessionSummary`, so a
 * bare `{ persistedView }` override would never apply and would silently revert
 * within the 10s federation poll.
 */
export function useUpdateSessionView(
  api: ApiClient | null,
  sessionId: string | null
): {
  updateView: (view: SessionView) => Promise<void>;
  isPending: boolean;
} {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async (view: SessionView) => {
      if (!api || !sessionId) {
        throw new Error("Session unavailable");
      }
      await api.updateSessionView(sessionId, view);
    },
    onMutate: async (view: SessionView) => {
      if (!sessionId) return;

      // Cancel outgoing refetches so they don't overwrite our optimistic update.
      await queryClient.cancelQueries({
        queryKey: queryKeys.session(sessionId),
      });
      await queryClient.cancelQueries({ queryKey: queryKeys.sessions });
      await queryClient.cancelQueries({
        queryKey: queryKeys.federationAllSessions,
      });

      // Snapshot previous values for rollback.
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

      // Register override so the 10s federation poll doesn't revert our value.
      // MUST wrap the full metadata object — a bare `{ persistedView }` never
      // applies (applyFederationOverrides spreads at the top level).
      const fedSession = prevFederation?.sessions.find(s => s.id === sessionId);
      if (fedSession?.metadata) {
        setFederationOverride(sessionId, {
          metadata: { ...fedSession.metadata, persistedView: view },
        });
      }

      // Detail cache: `persistedView` is a TOP-LEVEL field on the raw Session.
      if (prevSession?.session) {
        queryClient.setQueryData<SessionResponse>(
          queryKeys.session(sessionId),
          {
            ...prevSession,
            session: { ...prevSession.session, persistedView: view },
          }
        );
      }

      // List cache: `persistedView` lives INSIDE metadata on SessionSummary.
      if (prevSessions) {
        queryClient.setQueryData<SessionsResponse>(queryKeys.sessions, {
          ...prevSessions,
          sessions: prevSessions.sessions.map(s =>
            s.id === sessionId && s.metadata
              ? { ...s, metadata: { ...s.metadata, persistedView: view } }
              : s
          ),
        });
      }

      // Federation cache: `persistedView` lives INSIDE metadata on SessionSummary.
      if (prevFederation) {
        queryClient.setQueryData<FederationAllSessionsResponse>(
          queryKeys.federationAllSessions,
          {
            ...prevFederation,
            sessions: prevFederation.sessions.map(s =>
              s.id === sessionId && s.metadata
                ? { ...s, metadata: { ...s.metadata, persistedView: view } }
                : s
            ),
          }
        );
      }

      return { prevSession, prevSessions, prevFederation };
    },
    onError: (_err, _view, context) => {
      // Roll back to previous values on error.
      if (!sessionId || !context) return;
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
    onSettled: async () => {
      if (!sessionId) return;
      await queryClient.invalidateQueries({
        queryKey: queryKeys.session(sessionId),
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
      // Mark federation cache stale WITHOUT immediate refetch — the NodeRegistry
      // cache on the hub may still hold stale data for up to 10s. Let the regular
      // poll pick up fresh data instead of overwriting our optimistic value.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.federationAllSessions,
        refetchType: "none",
      });
    },
  });

  return {
    updateView: mutation.mutateAsync,
    isPending: mutation.isPending,
  };
}
