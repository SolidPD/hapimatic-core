// SPDX-License-Identifier: AGPL-3.0-only
import type {
  ApiKeyBudget,
  ApiKeyBudgetRecurrence,
  ApiKeyBudgetStatus,
} from "@hapi/protocol/schemas";

/**
 * API key credit estimate, computed at read time (never stored).
 *
 * No provider reports a key's remaining credit through an API (Anthropic has
 * none, to the key or to an admin key), so the operator records what the key
 * holds (`budget`: an amount and when it was true) and, optionally, a monthly
 * top-up (`budgetRecurrence`). This walks the top-ups since the budget's anchor
 * and subtracts the spend Hapimatic metered on the key between them. Nothing is
 * scheduled and nothing mutates the stored settings, so a top-up can never be
 * applied twice or missed while the server is down.
 *
 * `outOfCredit` reports the provider's own "credit balance is too low" answer
 * (`outOfCreditAt`) until something later says the key works again: metered
 * spend after it, a budget edit after it, or a top-up after it.
 */

/** Dollars metered on the key for work started in [fromMs, toMs). */
export type ApiKeySpendFn = (fromMs: number, toMs: number) => number;

export interface ApiKeyBudgetInput {
  budget?: ApiKeyBudget;
  recurrence?: ApiKeyBudgetRecurrence;
  outOfCreditAt?: string;
  nowMs: number;
  spend: ApiKeySpendFn;
}

export interface ApiKeyBudgetResult {
  status?: ApiKeyBudgetStatus;
  outOfCredit: boolean;
}

/** Spend below this (a fraction of a cent) is rounding noise, not usage. */
const SPEND_EPSILON_USD = 0.0001;
/** Bound on months walked (20 years) — a guard, never reached in practice. */
const MAX_MONTHS = 240;

/** `tz` when the runtime knows it, else UTC. */
export function resolveTimeZone(tz: string | undefined): string {
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

function zoneParts(ms: number, tz: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type: string) =>
    Number(parts.find(p => p.type === type)?.value ?? 0);
  return {
    year: get("year"),
    month0: get("month") - 1,
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  };
}

/** The zone's UTC offset at `ms`, in ms (positive east of UTC). */
function zoneOffsetMs(ms: number, tz: string): number {
  const p = zoneParts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month0, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Epoch ms of 00:00 local time in `tz` on the given calendar day. */
export function zonedMidnightMs(
  year: number,
  month0: number,
  day: number,
  tz: string
): number {
  const guess = Date.UTC(year, month0, day);
  const first = guess - zoneOffsetMs(guess, tz);
  const second = zoneOffsetMs(first, tz);
  return guess - second;
}

function daysInMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

/** The top-up instant in the given month (a short month uses its last day). */
function occurrenceInMonth(
  rule: ApiKeyBudgetRecurrence,
  tz: string,
  year: number,
  month0: number
): number {
  const day = Math.min(rule.dayOfMonth, daysInMonth(year, month0));
  return zonedMidnightMs(year, month0, day, tz);
}

/** Top-up instants in (fromMs, toMs], oldest first. */
export function topUpsBetween(
  rule: ApiKeyBudgetRecurrence,
  fromMs: number,
  toMs: number
): number[] {
  if (!(toMs > fromMs)) return [];
  const tz = resolveTimeZone(rule.timeZone);
  const start = zoneParts(fromMs, tz);
  const out: number[] = [];
  let year = start.year;
  let month0 = start.month0;
  for (let i = 0; i < MAX_MONTHS; i += 1) {
    const at = occurrenceInMonth(rule, tz, year, month0);
    if (at > toMs) break;
    if (at > fromMs) out.push(at);
    month0 += 1;
    if (month0 === 12) {
      month0 = 0;
      year += 1;
    }
  }
  return out;
}

/** The latest top-up at or before `ms`. */
export function lastTopUpAtOrBefore(
  rule: ApiKeyBudgetRecurrence,
  ms: number
): number {
  const tz = resolveTimeZone(rule.timeZone);
  const p = zoneParts(ms, tz);
  const thisMonth = occurrenceInMonth(rule, tz, p.year, p.month0);
  if (thisMonth <= ms) return thisMonth;
  const prevYear = p.month0 === 0 ? p.year - 1 : p.year;
  const prevMonth0 = p.month0 === 0 ? 11 : p.month0 - 1;
  return occurrenceInMonth(rule, tz, prevYear, prevMonth0);
}

/** The first top-up strictly after `ms`. */
export function nextTopUpAfter(
  rule: ApiKeyBudgetRecurrence,
  ms: number
): number {
  const tz = resolveTimeZone(rule.timeZone);
  const p = zoneParts(ms, tz);
  const thisMonth = occurrenceInMonth(rule, tz, p.year, p.month0);
  if (thisMonth > ms) return thisMonth;
  const nextYear = p.month0 === 11 ? p.year + 1 : p.year;
  const nextMonth0 = p.month0 === 11 ? 0 : p.month0 + 1;
  return occurrenceInMonth(rule, tz, nextYear, nextMonth0);
}

const cents = (usd: number): number => Math.round(usd * 100) / 100;

export function computeApiKeyBudget(
  input: ApiKeyBudgetInput
): ApiKeyBudgetResult {
  const { budget, recurrence, nowMs, spend } = input;
  const setAtMs = budget ? Date.parse(budget.setAt) : Number.NaN;
  const hasBudget = budget !== undefined && Number.isFinite(setAtMs);

  let status: ApiKeyBudgetStatus | undefined;
  if (hasBudget || recurrence) {
    let balance: number;
    let cursor: number;
    if (hasBudget) {
      balance = budget.amountUsd;
      cursor = Math.min(setAtMs, nowMs);
    } else {
      // A top-up with no recorded balance: the latest top-up is the anchor.
      cursor = lastTopUpAtOrBefore(recurrence!, nowMs);
      balance = recurrence!.amountUsd;
    }
    if (recurrence) {
      for (const at of topUpsBetween(recurrence, cursor, nowMs)) {
        // The provider stops at zero, so an overshooting estimate does not
        // carry a debt into the next top-up.
        balance = Math.max(0, balance - spend(cursor, at));
        balance =
          recurrence.mode === "add"
            ? balance + recurrence.amountUsd
            : recurrence.amountUsd;
        cursor = at;
      }
    }
    const spent = spend(cursor, nowMs);
    status = {
      remainingUsd: cents(balance - spent),
      periodStartBalanceUsd: cents(balance),
      spentUsd: cents(spent),
      periodStart: new Date(cursor).toISOString(),
      ...(recurrence
        ? {
            nextTopUpAt: new Date(
              nextTopUpAfter(recurrence, nowMs)
            ).toISOString(),
          }
        : {}),
      expiresAtNextTopUp: recurrence?.mode === "replace",
    };
  }

  return { status, outOfCredit: isStillOutOfCredit(input, setAtMs) };
}

function isStillOutOfCredit(input: ApiKeyBudgetInput, setAtMs: number) {
  const outAt = input.outOfCreditAt ? Date.parse(input.outOfCreditAt) : NaN;
  if (!Number.isFinite(outAt) || outAt > input.nowMs) return false;
  if (Number.isFinite(setAtMs) && setAtMs > outAt) return false;
  if (
    input.recurrence &&
    topUpsBetween(input.recurrence, outAt, input.nowMs).length > 0
  ) {
    return false;
  }
  return input.spend(outAt, input.nowMs) <= SPEND_EPSILON_USD;
}
