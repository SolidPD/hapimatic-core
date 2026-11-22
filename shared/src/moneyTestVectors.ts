// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #6779: the money cases both suites run, so `shared` (Vitest under
 * Node) and `server` (`bun:test`) prove the same answers in both runtimes.
 * Imported as `@hapi/protocol/moneyTestVectors`; deliberately NOT on the
 * package index, so test data is not part of what the apps import (X3).
 */
import type { RateInputResult } from "./money";

export type ParseRateVector = {
  text: string;
  currency: string;
  expected: RateInputResult;
};

export type FormatRateVector = {
  minor: number;
  currency: string;
  expected: string;
};

export const PARSE_RATE_VECTORS: readonly ParseRateVector[] = [
  // The issue's criterion: 160 with USD reads back as 160.00 USD.
  { text: "160", currency: "USD", expected: { ok: true, minor: 16000 } },
  { text: "0.29", currency: "USD", expected: { ok: true, minor: 29 } },
  { text: "160", currency: "JPY", expected: { ok: true, minor: 160 } },
  { text: "1.5", currency: "BHD", expected: { ok: true, minor: 1500 } },
  // ISO gives IQD three digits (Node's Intl gives 0).
  { text: "160", currency: "IQD", expected: { ok: true, minor: 160000 } },
  { text: "007", currency: "USD", expected: { ok: true, minor: 700 } },
  { text: "0", currency: "USD", expected: { ok: true, minor: 0 } },
  { text: "  42.5 ", currency: "USD", expected: { ok: true, minor: 4250 } },
  // Exactly the cap.
  {
    text: "10000000",
    currency: "USD",
    expected: { ok: true, minor: 1_000_000_000 },
  },
  {
    text: "1000000",
    currency: "BHD",
    expected: { ok: true, minor: 1_000_000_000 },
  },
  {
    text: "1000000000",
    currency: "JPY",
    expected: { ok: true, minor: 1_000_000_000 },
  },
  // One minor unit above the cap.
  {
    text: "10000000.01",
    currency: "USD",
    expected: { ok: false, reason: "too-large" },
  },
  {
    text: "1000000.001",
    currency: "BHD",
    expected: { ok: false, reason: "too-large" },
  },
  {
    text: "1000000001",
    currency: "JPY",
    expected: { ok: false, reason: "too-large" },
  },
  {
    text: "9".repeat(400),
    currency: "USD",
    expected: { ok: false, reason: "too-large" },
  },
  {
    text: "1.0",
    currency: "JPY",
    expected: { ok: false, reason: "too-many-decimals" },
  },
  {
    text: "1.234",
    currency: "USD",
    expected: { ok: false, reason: "too-many-decimals" },
  },
  { text: "1,5", currency: "USD", expected: { ok: false, reason: "comma" } },
  { text: "1,000", currency: "USD", expected: { ok: false, reason: "comma" } },
  { text: "", currency: "USD", expected: { ok: false, reason: "empty" } },
  { text: "   ", currency: "USD", expected: { ok: false, reason: "empty" } },
  { text: "160.", currency: "USD", expected: { ok: false, reason: "format" } },
  { text: ".5", currency: "USD", expected: { ok: false, reason: "format" } },
  { text: "1e3", currency: "USD", expected: { ok: false, reason: "format" } },
  { text: "+5", currency: "USD", expected: { ok: false, reason: "format" } },
  { text: "-5", currency: "USD", expected: { ok: false, reason: "format" } },
  // Full-width digits.
  {
    text: "１６０",
    currency: "USD",
    expected: { ok: false, reason: "format" },
  },
  { text: "1 000", currency: "USD", expected: { ok: false, reason: "format" } },
];

export const FORMAT_RATE_VECTORS: readonly FormatRateVector[] = [
  { minor: 16000, currency: "USD", expected: "160.00 USD" },
  { minor: 29, currency: "USD", expected: "0.29 USD" },
  { minor: 0, currency: "USD", expected: "0.00 USD" },
  { minor: 160, currency: "JPY", expected: "160 JPY" },
  { minor: 1500, currency: "BHD", expected: "1.500 BHD" },
  { minor: 160000, currency: "IQD", expected: "160.000 IQD" },
  { minor: 1_000_000_000, currency: "USD", expected: "10000000.00 USD" },
];

/** Inputs `formatRateMinor` refuses by throwing. */
export const FORMAT_RATE_THROWS: readonly {
  minor: number;
  currency: string;
}[] = [
  { minor: 1.5, currency: "USD" },
  { minor: -1, currency: "USD" },
  { minor: 100, currency: "ZZZ" },
];

export const CURRENCY_MEMBERSHIP_VECTORS: readonly {
  code: string;
  expected: boolean;
}[] = [
  { code: "USD", expected: true },
  { code: "EUR", expected: true },
  { code: "IQD", expected: true },
  { code: "ZZZ", expected: false },
  { code: "usd", expected: false },
  { code: "   ", expected: false },
  { code: "XXX", expected: false },
  { code: "constructor", expected: false },
];
