// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Time Tracking's pure part (#6780): the state of the group, its derivation,
 * its words and the payload. No React, no I/O. The Create page's adapter
 * (`NewSession/useCreateTimeTracking.ts`) and the later schedule form (#6805),
 * sync fields (#6784) and after-creation controls (#6203) share it.
 *
 * Contract: the settings are built from `validateTrackingSettings`, the same
 * function the server runs on both spawn routes, with `prior = null` as the
 * server passes it; `settings` is non-null exactly when that answers `ok`.
 * A money helper is never called with a currency `isBillingCurrency` refuses,
 * because `parseRateInput` and `formatRateMinor` throw on one.
 */
import {
  formatRateMinor,
  isBillingCurrency,
  parseRateInput,
  toTrackingCategory,
  TRACKING_RATE_NOTE_MAX,
  validateTrackingSettings,
  type BillingCategoryList,
  type BillingCategoryListItem,
  type TrackingBillingStatus,
  type TrackingSettingsInput,
} from "@hapi/protocol";
import {
  amountText,
  rateRefusalMessage,
} from "@/components/billingCategories/rateText";

/**
 * The rate's text and where it came from. A rate filled from a category's
 * default keeps that default's currency, and so does one the person kept after
 * the default was removed ("kept"), so its number is never read in another
 * currency. A typed rate ("person") takes the currency the form shows: the
 * category default's, else the list's.
 */
export type TrackingRateText =
  | { text: string; from: "default" | "kept"; currency: string }
  | { text: string; from: "person" };

export type TimeTrackingState = {
  on: boolean;
  status: TrackingBillingStatus;
  /** `source:id` of the chosen category, or null when none is chosen. */
  categoryKey: string | null;
  /** True once the first settled list read after switching on was applied. */
  prefilled: boolean;
  rate: TrackingRateText | null;
  note: string;
};

export const INITIAL_TIME_TRACKING: TimeTrackingState = Object.freeze({
  on: false,
  status: "billable",
  categoryKey: null,
  prefilled: false,
  rate: null,
  note: "",
});

export const TRACKING_STATUS_OPTIONS: ReadonlyArray<{
  value: TrackingBillingStatus;
  label: string;
  title: string;
}> = Object.freeze([
  { value: "billable", label: "Billable", title: "Billed to the client." },
  {
    value: "pending",
    label: "Pending",
    title: "Held: not billed until it is released.",
  },
  {
    value: "non-billable",
    label: "Non-billable",
    title: "Recorded, never billed.",
  },
]);

export function trackingStatusLabel(status: TrackingBillingStatus): string {
  return TRACKING_STATUS_OPTIONS.find(o => o.value === status)?.label ?? status;
}

// ---------------------------------------------------------------------------
// The project (R4, D-2, D-B)
// ---------------------------------------------------------------------------

export type ProjectShown = {
  kind: "repo" | "path" | "unknown";
  /** True while the repository is being read: Create waits (D-B). */
  pending: boolean;
  text: string;
  title: string;
};

export const PROJECT_READING_TEXT = "Reading the repository…";

/** A folder path as shown: no trailing slash, a leading `~` made absolute. */
export function displayPath(directory: string, homeDir: string | null): string {
  let path = directory.trim();
  if (homeDir && (path === "~" || path.startsWith("~/"))) {
    path = withoutTrailingSlash(homeDir) + path.slice(1);
  }
  return path.length > 1 ? withoutTrailingSlash(path) : path;
}

/** Drops trailing slashes, keeping a lone "/". */
function withoutTrailingSlash(path: string): string {
  let end = path.length;
  while (end > 1 && path[end - 1] === "/") end -= 1;
  return path.slice(0, end);
}

export function projectShown(input: {
  cloneRepo: string | null;
  detectedRepo: string | null;
  lookupPending: boolean;
  lookupFailed: boolean;
  directory: string;
  homeDir: string | null;
}): ProjectShown {
  const repo = (name: string): ProjectShown => ({
    kind: "repo",
    pending: false,
    text: name,
    title: `${name}. The session's time is attributed to this project.`,
  });
  if (input.cloneRepo) return repo(input.cloneRepo);
  if (!input.directory.trim()) {
    return {
      kind: "unknown",
      pending: false,
      text: "Choose a directory",
      title: "Choose a directory to name the project.",
    };
  }
  if (input.lookupPending) {
    return {
      kind: "unknown",
      pending: true,
      text: PROJECT_READING_TEXT,
      title: `${PROJECT_READING_TEXT} Create waits until the project is read.`,
    };
  }
  if (input.detectedRepo) return repo(input.detectedRepo);
  if (input.lookupFailed) {
    return {
      kind: "unknown",
      pending: false,
      text: "Repository not read",
      title:
        "The repository could not be read here. The session reads it again when it starts.",
    };
  }
  const path = displayPath(input.directory, input.homeDir);
  return {
    kind: "path",
    pending: false,
    text: path,
    title: `${path}. This folder has no repository identity, so the time is attributed to the folder, shown as its path.`,
  };
}

// ---------------------------------------------------------------------------
// Categories and the three writers of `rate` (answer 3)
// ---------------------------------------------------------------------------

/** The categories a person may choose: offered and not retired. */
export function offeredCategories(
  list: BillingCategoryList
): BillingCategoryListItem[] {
  return list.local.categories.filter(c => c.offered && c.retiredAt === null);
}

export function categoryKey(item: BillingCategoryListItem): string {
  return `${item.source}:${item.id}`;
}

/** The chosen category among the offered ones, or null. */
export function selectedCategory(
  state: TimeTrackingState,
  list: BillingCategoryList
): BillingCategoryListItem | null {
  if (state.categoryKey === null) return null;
  return (
    offeredCategories(list).find(c => categoryKey(c) === state.categoryKey) ??
    null
  );
}

/** The category's default as rate text, or null when it has no usable one. */
function defaultRateText(item: BillingCategoryListItem): string | null {
  const text = amountText(item.defaultRate);
  return text === "" ? null : text;
}

/** A usable default as the rate it fills, in the default's own currency. */
function defaultRateFill(
  item: BillingCategoryListItem
): TrackingRateText | null {
  const text = defaultRateText(item);
  return text === null || !item.defaultRate
    ? null
    : { text, from: "default", currency: item.defaultRate.currency };
}

/** The currency a rate carries itself (a default's or a kept one), else null. */
function rateCurrency(rate: TrackingRateText | null): string | null {
  return rate && rate.from !== "person" ? rate.currency : null;
}

function sameRate(
  a: TrackingRateText | null,
  b: TrackingRateText | null
): boolean {
  return (
    a === b ||
    (!!a &&
      !!b &&
      a.text === b.text &&
      a.from === b.from &&
      rateCurrency(a) === rateCurrency(b))
  );
}

/**
 * "Keep it": the person keeps a rate filled from a default that was removed,
 * in the currency it was filled in, so it is theirs and Create may send it.
 * Same reference when the rate is not a default's.
 */
export function keepRate(state: TimeTrackingState): TimeTrackingState {
  const rate = state.rate;
  if (rate === null || rate.from !== "default") return state;
  return {
    ...state,
    rate: { text: rate.text, from: "kept", currency: rate.currency },
  };
}

/**
 * Choosing a category: a usable default fills the rate, marked as the
 * default's; without one a default's amount is emptied (no assumed amount)
 * and a typed rate is kept (R10). Same reference when nothing changes.
 */
export function pickCategory(
  state: TimeTrackingState,
  item: BillingCategoryListItem
): TimeTrackingState {
  const key = categoryKey(item);
  const fill = defaultRateFill(item);
  let rate = state.rate;
  if (fill !== null) rate = fill;
  else if (state.rate?.from === "default") rate = null;
  if (key === state.categoryKey && sameRate(rate, state.rate)) return state;
  return { ...state, categoryKey: key, rate };
}

/** Typing a rate: the person's text, kept as typed (an emptied field stays empty). */
export function typeRate(
  state: TimeTrackingState,
  text: string
): TimeTrackingState {
  const rate: TrackingRateText = { text, from: "person" };
  if (sameRate(rate, state.rate)) return state;
  return { ...state, rate };
}

/**
 * The first settled read after switching on: always marks `prefilled`, sets
 * the category only while none is chosen, and the rate only while it is null
 * and the chosen category is the list's default (item 6). It never writes over
 * the person. Same reference when nothing changes.
 */
export function prefillOnce(
  state: TimeTrackingState,
  list: BillingCategoryList
): TimeTrackingState {
  const defaultId = list.local.defaultCategoryId;
  const item =
    defaultId === null
      ? undefined
      : offeredCategories(list).find(c => c.id === defaultId);
  let categoryKeyNext = state.categoryKey;
  let rate = state.rate;
  if (item && categoryKeyNext === null) categoryKeyNext = categoryKey(item);
  if (item && rate === null && categoryKeyNext === categoryKey(item)) {
    const fill = defaultRateFill(item);
    if (fill !== null) rate = fill;
  }
  if (
    state.prefilled &&
    categoryKeyNext === state.categoryKey &&
    rate === state.rate
  ) {
    return state;
  }
  return { ...state, prefilled: true, categoryKey: categoryKeyNext, rate };
}

// ---------------------------------------------------------------------------
// Refusal words (answer 4), shared by the derivation and the server refusals
// ---------------------------------------------------------------------------

export type TrackingField = "category" | "rate" | "note";

export const NOTE_REQUIRED_WORDS =
  "Add a note, because the rate differs from the category's default.";
export const NOTE_DEFAULT_MOVED_WORDS =
  "The category's default rate changed while this form was open. Check the rate, or add a note.";
/**
 * A hub note refusal's banner. It arrives only while the note field is hidden
 * (the form never sends without a note it asks for), so it reports the request
 * and never asks for a note (F2, the Project Manager's ruling of 2026-11-26).
 */
export const NOTE_HUB_ASKS_WORDS =
  "The hub asks for a note because this category's default rate differs from the one shown here.";
/** At Category, with Retry, when the list cannot be read again after that refusal. */
export const NOTE_REFETCH_FAILED_WORDS = `${NOTE_HUB_ASKS_WORDS} Retry to read the category's current default rate.`;

/**
 * The web's own words for a settings refusal by its `field` and `reason`, and
 * the field it shows at; null when the table has no row. One table for the
 * form's own check and the server's 400 answer, so both say the same.
 */
export function fieldRefusalWords(
  field: string,
  reason: string
): { at: TrackingField; words: string } | null {
  switch (field) {
    case "category":
      if (reason === "unknown_category") {
        return {
          at: "category",
          words: "That category is no longer on the list. Choose another.",
        };
      }
      if (reason === "category_retired") {
        return {
          at: "category",
          words: "That category can no longer be chosen here. Choose another.",
        };
      }
      return null;
    case "defaultRateMinor":
    case "defaultCurrency":
      return {
        at: "category",
        words:
          "This category's default rate cannot be used. Choose another category.",
      };
    case "rateMinor":
      return reason === "rate_out_of_range"
        ? { at: "rate", words: "That rate is too large." }
        : null;
    case "currency":
      return reason === "currency_not_allowed"
        ? {
            at: "rate",
            words: "That currency is not known on the node this app runs on.",
          }
        : null;
    case "rateNote":
      if (reason === "note_required") {
        return { at: "note", words: NOTE_REQUIRED_WORDS };
      }
      if (reason === "note_too_long") {
        return {
          at: "note",
          words: `At most ${TRACKING_RATE_NOTE_MAX} characters.`,
        };
      }
      return null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// The derivation
// ---------------------------------------------------------------------------

/** The category list as the group sees it. */
export type TrackingListContext =
  | { kind: "loading" }
  | { kind: "failed"; sentence: string }
  | { kind: "ready"; list: BillingCategoryList; refetchFailed: string | null };

export type TrackingDefaultRate = {
  minor: number;
  currency: string;
  /** "160.00 USD" */
  text: string;
};

export type TimeTrackingDerived = {
  category: BillingCategoryListItem | null;
  currency: string | null;
  currencyKnown: boolean;
  defaultRate: TrackingDefaultRate | null;
  /**
   * The current default when the shown rate is the default's and differs from
   * it, in amount or in currency.
   */
  defaultMoved: TrackingDefaultRate | null;
  /**
   * The shown rate, while it is a default's and the chosen category no longer
   * has a default: Create waits until the person keeps it, types a rate or
   * picks a category (the Project Manager's ruling, 2026-11-26).
   */
  defaultRemoved: { text: string; currency: string } | null;
  noteShown: boolean;
  errors: Partial<Record<TrackingField, string>>;
  settings: TrackingSettingsInput | null;
};

export const CATEGORY_LEFT_WORDS =
  "That category is no longer offered. Choose another.";

export function defaultRemovedWords(removed: {
  text: string;
  currency: string;
}): string {
  const rate = `${removed.text} ${removed.currency}/h`;
  return `This category no longer has a default rate. Keep ${rate} or type another rate.`;
}

/**
 * The shown rate came from the chosen category's default, and that default is
 * now in a currency this build does not know (a node older than the list's
 * owner). The default is not gone, so this is not the removed line (the closer
 * delta review of PR-1, `timeTracking.ts:495`); Create waits.
 */
export function defaultUnknownCurrencyWords(code: string): string {
  return `This category's default rate is now in ${code}, a currency this version does not know. Update this node first, or choose another category.`;
}

export function unknownCurrencyWords(code: string): string {
  return `This version does not know the currency ${code}, so a rate cannot be typed here. Update this node first.`;
}

const NOTHING: TimeTrackingDerived = Object.freeze({
  category: null,
  currency: null,
  currencyKnown: false,
  defaultRate: null,
  defaultMoved: null,
  defaultRemoved: null,
  noteShown: false,
  errors: Object.freeze({}),
  settings: null,
}) as TimeTrackingDerived;

/**
 * Everything the fields show and the settings to send, from the fields alone
 * (never from the target or a server refusal).
 */
export function deriveTimeTracking(
  state: TimeTrackingState,
  ctx: TrackingListContext
): TimeTrackingDerived {
  if (ctx.kind === "loading") return NOTHING;
  if (ctx.kind === "failed") {
    return { ...NOTHING, errors: { category: ctx.sentence } };
  }
  const errors: Partial<Record<TrackingField, string>> = {};
  const category = selectedCategory(state, ctx.list);
  if (state.categoryKey !== null && category === null) {
    errors.category = CATEGORY_LEFT_WORDS;
  } else if (ctx.refetchFailed) {
    errors.category = ctx.refetchFailed;
  }
  // A rate that carries its own currency (a default's, or one the person kept)
  // is read in it, so its number is never sent in another currency.
  const currency =
    rateCurrency(state.rate) ??
    category?.defaultRate?.currency ??
    ctx.list.currency;
  const currencyKnown = isBillingCurrency(currency);
  const defaultRate =
    category?.defaultRate && isBillingCurrency(category.defaultRate.currency)
      ? {
          minor: category.defaultRate.minor,
          currency: category.defaultRate.currency,
          text: formatRateMinor(
            category.defaultRate.minor,
            category.defaultRate.currency
          ),
        }
      : null;
  const fromDefault = state.rate?.from === "default" ? state.rate : null;
  const shownDefault =
    fromDefault !== null && category !== null
      ? defaultRateText(category)
      : null;
  // Moved: the default's amount or its currency is no longer the shown rate's.
  const defaultMoved =
    defaultRate !== null &&
    fromDefault !== null &&
    (shownDefault !== fromDefault.text ||
      defaultRate.currency !== fromDefault.currency)
      ? defaultRate
      : null;
  // A default in a currency this build does not know is not a removed one.
  const unknownDefault =
    fromDefault !== null &&
    category?.defaultRate &&
    !isBillingCurrency(category.defaultRate.currency)
      ? category.defaultRate.currency
      : null;
  if (unknownDefault !== null && errors.category === undefined) {
    errors.category = defaultUnknownCurrencyWords(unknownDefault);
  }
  // Removed: the chosen category has no default any more (ruled 2026-11-26).
  const defaultRemoved =
    fromDefault !== null && category !== null && category.defaultRate === null
      ? { text: fromDefault.text, currency: fromDefault.currency }
      : null;
  const base = {
    category,
    currency,
    currencyKnown,
    defaultRate,
    defaultMoved,
    defaultRemoved,
  };
  if (!currencyKnown) {
    errors.rate = unknownCurrencyWords(currency);
    return { ...base, noteShown: false, errors, settings: null };
  }
  const parsed = parseRateInput(state.rate?.text ?? "", currency);
  if (!parsed.ok) {
    errors.rate = rateRefusalMessage(parsed.reason, currency);
  }
  if (
    category === null ||
    !parsed.ok ||
    defaultRemoved !== null ||
    unknownDefault !== null
  ) {
    return { ...base, noteShown: false, errors, settings: null };
  }
  const input: TrackingSettingsInput = {
    billingStatus: state.status,
    category: { source: category.source, id: category.id },
    rateMinor: parsed.minor,
    currency,
  };
  const lookup = toTrackingCategory(category);
  const probe = validateTrackingSettings(input, lookup, null);
  const noteShown =
    !probe.ok && probe.field === "rateNote" && probe.reason === "note_required";
  const candidate: TrackingSettingsInput = noteShown
    ? { ...input, rateNote: state.note.trim() }
    : input;
  const result = noteShown
    ? validateTrackingSettings(candidate, lookup, null)
    : probe;
  if (result.ok) {
    return { ...base, noteShown, errors, settings: candidate };
  }
  const refusal = fieldRefusalWords(result.field, result.reason);
  if (refusal && errors[refusal.at] === undefined) {
    errors[refusal.at] = refusal.words;
  }
  return { ...base, noteShown, errors, settings: null };
}

/** The Session section's summary part: "Tracked: Billable", or null when off. */
export function trackingSummary(
  state: TimeTrackingState,
  derived: TimeTrackingDerived,
  blocked: boolean = derived.settings === null
): string | null {
  if (!state.on) return null;
  const label = `Tracked: ${trackingStatusLabel(state.status)}`;
  return blocked ? `${label} (incomplete)` : label;
}
