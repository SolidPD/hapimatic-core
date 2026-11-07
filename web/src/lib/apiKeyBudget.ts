// SPDX-License-Identifier: AGPL-3.0-only
import type {
  ApiKeyBudgetRecurrence,
  ApiKeyBudgetStatus,
  RedactedApiKey,
} from "@hapi/protocol/schemas";

/**
 * API key budgets — the pure helpers behind a key card's credit column. The
 * server computes the estimate (`budgetStatus`); these turn it into the meter,
 * the colour, the days to the next top-up and the "Use first" pick.
 */

/** Providers whose keys spend paid credit, so their cards offer a budget. */
export function providerHasBudget(provider: string): boolean {
  return provider === "anthropic" || provider === "openai";
}

/** Share of the period's starting balance still left, clamped to [0, 1]. */
export function budgetFraction(status: ApiKeyBudgetStatus): number {
  if (!(status.periodStartBalanceUsd > 0)) return 0;
  return Math.min(
    1,
    Math.max(0, status.remainingUsd / status.periodStartBalanceUsd)
  );
}

export type BudgetLevel = "mint" | "amber" | "red";

/** The meter colour: 30 % and up is healthy, under 10 % is nearly gone. */
export function budgetLevel(fraction: number): BudgetLevel {
  if (fraction >= 0.3) return "mint";
  if (fraction >= 0.1) return "amber";
  return "red";
}

/** Whole days until `iso`, rounded up (0 once it has passed); null when unset. */
export function daysUntil(
  iso: string | undefined,
  nowMs: number
): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.ceil((at - nowMs) / 86_400_000));
}

/** "$71.20"; a negative estimate reads "-$2.25". */
export function formatUsd(usd: number): string {
  const sign = usd < 0 ? "-" : "";
  return `${sign}$${Math.abs(usd).toFixed(2)}`;
}

/** "Nov 14" in the viewer's own zone. */
export function formatShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

/** "1st", "2nd", "14th", "31st". */
export function ordinalDay(day: number): string {
  const mod100 = day % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${day}th`;
  const suffix = { 1: "st", 2: "nd", 3: "rd" }[day % 10] ?? "th";
  return `${day}${suffix}`;
}

/** "+$200 on the 14th" / "resets to $200 on the 14th". */
export function topUpPhrase(rule: ApiKeyBudgetRecurrence): string {
  const amount = formatUsd(rule.amountUsd).replace(/\.00$/, "");
  const when = `on the ${ordinalDay(rule.dayOfMonth)}`;
  return rule.mode === "add"
    ? `+${amount} ${when}`
    : `resets to ${amount} ${when}`;
}

/** Days a non-expiring balance counts as having, for the urgency ranking. */
const NO_EXPIRY_DAYS = 365;

/**
 * The key to spend first: the one whose credit is most at risk of expiring
 * unused — dollars left ÷ days until the next top-up replaces the balance (a
 * balance that never expires counts as a year away). Only usable keys with
 * money left compete, and only when two or more do; otherwise null.
 */
export function pickUseFirstKeyId(
  keys: readonly RedactedApiKey[],
  nowMs: number
): string | null {
  let best: { id: string; urgency: number } | null = null;
  let candidates = 0;
  for (const key of keys) {
    const status = key.budgetStatus;
    if (!status || key.status === "invalid" || key.outOfCredit) continue;
    if (!(status.remainingUsd > 0)) continue;
    candidates += 1;
    const days = status.expiresAtNextTopUp
      ? Math.max(1, daysUntil(status.nextTopUpAt, nowMs) ?? NO_EXPIRY_DAYS)
      : NO_EXPIRY_DAYS;
    const urgency = status.remainingUsd / days;
    if (!best || urgency > best.urgency) best = { id: key.id, urgency };
  }
  return candidates >= 2 && best ? best.id : null;
}
