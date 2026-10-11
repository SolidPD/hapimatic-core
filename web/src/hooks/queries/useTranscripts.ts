// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo } from "react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import type {
  TranscriptFilterOptions,
  TranscriptIndexStatus,
  TranscriptListQuery,
  TranscriptMessagesResponse,
  TranscriptResumeResponse,
  TranscriptSummary,
} from "@hapi/protocol/schemas";
import type { ApiClient } from "@/api/client";
import type { DecryptedMessage } from "@/types/api";
import { queryKeys } from "@/lib/query-keys";
import { useAgentToolResult } from "./useAgentTranscript";

// Transcript-browser query hooks (issue #3839). Pattern: useSessionMetadata.ts.
// The archive is namespace-scoped server-side (D27) — these hooks just read it.

/** Rows per request. Must stay ≤ the server's `limit` cap (200). */
export const TRANSCRIPT_PAGE_SIZE = 50;

const EMPTY_TRANSCRIPTS: TranscriptSummary[] = [];

export type TranscriptFilters = Omit<
  Partial<TranscriptListQuery>,
  "limit" | "offset"
>;

/**
 * List + search, paged by `offset` (#4050). The filters form the query key, so
 * a filter or sort change starts over at offset 0; "Show more" fetches the next
 * fixed-size page and appends it. Growing a single `limit` instead hit the
 * server's `limit ≤ 200` cap on the 4th click and 400'd.
 *
 * `isError` is true only when there is nothing to show (the first page failed).
 * A failed "Show more" keeps the loaded rows and reports `loadMoreError`. A failed
 * background poll (backfill only) also keeps the rows, but is not surfaced —
 * TanStack reports it as `isRefetchError`, not `isFetchNextPageError`.
 */
export function useTranscripts(
  api: ApiClient | null,
  filters: TranscriptFilters
): {
  transcripts: TranscriptSummary[];
  total: number;
  status: TranscriptIndexStatus | null;
  isLoading: boolean;
  isError: boolean;
  hasMore: boolean;
  loadMore: () => void;
  isLoadingMore: boolean;
  loadMoreError: boolean;
} {
  const q = useInfiniteQuery({
    queryKey: queryKeys.transcripts(filters as Record<string, unknown>),
    queryFn: ({ pageParam }) =>
      api!.getTranscripts({
        ...filters,
        limit: TRANSCRIPT_PAGE_SIZE,
        offset: pageParam,
      }),
    enabled: Boolean(api),
    initialPageParam: 0,
    getNextPageParam: (lastPage, pages) => {
      const loaded = pages.reduce((n, p) => n + p.transcripts.length, 0);
      // An empty page means the archive shrank under us — stop, don't loop.
      return lastPage.transcripts.length > 0 && loaded < lastPage.total
        ? loaded
        : undefined;
    },
    placeholderData: previous => previous,
    // While the backfill is running, poll so "indexed N of M" advances.
    refetchInterval: current => {
      const pages = current.state.data?.pages;
      const status = pages?.[pages.length - 1]?.status;
      return status && status.indexed < status.total ? 5000 : false;
    },
  });

  const pages = q.data?.pages;
  const last = pages?.[pages.length - 1];
  // Offset paging over a live index can repeat a row at a page boundary when a
  // new transcript lands mid-scroll; keep the first occurrence.
  let transcripts = EMPTY_TRANSCRIPTS;
  if (pages) {
    const seen = new Set<string>();
    transcripts = pages
      .flatMap(p => p.transcripts)
      .filter(t => {
        if (seen.has(t.ccSessionId)) return false;
        seen.add(t.ccSessionId);
        return true;
      });
  }
  const hasData = Boolean(pages && pages.length > 0);

  return {
    transcripts,
    total: last?.total ?? 0,
    status: last?.status ?? null,
    isLoading: q.isLoading,
    isError: q.isError && !hasData,
    hasMore: Boolean(q.hasNextPage),
    loadMore: () => {
      if (!q.isFetchingNextPage) void q.fetchNextPage();
    },
    isLoadingMore: q.isFetchingNextPage,
    loadMoreError: q.isFetchNextPageError,
  };
}

export function useTranscriptFilterOptions(api: ApiClient | null): {
  options: TranscriptFilterOptions | null;
} {
  const q = useQuery({
    queryKey: queryKeys.transcriptFilterOptions,
    queryFn: () => api!.getTranscriptFilterOptions(),
    enabled: Boolean(api),
  });
  return { options: q.data ?? null };
}

/** The loaded pages of one transcript, merged (#4053). */
export type TranscriptMessagesView = Pick<
  TranscriptMessagesResponse,
  "transcript" | "messages" | "truncatedToolResults" | "truncated"
>;

/**
 * One transcript's messages, paged by the server's opaque cursor (#4053; only
 * fetched once a transcript is opened). The loaded pages are merged into one
 * view so the reader reduces the UNION (a tool_use and its tool_result can sit
 * on either side of a page boundary). A failed "Load more" keeps what is
 * loaded and reports `loadMoreError`.
 */
export function useTranscriptMessages(
  api: ApiClient | null,
  ccSessionId: string | null
): {
  data: TranscriptMessagesView | null;
  isLoading: boolean;
  isError: boolean;
  hasMore: boolean;
  loadMore: () => void;
  isLoadingMore: boolean;
  loadMoreError: boolean;
} {
  const q = useInfiniteQuery({
    queryKey: queryKeys.transcriptMessages(ccSessionId ?? ""),
    queryFn: ({ pageParam }) =>
      api!.getTranscriptMessages(ccSessionId as string, {
        cursor: pageParam ?? undefined,
      }),
    enabled: Boolean(api && ccSessionId),
    initialPageParam: null as string | null,
    getNextPageParam: lastPage => lastPage.nextCursor ?? undefined,
    staleTime: 60_000,
  });
  const pages = q.data?.pages;
  // #4110: keep the merged view's identity stable across re-renders. TanStack
  // shares `pages` structurally, so it only changes when a page is added or
  // refetched — and so does `data`, which lets the reader skip re-reducing and
  // re-rendering its blocks on every render.
  const data = useMemo<TranscriptMessagesView | null>(() => {
    if (!pages || pages.length === 0) return null;
    const last = pages[pages.length - 1];
    return {
      transcript: pages[0].transcript,
      messages: pages.flatMap(p => p.messages),
      truncatedToolResults: Object.assign(
        {},
        ...pages.map(p => p.truncatedToolResults ?? {})
      ),
      truncated: last.nextCursor !== null && last.nextCursor !== undefined,
    };
  }, [pages]);
  return {
    data,
    isLoading: q.isLoading,
    isError: q.isError && !data,
    hasMore: Boolean(q.hasNextPage),
    loadMore: () => {
      if (!q.isFetchingNextPage) void q.fetchNextPage();
    },
    isLoadingMore: q.isFetchingNextPage,
    loadMoreError: q.isFetchNextPageError,
  };
}

/**
 * The full (untruncated) entry at `seq` — the expand-on-demand read for a tool
 * result the server cut (#4053). Only fetched while `enabled`.
 */
export function useTranscriptToolResult(
  api: ApiClient | null,
  ccSessionId: string,
  seq: number,
  enabled: boolean
): {
  message: TranscriptMessagesResponse["messages"][number] | null;
  isLoading: boolean;
  isError: boolean;
  retry: () => void;
} {
  const q = useQuery({
    queryKey: queryKeys.transcriptToolResult(ccSessionId, seq),
    queryFn: () =>
      api!.getTranscriptMessages(ccSessionId, {
        cursor: `${seq - 1}:0`,
        limit: 1,
        full: true,
      }),
    enabled: Boolean(api) && enabled,
    staleTime: Infinity,
  });
  return {
    message: q.data?.messages[0] ?? null,
    isLoading: q.isLoading && enabled,
    isError: q.isError,
    retry: () => {
      void q.refetch();
    },
  };
}

/**
 * Where a cut tool result's full entry is read from (#4386): the parent
 * transcript, or one background agent's sub-transcript. `TranscriptReader`
 * passes the transcript kind, `AgentPeek` the agent kind.
 */
export type ToolResultSource =
  | { kind: "transcript"; ccSessionId: string }
  | { kind: "agent"; sessionId: string; agentId: string };

/**
 * The full (untruncated) entry at `seq`, dispatched by source (#4386). The agent
 * kind MUST read the AGENT route — `ArchivedToolCall`'s expand would otherwise
 * fetch `/api/transcripts/:ccSessionId/messages` (the PARENT transcript), the
 * wrong file for an agent page. Both sub-hooks are called unconditionally
 * (hook-safety) and gated by `enabled` + kind, so exactly one ever fetches.
 */
export function useFullToolResult(
  api: ApiClient | null,
  source: ToolResultSource,
  seq: number,
  enabled: boolean
): {
  message: DecryptedMessage | null;
  isLoading: boolean;
  isError: boolean;
  retry: () => void;
} {
  const isTranscript = source.kind === "transcript";
  const transcript = useTranscriptToolResult(
    api,
    isTranscript ? source.ccSessionId : "",
    seq,
    enabled && isTranscript
  );
  const agent = useAgentToolResult(
    api,
    isTranscript ? "" : source.sessionId,
    isTranscript ? "" : source.agentId,
    seq,
    enabled && !isTranscript
  );
  return isTranscript ? transcript : agent;
}

/** Resume a transcript (optionally into the D28 picker's chosen directory). */
export function useResumeTranscript(api: ApiClient | null) {
  return useMutation<
    TranscriptResumeResponse,
    Error,
    { ccSessionId: string; directory?: string }
  >({
    mutationFn: ({ ccSessionId, directory }) =>
      api!.resumeTranscript(ccSessionId, directory),
  });
}
