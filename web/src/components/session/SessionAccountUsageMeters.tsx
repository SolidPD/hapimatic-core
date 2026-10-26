// SPDX-License-Identifier: AGPL-3.0-only
/**
 * SessionAccountUsageMeters (#4523) — the Session Configuration modal's usage
 * block: the selected account's meters, from the SAME envelope the Account Usage
 * page and the account picker render (`GET /api/federation/accounts/usage`), in
 * the page's bar view (`views/BarsView.tsx`).
 *
 * The block is account-GLOBAL usage — the federation merge lets a healthy row
 * beat a degraded duplicate — so it never stands in for the session node's
 * credential health (R6; per-node health is #4461 / #4466). Like the picker, it
 * passes no `history`, so no projection line renders.
 */
import type { AccountUsage } from "@hapi/protocol";
import { STATUS_MESSAGE } from "@/components/AccountUsage/AccountUsageCard";
import {
  BarsView,
  deriveBarsMeters,
} from "@/components/AccountUsage/views/BarsView";

/**
 * The usage row for an account: the row whose `accountUuid` matches, else the
 * row whose `email` matches, else none. The uuid is the Anthropic account UUID —
 * the same on every node — so it wins; the email covers a session that recorded
 * no uuid (it runs on its node's active account, which the modal names by email).
 */
export function findAccountUsage(
  usage: readonly AccountUsage[],
  accountUuid: string | undefined,
  email: string | undefined
): AccountUsage | undefined {
  if (accountUuid) {
    const byUuid = usage.find(row => row.accountUuid === accountUuid);
    if (byUuid) return byUuid;
  }
  const wanted = email?.trim().toLowerCase();
  if (wanted) {
    return usage.find(row => row.email?.trim().toLowerCase() === wanted);
  }
  return undefined;
}

export function SessionAccountUsageMeters({
  usage,
}: {
  usage: AccountUsage | undefined;
}) {
  // No envelope for the account (loading, errored, not listed) → no block (R5).
  if (!usage) return null;

  // Same arm rule as the card (#2608): meters for `ok`, and for a `rate_limited`
  // row that still carries preserved meters (with the transient flag on top).
  const { hasMeterData } = deriveBarsMeters(usage.utilization);

  return (
    <div
      data-testid="config-account-usage"
      data-usage-status={usage.status}
      className="rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3"
    >
      {usage.status !== "ok" &&
      !(usage.status === "rate_limited" && hasMeterData) ? (
        // A degraded envelope: one status line, no bars and no Retry — the
        // modal is not the place to re-login or refresh usage (R5).
        <p className="py-2 text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
          {STATUS_MESSAGE[usage.status]}
        </p>
      ) : (
        <>
          {usage.status === "rate_limited" && (
            <p
              data-testid="config-account-usage-rate-limited"
              className="border-b border-[var(--app-border)] py-2 text-[length:var(--text-body-dense)] text-[var(--app-hint)]"
            >
              {STATUS_MESSAGE.rate_limited}
            </p>
          )}
          <BarsView account={usage} />
        </>
      )}
    </div>
  );
}
