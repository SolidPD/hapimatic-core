// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { AgentTranscriptPage } from "@hapi/protocol/schemas";
import type { DecryptedMessage } from "@/types/api";
import type { ApiClient } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";

// Background-agent peek query hooks (issue #4386). Newest-first: the first page
// shows the agent's latest entries; "Load earlier" fetches OLDER pages via the
// server's opaque `before` cursor. Modelled on useTranscripts.ts.
//
// Live-tail (#4388, R1): while `live` (the agent's tracker status is `running`),
// the hook ALSO polls the server's forward `after` cursor every few seconds and
// APPENDS the newly-written entries to the bottom of the view — the live-tail
// seam `agentTranscriptPage` exposes (`after=<seq>:<byteOffset>`, append-safe,
// same scrub + 8 KB cap as every other page). "Running" is derived from the
// caller's `live` flag (the tracker status in the session record), never from
// the file, so a completion the CLI saw but the file's last line hasn't settled
// still stops the poll. Polling stops on done/error, on close (`enabled`), and
// when the tab is hidden (`refetchIntervalInBackground: false`).

/** Rows per request. Must stay ≤ the server's `limit` cap (TRANSCRIPT_MESSAGES_PAGE). */
const AGENT_PAGE_SIZE = 50;

/** Live-tail poll cadence while the agent is running (#4388 Task 3). */
const LIVE_TAIL_POLL_MS = 2500;

/** The loaded pages of one agent transcript, merged oldest-above-newest (#4386). */
export interface AgentTranscriptView {
  messages: DecryptedMessage[];
  truncatedToolResults: AgentTranscriptPage["truncatedToolResults"];
  tokens: AgentTranscriptPage["tokens"];
  agentType: string | null;
  description: string | null;
  /** Kept entries still older than the oldest one loaded (drives "Load earlier · N more"). */
  remaining: number;
}

/**
 * One background agent's sub-transcript, paged newest-first by the server's
 * opaque `before` cursor (only fetched while `enabled`). The loaded pages are
 * merged into one chronological view (oldest at the top) so the reader reduces
 * the UNION — a tool_use and its tool_result can sit on either side of a page
 * boundary. A failed "Load earlier" keeps what is loaded and reports
 * `loadMoreError`.
 */
export function useAgentTranscript(
  api: ApiClient | null,
  sessionId: string | null,
  agentId: string | null,
  enabled: boolean,
  /** #4388 Task 3: poll the forward `after` cursor while the agent is running. */
  live = false
): {
  data: AgentTranscriptView | null;
  isLoading: boolean;
  isError: boolean;
  hasMore: boolean;
  loadMore: () => void;
  isLoadingMore: boolean;
  loadMoreError: boolean;
  /** True while the live-tail poll is active (agent running + first page loaded). */
  isLive: boolean;
} {
  const q = useInfiniteQuery({
    queryKey: queryKeys.agentTranscript(sessionId ?? "", agentId ?? ""),
    queryFn: ({ pageParam }) =>
      api!.getAgentTranscriptPage(sessionId as string, agentId as string, {
        before: pageParam ?? undefined,
        limit: AGENT_PAGE_SIZE,
      }),
    enabled: Boolean(api && sessionId && agentId && enabled),
    initialPageParam: null as string | null,
    getNextPageParam: lastPage => lastPage.before ?? undefined,
    staleTime: 60_000,
  });
  const pages = q.data?.pages;

  // ── Live-tail (#4388 R1) ───────────────────────────────────────────────────
  // The EOF cursor at initial load = the FIRST (newest) page's `nextCursor`. It
  // is stable across "Load earlier" (older pages never shift `pages[0]`), so it
  // seeds the forward poll exactly once.
  const headCursor = pages?.[0]?.nextCursor ?? null;
  const [tail, setTail] = useState<{
    messages: DecryptedMessage[];
    cuts: AgentTranscriptPage["truncatedToolResults"];
  }>({ messages: [], cuts: {} });
  // The byte cursor the next poll resumes from. A ref (not state) because it
  // advances inside the poll's queryFn and must not itself trigger a refetch.
  const tailCursorRef = useRef<string | null>(null);

  // Reset the accumulator whenever the target agent changes so a reopened peek
  // (or a deep-link to a different agent) never shows a stale tail.
  useEffect(() => {
    tailCursorRef.current = null;
    setTail({ messages: [], cuts: {} });
  }, [sessionId, agentId]);

  // Seed the forward cursor from the EOF snapshot once the first page arrives.
  useEffect(() => {
    if (headCursor && tailCursorRef.current === null) {
      tailCursorRef.current = headCursor;
    }
  }, [headCursor]);

  const tailActive = Boolean(
    api && sessionId && agentId && enabled && live && headCursor
  );
  useQuery({
    // A sub-key of the agent-transcript namespace; distinct from the before-paged
    // infinite query so the two never collide in the cache.
    queryKey: [
      ...queryKeys.agentTranscript(sessionId ?? "", agentId ?? ""),
      "tail",
    ],
    queryFn: async () => {
      const cursor = tailCursorRef.current;
      if (!cursor) return { appended: 0 };
      const page = await api!.getAgentTranscriptPage(
        sessionId as string,
        agentId as string,
        { after: cursor, limit: AGENT_PAGE_SIZE }
      );
      // Advance the cursor every poll — even an empty page returns a fresh EOF
      // cursor, so the next poll never re-reads what it already saw.
      tailCursorRef.current = page.nextCursor;
      if (page.messages.length > 0) {
        setTail(prev => ({
          messages: [
            ...prev.messages,
            ...(page.messages as DecryptedMessage[]),
          ],
          cuts: { ...prev.cuts, ...(page.truncatedToolResults ?? {}) },
        }));
      }
      return { appended: page.messages.length };
    },
    enabled: tailActive,
    staleTime: 0,
    gcTime: 0,
    // Interval as a function of `live`: stop the moment the agent is no longer
    // running (useApprovalState pattern). Tab-hidden pauses via the flag below.
    refetchInterval: live ? LIVE_TAIL_POLL_MS : false,
    refetchIntervalInBackground: false,
  });

  const data = useMemo<AgentTranscriptView | null>(() => {
    if (!pages || pages.length === 0) return null;
    // Pages are fetched newest→older; display oldest-above-newest, then the
    // live-tail entries (strictly newer than the initial EOF) at the very bottom.
    const chrono = pages.slice().reverse();
    const oldest = pages[pages.length - 1];
    return {
      messages: [
        ...chrono.flatMap(p => p.messages as DecryptedMessage[]),
        ...tail.messages,
      ],
      truncatedToolResults: Object.assign(
        {},
        ...pages.map(p => p.truncatedToolResults ?? {}),
        tail.cuts
      ),
      tokens: pages[0].tokens,
      agentType: pages[0].agentType,
      description: pages[0].description,
      remaining: oldest.remaining,
    };
  }, [pages, tail]);
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
    isLive: tailActive,
  };
}

/**
 * The full (untruncated) agent entry at `seq` — the expand-on-demand read for a
 * tool result the server cut (#4386). Fetches the AGENT route (not the parent
 * transcript). Only fetched while `enabled`.
 */
export function useAgentToolResult(
  api: ApiClient | null,
  sessionId: string,
  agentId: string,
  seq: number,
  enabled: boolean
): {
  message: DecryptedMessage | null;
  isLoading: boolean;
  isError: boolean;
  retry: () => void;
} {
  const q = useQuery({
    queryKey: queryKeys.agentToolResult(sessionId, agentId, seq),
    queryFn: () =>
      api!.getAgentTranscriptPage(sessionId, agentId, {
        after: `${seq - 1}:0`,
        limit: 1,
        full: true,
      }),
    enabled: Boolean(api) && enabled,
    staleTime: Infinity,
  });
  return {
    message: (q.data?.messages[0] as DecryptedMessage | undefined) ?? null,
    isLoading: q.isLoading && enabled,
    isError: q.isError,
    retry: () => {
      void q.refetch();
    },
  };
}
