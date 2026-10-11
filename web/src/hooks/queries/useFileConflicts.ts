// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import type { FileClaim } from "@hapi/protocol";
import type { SessionSummary } from "@/types/api";
import { queryKeys } from "@/lib/query-keys";
import { useSessions } from "@/hooks/queries/useSessions";
import { useFederatedSessions } from "@/hooks/queries/useFederatedSessions";
import {
  DEFAULT_CHURN,
  deriveConflictRows,
  deriveInFlightRows,
  type FileConflictRow,
  type InFlightSessionGroup,
} from "@/lib/fileConflicts";

// File Conflict Monitor (epic #1965) Sub F / #1971 — the query hook powering the
// observe-phase conflict table; extended by #2815 with the in-flight inventory.
// Two composed layers (KD1/KD3):
//   1. the MERGED session list (local + federated) → yields the DISTINCT repos,
//   2. a per-repo `useQueries` fan-out → `GET /api/file-claims?repo=<owner/name>`.
// The rows are computed client-side by the pure `deriveConflictRows` /
// `deriveInFlightRows` helpers. Live updates ride the existing session SSE
// events (see useSSE.ts, which invalidates the `["file-claims"]` prefix) plus
// this 15s poll backstop for mid-session claim churn.
//
// #2815 in-path fix (research Finding 1, empirically CONFIRMED on prod): the
// previous implementation sourced sessions ONLY from
// `GET /api/federation/all-sessions`, which returns REMOTE-registry sessions
// only (`webClient.ts` — `[]` on a standalone node, and never the answering
// node's own sessions on a hub). That left every surface blind to local-node
// sessions and the page permanently empty on standalone/worktree instances.
// The fix mirrors the documented merge convention (`router.tsx`,
// `claimedIssues.ts`): local sessions enriched with the hub's own node
// identity, then federated sessions, deduped by id.

const REFETCH_INTERVAL_MS = 15_000;

export interface UseFileConflictsResult {
  rows: FileConflictRow[];
  ignoredPaths: string[];
  /** #2815: the raw merged live claims across repos (inventory source). */
  claims: FileClaim[];
  /** #2815: every live claim grouped by session — the in-flight view. */
  inFlightRows: InFlightSessionGroup[];
  /** #2815: merged local+federated sessions (consumed by the history hook). */
  sessions: SessionSummary[];
  /** Distinct repos being polled (surfaced for an empty-state hint). */
  repos: string[];
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

/** Distinct `owner/name` repos across the live sessions (matches the claim `repo`). */
function distinctRepos(sessions: SessionSummary[]): string[] {
  const set = new Set<string>();
  for (const s of sessions) {
    const name = s.metadata?.repoIdentity?.name;
    if (name) set.add(name);
  }
  return [...set].sort();
}

export function useFileConflicts(
  api: ApiClient | null
): UseFileConflictsResult {
  const {
    sessions: localSessions,
    isLoading: localLoading,
    error: localError,
    refetch: refetchLocal,
  } = useSessions(api);
  const {
    remoteSessions,
    localNode,
    error: federatedError,
  } = useFederatedSessions(api);

  // Merge local + federated, deduped by id (defensive — the remote list should
  // never contain this node's sessions, but a duplicate would manufacture a
  // false self-conflict downstream). Mirrors router.tsx's enrichment so
  // NodeBadge data is present for local sessions too.
  const sessions = useMemo(() => {
    const enrichedLocal = localNode
      ? localSessions.map(s => ({
          ...s,
          nodeId: localNode.nodeId,
          nodeLabel: localNode.nodeLabel,
        }))
      : localSessions;
    const merged = new Map<string, SessionSummary>();
    for (const s of [...enrichedLocal, ...remoteSessions]) {
      if (!merged.has(s.id)) merged.set(s.id, s);
    }
    return [...merged.values()];
  }, [localSessions, remoteSessions, localNode]);

  const repos = distinctRepos(sessions);

  // Per-repo fan-out — ~1–3 calls per interval, one exact-match query per repo.
  const claimQueries = useQueries({
    queries: repos.map(repo => ({
      queryKey: queryKeys.fileClaims(repo),
      queryFn: async () => {
        if (!api) throw new Error("API unavailable");
        const { claims } = await api.getFileClaims(repo);
        return claims;
      },
      enabled: Boolean(api),
      refetchInterval: REFETCH_INTERVAL_MS,
      retry: 1,
    })),
  });

  // The derivations are cheap pure folds over a small claim set — compute inline
  // rather than memoize a variable-length query array (an observe-only leaf table).
  // #3508 (Task 2, non-target): the `q.data` empty fallback here is a per-element
  // flatMap fallback that yields a fresh array regardless — not a returned array identity.
  const claims = claimQueries.flatMap(q => q.data ?? []);
  const { rows, ignoredPaths } = deriveConflictRows(claims, sessions, {
    ignore: DEFAULT_CHURN,
  });
  const inFlightRows = deriveInFlightRows(claims, sessions);

  // Error surface parity with the pre-#2815 hook (PR-review finding): the old
  // implementation surfaced the all-sessions fetch error first; the merged
  // sourcing must surface BOTH session sources plus the claim fan-out, or a
  // failing federation fetch silently degrades every surface (labels fall back
  // to raw ids — camouflaged as the legitimate R6 degradation).
  const claimError = claimQueries.find(q => q.error)?.error;
  const error =
    localError ??
    federatedError ??
    (claimError instanceof Error
      ? claimError.message
      : claimError
        ? "Failed to load file claims"
        : null);

  const isLoading = localLoading || claimQueries.some(q => q.isLoading);

  const refetch = () => {
    void refetchLocal();
    claimQueries.forEach(q => void q.refetch());
  };

  return {
    rows,
    ignoredPaths,
    claims,
    inFlightRows,
    sessions,
    repos,
    isLoading,
    error,
    refetch,
  };
}
