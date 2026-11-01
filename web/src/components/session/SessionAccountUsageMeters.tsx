// SPDX-License-Identifier: AGPL-3.0-only
/**
 * SessionAccountUsageMeters (#4523) — the Session Configuration modal's usage
 * block: the selected account's meters, from the SAME envelope the Account Usage
 * page and the account picker render (`GET /api/federation/accounts/usage`), in
 * the page's views (`views/BarsView.tsx`, and Arcs / Chips since #4600).
 *
 * The block is account-GLOBAL usage — the federation merge lets a healthy row
 * beat a degraded duplicate — so it never stands in for the session node's
 * credential health (R6; per-node health is #4461 / #4466). Like the picker, it
 * passes no `history`, so no projection line renders.
 *
 * #4600: the healthy arm renders the account's chosen usage view (Arcs / Chips /
 * Bars) from the `view` prop, never from `UsageViewContext` — a provider around
 * the modal would also reach the staged account picker, which must stay Bars
 * (#4467 R8).
 */
import type { AccountUsage } from "@hapi/protocol";
import type { UsageViewId } from "@hapi/protocol/schemas";
import { STATUS_MESSAGE } from "@/components/AccountUsage/AccountUsageCard";
import {
  BarsView,
  deriveBarsMeters,
} from "@/components/AccountUsage/views/BarsView";
import { ArcsView } from "@/components/AccountUsage/views/ArcsView";
import { ChipsView } from "@/components/AccountUsage/views/ChipsView";
import { buildUsageColumns } from "@/components/AccountUsage/views/usageMeters";

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
  view,
}: {
  usage: AccountUsage | undefined;
  /** The Anthropic usage view (#4600); unset or unknown renders Bars. */
  view?: UsageViewId;
}) {
  // No envelope for the account (loading, errored, not listed) → no block (R5).
  if (!usage) return null;

  // Same arm rule as the card (#2608): meters for `ok`, and for a `rate_limited`
  // row that still carries preserved meters (with the transient flag on top).
  const { hasMeterData } = deriveBarsMeters(usage.utilization);
  // #4600: the card's dispatch rule (#4467 Task 7) — Arcs / Chips only with a
  // meter to draw; Bars otherwise, which keeps its "No usage data this period."
  // line for a meter-less row in every view.
  const degraded =
    usage.status !== "ok" && !(usage.status === "rate_limited" && hasMeterData);
  const effective =
    !degraded && hasMeterData && (view === "arcs" || view === "chips")
      ? view
      : "bars";

  return (
    <div
      data-testid="config-account-usage"
      data-usage-status={usage.status}
      data-usage-view={degraded ? undefined : effective}
      className="rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3"
    >
      {/* Inline (not `degraded`) so `usage.status` narrows for STATUS_MESSAGE. */}
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
          {effective === "arcs" ? (
            <ArcsView
              columns={buildUsageColumns(usage.utilization, "anthropic")}
            />
          ) : effective === "chips" ? (
            <ChipsView
              columns={buildUsageColumns(usage.utilization, "anthropic")}
            />
          ) : (
            <BarsView account={usage} />
          )}
        </>
      )}
    </div>
  );
}
