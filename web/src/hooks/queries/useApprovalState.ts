// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { ApiClient, ApprovalStateResponse } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";

/** How often to re-poll while the gate is still open / in-flight (#3559 R6). */
const APPROVAL_STATE_POLL_MS = 2_000;

export interface UseApprovalStateResult {
  /** The server-authoritative gate state, or undefined while loading / disabled. */
  state: ApprovalStateResponse["state"] | undefined;
  /** Present on `consumed` — the grant mint instant (ISO). */
  mintedAt?: string;
  /** Present on `used` — the acceptance-ledger consumption instant (ISO). */
  consumedAt?: string;
}

/**
 * #3559 (R6): poll the server-driven approval-gate state for the approval card,
 * so the card's status comes from the grant/ledger on the server rather than from
 * the tap response alone.
 *
 * DISABLED unless `challengeId` is a decimal integer — it is an OPTIONAL,
 * FREE-FORM string on the wire, while both read routes 400 on a non-integer, so a
 * non-numeric id would poll a 400 forever on the `refetchInterval`. When disabled
 * (or while `api` is null / loading), `state` is undefined and the card falls back
 * to its tap-response behaviour.
 *
 * Polls every 2s while the gate is still open (`pending` / `consumed` /
 * `awaiting-overlap-decision` / `none`) and STOPS at a terminal state (`used` /
 * `invalidated`), so a completed or invalidated gate stops hitting the server.
 */
export function useApprovalState(
  api: ApiClient | null,
  sessionId: string,
  challengeId: string | undefined,
  nonce: string | undefined
): UseApprovalStateResult {
  const idOk =
    challengeId != null &&
    challengeId.trim() !== "" &&
    Number.isInteger(Number(challengeId));

  const query = useQuery({
    queryKey: queryKeys.approvalState(sessionId, challengeId ?? ""),
    queryFn: async (): Promise<ApprovalStateResponse> => {
      if (!api || !challengeId) throw new Error("API unavailable");
      return await api.getApprovalState(sessionId, challengeId, nonce);
    },
    enabled: Boolean(api) && Boolean(sessionId) && idOk,
    staleTime: 0,
    refetchInterval: q => {
      const s = q.state.data?.state;
      return s === "used" || s === "invalidated"
        ? false
        : APPROVAL_STATE_POLL_MS;
    },
    refetchIntervalInBackground: false,
  });

  return {
    state: query.data?.state,
    mintedAt: query.data?.minted_at,
    consumedAt: query.data?.consumed_at,
  };
}
