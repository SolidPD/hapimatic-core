// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";
import {
  BILLABLE_SWITCH_KEY_KINDS,
  BillableConfirmSchema,
  BillableSwitchStartChoiceSchema,
  projectBaseKey,
  projectKeyKind,
  type BillableConfirm,
  type BillableSwitchMode,
  type BillableSwitchStartChoice,
  type BillableSwitchStartKind,
  type ProjectKeyMetadata,
} from "./billableSwitch";
import type { TrackingCategory } from "./billingCategories";
import { BILLING_RATE_MINOR_MAX, isBillingCurrency } from "./money";

// A session's time-tracking record (issue #6778, epic #6585): what its time is
// logged as. One current row per tracked session (row present ⇔ tracked) and
// the history in `billable_switch_events`; #6646's two `sessions` columns
// (`billable`, `billable_confirm`) are a projection of the row that only the
// one writer sets (`projectSwitch`). Everything here is pure, so the server, its
// tests and #6780's form read the same rules. The category list and the money
// helpers are #6779's (`./billingCategories`, `./money`); none is defined here.
//
// Two words share the value `pending`: the billing status (a record's time is
// Pending) and the confirm state (a copy waits under "To confirm"). The code
// names them `billingStatus` and `confirm` everywhere.

// ---------------------------------------------------------------------------
// Values

export const TRACKING_BILLING_STATUSES = [
  "billable",
  "pending",
  "non-billable",
] as const;
export type TrackingBillingStatus = (typeof TRACKING_BILLING_STATUSES)[number];
export const TrackingBillingStatusSchema = z.enum(TRACKING_BILLING_STATUSES);

/** Where the write that created a record, or a history row, came from (7.4). */
export const TRACKING_ORIGINS = [
  "create-page",
  "inheritance",
  "schedule",
  "switch",
  "session-controls",
  "api",
  "reconciled",
] as const;
export type TrackingOrigin = (typeof TRACKING_ORIGINS)[number];
export const TrackingOriginSchema = z.enum(TRACKING_ORIGINS);

/** The longest special-rate note, after trimming. */
export const TRACKING_RATE_NOTE_MAX = 500;

/** A project: `repo` (owner/repo) or `path` (a folder that is not a repository, D-2). */
export type TrackingProjectKind = (typeof BILLABLE_SWITCH_KEY_KINDS)[number];
export type TrackingProject = {
  kind: TrackingProjectKind;
  key: string;
  name: string;
};

/**
 * A session's own project, as its record names it (R1; ruling D-2: a folder
 * that is not a repository is the project, shown as its path). The one place
 * the server derives it: the start, the reconcile, the old switch and the PUT.
 */
export function trackingProjectOf(
  metadata: ProjectKeyMetadata
): TrackingProject {
  const key = projectBaseKey(metadata);
  return { kind: projectKeyKind(metadata), key, name: key };
}

/** The external sync selection: IDs and readable names only, never a token. */
export const TrackingSyncSelectionSchema = z
  .object({
    provider: z.string().min(1).max(64),
    connectionId: z.string().min(1).max(200),
    externalProjectId: z.string().min(1).max(200),
    name: z.string().max(200).optional(),
    context: z.string().max(500).optional(),
  })
  .strict();
export type TrackingSyncSelection = z.infer<typeof TrackingSyncSelectionSchema>;

// ---------------------------------------------------------------------------
// What a client sends (shape only; `validateTrackingSettings` checks values)

/** A category as a client names it: never its name or default rate (R3). */
export const TrackingCategoryInputSchema = z
  .object({
    source: z.string().min(1).max(64),
    id: z.string().min(1).max(200),
    connectionId: z.string().min(1).max(200).optional(),
  })
  .strict();

/** A person's settings: no project (the server derives it, R1). */
export const TrackingSettingsInputSchema = z
  .object({
    billingStatus: TrackingBillingStatusSchema,
    category: TrackingCategoryInputSchema,
    rateMinor: z.number(),
    currency: z.string(),
    rateNote: z.string().optional(),
    sync: TrackingSyncSelectionSchema.optional(),
  })
  .strict();
export type TrackingSettingsInput = z.infer<typeof TrackingSettingsInputSchema>;

/** The status-only form: an existing record's status, nothing else (7.2). */
export const TrackingStatusOnlyInputSchema = z
  .object({
    token: z.number().int().nonnegative(),
    tracked: z.literal(true),
    billingStatus: TrackingBillingStatusSchema,
  })
  .strict();
export type TrackingStatusOnlyInput = z.infer<
  typeof TrackingStatusOnlyInputSchema
>;

// ---------------------------------------------------------------------------
// Validated values and the record

/**
 * Validated settings, as the start context carries them: the category's name
 * and default copied from the lookup (or kept from the record), the note
 * trimmed. No project, so the owning node derives it. The owning node runs the
 * structural rules again (`checkTrackingStartValues`) without a lookup.
 */
export const TrackingStartValuesSchema = z
  .object({
    billingStatus: TrackingBillingStatusSchema,
    categorySource: z.string().min(1).max(64),
    categoryId: z.string().min(1).max(200),
    categoryName: z.string().min(1).max(200),
    defaultRateMinor: z.number().int().nullable(),
    defaultCurrency: z.string().nullable(),
    rateMinor: z.number().int(),
    currency: z.string(),
    rateNote: z.string().nullable(),
    sync: TrackingSyncSelectionSchema.nullable(),
  })
  .strict();
export type TrackingStartValues = z.infer<typeof TrackingStartValuesSchema>;

/**
 * The whole row as a history snapshot carries it (3.1, review S3): every column
 * but `session_id`, `namespace` and `last_event_id`. Loose: a newer node's
 * added field survives a reader that copies it.
 */
const TrackingRecordShape = z.object({
  billingStatus: TrackingBillingStatusSchema,
  confirm: BillableConfirmSchema,
  projectKind: z.enum(BILLABLE_SWITCH_KEY_KINDS),
  projectKey: z.string(),
  projectName: z.string(),
  categorySource: z.string().nullable(),
  categoryId: z.string().nullable(),
  categoryName: z.string().nullable(),
  defaultRateMinor: z.number().int().nullable(),
  defaultCurrency: z.string().nullable(),
  rateMinor: z.number().int().nullable(),
  currency: z.string().nullable(),
  rateNote: z.string().nullable(),
  sync: TrackingSyncSelectionSchema.nullable(),
  complete: z.boolean(),
  createdVia: TrackingOriginSchema,
  trackFrom: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export const TrackingRecordSchema = TrackingRecordShape.passthrough();
export type TrackingRecord = z.infer<typeof TrackingRecordShape>;

/** A record before the writer stamps its times. */
export type TrackingRecordDraft = Omit<
  TrackingRecord,
  "createdAt" | "updatedAt"
>;

// ---------------------------------------------------------------------------
// The projection and the status time is logged under (3.3)

/** #6646's two columns as a function of the record (keeps "no confirm unless billable"). */
export function projectSwitch(
  record: {
    billingStatus: TrackingBillingStatus;
    confirm: BillableConfirm;
  } | null
): { billable: boolean; billableConfirm: BillableConfirm } {
  const billable = record !== null && record.billingStatus === "billable";
  return {
    billable,
    billableConfirm:
      billable && record?.confirm === "pending" ? "pending" : null,
  };
}

/**
 * The status a stretch of the session's time is logged under (3.3 item 8,
 * Matt Starfield's ruling of 2026-11-19): a copy waiting under "To confirm" is
 * Pending whatever its copied status; untracked is null.
 */
export function timeBillingStatus(
  record: {
    billingStatus: TrackingBillingStatus;
    confirm: BillableConfirm;
  } | null
): TrackingBillingStatus | null {
  if (record === null) return null;
  if (record.confirm === "pending") return "pending";
  return record.billingStatus;
}

/** A record with no category or rate: the old switch-on, the reconcile (3.1). */
export function partialBillableRecord(input: {
  project: TrackingProject;
  createdVia: TrackingOrigin;
  trackFrom: number;
}): TrackingRecordDraft {
  return {
    billingStatus: "billable",
    confirm: null,
    projectKind: input.project.kind,
    projectKey: input.project.key,
    projectName: input.project.name,
    categorySource: null,
    categoryId: null,
    categoryName: null,
    defaultRateMinor: null,
    defaultCurrency: null,
    rateMinor: null,
    currency: null,
    rateNote: null,
    sync: null,
    complete: false,
    createdVia: input.createdVia,
    trackFrom: input.trackFrom,
  };
}

/** A complete record from validated values (a person's start, a carried start). */
export function recordFromStartValues(input: {
  values: TrackingStartValues;
  project: TrackingProject;
  confirm: BillableConfirm;
  createdVia: TrackingOrigin;
  trackFrom: number;
}): TrackingRecordDraft {
  const v = input.values;
  return {
    billingStatus: v.billingStatus,
    confirm: input.confirm,
    projectKind: input.project.kind,
    projectKey: input.project.key,
    projectName: input.project.name,
    categorySource: v.categorySource,
    categoryId: v.categoryId,
    categoryName: v.categoryName,
    defaultRateMinor: v.defaultRateMinor,
    defaultCurrency: v.defaultCurrency,
    rateMinor: v.rateMinor,
    currency: v.currency,
    rateNote: v.rateNote,
    sync: v.sync,
    complete: true,
    createdVia: input.createdVia,
    trackFrom: input.trackFrom,
  };
}

/**
 * A copy of another session's record (rows 4, 6a, 6b, 8b and 11a): the source's
 * status, category, rates, note, sync, `complete` flag and project (C8), its own
 * confirm state and origin, tracking from the new session's own start.
 */
export function copyRecord(
  source: TrackingRecordDraft,
  input: {
    confirm: BillableConfirm;
    createdVia: TrackingOrigin;
    trackFrom: number;
  }
): TrackingRecordDraft {
  return {
    billingStatus: source.billingStatus,
    confirm: input.confirm,
    projectKind: source.projectKind,
    projectKey: source.projectKey,
    projectName: source.projectName,
    categorySource: source.categorySource,
    categoryId: source.categoryId,
    categoryName: source.categoryName,
    defaultRateMinor: source.defaultRateMinor,
    defaultCurrency: source.defaultCurrency,
    rateMinor: source.rateMinor,
    currency: source.currency,
    rateNote: source.rateNote,
    sync: source.sync,
    complete: source.complete,
    createdVia: input.createdVia,
    trackFrom: input.trackFrom,
  };
}

// ---------------------------------------------------------------------------
// The old switch routes as a shorthand (3.3, C2 = a)

/**
 * What #6646's switch routes now do to the record. "Waiting" is judged on the
 * record (`confirm` pending, any status), so a waiting Pending or Non-billable
 * copy can be kept or reversed. Returns the next record, or null for "no
 * record" (nothing is created by a switch-off, a Keep or a Reverse).
 *  - `switch-on`: no record → a partial Billable record; waiting → Billable and
 *    kept (the old Keep); otherwise → Billable.
 *  - `switch-off`: waiting → the Reverse; otherwise → Non-billable, kept (C2 = a).
 *  - `keep`: `confirm` cleared, the status unchanged (Matt's ruling 1).
 *  - `reverse`: Non-billable and `confirm` cleared, the record kept (ruling 1).
 */
export type OldRouteAction = "switch-on" | "switch-off" | "keep" | "reverse";

export function applyOldRoute(
  prior: TrackingRecordDraft | null,
  action: OldRouteAction,
  fresh: {
    project: TrackingProject;
    createdVia: TrackingOrigin;
    trackFrom: number;
  }
): TrackingRecordDraft | null {
  if (prior === null) {
    return action === "switch-on" ? partialBillableRecord(fresh) : null;
  }
  const waiting = prior.confirm === "pending";
  switch (action) {
    case "switch-on":
      return { ...prior, billingStatus: "billable", confirm: null };
    case "switch-off":
      return waiting
        ? { ...prior, billingStatus: "non-billable", confirm: null }
        : { ...prior, billingStatus: "non-billable" };
    case "keep":
      return { ...prior, confirm: null };
    case "reverse":
      return { ...prior, billingStatus: "non-billable", confirm: null };
  }
}

// ---------------------------------------------------------------------------
// Validation (R5, 7.3): one pure function for the server and #6780's form

export type TrackingValidationReason =
  | "required"
  | "unknown_category"
  | "category_retired"
  | "rate_out_of_range"
  | "currency_not_allowed"
  | "note_required"
  | "note_too_long"
  | "sync_unavailable";

export type TrackingValidationResult =
  | { ok: true; values: TrackingStartValues }
  | { ok: false; field: string; reason: TrackingValidationReason };

/**
 * A rate in integer minor units: a safe integer from 0 to
 * `BILLING_RATE_MINOR_MAX` (7.3). The one rule for a rate and a default rate,
 * in both validators and in the writer's domain check (3.1).
 */
export function isTrackingRateMinor(value: number): boolean {
  return (
    Number.isSafeInteger(value) && value >= 0 && value <= BILLING_RATE_MINOR_MAX
  );
}

/**
 * The special-rate note rule (7.3), for both validators: the note, trimmed, is
 * at most `TRACKING_RATE_NOTE_MAX` characters; a rate or currency that differs
 * from the category's default needs one; a category with no default needs
 * none. Returns the refusal, or the trimmed note ("" for none).
 */
function rateNoteRule(
  rateNote: string | null | undefined,
  rate: {
    rateMinor: number;
    currency: string;
    defaultRateMinor: number | null;
    defaultCurrency: string | null;
  }
):
  | { ok: true; note: string }
  | { ok: false; reason: "note_too_long" | "note_required" } {
  const note = rateNote?.trim() ?? "";
  if (note.length > TRACKING_RATE_NOTE_MAX) {
    return { ok: false, reason: "note_too_long" };
  }
  const differs =
    rate.defaultRateMinor !== null &&
    (rate.rateMinor !== rate.defaultRateMinor ||
      rate.currency !== rate.defaultCurrency);
  if (differs && note === "") return { ok: false, reason: "note_required" };
  return { ok: true, note };
}

/**
 * The writer's three rules for a category's default (3.1), for both
 * validators: the rate and the currency are both set or both null, the rate is
 * in range, and the currency is in the list. Returns the refusal, or null.
 */
function defaultRateRule(
  defaultRateMinor: number | null,
  defaultCurrency: string | null
): { field: string; reason: TrackingValidationReason } | null {
  if ((defaultRateMinor === null) !== (defaultCurrency === null)) {
    return { field: "defaultRateMinor", reason: "required" };
  }
  if (defaultRateMinor !== null && !isTrackingRateMinor(defaultRateMinor)) {
    return { field: "defaultRateMinor", reason: "rate_out_of_range" };
  }
  if (defaultCurrency !== null && !isBillingCurrency(defaultCurrency)) {
    return { field: "defaultCurrency", reason: "currency_not_allowed" };
  }
  return null;
}

/**
 * Whether settings keep the record's category (ruling 12): then the route looks
 * nothing up and the validator keeps the stored name and default. One rule, so
 * the two never disagree on a write.
 */
export function keepsTrackingCategory(
  a: { source: string; id: string },
  prior: TrackingRecordDraft | null
): boolean {
  return (
    prior !== null &&
    prior.categorySource === a.source &&
    prior.categoryId === a.id
  );
}

/**
 * Check a person's settings. `category` is the lookup's answer for the body's
 * category, or undefined when no lookup ran (the category is the record's own,
 * ruling 12: nothing is looked up, the stored name and default stay). `prior`
 * is the session's current record or null. A category the lookup calls
 * `offered: false` is refused unless it is the record's current one. A rate or
 * currency that differs from the category's default needs a note; a category
 * with no default needs none. Sync is refused until #6783 gives its lookup.
 */
export function validateTrackingSettings(
  input: TrackingSettingsInput,
  category: TrackingCategory | null | undefined,
  prior: TrackingRecordDraft | null
): TrackingValidationResult {
  const kept = keepsTrackingCategory(input.category, prior);
  let name: string;
  let defaultRateMinor: number | null;
  let defaultCurrency: string | null;
  if (kept && prior !== null && category === undefined) {
    name = prior.categoryName ?? "";
    defaultRateMinor = prior.defaultRateMinor;
    defaultCurrency = prior.defaultCurrency;
  } else {
    if (!category) {
      return { ok: false, field: "category", reason: "unknown_category" };
    }
    if (!category.offered && !kept) {
      return { ok: false, field: "category", reason: "category_retired" };
    }
    name = category.name;
    defaultRateMinor = category.defaultRateMinor;
    defaultCurrency = category.defaultCurrency;
  }
  // A default the writer would refuse is named here (400), never passed on to
  // fail inside the write (500; review finding f883b2e5).
  const badDefault = defaultRateRule(defaultRateMinor, defaultCurrency);
  if (badDefault) return { ok: false, ...badDefault };
  if (!isTrackingRateMinor(input.rateMinor)) {
    return { ok: false, field: "rateMinor", reason: "rate_out_of_range" };
  }
  if (!isBillingCurrency(input.currency)) {
    return { ok: false, field: "currency", reason: "currency_not_allowed" };
  }
  const noted = rateNoteRule(input.rateNote, {
    rateMinor: input.rateMinor,
    currency: input.currency,
    defaultRateMinor,
    defaultCurrency,
  });
  if (!noted.ok) {
    return { ok: false, field: "rateNote", reason: noted.reason };
  }
  if (input.sync !== undefined) {
    return { ok: false, field: "sync", reason: "sync_unavailable" };
  }
  return {
    ok: true,
    values: {
      billingStatus: input.billingStatus,
      categorySource: input.category.source,
      categoryId: input.category.id,
      categoryName: name,
      defaultRateMinor,
      defaultCurrency,
      rateMinor: input.rateMinor,
      currency: input.currency,
      rateNote: noted.note === "" ? null : noted.note,
      sync: null,
    },
  };
}

/**
 * The structural rules again, on carried values at the owning node (4.2 row 8):
 * the carried category and default make them checkable without a lookup.
 * Returns the refused field, or null when the values hold.
 */
export function checkTrackingStartValues(
  values: TrackingStartValues
): { field: string; reason: TrackingValidationReason } | null {
  const v = values;
  if (!isTrackingRateMinor(v.rateMinor)) {
    return { field: "rateMinor", reason: "rate_out_of_range" };
  }
  if (!isBillingCurrency(v.currency)) {
    return { field: "currency", reason: "currency_not_allowed" };
  }
  // The writer's own default rules (review finding 65fc8fb5): a carried
  // default it refuses would otherwise pass here and fail inside the
  // registration, a lost start (`hook-failed`).
  const badDefault = defaultRateRule(v.defaultRateMinor, v.defaultCurrency);
  if (badDefault) return badDefault;
  const noted = rateNoteRule(v.rateNote, v);
  if (!noted.ok) return { field: "rateNote", reason: noted.reason };
  if (v.sync !== null) {
    return { field: "sync", reason: "sync_unavailable" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The carried copy (section 5 row 4 across nodes; PR-B's moved item 2)

/**
 * A parent's record carried to another node for an agent's copy: every field a
 * copy keeps (`copyRecord`), the project and the `complete` flag among them
 * (C8 = a), and none it sets itself (confirm, origin, start). Carried only to a
 * node that advertises `billable:tracking-carry`, and read there strictly: a
 * malformed value is refused with 400, never dropped (4.1).
 */
export const TrackingCarriedCopySchema = TrackingRecordShape.omit({
  confirm: true,
  createdVia: true,
  trackFrom: true,
  createdAt: true,
  updatedAt: true,
}).strict();
export type TrackingCarriedCopy = z.infer<typeof TrackingCarriedCopySchema>;

/** A record in its carried form, field by field. */
export function carriedCopyOf(
  record: TrackingRecordDraft
): TrackingCarriedCopy {
  return {
    billingStatus: record.billingStatus,
    projectKind: record.projectKind,
    projectKey: record.projectKey,
    projectName: record.projectName,
    categorySource: record.categorySource,
    categoryId: record.categoryId,
    categoryName: record.categoryName,
    defaultRateMinor: record.defaultRateMinor,
    defaultCurrency: record.defaultCurrency,
    rateMinor: record.rateMinor,
    currency: record.currency,
    rateNote: record.rateNote,
    sync: record.sync,
    complete: record.complete,
  };
}

/** The source a copy is made from (`copyRecord` sets the confirm state, the origin and the start itself). */
export function sourceFromCarriedCopy(
  copy: TrackingCarriedCopy
): TrackingRecordDraft {
  return { ...copy, confirm: null, createdVia: "inheritance", trackFrom: 0 };
}

/**
 * #6778 FND-3 (review T2): a partial record (the old switch-on's) under the
 * writer's own rules (`checkTrackingDomains`): a rate in range and its currency
 * together, on the list, the default paired, no sync. Otherwise such a copy
 * would pass here and then be lost in the peer's start hook.
 */
function checkPartialCopy(
  copy: TrackingCarriedCopy
): { field: string; reason: TrackingValidationReason } | null {
  if (copy.rateMinor !== null && !isTrackingRateMinor(copy.rateMinor)) {
    return { field: "rateMinor", reason: "rate_out_of_range" };
  }
  if ((copy.rateMinor === null) !== (copy.currency === null)) {
    return { field: "currency", reason: "required" };
  }
  if (copy.currency !== null && !isBillingCurrency(copy.currency)) {
    return { field: "currency", reason: "currency_not_allowed" };
  }
  const badDefault = defaultRateRule(
    copy.defaultRateMinor,
    copy.defaultCurrency
  );
  if (badDefault) return badDefault;
  if (copy.sync !== null) return { field: "sync", reason: "sync_unavailable" };
  return null;
}

/**
 * The structural rules on a carried copy at the owning node (4.2 row 8), so a
 * value the writer would refuse is refused before the spawn, not lost in the
 * start hook: a project key, the category and the note as a local write stores
 * them, then for a complete record every setting with the rules of
 * `checkTrackingStartValues`, for a partial one `checkPartialCopy`. Returns the
 * refused field, or null.
 */
export function checkCarriedCopy(
  copy: TrackingCarriedCopy
): { field: string; reason: TrackingValidationReason } | null {
  if (copy.projectKey.trim() === "") {
    return { field: "projectKey", reason: "required" };
  }
  // #6778 FND-3 (T9): a carried name or note in the form a local write stores
  // (trimmed, never blank), which a copy of a stored record always is.
  for (const part of [
    copy.categorySource,
    copy.categoryId,
    copy.categoryName,
  ]) {
    if (part !== null && part.trim() === "") {
      return { field: "category", reason: "required" };
    }
  }
  const note = copy.rateNote;
  if (note !== null && (note.trim() === "" || note !== note.trim())) {
    return { field: "rateNote", reason: "required" };
  }
  if (!copy.complete) return checkPartialCopy(copy);
  const { categorySource, categoryId, categoryName, rateMinor, currency } =
    copy;
  if (categorySource === null || categoryId === null || categoryName === null) {
    return { field: "category", reason: "required" };
  }
  if (rateMinor === null) return { field: "rateMinor", reason: "required" };
  if (currency === null) return { field: "currency", reason: "required" };
  return checkTrackingStartValues({
    billingStatus: copy.billingStatus,
    categorySource,
    categoryId,
    categoryName,
    defaultRateMinor: copy.defaultRateMinor,
    defaultCurrency: copy.defaultCurrency,
    rateMinor,
    currency,
    rateNote: copy.rateNote,
    sync: copy.sync,
  });
}

// ---------------------------------------------------------------------------
// The agent rule (C7 = a, 7.1): no rate, default rate or note reaches an agent

const AGENT_HIDDEN_FIELDS = [
  "rateMinor",
  "defaultRateMinor",
  "rateNote",
  // Issue #6204 (section 6): a time entry's value.
  "valueMinor",
] as const;

/** A record without the money fields, for an agent's request. */
export function redactTrackingForAgent<T extends Record<string, unknown>>(
  record: T
): Omit<T, (typeof AGENT_HIDDEN_FIELDS)[number]> {
  const out: Record<string, unknown> = { ...record };
  for (const k of AGENT_HIDDEN_FIELDS) delete out[k];
  return out as Omit<T, (typeof AGENT_HIDDEN_FIELDS)[number]>;
}

/** A history row with both snapshots redacted, for an agent's request. */
export function redactTrackingEventForAgent<T extends Record<string, unknown>>(
  event: T
): T {
  const out: Record<string, unknown> = { ...event };
  for (const key of ["settingsBefore", "settingsAfter"] as const) {
    const snap = out[key];
    if (snap !== null && typeof snap === "object" && !Array.isArray(snap)) {
      out[key] = redactTrackingForAgent(snap as Record<string, unknown>);
    }
  }
  return out as T;
}

// ---------------------------------------------------------------------------
// The start rule (section 5): fifteen rows

export const TRACKING_START_REASONS = [
  "create-page",
  "explicit-not-billable",
  "default",
  "agent-inherit",
  "inherit",
  "inherit-waiting",
  "schedule-carried",
  "system",
  "start-lost",
] as const;
export type TrackingStartReason = (typeof TRACKING_START_REASONS)[number];

/**
 * Why a start's settings were lost (row 12); `unreadable` (#6778 PR-C, moved
 * item 7): its queued context could not be read; `queue-failed` (moved item 6):
 * the queue write itself failed, so nothing waited for the registration.
 */
export type TrackingLostCause =
  | "expired"
  | "namespace"
  | "hook-failed"
  | "unreadable"
  | "queue-failed";

/**
 * #6778 PRC-R9 (FND-5): what the owning node observed of a start that carried
 * settings or a copy, on the spawn-status callback and the local success
 * answer: applied, or the cause it saw, never a value. `gate-off`: its gate
 * was not on; `no-record`: the gate was on and the session had no record
 * after its registration; `record-unreadable`: the record could not be read.
 */
export const SPAWN_TRACKING_CAUSES = [
  "gate-off",
  "no-record",
  "record-unreadable",
] as const;
export const SpawnTrackingAnswerSchema = z.discriminatedUnion("applied", [
  z.object({ applied: z.literal(true) }).strict(),
  z
    .object({ applied: z.literal(false), cause: z.enum(SPAWN_TRACKING_CAUSES) })
    .strict(),
]);
export type SpawnTrackingAnswer = z.infer<typeof SpawnTrackingAnswerSchema>;

export type TrackingStartInput = {
  mode: BillableSwitchMode;
  kind: BillableSwitchStartKind;
  choice?: BillableSwitchStartChoice;
  /** Validated settings: a person's (row 2) or carried to a schedule start (row 8b). */
  tracking?: TrackingStartValues;
  /**
   * The record a copy is made from: the parent's local record (rows 4, 6a, 6b,
   * 11a) or the values carried from the entry node (row 4 across nodes). Null
   * when the parent is untracked, not found or deleted (an `inherit` copies only
   * from a parent whose session row exists, review C12).
   */
  source: TrackingRecordDraft | null;
  /** For `inherit`: true when the start waits (row 6b), false for a person's branch in the app or a successor (row 6a). */
  inheritWaits: boolean;
  /** Set when the start's settings were lost (row 12, checked before the rows that decide a start). */
  lost: TrackingLostCause | null;
  /** The new session's own project, for a start that is not a copy. */
  project: TrackingProject;
  /** The new session's own start time: `track_from` of every start, a copy's too. */
  createdAt: number;
};

export type TrackingStartResult = {
  /** The record to write, or null for an untracked start. */
  record: TrackingRecordDraft | null;
  /** The `start` row's reason; null for row 1 (the gate is not `on`: no row). */
  reason: TrackingStartReason | null;
  /** The cause of a lost start (row 12), for the row's label; never a requested value. */
  lostCause?: TrackingLostCause;
};

/**
 * A new session's record. Row 1 (the gate is not `on`: nothing stored, no row)
 * comes first, because with the gate off nothing is written (R10); row 12 (a
 * lost start) is checked next, whatever the kind; then the first matching row.
 * Rows 11a and 11b (a transcript resume) are `inherit` starts, so rows 6a, 6b
 * and 7 decide them. A copy waits under "To confirm" except a person's branch
 * in the app and a successor (row 6a, the parent's confirm state).
 */
export function resolveTrackingStart(
  input: TrackingStartInput
): TrackingStartResult {
  if (input.mode !== "on") return { record: null, reason: null };
  if (input.lost !== null) {
    return { record: null, reason: "start-lost", lostCause: input.lost };
  }
  const trackFrom = input.createdAt;
  switch (input.kind) {
    case "person":
      if (input.tracking) {
        return {
          record: recordFromStartValues({
            values: input.tracking,
            project: input.project,
            confirm: null,
            createdVia: "create-page",
            trackFrom,
          }),
          reason: "create-page",
        };
      }
      return {
        record: null,
        reason:
          input.choice === "not-billable" ? "explicit-not-billable" : "default",
      };
    case "agent":
      if (input.source) {
        return {
          record: copyRecord(input.source, {
            confirm: "pending",
            createdVia: "inheritance",
            trackFrom,
          }),
          reason: "agent-inherit",
        };
      }
      return { record: null, reason: "default" };
    case "inherit":
      if (input.source) {
        return {
          record: copyRecord(input.source, {
            confirm: input.inheritWaits ? "pending" : input.source.confirm,
            createdVia: "inheritance",
            trackFrom,
          }),
          reason: input.inheritWaits ? "inherit-waiting" : "inherit",
        };
      }
      return { record: null, reason: "inherit" };
    case "schedule":
      if (input.tracking) {
        return {
          record: recordFromStartValues({
            values: input.tracking,
            project: input.project,
            confirm: "pending",
            createdVia: "schedule",
            trackFrom,
          }),
          reason: "schedule-carried",
        };
      }
      return { record: null, reason: "default" };
    case "system":
      return { record: null, reason: "system" };
    case "unattended":
      return { record: null, reason: "default" };
  }
}

// ---------------------------------------------------------------------------
// The client body's start field (4.1): exactly one key

/**
 * `billableSwitchStart` in a spawn request: `{ tracking }` (a person's settings)
 * or `{ choice }`. Strict: neither key and both keys are refused (review C5).
 */
export const BillableSwitchStartBodySchema = z.union([
  z.object({ tracking: TrackingSettingsInputSchema }).strict(),
  // Every choice, the two retired ones too (#6778 PR-A ruling Q2): they parse
  // here so that a route can answer 400 `billable_choice_retired` naming them.
  z.object({ choice: BillableSwitchStartChoiceSchema }).strict(),
]);
export type BillableSwitchStartBody = z.infer<
  typeof BillableSwitchStartBodySchema
>;
