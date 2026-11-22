// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #6779: billing categories and default hourly rates, the shared
 * contract. The list is kept on one node (the owner, the billing hub) and every
 * other node reads it through (plan section 3.4); #6778 imports the lookup
 * types below.
 *
 * Input is strict, records are loose (`./pins.ts`): the write request bodies
 * are `.strict()`, and every schema for a value that crosses nodes (the list
 * answer, the receiver bodies and answers, the history row, the error body, the
 * lookup ref and category) strips unknown keys and checks shapes only, so an
 * older reader accepts a newer owner's answer (an added `providers` key, a
 * currency code a newer table holds) and the other way round. Readers already
 * shipped cannot be loosened later.
 */
import { z } from "zod";
import { BILLING_RATE_MINOR_MAX, isBillingCurrency } from "./money";

/** The shipped category. Its ID is the same on every node. */
export const BILLING_BUILT_IN_CATEGORY = Object.freeze({
  id: "ai-value-add-time",
  name: "AI value-add time",
});
/** The currency offered for a new rate until a person changes it. */
export const BILLING_DEFAULT_CURRENCY = "USD";
/** The only source today; #6786 adds a provider's categories. */
export const BILLING_LOCAL_SOURCE = "local";
/** The most offered categories a namespace may hold. */
export const BILLING_CATEGORY_LIMIT = 100;
export const BILLING_CATEGORY_NAME_MAX = 60;
export const BILLING_HISTORY_LIMIT_MAX = 100;
export const BILLING_HISTORY_LIMIT_DEFAULT = 50;

// ---------------------------------------------------------------------------
// The name rule (plan 3.1, X2)
// ---------------------------------------------------------------------------

/**
 * Control, format, private-use and surrogate characters. The unassigned class
 * (`\p{Cn}`) is not refused: what is unassigned differs between engines'
 * Unicode versions, so refusing it would split the runtimes.
 */
const INVISIBLE_RE = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}]/u;

export type BillingCategoryNameRefusal = "empty" | "too-long" | "invisible";

/** The field's message for each refusal (the routes send the reason). */
export const BILLING_CATEGORY_NAME_MESSAGES: Readonly<
  Record<BillingCategoryNameRefusal, string>
> = Object.freeze({
  empty: "A name cannot be blank.",
  "too-long": `A name can be at most ${BILLING_CATEGORY_NAME_MAX} characters.`,
  invisible: "A name cannot hold invisible or control characters.",
});

/** NFC, trimmed, 1 to 60 characters, no invisible or control character. */
export function normalizeBillingCategoryName(
  raw: string
):
  | { ok: true; name: string }
  | { ok: false; reason: BillingCategoryNameRefusal } {
  const name = raw.normalize("NFC").trim();
  if (name === "") return { ok: false, reason: "empty" };
  if (INVISIBLE_RE.test(name)) return { ok: false, reason: "invisible" };
  if ([...name].length > BILLING_CATEGORY_NAME_MAX) {
    return { ok: false, reason: "too-long" };
  }
  return { ok: true, name };
}

/**
 * The key two names compare by on add, rename and restore: NFC, trimmed and
 * lower-cased in English. A superset of the SQL index's ASCII `NOCASE`.
 */
export function billingCategoryNameKey(name: string): string {
  return name.normalize("NFC").trim().toLocaleLowerCase("en");
}

/** A person's name input: normalised, with the reason as the issue message. */
export const BillingCategoryNameSchema = z.string().transform((raw, ctx) => {
  const result = normalizeBillingCategoryName(raw);
  if (!result.ok) {
    ctx.addIssue({ code: "custom", message: result.reason });
    return z.NEVER;
  }
  return result.name;
});

// ---------------------------------------------------------------------------
// Money on the wire
// ---------------------------------------------------------------------------

/** A rate in a person's request: the writer's domain (P-5). */
export const BillingRateSchema = z
  .object({
    minor: z.number().int().min(0).max(BILLING_RATE_MINOR_MAX),
    currency: z.string().refine(isBillingCurrency, {
      message: "not a billing currency",
    }),
  })
  .strict();

/** A rate that crosses nodes: shape only, unknown keys stripped. */
export const BillingRateWireSchema = z.object({
  minor: z.number().int().min(0),
  currency: z.string().regex(/^[A-Z]{3}$/),
});

export type BillingRate = z.infer<typeof BillingRateWireSchema>;

const TokenSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const CategoryIdSchema = z.string().min(1).max(64);

// ---------------------------------------------------------------------------
// The five write request bodies (strict)
// ---------------------------------------------------------------------------

export const BillingCategoryAddBodySchema = z
  .object({
    token: TokenSchema,
    name: BillingCategoryNameSchema,
    defaultRate: BillingRateSchema.nullable().optional(),
  })
  .strict();

export const BillingCategoryUpdateBodySchema = z
  .object({
    token: TokenSchema,
    name: BillingCategoryNameSchema.optional(),
    defaultRate: BillingRateSchema.nullable().optional(),
    retired: z.boolean().optional(),
  })
  .strict()
  .refine(
    body =>
      body.name !== undefined ||
      body.defaultRate !== undefined ||
      body.retired !== undefined,
    { message: "empty", path: ["body"] }
  );

export const BillingCategoryOrderBodySchema = z
  .object({
    token: TokenSchema,
    ids: z.array(CategoryIdSchema).max(BILLING_CATEGORY_LIMIT),
  })
  .strict();

export const BillingCategorySettingsBodySchema = z
  .object({
    token: TokenSchema,
    defaultCategoryId: CategoryIdSchema.optional(),
    currency: z
      .string()
      .refine(isBillingCurrency, { message: "not a billing currency" })
      .optional(),
  })
  .strict();

export type BillingCategoryAddBody = z.infer<
  typeof BillingCategoryAddBodySchema
>;
export type BillingCategoryUpdateBody = z.infer<
  typeof BillingCategoryUpdateBodySchema
>;
export type BillingCategoryOrderBody = z.infer<
  typeof BillingCategoryOrderBodySchema
>;
export type BillingCategorySettingsBody = z.infer<
  typeof BillingCategorySettingsBodySchema
>;

// ---------------------------------------------------------------------------
// The list answer (stripping)
// ---------------------------------------------------------------------------

export const BillingCategoryListItemSchema = z.object({
  source: z.string(),
  id: z.string(),
  name: z.string(),
  position: z.number().int(),
  isDefault: z.boolean(),
  offered: z.boolean(),
  retiredAt: z.number().int().nullable(),
  defaultRate: BillingRateWireSchema.nullable(),
});

export const BillingCategoryPlaceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local") }),
  z.object({
    kind: z.literal("owner"),
    nodeId: z.string(),
    nodeLabel: z.string(),
  }),
]);

export const BillingCategoryListSchema = z.object({
  token: TokenSchema,
  // Shape only, as a rate's currency: a reader passes on a well-formed code its
  // own table lacks and names it in a log line, and refuses anything else.
  currency: z.string().regex(/^[A-Z]{3}$/),
  place: BillingCategoryPlaceSchema,
  local: z.object({
    // Null only in a READER's own answer, when this build cannot offer the
    // category the owner's default names (a currency its table lacks): the
    // default category is never cleared, and the owner always sends a string.
    defaultCategoryId: z.string().nullable(),
    categories: z.array(BillingCategoryListItemSchema),
  }),
});

export type BillingCategoryListItem = z.infer<
  typeof BillingCategoryListItemSchema
>;
export type BillingCategoryPlace = z.infer<typeof BillingCategoryPlaceSchema>;
export type BillingCategoryList = z.infer<typeof BillingCategoryListSchema>;

// ---------------------------------------------------------------------------
// History (stripping; an unknown scope or kind is shown as a generic row)
// ---------------------------------------------------------------------------

export const BILLING_CATEGORY_EVENT_KINDS = [
  "seeded",
  "added",
  "renamed",
  "rate-set",
  "rate-cleared",
  "retired",
  "restored",
  "updated",
  "reordered",
  "default-set",
  "currency-set",
  "settings-updated",
] as const;

export type BillingCategoryEventKind =
  (typeof BILLING_CATEGORY_EVENT_KINDS)[number];

export const BillingCategoryHistoryRowSchema = z.object({
  id: z.number().int(),
  scope: z.string(),
  kind: z.string(),
  subjectSource: z.string().nullable(),
  subjectId: z.string().nullable(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  actorKind: z.string(),
  actorUserAgent: z.string().nullable(),
  entryNodeId: z.string().nullable(),
  at: z.number().int(),
});

export const BillingCategoryHistorySchema = z.object({
  rows: z.array(BillingCategoryHistoryRowSchema),
  nextBefore: z.number().int().nullable(),
});

export type BillingCategoryHistoryRow = z.infer<
  typeof BillingCategoryHistoryRowSchema
>;
export type BillingCategoryHistory = z.infer<
  typeof BillingCategoryHistorySchema
>;

// ---------------------------------------------------------------------------
// Errors (stripping). No error body carries a list or a rate (R11, R12).
// ---------------------------------------------------------------------------

export const BILLING_CATEGORIES_UNAVAILABLE_REASONS = [
  "no-owner",
  "two-owners",
  "owner-not-polled",
  "owner-offline",
  "owner-unsupported",
  "owner-unreachable",
  "storage-not-ready",
] as const;

export type BillingCategoriesUnavailableReason =
  (typeof BILLING_CATEGORIES_UNAVAILABLE_REASONS)[number];

export const BillingCategoryOwnerRefSchema = z.object({
  nodeId: z.string(),
  nodeLabel: z.string(),
});

export const BillingCategoryErrorBodySchema = z.object({
  code: z.string(),
  reason: z.string().optional(),
  field: z.string().optional(),
  ownerNodeId: z.string().optional(),
  ownerLabel: z.string().optional(),
  owners: z.array(BillingCategoryOwnerRefSchema).optional(),
  /** Only on `stale_token`: the namespace's new token. */
  token: TokenSchema.optional(),
});

export type BillingCategoryOwnerRef = z.infer<
  typeof BillingCategoryOwnerRefSchema
>;
export type BillingCategoryErrorBody = z.infer<
  typeof BillingCategoryErrorBodySchema
>;

// ---------------------------------------------------------------------------
// The lookup #6778 calls (plan section 5)
// ---------------------------------------------------------------------------

export type TrackingCategoryRef = {
  source: string;
  id: string;
  connectionId?: string;
};

export type TrackingCategory = {
  source: string;
  id: string;
  name: string;
  /** null exactly when `defaultCurrency` is null (the table's pair rule). */
  defaultRateMinor: number | null;
  defaultCurrency: string | null;
  /** false: retired (local); #6786 uses it for a provider's hidden category. */
  offered: boolean;
};

export const TrackingCategoryRefSchema = z.object({
  source: z.string().min(1).max(64),
  id: z.string().min(1).max(200),
  connectionId: z.string().min(1).max(200).optional(),
});

export const TrackingCategorySchema = z
  .object({
    source: z.string(),
    id: z.string(),
    name: z.string(),
    defaultRateMinor: z.number().int().min(0).nullable(),
    defaultCurrency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullable(),
    offered: z.boolean(),
  })
  .refine(c => (c.defaultRateMinor === null) === (c.defaultCurrency === null), {
    message: "a rate and its currency are both set or both null",
  });

export class TrackingCategoryUnavailableError extends Error {
  constructor(readonly reason: BillingCategoriesUnavailableReason) {
    super(`billing categories unavailable: ${reason}`);
    this.name = "TrackingCategoryUnavailableError";
  }
}

export interface TrackingCategoryLookup {
  /**
   * Resolves null for an unknown category; rejects with
   * TrackingCategoryUnavailableError, carrying the reason, when the owner's
   * list cannot be read.
   */
  get(ref: TrackingCategoryRef): Promise<TrackingCategory | null>;
}

/** A list item as the lookup's category (#6780's form holds list items). */
export function toTrackingCategory(
  item: BillingCategoryListItem
): TrackingCategory {
  return {
    source: item.source,
    id: item.id,
    name: item.name,
    defaultRateMinor: item.defaultRate ? item.defaultRate.minor : null,
    defaultCurrency: item.defaultRate ? item.defaultRate.currency : null,
    offered: item.offered,
  };
}

// ---------------------------------------------------------------------------
// The federation receivers' bodies and answers (stripping, plan 4.2)
// ---------------------------------------------------------------------------

export const FederationBillingCategoryListBodySchema = z.object({
  includeRetired: z.boolean().optional(),
});

export const FederationBillingCategoryLookupBodySchema = z.object({
  ref: TrackingCategoryRefSchema,
});

export const FederationBillingCategoryLookupAnswerSchema = z.union([
  z.object({ found: z.literal(false) }),
  z.object({ found: z.literal(true), category: TrackingCategorySchema }),
]);

export type FederationBillingCategoryLookupAnswer = z.infer<
  typeof FederationBillingCategoryLookupAnswerSchema
>;

// ---------------------------------------------------------------------------
// The effective list (plan 3.2)
// ---------------------------------------------------------------------------

/** The stored settings row, or null when the namespace has none. */
export type BillingCategorySettingsRow = {
  defaultCategoryId: string;
  currency: string;
};

/** A stored category row, as the store reads it. */
export type BillingCategoryRow = {
  id: string;
  name: string;
  position: number;
  defaultRateMinor: number | null;
  defaultCurrency: string | null;
  retiredAt: number | null;
};

export type EffectiveCategoryList = {
  currency: string;
  defaultCategoryId: string;
  categories: BillingCategoryListItem[];
};

/**
 * The list a namespace reads. With no settings row it is the built-in list
 * (one category, default, no rate, USD), whatever rows exist: reads never
 * write, and the first write stores the settings row and the seed together.
 * Ordered by `position, id`; retired rows only with `includeRetired`.
 */
export function effectiveCategoryList(
  settingsRow: BillingCategorySettingsRow | null,
  rows: readonly BillingCategoryRow[],
  options: { includeRetired?: boolean } = {}
): EffectiveCategoryList {
  if (settingsRow === null) {
    return {
      currency: BILLING_DEFAULT_CURRENCY,
      defaultCategoryId: BILLING_BUILT_IN_CATEGORY.id,
      categories: [
        {
          source: BILLING_LOCAL_SOURCE,
          id: BILLING_BUILT_IN_CATEGORY.id,
          name: BILLING_BUILT_IN_CATEGORY.name,
          position: 0,
          isDefault: true,
          offered: true,
          retiredAt: null,
          defaultRate: null,
        },
      ],
    };
  }
  const categories = [...rows]
    .filter(row => options.includeRetired || row.retiredAt === null)
    .sort((a, b) =>
      a.position !== b.position
        ? a.position - b.position
        : a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0
    )
    .map(row => ({
      source: BILLING_LOCAL_SOURCE,
      id: row.id,
      name: row.name,
      position: row.position,
      isDefault: row.id === settingsRow.defaultCategoryId,
      offered: row.retiredAt === null,
      retiredAt: row.retiredAt,
      defaultRate:
        row.defaultRateMinor !== null && row.defaultCurrency !== null
          ? { minor: row.defaultRateMinor, currency: row.defaultCurrency }
          : null,
    }));
  return {
    currency: settingsRow.currency,
    defaultCategoryId: settingsRow.defaultCategoryId,
    categories,
  };
}
