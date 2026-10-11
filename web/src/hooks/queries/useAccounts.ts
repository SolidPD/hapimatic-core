// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import type {
  AccountsResponse,
  OnboardingRegistration,
  RedactedAccount,
} from "@/types/api";
import { queryKeys } from "@/lib/query-keys";

// #3508: module-level stable empty fallback — keeps the pending-query array
// identity constant across renders (the #3462 render-loop fuel). Pattern:
// useMessages.ts EMPTY_BUBBLES.
const EMPTY_ACCOUNTS: RedactedAccount[] = [];

/** #4736: re-check interval while the onboarding seed is still in flight. */
export const ONBOARDING_PENDING_POLL_MS = 3_000;
/** #4736: slower re-check while the onboarding sign-in reads as missing. */
export const ONBOARDING_MISSING_POLL_MS = 15_000;

/**
 * #4736: how often to re-read `GET /api/accounts` for a given onboarding state.
 * `"missing"` is polled too, not just `"pending"`: the daemon records `"pending"`
 * only after its machine registration, so a read during boot can say `"missing"`
 * a few seconds before the seed lands — the notice must still clear by itself.
 */
export function onboardingPollInterval(
  registration: OnboardingRegistration
): number | false {
  if (registration === "pending") return ONBOARDING_PENDING_POLL_MS;
  if (registration === "missing") return ONBOARDING_MISSING_POLL_MS;
  return false;
}

/**
 * #4736: the Accounts page's `refetchInterval` for `GET /api/accounts`. A read that
 * failed before any data arrived keeps polling at the missing cadence: the page is
 * often opened right after the wizard restarts both units, and a failed first read
 * must not leave the onboarding notice off for the rest of the visit.
 */
export function onboardingRefetchInterval(state: {
  status: string;
  data: AccountsResponse | undefined;
}): number | false {
  if (state.data === undefined && state.status === "error") {
    return ONBOARDING_MISSING_POLL_MS;
  }
  return onboardingPollInterval(state.data?.onboardingRegistration ?? null);
}

/**
 * Query the stored accounts for the local node (epic #1446, Sub-Issue H).
 * Mirrors `useMachines` — fetches `GET /api/accounts` (Sub-Issue E #1451) only
 * while `enabled` (the modal passes `isOpen` so it does not poll when closed).
 *
 * `pollOnboardingRegistration` (#4736, the Accounts page): re-read on the
 * `onboardingPollInterval` cadence while the onboarding sign-in is not yet in the
 * store, paused in a background tab. Off for every other caller (no polling).
 */
export function useAccounts(
  api: ApiClient | null,
  enabled: boolean,
  options: { pollOnboardingRegistration?: boolean } = {}
): {
  accounts: RedactedAccount[];
  /** Node env carries a Claude credential (cloud-VM case, #2095) — the create
   * form shows "Instance credential (default)" when the store is empty. */
  envCredentialPresent: boolean;
  /** #4736: the onboarding sign-in is missing from the store (`"missing"`), or its
   * seed is still running (`"pending"`); `null` otherwise or on an older server. */
  onboardingRegistration: OnboardingRegistration;
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<unknown>;
} {
  const query = useQuery({
    queryKey: queryKeys.accounts,
    queryFn: async () => {
      if (!api) {
        throw new Error("API unavailable");
      }
      return await api.getAccounts();
    },
    enabled: Boolean(api && enabled),
    refetchInterval: options.pollOnboardingRegistration
      ? q => onboardingRefetchInterval(q.state)
      : false,
    refetchIntervalInBackground: false,
  });

  return {
    accounts: query.data?.accounts ?? EMPTY_ACCOUNTS,
    envCredentialPresent: query.data?.envCredentialPresent ?? false,
    onboardingRegistration: query.data?.onboardingRegistration ?? null,
    isLoading: query.isLoading,
    error:
      query.error instanceof Error
        ? query.error.message
        : query.error
          ? "Failed to load accounts"
          : null,
    refetch: query.refetch,
  };
}

/**
 * Query the local node's active (default) account (epic #1446, Sub-Issue I #1455).
 * Used by the create-session form to pre-select the node default. The endpoint
 * 404s/501s for remote/unsupported nodes — degrade to `null` rather than error,
 * matching `AccountSelectorModal`'s per-node behavior.
 */
export function useNodeActiveAccount(
  api: ApiClient | null,
  nodeId: string | null,
  enabled: boolean,
  // #3808 Task 5: an optional provider reads the PER-PROVIDER node default so the
  // create-page account field shows the right "(default)" for a codex/gemini spawn.
  // Absent ⇒ the Anthropic default (byte-identical; the query key stays 2-element).
  provider?: string
): {
  activeAccount: RedactedAccount | null;
  isLoading: boolean;
} {
  const query = useQuery({
    queryKey: queryKeys.nodeActiveAccount(nodeId ?? "none", provider),
    queryFn: async () => {
      if (!api || !nodeId) {
        return { activeAccount: null };
      }
      try {
        return await api.getNodeActiveAccount(nodeId, provider);
      } catch {
        return { activeAccount: null };
      }
    },
    enabled: Boolean(api && enabled && nodeId),
  });

  return {
    activeAccount: query.data?.activeAccount ?? null,
    isLoading: query.isLoading,
  };
}
