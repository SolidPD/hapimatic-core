// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import type {
  DigestDetail,
  DigestMeta,
  ThroughputBreakdown,
  ThroughputBreakdownDim,
  ThroughputSummary,
  ThroughputTestsPage,
} from "@/types/api";
import { queryKeys } from "@/lib/query-keys";

/**
 * Throughput telemetry queries (issue #6164, A1 — R9).
 *
 * Kept in their own file (the analytics page test mocks `useTelemetry` with a
 * closed factory) and called inside the Throughput panel, never at page level:
 * Radix unmounts an inactive tab's content, so nothing here runs until the
 * Throughput tab is open. The data changes slowly (rollups, an hourly GitHub
 * job, a weekly digest), so every query refetches at most every 5 minutes.
 */

const FIVE_MIN = 5 * 60_000;

export interface ThroughputRange {
  from: number;
  to: number;
}

function errorText(error: unknown, fallback: string): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : fallback;
}

export function useThroughputSummary(
  api: ApiClient | null,
  range: ThroughputRange
): {
  summary: ThroughputSummary | null;
  isLoading: boolean;
  error: string | null;
} {
  const query = useQuery({
    queryKey: queryKeys.throughputSummary(range.from, range.to),
    queryFn: async () => {
      if (!api) throw new Error("API unavailable");
      return await api.getThroughputSummary(range);
    },
    enabled: Boolean(api),
    refetchInterval: FIVE_MIN,
    staleTime: FIVE_MIN,
  });
  return {
    summary: query.data ?? null,
    isLoading: query.isLoading,
    error: errorText(query.error, "Failed to load the throughput summary"),
  };
}

export function useThroughputBreakdown(
  api: ApiClient | null,
  dim: ThroughputBreakdownDim,
  range: ThroughputRange,
  cursor: string
): {
  page: ThroughputBreakdown | null;
  isLoading: boolean;
  error: string | null;
} {
  const query = useQuery({
    queryKey: queryKeys.throughputBreakdown(dim, range.from, range.to, cursor),
    queryFn: async () => {
      if (!api) throw new Error("API unavailable");
      return await api.getThroughputBreakdown(dim, range, cursor || undefined);
    },
    enabled: Boolean(api),
    refetchInterval: FIVE_MIN,
    staleTime: FIVE_MIN,
  });
  return {
    page: query.data ?? null,
    isLoading: query.isLoading,
    error: errorText(query.error, "Failed to load the breakdown"),
  };
}

export function useThroughputTests(
  api: ApiClient | null,
  range: ThroughputRange
): { page: ThroughputTestsPage | null; isLoading: boolean } {
  const query = useQuery({
    queryKey: queryKeys.throughputTests(range.from, range.to),
    queryFn: async () => {
      if (!api) throw new Error("API unavailable");
      return await api.getThroughputTests(range);
    },
    enabled: Boolean(api),
    refetchInterval: FIVE_MIN,
    staleTime: FIVE_MIN,
  });
  return { page: query.data ?? null, isLoading: query.isLoading };
}

export function useThroughputDigests(api: ApiClient | null): {
  digests: DigestMeta[];
  isLoading: boolean;
} {
  const query = useQuery({
    queryKey: queryKeys.throughputDigests(),
    queryFn: async () => {
      if (!api) throw new Error("API unavailable");
      return await api.getThroughputDigests();
    },
    enabled: Boolean(api),
    refetchInterval: FIVE_MIN,
    staleTime: FIVE_MIN,
  });
  return { digests: query.data?.digests ?? [], isLoading: query.isLoading };
}

export function useThroughputDigest(
  api: ApiClient | null,
  id: string | null
): { digest: DigestDetail | null; isLoading: boolean } {
  const query = useQuery({
    queryKey: queryKeys.throughputDigest(id ?? ""),
    queryFn: async () => {
      if (!api || !id) throw new Error("API unavailable");
      return await api.getThroughputDigest(id);
    },
    enabled: Boolean(api) && id !== null,
    staleTime: FIVE_MIN,
  });
  return { digest: query.data ?? null, isLoading: query.isLoading };
}
