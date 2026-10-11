// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Bookmark, BookmarkListResponse } from "@hapi/protocol";
import { useAppContext } from "@/lib/app-context";
import { queryKeys } from "@/lib/query-keys";
import { getStorageKey } from "@/lib/storage-keys";

export interface UseBookmarksResult {
  /** All bookmarks for the session, oldest-first (server-authoritative). */
  bookmarks: Bookmark[];
  /**
   * Toggle a bookmark at the tapped SPOT `(messageId, blockId, offsetPx)`
   * (issue #3146). A double-tap within `TOGGLE_TOLERANCE_PX` of an existing
   * bookmark on the same anchor REMOVES it; otherwise a new bookmark is added at
   * the tapped spot — so one message/block can hold multiple bookmarks at
   * arbitrary spots. `blockId` omitted/null anchors to the whole turn (message
   * root); `offsetPx` omitted = 0 (the element top). `anchorHeightPx` is the
   * height of the element the offset was measured from (issue #3878) — carried
   * on an ADD only; it is not part of the spot identity. Optimistic.
   */
  toggleBookmark: (
    messageId: string,
    blockId?: string | null,
    offsetPx?: number,
    anchorHeightPx?: number | null
  ) => void;
  /**
   * Whether an anchor is bookmarked. `blockId` OMITTED → "does this message have
   * ANY bookmark" (the gutter-icon question); `blockId` provided (incl. null) →
   * exact-anchor match.
   */
  isBookmarked: (messageId: string, blockId?: string | null) => boolean;
  /** Remove all bookmarks for the session. Optimistic. */
  clearAll: () => void;
  /** True while the initial server fetch is in flight. */
  isLoading: boolean;
}

const EMPTY_BOOKMARKS: Bookmark[] = [];

/** PUT payload for a new bookmark at a spot (a type alias, so it satisfies the
 * `.passthrough()` request type's index signature). */
type PutBookmarkVars = {
  messageId: string;
  blockId: string | null;
  offsetPx: number;
  anchorHeightPx: number | null;
};

/**
 * A double-tap within this many pixels of an existing bookmark on the same
 * anchor toggles it OFF (issue #3146); a tap farther away adds a new bookmark.
 * Roughly the bookmark icon's height, so tapping "on" a visible icon removes it.
 */
const TOGGLE_TOLERANCE_PX = 16;

/** Read a legacy port-scoped localStorage bookmark set (message ids), fail-soft. */
function readLegacyBookmarks(storageKey: string): string[] {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

/** Remove the legacy localStorage key after a successful migration, fail-soft. */
function clearLegacyBookmarks(storageKey: string): void {
  try {
    localStorage.removeItem(storageKey);
  } catch {
    // Unavailable storage — nothing to clean up.
  }
}

/**
 * Per-session chat bookmarks, backed by the SERVER store (issue #3115, epic
 * #3133). Replaces the pre-#3115 port-scoped-localStorage model so bookmarks
 * placed on one device appear on the same session's chat on any other device
 * after a normal query refresh.
 *
 * The data model is `{ messageId, blockId, offsetPx }` (issue #3146): a bookmark
 * is a scroll POSITION — a nearest stable anchor element (`blockId`, or the
 * message root when null) plus `offsetPx`, the pixel offset of the tapped spot
 * within it. Messages/blocks have zero visible standing; the offset reproduces
 * the exact tapped row. A single message/block can hold multiple bookmarks at
 * arbitrary spots (`toggleBookmark` matches an existing bookmark by pixel
 * tolerance to remove it, else adds a new one).
 *
 * Node-local per RULING D2=A: a remote (federated) session persists its bookmarks
 * to the SERVING node; cross-node visibility is a documented follow-up.
 *
 * ## R5 — one-time localStorage → server migration (documented choice: MIGRATE)
 *
 * On the first load of a session whose server store is empty but whose legacy
 * `hapi:bookmarks:<sessionId>` localStorage key holds message ids, those ids are
 * POSTed once as whole-turn bookmarks, then the legacy key is cleared. Migration
 * is best-effort — a failure leaves the legacy key so a later load retries.
 */
export function useBookmarks(sessionId: string): UseBookmarksResult {
  const { api } = useAppContext();
  const queryClient = useQueryClient();
  const bookmarksKey = queryKeys.bookmarks(sessionId);

  const query = useQuery({
    queryKey: bookmarksKey,
    queryFn: () => api.getBookmarks(sessionId),
    enabled: Boolean(sessionId),
    staleTime: 5_000,
  });

  const bookmarks = query.data?.bookmarks ?? EMPTY_BOOKMARKS;

  // The three bookmark mutations (put / delete / clear) share one optimistic
  // lifecycle: cancel in-flight fetches, snapshot the list for rollback, apply an
  // optimistic transform, roll back on error, and always re-sync from the server
  // on settle. Only the transform differs, so it is the single parameter here.
  type OptimisticContext = { previous: BookmarkListResponse | undefined };
  const optimisticLifecycle = <TVars>(
    transform: (current: Bookmark[], vars: TVars) => Bookmark[]
  ) => ({
    onMutate: async (vars: TVars): Promise<OptimisticContext> => {
      await queryClient.cancelQueries({ queryKey: bookmarksKey });
      const previous =
        queryClient.getQueryData<BookmarkListResponse>(bookmarksKey);
      queryClient.setQueryData<BookmarkListResponse>(bookmarksKey, old => ({
        bookmarks: transform(old?.bookmarks ?? [], vars),
      }));
      return { previous };
    },
    onError: (
      _err: unknown,
      _vars: TVars,
      ctx: OptimisticContext | undefined
    ) => {
      if (ctx?.previous) queryClient.setQueryData(bookmarksKey, ctx.previous);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: bookmarksKey });
    },
  });

  const putMutation = useMutation({
    mutationFn: (vars: PutBookmarkVars) => api.putBookmark(sessionId, vars),
    // Optimistically add — a stable temp id keyed to the exact spot so a repeat
    // toggle before settle still finds it. The row carries `anchorHeightPx` too
    // (#3878), so the icon and a jump agree with the server row from the first
    // frame instead of using the raw offset until the refetch lands.
    ...optimisticLifecycle<PutBookmarkVars>((current, vars) => [
      ...current,
      {
        id: `optimistic:${vars.messageId}:${vars.blockId ?? ""}:${vars.offsetPx}`,
        messageId: vars.messageId,
        blockId: vars.blockId,
        offsetPx: vars.offsetPx,
        anchorHeightPx: vars.anchorHeightPx,
        createdAt: new Date().toISOString(),
      },
    ]),
  });

  const deleteMutation = useMutation({
    mutationFn: (bookmarkId: string) =>
      api.deleteBookmark(sessionId, bookmarkId),
    ...optimisticLifecycle<string>((current, bookmarkId) =>
      current.filter(b => b.id !== bookmarkId)
    ),
  });

  const clearMutation = useMutation({
    mutationFn: () => api.clearBookmarks(sessionId),
    ...optimisticLifecycle<void>(() => []),
  });

  const toggleBookmark = useCallback(
    (
      messageId: string,
      blockId?: string | null,
      offsetPx?: number,
      anchorHeightPx?: number | null
    ) => {
      const bid = blockId ?? null;
      const off = offsetPx ?? 0;
      // Read the freshest cache so a rapid double-toggle never acts on a stale list.
      const current =
        queryClient.getQueryData<BookmarkListResponse>(bookmarksKey)
          ?.bookmarks ?? [];
      // Toggle by SPOT (#3146): a tap within tolerance of an existing bookmark on
      // the same anchor removes it; otherwise add a new bookmark at the tapped
      // spot. Prefer the nearest match so overlapping bookmarks stay resolvable.
      const nearby = current
        .filter(
          b =>
            b.messageId === messageId &&
            b.blockId === bid &&
            !b.id.startsWith("optimistic:") &&
            Math.abs(b.offsetPx - off) <= TOGGLE_TOLERANCE_PX
        )
        .sort(
          (a, b) => Math.abs(a.offsetPx - off) - Math.abs(b.offsetPx - off)
        );
      if (nearby.length > 0) {
        deleteMutation.mutate(nearby[0].id);
      } else {
        putMutation.mutate({
          messageId,
          blockId: bid,
          offsetPx: off,
          anchorHeightPx: anchorHeightPx ?? null,
        });
      }
    },
    [queryClient, bookmarksKey, deleteMutation, putMutation]
  );

  const isBookmarked = useCallback(
    (messageId: string, blockId?: string | null) => {
      if (blockId === undefined) {
        return bookmarks.some(b => b.messageId === messageId);
      }
      const bid = blockId ?? null;
      return bookmarks.some(
        b => b.messageId === messageId && b.blockId === bid
      );
    },
    [bookmarks]
  );

  const clearAll = useCallback(() => {
    clearMutation.mutate();
  }, [clearMutation]);

  // R5 migration — one-time localStorage → server, per session.
  const migratedSessions = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!sessionId || !query.isSuccess) return;
    if ((query.data?.bookmarks.length ?? 0) > 0) return; // server already has data
    if (migratedSessions.current.has(sessionId)) return;
    migratedSessions.current.add(sessionId);

    const legacyKey = getStorageKey(`hapi:bookmarks:${sessionId}`);
    const legacyIds = readLegacyBookmarks(legacyKey);
    if (legacyIds.length === 0) return;

    void (async () => {
      try {
        for (const messageId of legacyIds) {
          await api.putBookmark(sessionId, { messageId, blockId: null });
        }
        clearLegacyBookmarks(legacyKey);
        await queryClient.invalidateQueries({ queryKey: bookmarksKey });
      } catch {
        // Best-effort — leave the legacy key + allow a retry on a later load.
        migratedSessions.current.delete(sessionId);
      }
    })();
  }, [sessionId, query.isSuccess, query.data, api, queryClient, bookmarksKey]);

  return {
    bookmarks,
    toggleBookmark,
    isBookmarked,
    clearAll,
    isLoading: query.isLoading,
  };
}
