// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #6204: the time-entry record (the Work Log's record of tracked time
 * that survives session deletion), the shared contract.
 *
 * The record is kept on one node, the owner (the billing hub of #6779), and
 * every other node reads it through (plan section 8.2). Input is strict and
 * records are loose, as `./billingCategories.ts` does: the request bodies and
 * the list filter are `.strict()` with closed value lists, and every schema
 * for a value that crosses nodes (an entry, its events, coverage and sync row,
 * a list page, the figures, the baseline read, the runs, the unlogged read)
 * strips unknown keys and checks shapes only, so an older reader accepts a
 * newer owner's answer. The one exception is the figures' `known: false`
 * reason, a closed list, because a guard refuses on every one of them anyway.
 *
 * An agent never reads a rate, a value or a note (#6778's ruling C7 = a):
 * `timeEntryForAgent` builds the agent's form from an allowlist, so a field
 * added later is hidden until it is named.
 */
import { z } from "zod";
import { TRACKING_BILLING_STATUSES } from "./billableTracking";
import { TIME_ENTRY_MINUTES_MAX } from "./money";

// ---------------------------------------------------------------------------
// Value domains (the writer keeps them: no CHECK in the tables, #6778 ruling 10)

/** `time` (measured), `void` and `relog` (a correction), `historical` (import). */
export const TIME_ENTRY_KINDS = [
  "time",
  "void",
  "relog",
  "historical",
] as const;
export type TimeEntryKind = (typeof TIME_ENTRY_KINDS)[number];

/** The basis an entry names (R3); `turns` only on a historical entry. */
export const TIME_ENTRY_BASES = ["intervals", "timer", "turns"] as const;
export type TimeEntryBasis = (typeof TIME_ENTRY_BASES)[number];

export const TIME_ENTRY_SOURCES = [
  "midnight",
  "log-now",
  "correction",
  "import",
] as const;
export type TimeEntrySource = (typeof TIME_ENTRY_SOURCES)[number];

/** R10: this issue sets only the first; #6787 drives the others. */
export const TIME_ENTRY_SYNC_STATES = [
  "not-requested",
  "waiting",
  "synced",
  "failed",
  "change-pending",
] as const;
export type TimeEntrySyncState = (typeof TIME_ENTRY_SYNC_STATES)[number];

/** The status history's event kinds (append-only, section 7). */
export const TIME_ENTRY_EVENT_KINDS = [
  "made",
  "decision",
  "hold-kept",
  "hold-reversed",
  "hold-lapsed",
  "completed",
  "voided",
] as const;
export type TimeEntryEventKind = (typeof TIME_ENTRY_EVENT_KINDS)[number];

/** The two ways measured time is held (section 4.2). */
export const TIME_ENTRY_LANES = ["interval", "counter"] as const;
export type TimeEntryLane = (typeof TIME_ENTRY_LANES)[number];

/**
 * What removed not-yet-logged time (section 7.6; Q1 = RM2, Q3 = ST1, 5.6). A
 * person's clock controls and an agent's word come through the routes;
 * `switch-step` and `restore` have system callers (7.6).
 */
export const TIME_ENTRY_EXCLUSION_CONTROLS = [
  "clock-set",
  "clock-reset",
  "clock-disable",
  "agent",
  "switch-step",
  "restore",
] as const;
export type TimeEntryExclusionControl =
  (typeof TIME_ENTRY_EXCLUSION_CONTROLS)[number];

/** The controls a request may name; the other two have system callers only. */
export const TIME_ENTRY_REQUEST_CONTROLS = [
  "clock-set",
  "clock-reset",
  "clock-disable",
  "agent",
] as const satisfies readonly TimeEntryExclusionControl[];

/**
 * How an exclusion or its release arrived (7.6, 4.2): the session clock's
 * adjustment route (a person), the agent's CLI verb (an agent), the engine
 * (the system callers: the switch step and the restore).
 */
export const TIME_ENTRY_EXCLUSION_VIAS = ["clock", "cli", "engine"] as const;
export type TimeEntryExclusionVia = (typeof TIME_ENTRY_EXCLUSION_VIAS)[number];

/** Why the record cannot answer a session's figures (R13). */
export const TIME_ENTRY_UNKNOWN_REASONS = [
  "no_owner",
  "stale_copy",
  "no_baseline",
  "epoch_pending",
] as const;
export type TimeEntryUnknownReason =
  (typeof TIME_ENTRY_UNKNOWN_REASONS)[number];

/** Why an entry has no value though it copied a rate (section 6, item 30). */
export const TIME_ENTRY_VALUE_REASONS = [
  "currency_unknown",
  "rate_out_of_range",
] as const;
export type TimeEntryValueReason = (typeof TIME_ENTRY_VALUE_REASONS)[number];

/** `applyDecision`'s answer per entry (section 7.1). */
export const TIME_ENTRY_DECISION_RESULTS = [
  "applied",
  "unchanged",
  "stale",
  "voided",
  "not_found",
] as const;
export type TimeEntryDecisionResult =
  (typeof TIME_ENTRY_DECISION_RESULTS)[number];

/** A node's baseline row (section 5.1): taken, handed over, or released. */
export const TIME_ENTRY_BASELINE_KINDS = [
  "first",
  "handover",
  "released",
] as const;
export type TimeEntryBaselineKind = (typeof TIME_ENTRY_BASELINE_KINDS)[number];

/** A session's baseline reading: with its node's baseline, or adopted later. */
export const TIME_ENTRY_SESSION_BASELINE_KINDS = ["first", "late"] as const;
export type TimeEntrySessionBaselineKind =
  (typeof TIME_ENTRY_SESSION_BASELINE_KINDS)[number];

/** The path that removed a session, on its removal mark (section 3.4, 5.3). */
export const TIME_ENTRY_REMOVED_VIAS = [
  "delete",
  "refresh",
  "registry-exit",
] as const;
export type TimeEntryRemovedVia = (typeof TIME_ENTRY_REMOVED_VIAS)[number];

/** A run row's state; a `blocked` row is never counted as a cut. */
export const TIME_ENTRY_RUN_STATES = ["running", "done", "blocked"] as const;
export type TimeEntryRunState = (typeof TIME_ENTRY_RUN_STATES)[number];

/** What lowered a history row's cut (section 4.1). */
export const TIME_ENTRY_CUT_SOURCES = ["sample", "boot"] as const;
export type TimeEntryCutSource = (typeof TIME_ENTRY_CUT_SOURCES)[number];

/** The largest page of the list route (section 8.1). */
export const TIME_ENTRY_LIST_LIMIT_MAX = 500;
export const TIME_ENTRY_LIST_LIMIT_DEFAULT = 100;

/** The longest correction note and agent's quoted words, after trimming. */
export const TIME_ENTRY_NOTE_MAX = 500;
export const TIME_ENTRY_WORDS_MAX = 1000;

// ---------------------------------------------------------------------------
// The wire forms (stripping; shapes only)

const int = () => z.number().int();
const nullableInt = () => z.number().int().nullable();
const nullableString = () => z.string().nullable();

/** One entry, as the owner answers it (section 3.2's columns, camelCase). */
export const TimeEntrySchema = z.object({
  id: z.string(),
  namespace: z.string(),
  sessionId: z.string(),
  ordinal: nullableInt(),
  originNodeId: z.string(),
  kind: z.string(),
  refersTo: nullableString(),
  source: z.string(),
  night: nullableString(),
  workDate: z.string(),
  zone: z.string(),
  late: z.boolean(),
  /** Negative on a void. */
  minutes: int(),
  basis: z.string(),
  /** Both parts, set only on a switch night (4.3 step 3). */
  basisMs: z.object({ interval: int(), counter: int() }).nullable(),
  readFromAt: nullableInt(),
  readToAt: nullableInt(),
  epoch: int(),
  measuredMs: int(),
  carryInMs: int(),
  carryOutMs: int(),
  periodEventId: nullableInt(),
  periodBeginEventId: nullableInt(),
  periodFrom: nullableInt(),
  periodTo: nullableInt(),
  firstMs: nullableInt(),
  lastMs: nullableInt(),
  /** Milliseconds per launcher kind (OC-11). */
  launcherMs: z.record(z.string(), int()).nullable(),
  turns: z.array(z.unknown()).nullable(),
  projectKind: z.string(),
  projectKey: z.string(),
  projectName: z.string(),
  repoKey: nullableString(),
  external: z.unknown().nullable(),
  statusMade: z.string(),
  held: z.boolean(),
  heldStatus: nullableString(),
  categorySource: nullableString(),
  categoryId: nullableString(),
  categoryName: nullableString(),
  defaultRateMinor: nullableInt(),
  defaultCurrency: nullableString(),
  rateMinor: nullableInt(),
  currency: nullableString(),
  rateNote: nullableString(),
  complete: z.boolean(),
  /** Stored when written, never recomputed; negative on a void. */
  valueMinor: nullableInt(),
  valueReason: nullableString(),
  settlesBaseline: z.boolean(),
  sessionName: nullableString(),
  loggedAt: int(),
  status: z.string(),
  billableSince: nullableString(),
  currentProjectKind: z.string(),
  currentProjectKey: z.string(),
  currentProjectName: z.string(),
  currentExternal: z.unknown().nullable(),
  voidedBy: nullableString(),
  lastEventId: int(),
});
export type TimeEntry = z.infer<typeof TimeEntrySchema>;

export const TimeEntryEventSchema = z.object({
  id: int(),
  entryId: z.string(),
  kind: z.string(),
  statusBefore: nullableString(),
  statusAfter: nullableString(),
  projectBefore: z.unknown().nullable(),
  projectAfter: z.unknown().nullable(),
  billableSinceBefore: nullableString(),
  billableSinceAfter: nullableString(),
  effectiveDate: nullableString(),
  zone: nullableString(),
  actorKind: z.string(),
  actorSessionId: nullableString(),
  actorUserAgent: nullableString(),
  via: z.string(),
  note: nullableString(),
  sourceEventId: nullableInt(),
  at: int(),
});
export type TimeEntryEvent = z.infer<typeof TimeEntryEventSchema>;

export const TimeEntryCoverageSchema = z.object({
  lane: z.string(),
  key: z.string(),
  fromMs: int(),
  toMs: int(),
  ownerId: z.string(),
});
export type TimeEntryCoverage = z.infer<typeof TimeEntryCoverageSchema>;

export const TimeEntrySyncSchema = z.object({
  state: z.string(),
  provider: nullableString(),
  connectionId: nullableString(),
  externalTaskId: nullableString(),
  externalEntryId: nullableString(),
  taskLink: nullableString(),
  entryLink: nullableString(),
  errorCode: nullableString(),
  /** A void's own row: never sent itself (item 28). */
  neverSent: z.boolean(),
  updatedAt: int(),
});
export type TimeEntrySync = z.infer<typeof TimeEntrySyncSchema>;

/** `GET /api/time-entries/:id`: one entry, its events, coverage and sync. */
export const TimeEntryDetailSchema = z.object({
  entry: TimeEntrySchema,
  events: z.array(TimeEntryEventSchema),
  coverage: z.array(TimeEntryCoverageSchema),
  sync: TimeEntrySyncSchema.nullable(),
});
export type TimeEntryDetail = z.infer<typeof TimeEntryDetailSchema>;

/** A page of the list; the filters travel in the opaque cursor (item 42). */
export const TimeEntryListPageSchema = z.object({
  entries: z.array(TimeEntrySchema),
  nextCursor: nullableString(),
});
export type TimeEntryListPage = z.infer<typeof TimeEntryListPageSchema>;

/** One recorded exclusion (7.6), as #6781's views and the run rows list it. */
export const TimeEntryExclusionSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  originNodeId: z.string(),
  control: z.string(),
  adjustmentId: nullableString(),
  rangeFrom: nullableInt(),
  rangeTo: nullableInt(),
  upToMs: int(),
  measuredMs: int(),
  epoch: int(),
  actorKind: z.string(),
  actorSessionId: nullableString(),
  actorUserAgent: nullableString(),
  via: z.string(),
  words: nullableString(),
  at: int(),
  releasedAt: nullableInt(),
  releasedByKind: nullableString(),
  releasedVia: nullableString(),
  releasedAdjustmentId: nullableString(),
});
export type TimeEntryExclusion = z.infer<typeof TimeEntryExclusionSchema>;

/** The exclusion preview's answer (7.6): writes nothing. */
export const TimeEntryExcludePreviewSchema = z.object({
  amountMs: int(),
  amountMinutes: int(),
  upTo: int(),
  previewToken: z.string(),
  session: z.object({ id: z.string(), name: nullableString() }),
});
export type TimeEntryExcludePreview = z.infer<
  typeof TimeEntryExcludePreviewSchema
>;

/**
 * R13 (section 8.3): a session's figures, the one answer the guard (#6484)
 * and the swap point of #6778 (Q5 = OC12-1) read. `known: false` carries a
 * reason the guard must refuse on; a remainder under one minute is 0 minutes.
 */
export const TimeEntryFiguresSchema = z.discriminatedUnion("known", [
  z.object({
    sessionId: z.string(),
    known: z.literal(true),
    tracked: z.boolean(),
    unloggedMinutes: int(),
    unloggedMs: int(),
    unsyncedMinutes: int(),
    excludedMs: int(),
    /** The highest timer value below which the session's billable time is covered. */
    coveredThroughMs: nullableInt(),
    /** The lowered cut of a tracking-off row that is the session's last row. */
    untrackedFromMs: nullableInt().optional(),
    asOf: int(),
    preBaselineMs: int(),
    preBaselineSettled: z.boolean(),
  }),
  z.object({
    sessionId: z.string(),
    known: z.literal(false),
    reason: z.enum(TIME_ENTRY_UNKNOWN_REASONS),
    asOf: int(),
  }),
]);
export type TimeEntryFigures = z.infer<typeof TimeEntryFiguresSchema>;

/** `GET /api/time-entries/baselines?node=<id>` (8.1; 5.8 step 3; item 9). */
export const TimeEntryBaselineRowSchema = z.object({
  sessionId: z.string(),
  originNodeId: z.string(),
  basis: z.string(),
  /** The session timer on the closed scale at the baseline. */
  baselineMs: int(),
  readingAt: int(),
  baselineKind: z.string(),
  /** Whether the session had a tracking record at its baseline (EA2, N4). */
  baselineTracked: z.boolean(),
  logFrom: int(),
  settled: z.boolean(),
});
export const TimeEntryBaselineReadSchema = z.object({
  originNodeId: z.string(),
  logFrom: nullableInt(),
  sessions: z.array(TimeEntryBaselineRowSchema),
});
export type TimeEntryBaselineRow = z.infer<typeof TimeEntryBaselineRowSchema>;
export type TimeEntryBaselineRead = z.infer<typeof TimeEntryBaselineReadSchema>;

/** `GET /api/time-entries/runs`: the last 30 run rows (OC-8). */
export const TimeEntryRunSchema = z.object({
  id: int(),
  night: z.string(),
  cutMs: int(),
  zone: z.string(),
  state: z.string(),
  startedAt: nullableInt(),
  finishedAt: nullableInt(),
  sessions: nullableInt(),
  entries: nullableInt(),
  minutes: nullableInt(),
  detail: z.unknown().nullable(),
});
export const TimeEntryRunListSchema = z.object({
  runs: z.array(TimeEntryRunSchema),
});
export type TimeEntryRun = z.infer<typeof TimeEntryRunSchema>;

/** `GET /api/time-entries/unlogged`: a dry run of the planner (8.1). */
export const TimeEntryUnloggedSchema = z.object({
  sessions: z.array(
    z.object({
      sessionId: z.string(),
      periods: z.array(
        z.object({
          from: int(),
          to: nullableInt(),
          status: z.string(),
          basis: z.string(),
          unloggedMs: int(),
          unloggedMinutes: int(),
        })
      ),
      asOf: int(),
      stale: z.boolean(),
      excludedMs: int(),
    })
  ),
});
export type TimeEntryUnlogged = z.infer<typeof TimeEntryUnloggedSchema>;

// ---------------------------------------------------------------------------
// The request forms (strict; closed lists)

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const shortText = (max: number) => z.string().trim().min(1).max(max);

/** A query value arrives as text; a body value may be a number. */
const limitField = z
  .union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
  .pipe(z.number().int().min(1).max(TIME_ENTRY_LIST_LIMIT_MAX));
const flagField = z.union([
  z.boolean(),
  z.enum(["true", "false"]).transform(v => v === "true"),
]);

/**
 * The list's filters (R14; 8.1). `decidable: true` leaves out both rows of
 * every frozen pair (7.1). A category is its source and id together.
 */
export const TimeEntryFilterSchema = z
  .object({
    session: shortText(200).optional(),
    project: shortText(500).optional(),
    from: z.string().regex(DATE_RE).optional(),
    to: z.string().regex(DATE_RE).optional(),
    dateBy: z.enum(["work", "billable"]).default("work"),
    status: z.enum(TRACKING_BILLING_STATUSES).optional(),
    categorySource: shortText(200).optional(),
    categoryId: shortText(200).optional(),
    sync: z.enum(TIME_ENTRY_SYNC_STATES).optional(),
    kind: z.enum(TIME_ENTRY_KINDS).optional(),
    decidable: flagField.optional(),
    cursor: shortText(2000).optional(),
    limit: limitField.optional(),
  })
  .strict()
  .superRefine((f, ctx) => {
    if ((f.categorySource === undefined) !== (f.categoryId === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["categoryId"],
        message: "a category is its source and its id together",
      });
    }
  });
export type TimeEntryFilter = z.infer<typeof TimeEntryFilterSchema>;

/** `POST /api/time-entries/:id/correct` (7.3): 0 writes a void only. */
export const TimeEntryCorrectBodySchema = z
  .object({
    /** The entry's `lastEventId`, the token. */
    expect: z.number().int().min(0),
    minutes: z.number().int().min(0).max(TIME_ENTRY_MINUTES_MAX),
    note: shortText(TIME_ENTRY_NOTE_MAX),
  })
  .strict();
export type TimeEntryCorrectBody = z.infer<typeof TimeEntryCorrectBodySchema>;

const RangeSchema = z
  .object({ fromMs: z.number().int().min(0), toMs: z.number().int().min(0) })
  .strict()
  .refine(r => r.toMs > r.fromMs, { message: "a range ends after it starts" });

/**
 * `POST /api/sessions/:id/time-entries/exclude` (7.6; Q1 = RM2; D-7): the
 * exclusion and its release, each with a preview (`dryRun: true`) that writes
 * nothing. A confirmed request carries the preview's token. An agent names the
 * person's words; a Set names X (`toMs`); a Disable names its range. A release
 * names an exclusion, an adjustment (Undo) or a range (Enable).
 */
export const TimeEntryExcludeBodySchema = z
  .object({
    action: z.enum(["exclude", "release"]).default("exclude"),
    dryRun: z.boolean().optional(),
    control: z.enum(TIME_ENTRY_REQUEST_CONTROLS).optional(),
    toMs: z.number().int().min(0).optional(),
    range: RangeSchema.optional(),
    adjustmentId: shortText(200).optional(),
    exclusionId: shortText(300).optional(),
    words: shortText(TIME_ENTRY_WORDS_MAX).optional(),
    previewToken: shortText(200).optional(),
  })
  .strict()
  .superRefine((b, ctx) => {
    const need = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    if (b.dryRun !== true && b.previewToken === undefined) {
      need("previewToken", "a confirmed request carries its preview's token");
    }
    if (b.action === "release") {
      if (
        b.exclusionId === undefined &&
        b.adjustmentId === undefined &&
        b.range === undefined
      ) {
        need(
          "exclusionId",
          "a release names an exclusion, an adjustment or a range"
        );
      }
      return;
    }
    if (b.control === undefined) {
      need("control", "an exclusion names its control");
      return;
    }
    if (b.control === "agent" && b.words === undefined) {
      need("words", "an agent's exclusion quotes the person's words");
    }
    if (b.control === "clock-set" && b.toMs === undefined) {
      need("toMs", "a Set names the time to keep");
    }
    if (b.control === "clock-disable" && b.range === undefined) {
      need("range", "a Disable names its range");
    }
  });
export type TimeEntryExcludeBody = z.infer<typeof TimeEntryExcludeBodySchema>;

// ---------------------------------------------------------------------------
// The agent's form (OC-9; C7 = a): minutes, status, project and dates only

export const TIME_ENTRY_AGENT_FIELDS = [
  "id",
  "sessionId",
  "sessionName",
  "kind",
  "refersTo",
  "source",
  "workDate",
  "zone",
  "late",
  "minutes",
  "basis",
  "status",
  "held",
  "billableSince",
  "currentProjectKind",
  "currentProjectKey",
  "currentProjectName",
  "complete",
  "voidedBy",
  "loggedAt",
] as const satisfies readonly (keyof TimeEntry)[];

export type TimeEntryAgentForm = Pick<
  TimeEntry,
  (typeof TIME_ENTRY_AGENT_FIELDS)[number]
>;

/** An entry for an agent: built from the allowlist, never by deleting keys. */
export function timeEntryForAgent(entry: TimeEntry): TimeEntryAgentForm {
  const out: Record<string, unknown> = {};
  for (const key of TIME_ENTRY_AGENT_FIELDS) out[key] = entry[key];
  return out as TimeEntryAgentForm;
}
