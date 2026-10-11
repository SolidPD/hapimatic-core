// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { serializeNotes, type NotesContent } from "@hapi/protocol";
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
 * Optimistic notes mutation (issue #1617).
 *
 * Mirrors `renameMutation` in `useSessionActions.ts` — the only other
 * metadata-field mutation — but is kept OUT of that already-large hook so the
 * consumers that need ONLY notes (SessionNotes, the session-list notes modal)
 * don't instantiate a dozen unrelated mutations. The shared autosave hook
 * (`useSessionNotesAutosave`) composes this.
 *
 * 🔴 R9 (envelope preservation): the mutation variable is a `NotesContent`
 * ENVELOPE, never `string | null`. The OBJECT is passed to
 * `api.updateSessionNotes` (which serializes it), and the SERIALIZED envelope
 * string is written into every cache/override — because `metadata.notes` holds
 * the serialized envelope and every consumer decodes it with `parseNotes()`. A
 * text-only cache write would orphan the session's attachments in the preview.
 *
 * 🔴 R4 (federation correctness): the federation override wraps the FULL
 * `metadata` object (`{ metadata: { ...fedSession.metadata, notes } }`).
 * `applyFederationOverrides` spreads overrides at the TOP level and `notes`
 * lives INSIDE `metadata` on `SessionSummary`, so a bare `{ notes }` override
 * would never apply and the value would silently revert within 10-30s.
 *
 * NOTE the cache-shape asymmetry: `notes` is a TOP-LEVEL field on the detail
 * `Session` (`session.notes`, read by SessionChat) but lives INSIDE `metadata`
 * on the list/federation `SessionSummary` (`s.metadata.notes`, read by
 * SessionItem). Each cache is updated in its own correct location.
 */
export function useUpdateSessionNotes(
  api: ApiClient | null,
  sessionId: string | null
): {
  updateNotes: (content: NotesContent) => Promise<void>;
  isPending: boolean;
} {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async (content: NotesContent) => {
      if (!api || !sessionId) {
        throw new Error("Session unavailable");
      }
      // Pass the OBJECT — api.updateSessionNotes serializes it to the envelope.
      await api.updateSessionNotes(sessionId, content);
    },
    onMutate: async (content: NotesContent) => {
      if (!sessionId) return;
      // Serialize ONCE — this string is what every cache/override stores,
      // because `metadata.notes` holds the serialized envelope (not raw text).
      const serialized = serializeNotes(content);
      const notesValue = serialized ?? undefined;

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

      // Register override so the 10s federation poll doesn't revert our value.
      // MUST wrap the full metadata object (R4) — a bare `{ notes }` never
      // applies (applyFederationOverrides spreads at the top level).
      const fedSession = prevFederation?.sessions.find(s => s.id === sessionId);
      if (fedSession?.metadata) {
        setFederationOverride(sessionId, {
          metadata: { ...fedSession.metadata, notes: notesValue },
        });
      }

      // Detail cache: `notes` is a TOP-LEVEL field on the raw Session.
      if (prevSession?.session) {
        queryClient.setQueryData<SessionResponse>(
          queryKeys.session(sessionId),
          {
            ...prevSession,
            session: { ...prevSession.session, notes: notesValue },
          }
        );
      }

      // List cache: `notes` lives INSIDE metadata on SessionSummary.
      if (prevSessions) {
        queryClient.setQueryData<SessionsResponse>(queryKeys.sessions, {
          ...prevSessions,
          sessions: prevSessions.sessions.map(s =>
            s.id === sessionId && s.metadata
              ? { ...s, metadata: { ...s.metadata, notes: notesValue } }
              : s
          ),
        });
      }

      // Federation cache: `notes` lives INSIDE metadata on SessionSummary.
      if (prevFederation) {
        queryClient.setQueryData<FederationAllSessionsResponse>(
          queryKeys.federationAllSessions,
          {
            ...prevFederation,
            sessions: prevFederation.sessions.map(s =>
              s.id === sessionId && s.metadata
                ? { ...s, metadata: { ...s.metadata, notes: notesValue } }
                : s
            ),
          }
        );
      }

      return { prevSession, prevSessions, prevFederation };
    },
    onError: (_err, _content, context) => {
      // Rollback to previous values on error
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
      // cache on the hub may still hold stale data for up to 10s. Letting the
      // regular poll pick up fresh data avoids overwriting our optimistic value.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.federationAllSessions,
        refetchType: "none",
      });
    },
  });

  return {
    updateNotes: mutation.mutateAsync,
    isPending: mutation.isPending,
  };
}
