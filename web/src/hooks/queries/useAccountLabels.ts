// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AccountMonogram } from "@hapi/protocol";
import type { ApiClient } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";
import { accountShortName } from "@/components/session/accountLabel";

/**
 * Account display labels for the Account Chip (epic #3285 correction pass 1).
 *
 * The chip shows the account's **nickname** — the operator-set colloquial name
 * from the NicknameStore ("Work", "Mose", "Personal" in the E6 mockups) — never
 * the raw email. Precedence per account: nickname → the OAuth `displayName` →
 * the email local part (`resolveAccountLabel`).
 *
 * Reads `GET /api/accounts` (node-local, token-redacted, now carrying `nickname`)
 * under its own query key so the 60s staleTime here never fights the
 * AccountSelectorModal's on-open refetch of `queryKeys.accounts`. Many chips on
 * one page share ONE query (TanStack dedupes by key). Federated sessions whose
 * account lives on another node simply fall back to the email local part.
 */
export type AccountLabelSource = {
  nickname?: string;
  displayName?: string;
  /** Operator-set monogram override (letter + color) — issue #3621. Rides the
   * same GET /api/accounts read as the label, so every chip surface resolves it
   * through this one query. */
  monogram?: AccountMonogram;
};

/** The ONE labels query both maps below read (same key → one request). */
function useLabelAccounts(api: ApiClient | null, enabled: boolean) {
  const query = useQuery({
    queryKey: [...queryKeys.accounts, "labels"] as const,
    queryFn: async () => {
      if (!api) throw new Error("API unavailable");
      return await api.getAccounts();
    },
    enabled: Boolean(api && enabled),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  return query.data?.accounts;
}

function toLabelSource(account: {
  nickname?: string;
  displayName?: string;
  monogram?: AccountMonogram;
}): AccountLabelSource {
  return {
    nickname: account.nickname,
    displayName: account.displayName,
    monogram: account.monogram,
  };
}

export function useAccountLabels(
  api: ApiClient | null,
  enabled = true
): Map<string, AccountLabelSource> {
  const accounts = useLabelAccounts(api, enabled);
  return useMemo(() => {
    const map = new Map<string, AccountLabelSource>();
    // #3508 (Task 2, non-target): this empty-array fallback is only a loop
    // ITERABLE inside this useMemo, not a returned array identity. The memo keys on `accounts`
    // (stays `undefined` while pending), so the returned Map is already stable.
    for (const account of accounts ?? []) {
      const email = account.emailAddress.toLowerCase();
      // #3982: email-less records (Google, API-key OpenAI) all carry "" — keying
      // them here would collide; they resolve by uuid (useAccountLabelsByUuid).
      if (!email) continue;
      map.set(email, toLabelSource(account));
    }
    return map;
  }, [accounts]);
}

/**
 * #3982: the same label sources keyed by `accountUuid` — the only identity an
 * email-less provider account has. Reads the SAME query as `useAccountLabels`.
 */
export function useAccountLabelsByUuid(
  api: ApiClient | null,
  enabled = true
): Map<string, AccountLabelSource> {
  const accounts = useLabelAccounts(api, enabled);
  return useMemo(() => {
    const map = new Map<string, AccountLabelSource>();
    for (const account of accounts ?? []) {
      map.set(account.accountUuid, toLabelSource(account));
    }
    return map;
  }, [accounts]);
}

/** #3982: nickname → displayName → `fallback` for an account named by uuid. */
export function resolveAccountLabelByUuid(
  accountUuid: string,
  fallback: string,
  labels: Map<string, AccountLabelSource>
): string {
  const source = labels.get(accountUuid);
  const nickname = source?.nickname?.trim();
  if (nickname) return nickname;
  const displayName = source?.displayName?.trim();
  if (displayName) return displayName;
  return fallback;
}

/** #3982: the monogram override for an account named by uuid. */
export function useAccountMonogramByUuid(
  api: ApiClient | null,
  accountUuid: string | undefined
): AccountMonogram | undefined {
  const labels = useAccountLabelsByUuid(api, Boolean(accountUuid));
  return accountUuid ? labels.get(accountUuid)?.monogram : undefined;
}

/** nickname → displayName → email local part (never the full email). */
export function resolveAccountLabel(
  email: string,
  labels: Map<string, AccountLabelSource>
): string {
  const source = labels.get(email.toLowerCase());
  const nickname = source?.nickname?.trim();
  if (nickname) return nickname;
  const displayName = source?.displayName?.trim();
  if (displayName) return displayName;
  return accountShortName(email);
}

/** The resolved chip label for one session's account email (undefined → undefined). */
export function useAccountLabel(
  api: ApiClient | null,
  email: string | undefined
): string | undefined {
  const labels = useAccountLabels(api, Boolean(email));
  return email ? resolveAccountLabel(email, labels) : undefined;
}

/**
 * The monogram override for one session's account email (undefined → undefined),
 * issue #3621. A SIBLING of `useAccountLabel` on the SAME `useAccountLabels`
 * query, so a consumer that reads both a label and a monogram dedupes to one
 * network request (TanStack keys by query key). Kept separate rather than
 * widening `useAccountLabel`'s bare-`string` return, which has many callers.
 */
export function useAccountMonogram(
  api: ApiClient | null,
  email: string | undefined
): AccountMonogram | undefined {
  const labels = useAccountLabels(api, Boolean(email));
  return email ? labels.get(email.toLowerCase())?.monogram : undefined;
}
