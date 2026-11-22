// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #6779 (P-1): a pure reader of ISO 4217's list one ("current currency
 * and funds"), as published by its maintenance agency. No dependency: each
 * `<CcyNtry>` is a flat block of elements, so a regular expression per element
 * reads it. The generator (`shared/scripts/generate-iso4217-currencies-v1.ts`)
 * calls `parseListOne` and `selectBillingCurrencies`; the table it writes
 * (`currencies.generated.ts`) is the only source of currency exponents
 * (`shared/src/money.ts` makes no `Intl` call).
 */

export type ListOneEntry = {
  /** `CtryNm`, entities decoded; "" when the entry has none. */
  country: string;
  /** `Ccy`, or null for an entry with no code (e.g. "No universal currency"). */
  code: string | null;
  /** `CcyNm IsFund="true"`. */
  isFund: boolean;
  /** `CcyMnrUnts` when it is a number, else null. */
  minorUnits: number | null;
  /** `CcyMnrUnts` as written ("2", "N.A."), or null when absent. */
  minorUnitsRaw: string | null;
};

export type ListOne = {
  /** The root element's `Pblshd` attribute (the file's own publication date). */
  published: string | null;
  entries: ListOneEntry[];
};

/** The metals, named in the drop rules (their minor unit is `N.A.`). */
export const ISO4217_METAL_CODES: readonly string[] = [
  "XAG",
  "XAU",
  "XPD",
  "XPT",
];
/** The test code and the "no currency" code (their minor unit is `N.A.`). */
export const ISO4217_TEST_CODE = "XTS";
export const ISO4217_NO_CURRENCY_CODE = "XXX";

export type BillingCurrencySelection = {
  /** Code to exponent, sorted by code. */
  kept: Record<string, number>;
  dropped: {
    funds: string[];
    metals: string[];
    testCode: string[];
    noCurrency: string[];
    /** Other entries whose minor unit is not a number (`N.A.`). */
    otherNotApplicable: string[];
    /** Entries that carry no code. */
    entriesWithoutCode: number;
  };
};

const ENTRY_RE = /<CcyNtry>([\s\S]*?)<\/CcyNtry>/g;
const PUBLISHED_RE = /<ISO_4217\b[^>]*\bPblshd="([^"]*)"/;
const CODE_RE = /^[A-Z]{3}$/;

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

function element(block: string, name: string): string | null {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(
    block
  );
  return match ? decodeEntities(match[1]!.trim()) : null;
}

/** Reads every `<CcyNtry>` of a list-one XML text, in file order. */
export function parseListOne(xmlText: string): ListOne {
  const published = PUBLISHED_RE.exec(xmlText)?.[1] ?? null;
  const entries: ListOneEntry[] = [];
  for (const match of xmlText.matchAll(ENTRY_RE)) {
    const block = match[1]!;
    const code = element(block, "Ccy");
    const minorUnitsRaw = element(block, "CcyMnrUnts");
    const minorUnits =
      minorUnitsRaw !== null && /^[0-9]+$/.test(minorUnitsRaw)
        ? Number(minorUnitsRaw)
        : null;
    entries.push({
      country: element(block, "CtryNm") ?? "",
      code: code === null || code === "" ? null : code,
      isFund: /<CcyNm\s[^>]*\bIsFund="true"/.test(block),
      minorUnits,
      minorUnitsRaw,
    });
  }
  return { published, entries };
}

function sortedUnique(codes: Iterable<string>): string[] {
  return [...new Set(codes)].sort();
}

/**
 * Applies the drop rules: keep every code of a country entry that is not a fund
 * and whose minor unit is a number. Throws on a code given two different
 * exponents, and on a malformed code.
 */
export function selectBillingCurrencies(
  list: ListOne
): BillingCurrencySelection {
  const kept = new Map<string, number>();
  const funds: string[] = [];
  const notApplicable: string[] = [];
  let entriesWithoutCode = 0;
  for (const entry of list.entries) {
    if (entry.code === null) {
      entriesWithoutCode += 1;
      continue;
    }
    if (!CODE_RE.test(entry.code)) {
      throw new Error(`list one holds a malformed code: ${entry.code}`);
    }
    if (entry.isFund) {
      funds.push(entry.code);
      continue;
    }
    if (entry.minorUnits === null) {
      notApplicable.push(entry.code);
      continue;
    }
    const prior = kept.get(entry.code);
    if (prior !== undefined && prior !== entry.minorUnits) {
      throw new Error(
        `list one gives ${entry.code} two exponents: ${prior} and ${entry.minorUnits}`
      );
    }
    kept.set(entry.code, entry.minorUnits);
  }
  const keptRecord: Record<string, number> = {};
  for (const code of [...kept.keys()].sort()) {
    keptRecord[code] = kept.get(code)!;
  }
  const na = sortedUnique(notApplicable).filter(code => !kept.has(code));
  return {
    kept: keptRecord,
    dropped: {
      funds: sortedUnique(funds).filter(code => !kept.has(code)),
      metals: na.filter(code => ISO4217_METAL_CODES.includes(code)),
      testCode: na.filter(code => code === ISO4217_TEST_CODE),
      noCurrency: na.filter(code => code === ISO4217_NO_CURRENCY_CODE),
      otherNotApplicable: na.filter(
        code =>
          !ISO4217_METAL_CODES.includes(code) &&
          code !== ISO4217_TEST_CODE &&
          code !== ISO4217_NO_CURRENCY_CODE
      ),
      entriesWithoutCode,
    },
  };
}

/**
 * Merges a fresh selection into the committed table (reading R-5: a code is
 * never removed once released). Throws when the source changes the exponent of
 * a code the table holds (P-2: a redenomination arrives as a new code).
 * Returns the merged table, sorted by code, and the held codes the source no
 * longer carries.
 */
export function mergeIntoCommittedTable(
  committed: Readonly<Record<string, number>>,
  fresh: Readonly<Record<string, number>>
): { table: Record<string, number>; retainedNotInSource: string[] } {
  const merged = new Map<string, number>(Object.entries(committed));
  for (const [code, exponent] of Object.entries(fresh)) {
    const held = merged.get(code);
    if (held !== undefined && held !== exponent) {
      throw new Error(
        `list one changes the exponent of held code ${code} from ${held} to ${exponent}; a held exponent never changes (P-2)`
      );
    }
    merged.set(code, exponent);
  }
  const table: Record<string, number> = {};
  for (const code of [...merged.keys()].sort()) table[code] = merged.get(code)!;
  const retainedNotInSource = Object.keys(committed)
    .filter(code => !Object.hasOwn(fresh, code))
    .sort();
  return { table, retainedNotInSource };
}
