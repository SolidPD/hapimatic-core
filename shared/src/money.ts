// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #6779: money in integer minor units with an ISO 4217 code.
 *
 * The currency list and each exponent come from the committed table generated
 * from ISO 4217's list one (`./iso4217/currencies.generated.ts`), never from the
 * runtime's `Intl`, whose lists and exponents differ between engines (P-1). A
 * held code's exponent never changes (P-2), so no exponent is stored beside an
 * amount. This module makes no `Intl` call and parses with integer string
 * arithmetic only (never `parseFloat`: `Math.floor(parseFloat("0.29") * 100)`
 * is 28).
 */
import { ISO4217_CURRENCY_EXPONENTS } from "./iso4217/currencies.generated";

/** The largest default rate, in minor units. */
export const BILLING_RATE_MINOR_MAX = 1_000_000_000;

/**
 * Codes that are never a billing currency. None of them is in the table (a
 * test invariant); the name is the one #6778 imports.
 */
export const BILLING_EXCLUDED_CURRENCIES: readonly string[] = Object.freeze([
  "XXX",
  "XTS",
  "XAU",
  "XAG",
  "XPD",
  "XPT",
  "XDR",
]);

const SORTED_CODES: readonly string[] = Object.freeze(
  Object.keys(ISO4217_CURRENCY_EXPONENTS).sort()
);

/** Every billing currency code, sorted. */
export function billingCurrencies(): readonly string[] {
  return SORTED_CODES;
}

/** Membership of the committed table, never "the formatter did not throw". */
export function isBillingCurrency(code: unknown): boolean {
  return (
    typeof code === "string" && Object.hasOwn(ISO4217_CURRENCY_EXPONENTS, code)
  );
}

/** The table's exponent for a code; throws on a code the table does not hold. */
export function currencyMinorDigits(code: string): number {
  if (!isBillingCurrency(code)) {
    throw new Error("not a billing currency code");
  }
  return ISO4217_CURRENCY_EXPONENTS[code]!;
}

export type RateInputRefusal =
  | "empty"
  | "comma"
  | "format"
  | "too-many-decimals"
  | "too-large";

export type RateInputResult =
  | { ok: true; minor: number }
  | { ok: false; reason: RateInputRefusal };

const RATE_TEXT_RE = /^[0-9]+(\.[0-9]+)?$/;
const RATE_MAX_TEXT = String(BILLING_RATE_MINOR_MAX);

/**
 * Parses a person's rate text ("160", "160.5") in a currency into minor units.
 * Trims; refuses a comma with its own reason; ASCII digits and one point only;
 * at most the currency's exponent of decimals; at most `BILLING_RATE_MINOR_MAX`.
 */
export function parseRateInput(
  text: string,
  currency: string
): RateInputResult {
  const digits = currencyMinorDigits(currency);
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, reason: "empty" };
  if (trimmed.includes(",")) return { ok: false, reason: "comma" };
  if (!RATE_TEXT_RE.test(trimmed)) return { ok: false, reason: "format" };
  const [whole, fraction = ""] = trimmed.split(".") as [string, string?];
  if (fraction.length > digits) {
    return { ok: false, reason: "too-many-decimals" };
  }
  const minorText =
    (whole + fraction.padEnd(digits, "0")).replace(/^0+(?=[0-9])/, "") || "0";
  if (
    minorText.length > RATE_MAX_TEXT.length ||
    (minorText.length === RATE_MAX_TEXT.length && minorText > RATE_MAX_TEXT)
  ) {
    return { ok: false, reason: "too-large" };
  }
  return { ok: true, minor: Number(minorText) };
}

/**
 * Formats minor units as "160.00 USD": no grouping, no locale. Throws on a
 * non-integer, a negative amount or an unknown code.
 */
export function formatRateMinor(minor: number, currency: string): string {
  if (!Number.isSafeInteger(minor) || minor < 0) {
    throw new Error("a rate is a non-negative safe integer of minor units");
  }
  const digits = currencyMinorDigits(currency);
  const text = String(minor).padStart(digits + 1, "0");
  const amount =
    digits === 0
      ? text
      : `${text.slice(0, text.length - digits)}.${text.slice(text.length - digits)}`;
  return `${amount} ${currency}`;
}
