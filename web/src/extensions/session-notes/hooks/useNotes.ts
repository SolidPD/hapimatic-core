// SPDX-License-Identifier: AGPL-3.0-only
/**
 * TanStack Query hooks for `builtin.session-notes` (issue #1284).
 *
 * ## The shared cache key IS the realtime mechanism
 *
 * The issue asks for "CRUD works in real time". For Hapimatic's single-user PWA
 * model that does not require SSE: `NotesTab` and `NotesIndicator` both read
 * `sessionNotesKey(sessionId)`, so they are two subscribers to ONE cache entry.
 * Invalidating that key after any mutation re-renders both in the same tick,
 * which is exactly the observable behavior an SSE round-trip would produce here
 * — without adding a server event type, a wire schema, or a subscription.
 *
 * ## Why the key is local, not in `@/lib/query-keys`
 *
 * `queryKeys` is core's namespace registry. An extension adding an entry there
 * would make core aware of the extension — the same inversion the
 * `ApiClient.extensionRequest` seam exists to avoid. The `["ext", <id>, …]`
 * prefix keeps extension keys collision-free from core's without core knowing.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";

import type { ApiClient } from "@/api/client";

/**
 * One note as the server returns it. Structurally mirrors the server's
 * `SessionNote` but is declared here rather than imported from `shared` — the
 * two halves are coupled by the REST contract, not by a shared type, exactly as
 * a third-party extension would be.
 */
export interface SessionNote {
  id: string;
  sessionId: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

interface NotesListResponse {
  notes: SessionNote[];
  count: number;
}

interface NoteResponse {
  note: SessionNote;
}

/** Maximum note length — mirrors `MAX_NOTE_LENGTH` on the server. */
export const MAX_NOTE_LENGTH = 5000;

/** Cache key shared by every consumer of this extension's data. */
export const sessionNotesKey = (sessionId: string): readonly unknown[] => [
  "ext",
  "session-notes",
  sessionId,
];

const basePath = (sessionId: string): string =>
  `/api/session-notes/${encodeURIComponent(sessionId)}`;

const notePath = (sessionId: string, noteId: string): string =>
  `${basePath(sessionId)}/${encodeURIComponent(noteId)}`;

export function useNotes(
  api: ApiClient | null,
  sessionId: string | null
): {
  notes: SessionNote[];
  count: number;
  isLoading: boolean;
  error: string | null;
} {
  const query = useQuery({
    queryKey: sessionNotesKey(sessionId ?? "unknown"),
    queryFn: async () => {
      if (!api || !sessionId) throw new Error("Session unavailable");
      return await api.extensionRequest<NotesListResponse>(basePath(sessionId));
    },
    enabled: Boolean(api && sessionId),
  });

  return {
    notes: query.data?.notes ?? [],
    count: query.data?.count ?? 0,
    isLoading: query.isLoading,
    error:
      query.error instanceof Error
        ? query.error.message
        : query.error
          ? "Failed to load notes"
          : null,
  };
}

/**
 * Create / update / delete, each invalidating the shared key on success so the
 * tab and the indicator refresh together.
 */
export function useNoteActions(
  api: ApiClient | null,
  sessionId: string | null
): {
  create: UseMutationResult<NoteResponse, Error, string>;
  update: UseMutationResult<
    NoteResponse,
    Error,
    { noteId: string; content: string }
  >;
  remove: UseMutationResult<{ success: boolean }, Error, string>;
} {
  const queryClient = useQueryClient();
  const invalidate = async () => {
    await queryClient.invalidateQueries({
      queryKey: sessionNotesKey(sessionId ?? "unknown"),
    });
  };

  const create = useMutation<NoteResponse, Error, string>({
    mutationFn: async (content: string) => {
      if (!api || !sessionId) throw new Error("Session unavailable");
      return await api.extensionRequest<NoteResponse>(basePath(sessionId), {
        method: "POST",
        body: JSON.stringify({ content }),
      });
    },
    onSuccess: invalidate,
  });

  const update = useMutation<
    NoteResponse,
    Error,
    { noteId: string; content: string }
  >({
    mutationFn: async ({ noteId, content }) => {
      if (!api || !sessionId) throw new Error("Session unavailable");
      return await api.extensionRequest<NoteResponse>(
        notePath(sessionId, noteId),
        { method: "PUT", body: JSON.stringify({ content }) }
      );
    },
    onSuccess: invalidate,
  });

  const remove = useMutation<{ success: boolean }, Error, string>({
    mutationFn: async (noteId: string) => {
      if (!api || !sessionId) throw new Error("Session unavailable");
      return await api.extensionRequest<{ success: boolean }>(
        notePath(sessionId, noteId),
        { method: "DELETE" }
      );
    },
    onSuccess: invalidate,
  });

  return { create, update, remove };
}
