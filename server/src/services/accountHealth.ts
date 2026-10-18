// SPDX-License-Identifier: AGPL-3.0-only
import {
  AccountHealthEntrySchema,
  deriveAccountHealth,
  type AccountHealthEntry,
  type NodeAccountHealthFacts,
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
 * 🔴 SECRETS: the full record is read ONLY to learn its `authKind` (the redacted
 * view does not carry it). Every entry is built field by field from the redacted
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
    // `StoredAccountSchema` that `getRaw` validates with.
    const authKind =
      row.provider === "anthropic"
        ? ((
            deps.accountService.getRawAny(row.accountUuid) as {
              authKind?: unknown;
            } | null
          )?.authKind ?? undefined)
        : null;
    const entry = deriveAccountHealth(
      {
        provider: row.provider,
        accountUuid: row.accountUuid,
        emailAddress: row.emailAddress,
        authKind: typeof authKind === "string" ? authKind : null,
        unrefreshable: row.unrefreshable,
        lastRefreshedAt: row.lastRefreshedAt,
        capturedAt: row.capturedAt,
        expiresAt: row.expiresAt,
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
