// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A rate's words, shared by the category editor and the Create page's Time
 * Tracking group (#6780): the rate field's refusal sentences and a rate's
 * amount without its code. Moved here unchanged from `BillingCategoryEditor.tsx`.
 */
import {
  currencyMinorDigits,
  formatRateMinor,
  isBillingCurrency,
  type BillingRate,
  type RateInputRefusal,
} from "@hapi/protocol";

/** The rate field's message for each refusal (the comma has its own, C3). */
export function rateRefusalMessage(
  reason: RateInputRefusal,
  currency: string
): string {
  switch (reason) {
    case "comma":
      return "Use a point for decimals, with no thousands separator";
    case "too-many-decimals": {
      const digits = currencyMinorDigits(currency);
      return digits === 0
        ? `${currency} takes no decimals.`
        : `${currency} takes at most ${digits} decimals.`;
    }
    case "too-large":
      return "That rate is too large.";
    case "empty":
    case "format":
      return "Enter a number, like 160 or 160.50.";
  }
}

/** A formattable rate's amount without its code ("160.00"); "" otherwise. */
export function amountText(rate: BillingRate | null): string {
  if (!rate || !isBillingCurrency(rate.currency)) return "";
  return formatRateMinor(rate.minor, rate.currency).split(" ")[0] ?? "";
}
