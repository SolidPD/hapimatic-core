// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { FileClaimConflictPair } from "@hapi/protocol";
import type { ApiClient } from "@/api/client";
import type { SessionSummary } from "@/types/api";
import { queryKeys } from "@/lib/query-keys";
import {
  DEFAULT_CHURN,
  deriveHistoryRows,
  type HistoryConflictRow,
} from "@/lib/fileConflicts";

// #2815 — recent-conflicts history for the /settings/file-conflicts page.
//
// Deliberately NOT on the 15s live poll and NOT under the ["file-claims"]
// query-key prefix (useSSE.ts invalidates that prefix on EVERY session event):
// history is a forensic view that changes at claim granularity (a new OPEN
// pair appears when a second overlapping claim lands; it closes at release),
// not a live surface — so it fetches on mount, stays fresh for 5 minutes, and
// refreshes on demand via the page's refresh affordance. Local-node history only — replicas carry live
// claims, not released history (KD5).

const HISTORY_STALE_MS = 300_000;

// #3508: module-level stable empty fallback for the pending-query pair stream —
// keeps the arg identity constant across renders (the #3462 render-loop fuel).
// NOTE: `deriveHistoryRows` is called UNMEMOIZED, so the returned `rows` identity
// still churns per render regardless (memoizing it is out of scope, #3508 Task 1);
// this constant simply gives the pending fallback a stable owner. Pattern:
// useMessages.ts EMPTY_BUBBLES.
const EMPTY_HISTORY_PAIRS: FileClaimConflictPair[] = [];

export interface UseFileClaimHistoryResult {
  rows: HistoryConflictRow[];
  ignoredPaths: string[];
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useFileClaimHistory(
  api: ApiClient | null,
  /** Merged session list from useFileConflicts — enriches labels; usually dead sessions degrade to raw ids. */
  sessions: SessionSummary[],
  opts?: { days?: number }
): UseFileClaimHistoryResult {
  const days = opts?.days ?? 7;

  const query = useQuery({
    queryKey: queryKeys.fileClaimHistory(days),
    queryFn: async () => {
      if (!api) throw new Error("API unavailable");
      const { conflicts } = await api.getFileClaimHistory({ days });
      return conflicts;
    },
    enabled: Boolean(api),
    staleTime: HISTORY_STALE_MS,
    retry: 1,
  });

  const { rows, ignoredPaths } = deriveHistoryRows(
    query.data ?? EMPTY_HISTORY_PAIRS,
    sessions,
    {
      ignore: DEFAULT_CHURN,
    }
  );

  return {
    rows,
    ignoredPaths,
    isLoading: query.isLoading,
    error: query.error instanceof Error ? query.error.message : null,
    refetch: () => void query.refetch(),
  };
}
