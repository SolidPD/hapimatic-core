// SPDX-License-Identifier: AGPL-3.0-only
import {
  AccountHealthEntrySchema,
  accountProviderOf,
  deriveAccountHealth,
  isNativeAnthropicAccount,
  trustedUnrefreshableAt,
  type AccountHealthEntry,
  type NodeAccountHealthFacts,
  type StoredAccount,
} from "@hapi/protocol";
import type { AccountService } from "./accountService";
import type { NicknameStore } from "../accounts/nicknameStore";
import type { MonogramStore } from "../accounts/monogramStore";
import type { UsageService } from "../accounts/usageService";

/**
 * Node-local account-health reader (issue #4461, epic #4460 sub-issue A).
 *
 * Returns the bare facts — `{ accounts, fetchedAt }` — for every account record
 * THIS node holds; the routes (`web/routes/federation/accountHealth.ts`) add the
 * node identity and status and parse the whole row on egress (the
 * `providerAuthState` split: the reader owns facts, the route owns the envelope).
 *
 * READ-ONLY and cache-only: it never refreshes a token, never imports provider
 * records (`triggerProviderImport` writes), and reads usage through
 * `UsageService.getLatest()`, which never fetches upstream.
 *
 * 🔴 SECRETS: the full record is read ONLY for fields the redacted view does not
 * carry: its `authKind`, and (#6801) its death time, the flag it is bound to, its
 * `unrefreshableReason` and its `signInDeaths`. The time reaches the entry only
 * through `trustedUnrefreshableAt`, the reason only as the `quarantined` boolean,
 * and the history only as the schema-validated `{signedInAt, diedAt, lastAliveAt}`
 * triples. Every entry is built field by field from the redacted
 * row by `deriveAccountHealth` and parsed through the whitelist
 * `AccountHealthEntrySchema`, so no token value can reach the result (R4).
 */
export interface AccountHealthReaderDeps {
  accountService: Pick<AccountService, "list" | "getRawAny">;
  nicknameStore?: Pick<NicknameStore, "get"> | null;
  monogramStore?: Pick<MonogramStore, "get"> | null;
  usageService?: Pick<UsageService, "getLatest"> | null;
  now: () => number;
}

export function readNodeAccountHealth(
  deps: AccountHealthReaderDeps
): NodeAccountHealthFacts {
  const usage = deps.usageService?.getLatest() ?? null;
  const accounts: AccountHealthEntry[] = [];
  for (const row of deps.accountService.list()) {
    // `authKind` lives on the stored record only. `getRawAny` (not `getRaw`)
    // because a token-less native record (#4349) fails the Anthropic-only
    // `StoredAccountSchema` that `getRaw` validates with. Read once per
    // Anthropic row: #6801 reads the death time and history from it too.
    const raw =
      row.provider === "anthropic"
        ? deps.accountService.getRawAny(row.accountUuid)
        : null;
    const authKind = raw
      ? ((raw as { authKind?: unknown }).authKind ?? undefined)
      : row.provider === "anthropic"
        ? undefined
        : null;
    // #6801: the death fields exist on a token-bearing Anthropic record only.
    const stored: StoredAccount | null =
      raw &&
      accountProviderOf(raw) === "anthropic" &&
      !isNativeAnthropicAccount(raw)
        ? (raw as StoredAccount)
        : null;
    const entry = deriveAccountHealth(
      {
        provider: row.provider,
        accountUuid: row.accountUuid,
        emailAddress: row.emailAddress,
        authKind: typeof authKind === "string" ? authKind : null,
        // #6801: the flag and its times from the same read as the death fields
        // below, so a sign-in or a clear landing between list() and that read
        // never pairs an old flag with a new record. The row is the fallback.
        unrefreshable: stored
          ? stored.unrefreshable === true
          : row.unrefreshable,
        lastRefreshedAt: stored ? stored.lastRefreshedAt : row.lastRefreshedAt,
        capturedAt: stored ? stored.capturedAt : row.capturedAt,
        expiresAt: stored ? stored.expiresAt : row.expiresAt,
        // #6801: the TRUSTED death time only (a stamp bound to another flag is
        // unknown), the reason (so a quarantine is marked, R14), the history.
        unrefreshableAt: stored ? trustedUnrefreshableAt(stored) : null,
        unrefreshableReason: stored?.unrefreshableReason ?? null,
        // Already valid: the record schema reads a malformed history as absent,
        // so the hub never drops the entry for it on ingress.
        signInDeaths: stored?.signInDeaths,
      },
      {
        nickname: deps.nicknameStore?.get(row.accountUuid) ?? null,
        monogram: deps.monogramStore?.get(row.accountUuid) ?? null,
        usageStatus:
          usage?.find(u => u.accountUuid === row.accountUuid)?.status ?? null,
      }
    );
    accounts.push(AccountHealthEntrySchema.parse(entry));
  }
  return { accounts, fetchedAt: deps.now() };
}
