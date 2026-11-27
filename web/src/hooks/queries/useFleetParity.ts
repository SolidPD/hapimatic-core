// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  FLEET_PARITY_STALE_AFTER_MS,
  FleetParityVerdictSchema,
  type FleetParityVerdict,
} from "@hapi/protocol/adminVms";
import type { ApiClient } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";

/** How often an open page re-reads the verdict (#6300 PR-4 round 4: at most 5 minutes). */
export const FLEET_PARITY_REFETCH_MS = 5 * 60 * 1000;

/** How often the page re-checks the verdict's age between reads. */
const AGE_CHECK_MS = 60 * 1000;

/**
 * The verdict as the page shows it: stale when the server said so, OR when it
 * has aged past {@link FLEET_PARITY_STALE_AFTER_MS} since (#6300 PR-4 round 4),
 * so a page left open, or a refetch that fails, never keeps a stale pass green.
 */
export function withAgedStale(
  verdict: FleetParityVerdict,
  nowMs: number
): FleetParityVerdict {
  if (verdict.state !== "ok" || verdict.stale) return verdict;
  const checkedMs = Date.parse(verdict.checkedAt);
  return Number.isFinite(checkedMs) &&
    nowMs - checkedMs > FLEET_PARITY_STALE_AFTER_MS
    ? { ...verdict, stale: true }
    : verdict;
}

/**
 * RP1's nightly fleet parity verdict, as `GET /api/admin-vms/fleet-parity`
 * projects it (#6300 PR-4): `absent`, `unreadable`, or each node's state. The
 * response is parsed with the shared `.strict()` schema, so a shape drift fails
 * loudly here rather than rendering wrong rows. No retry: a 404 means the
 * capability is closed on this instance. `stale` is the aged value
 * ({@link withAgedStale}), which the panel and the inventory both read.
 */
export function useFleetParity(
  api: ApiClient | null,
  options?: { enabled?: boolean }
) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), AGE_CHECK_MS);
    return () => clearInterval(timer);
  }, []);
  const select = useCallback(
    (verdict: FleetParityVerdict) => withAgedStale(verdict, nowMs),
    [nowMs]
  );
  return useQuery({
    queryKey: queryKeys.fleetParity,
    queryFn: async (): Promise<FleetParityVerdict> => {
      if (!api) throw new Error("API unavailable");
      return FleetParityVerdictSchema.parse(
        await api.extensionRequest<unknown>("/api/admin-vms/fleet-parity")
      );
    },
    select,
    enabled: (options?.enabled ?? true) && Boolean(api),
    refetchInterval: FLEET_PARITY_REFETCH_MS,
    retry: false,
  });
}
