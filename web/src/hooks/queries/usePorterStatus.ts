// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import {
  PORTER_WITHHELD_CODE,
  type PorterStatusResponse,
} from "@hapi/protocol/porter";
import { ApiError, type ApiClient } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";

/**
 * Configuration Porter exposure probe (issues #4533, #5165 and #4655, epic
 * #4290).
 *
 * FAIL-CLOSED, the `useVmPreflight` contract: Porter is exposed by default
 * (#5165) and answers `GET /api/porter/status` with 200 `{ exposed: true }`; an
 * instance withheld by the kill switch (`HAPI_PORTER_EXPOSED=0`) answers 404
 * `porter_withheld`. Callers gate on {@link porterExposure} /
 * {@link isPorterExposed}, and Porter UI mounts only on an `exposed` verdict.
 * `retry: false` is load-bearing: a retry storm on the designed 404 would only
 * delay that verdict. The client method declares 404 an expected status, so a
 * withheld tenant's Settings visit reports nothing.
 */
export function usePorterStatus(api: ApiClient | null) {
  return useQuery({
    queryKey: queryKeys.porterStatus,
    queryFn: async (): Promise<PorterStatusResponse> => {
      if (!api) throw new Error("API unavailable");
      return await api.getPorterStatus();
    },
    enabled: Boolean(api),
    retry: false,
    staleTime: 60_000,
  });
}

/** The fields of a probe query the verdict reads (#4655). */
export interface PorterStatusQuery {
  status: "pending" | "error" | "success";
  data?: PorterStatusResponse;
  error: unknown;
}

/** The exposure verdict a caller renders (#4655). */
export type PorterExposure = "loading" | "exposed" | "withheld" | "unknown";

/** True only for the gate's own refusal: a 404 `ApiError` with `porter_withheld`. */
export function isPorterWithheldError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 404 &&
    error.code === PORTER_WITHHELD_CODE
  );
}

/**
 * The exposure verdict for a probe query (#4655). The ERROR branch comes first:
 * TanStack Query v5 keeps the last successful `data` when a refetch fails, so a
 * tab that cached `{ exposed: true }` before an exposed → withheld rollback must
 * not stay exposed. A 404 `porter_withheld` is `withheld`. Every other failure
 * (a 5xx, a timeout, a network drop, an unrecovered 401) is `unknown`: it is
 * not proof of withholding, so the page offers Retry instead of the
 * not-available notice.
 */
export function porterExposure(query: PorterStatusQuery): PorterExposure {
  if (query.status === "error") {
    return isPorterWithheldError(query.error) ? "withheld" : "unknown";
  }
  if (query.status === "pending") return "loading";
  return query.data?.exposed === true ? "exposed" : "unknown";
}

/** True only for an `exposed` verdict: loading, withheld and unknown hide Porter. */
export function isPorterExposed(query: PorterStatusQuery): boolean {
  return porterExposure(query) === "exposed";
}
