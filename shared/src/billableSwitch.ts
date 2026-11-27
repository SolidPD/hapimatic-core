// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";
import type {
  TrackingCarriedCopy,
  TrackingStartValues,
} from "./billableTracking";

// The billable switch (issue #6646, epic #6585): whether a session's time is
// billed. (#6586 says how much time there is; this module never measures time.)
//
// This module is the single cross-package contract: the store, the start rule,
// the routes, the federation hop and the screens all validate against it. The
// rule that decides a session's start value is `resolveTrackingStart`
// (`./billableTracking`, #6778 PR-B), one pure function over the plan's table,
// so the server's insert path and its tests read the same table.

// ---------------------------------------------------------------------------
// The gate

/**
 * The state the gate takes when `HAPI_BILLABLE_SWITCH` is unset. It stays `off`
 * in every build (ruling ROLL-1): the feature is switched on node by node, by a
 * setting on each node, on the operator's own nodes.
 */
export const BILLABLE_SWITCH_DEFAULT_MODE = "off" as const;

/** The gate's three states (ruling Q9 (a)). */
export const BILLABLE_SWITCH_MODES = ["off", "on", "closed"] as const;
/**
 * `off`: dark, nothing new is served or written. `on`: everything. `closed`: the
 * off direction and the reads stay alive; nothing can be switched on.
 */
export type BillableSwitchMode = (typeof BILLABLE_SWITCH_MODES)[number];

// ---------------------------------------------------------------------------
// A session's switch

/** A waiting session ("To confirm") carries `"pending"`; otherwise null. */
export const BillableConfirmSchema = z.enum(["pending"]).nullable();
export type BillableConfirm = z.infer<typeof BillableConfirmSchema>;

/** How a session was started, as far as the start rule is concerned (R6). */
export const BILLABLE_SWITCH_START_KINDS = [
  "person",
  "agent",
  "schedule",
  "inherit",
  "system",
  "unattended",
] as const;
export type BillableSwitchStartKind =
  (typeof BILLABLE_SWITCH_START_KINDS)[number];
export const BillableSwitchStartKindSchema = z.enum(
  BILLABLE_SWITCH_START_KINDS
);

/**
 * The `choice` a person's start may carry in `billableSwitchStart`. Only
 * `not-billable` decides a start (it starts off); `follow-header` is no answer.
 * The other two are retired (#6778 PR-A, R12): they billed through the project
 * header, which no longer decides a start, so the spawn routes refuse them with
 * 400 `billable_choice_retired`. They stay listed so that the refusal can name
 * them and an older client's value still parses.
 */
export const BILLABLE_SWITCH_START_CHOICES = [
  "follow-header",
  "header-and-session",
  "session-only",
  "not-billable",
] as const;
export type BillableSwitchStartChoice =
  (typeof BILLABLE_SWITCH_START_CHOICES)[number];
export const BillableSwitchStartChoiceSchema = z.enum(
  BILLABLE_SWITCH_START_CHOICES
);

/** The answers the spawn routes refuse with 400 `billable_choice_retired` (#6778). */
export const BILLABLE_SWITCH_RETIRED_CHOICES = [
  "header-and-session",
  "session-only",
] as const satisfies readonly BillableSwitchStartChoice[];

/** True for an answer the spawn routes refuse as retired. */
export function isRetiredBillableSwitchChoice(choice: unknown): boolean {
  return (BILLABLE_SWITCH_RETIRED_CHOICES as readonly unknown[]).includes(
    choice
  );
}

/**
 * The channel a write came in on: `direct` for a token-authenticated request,
 * `tool` for one the agents' tool channel dispatched, `internal` for a start
 * whose start context carries no actor (a start with one records the
 * request's channel).
 */
export const BILLABLE_SWITCH_VIAS = ["direct", "tool", "internal"] as const;
export type BillableSwitchVia = (typeof BILLABLE_SWITCH_VIAS)[number];
export const BillableSwitchViaSchema = z.enum(BILLABLE_SWITCH_VIAS);

/**
 * Who wrote an event, as CLAIMED, never an identity (section 6 item 3):
 * `client` held the node's access token and named no session (the web app, a
 * script, an agent that left the header out), so no screen may show it as "you";
 * `session` named this session; `system` is a start whose start context carries
 * no actor (a start with one records the request's actor).
 */
export const BILLABLE_SWITCH_ACTOR_KINDS = [
  "client",
  "session",
  "system",
] as const;
export type BillableSwitchActorKind =
  (typeof BILLABLE_SWITCH_ACTOR_KINDS)[number];
export const BillableSwitchActorSchema = z.object({
  kind: z.enum(BILLABLE_SWITCH_ACTOR_KINDS),
  sessionId: z.string().max(200).optional(),
  userAgent: z.string().max(200).optional(),
});
export type BillableSwitchActor = z.infer<typeof BillableSwitchActorSchema>;

// ---------------------------------------------------------------------------
// A node's header default for a project

/** `repo`: keyed by `repoIdentity.name`; `path`: by a directory. Only `repo` keys match across nodes (X1). */
export const BILLABLE_SWITCH_KEY_KINDS = ["repo", "path"] as const;
export type BillableSwitchKeyKind = (typeof BILLABLE_SWITCH_KEY_KINDS)[number];
export const BillableSwitchKeyKindSchema = z.enum(BILLABLE_SWITCH_KEY_KINDS);

/** One header row, as stored and as reported on the federation poll. */
export const BillableSwitchHeaderSchema = z.object({
  namespace: z.string().max(200),
  projectKey: z.string().min(1).max(500),
  keyKind: BillableSwitchKeyKindSchema,
  billable: z.boolean(),
  updatedAt: z.number(),
});
export type BillableSwitchHeader = z.infer<typeof BillableSwitchHeaderSchema>;

/**
 * How old another node's header report may be before the push stops passing it
 * on: 7 days. Since #6778 PR-A no start reads a report: the start-up step
 * deletes the stored header rows (`billable_switch_peer_headers`), while each
 * node's report row (`billable_switch_peer_reports`) stays and the push still
 * sends an empty entry for it up to this age (an older node replaces its stored
 * copy with it).
 */
export const BILLABLE_SWITCH_REPORT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// The event record (section 6 item 3 of the plan, as data)

/**
 * The seven kinds a build before #6778 PR-B knows. Its history parse and its
 * puller hold a strict kind enum, so they see only these (the feed and the old
 * history routes leave `tracking` out unless asked, section 6.3).
 */
export const BILLABLE_SWITCH_LEGACY_EVENT_KINDS = [
  "start",
  "on",
  "off",
  "keep",
  "reverse",
  "header-on",
  "header-off",
] as const;

/**
 * Every kind. `tracking` (#6778 PR-B) is a write that leaves the projection
 * alone: settings, the reconcile, a copy not sent, a Keep or Reverse of a
 * waiting copy that is not Billable.
 */
export const BILLABLE_SWITCH_EVENT_KINDS = [
  ...BILLABLE_SWITCH_LEGACY_EVENT_KINDS,
  "tracking",
] as const;
export type BillableSwitchEventKind =
  (typeof BILLABLE_SWITCH_EVENT_KINDS)[number];

/**
 * The reasons a `start` event may carry. Since #6778 PR-A a new start writes
 * only `explicit-not-billable`, `inherit`, `system` or `default`; the others
 * stay because events #6646 recorded carry them and the history reads them.
 */
export const BILLABLE_SWITCH_START_REASONS = [
  "explicit-header-and-session",
  "explicit-session-only",
  "explicit-not-billable",
  "inherit",
  "system",
  "header",
  // #6646's row 8: a person switched this node's header off. The plan wrote
  // this reason as `header-off`, which is also the name of a kind; the plan's
  // own rule says no reason shares a name with a kind, so it carries this name.
  "header-switched-off",
  "cross-node",
  "cross-node-unasked",
  "default",
  // #6778 PR-B (section 5): a person's start from the Create page's settings,
  // an agent's copy, a copy that waits, a schedule start with carried settings,
  // a start whose settings were lost (its label carries the cause only).
  "create-page",
  "agent-inherit",
  "inherit-waiting",
  "schedule-carried",
  "start-lost",
] as const;
export type BillableSwitchStartReason =
  (typeof BILLABLE_SWITCH_START_REASONS)[number];

/** Which reasons each kind may carry. The store and the service refuse any other pair. */
export const BILLABLE_SWITCH_REASONS_BY_KIND = {
  start: BILLABLE_SWITCH_START_REASONS,
  on: ["switch", "pick", "tracking-on", "status-change"],
  off: [
    "switch",
    "switch-off-and-delete",
    "never-bill",
    "tracking-off",
    "status-change",
  ],
  keep: ["confirm", "confirm-all", "switch"],
  reverse: ["confirm-reverse", "switch", "switch-off-and-delete", "never-bill"],
  "header-on": ["switch", "create-choice"],
  // `retired`: #6778 PR-A's start-up step switched a header off for good (R12).
  "header-off": ["switch", "retired"],
  // #6778 PR-B (3.2): a write that leaves the projection alone.
  tracking: [
    "settings",
    "reconciled",
    "copy-not-sent",
    "confirm-kept",
    "confirm-reversed",
  ],
} as const satisfies Record<BillableSwitchEventKind, readonly string[]>;

export type BillableSwitchReason =
  (typeof BILLABLE_SWITCH_REASONS_BY_KIND)[BillableSwitchEventKind][number];

/** True when `reason` is allowed for `kind`. */
export function isBillableSwitchReasonForKind(
  kind: string,
  reason: string
): boolean {
  if (!(BILLABLE_SWITCH_EVENT_KINDS as readonly string[]).includes(kind)) {
    return false;
  }
  const allowed = BILLABLE_SWITCH_REASONS_BY_KIND[
    kind as BillableSwitchEventKind
  ] as readonly string[];
  return allowed.includes(reason);
}

/**
 * The reasons a person or an agent may send with `PUT /api/sessions/:id/billable`
 * (section 6 item 8). Any reason other than `switch` is accepted only with
 * `billable: false`.
 */
export const BILLABLE_SWITCH_WRITE_REASONS = [
  "switch",
  "switch-off-and-delete",
  "never-bill",
] as const;
export type BillableSwitchWriteReason =
  (typeof BILLABLE_SWITCH_WRITE_REASONS)[number];

/**
 * One row of `billable_switch_events`, as the event feed carries it whole
 * (the label included). Records are loose (`.passthrough()`): a newer origin's
 * added field must survive a hub that copies it.
 */
export const BillableSwitchEventSchema = z
  .object({
    id: z.number().int(),
    at: z.number(),
    namespace: z.string(),
    kind: z.enum(BILLABLE_SWITCH_EVENT_KINDS),
    reason: z.string().nullable(),
    sessionId: z.string().nullable(),
    projectKey: z.string().nullable(),
    keyKind: BillableSwitchKeyKindSchema.nullable(),
    startKind: BillableSwitchStartKindSchema.nullable(),
    billableBefore: z.boolean().nullable(),
    billableAfter: z.boolean().nullable(),
    confirmBefore: BillableConfirmSchema,
    confirmAfter: BillableConfirmSchema,
    actor: z.object({
      kind: z.enum(BILLABLE_SWITCH_ACTOR_KINDS),
      sessionId: z.string().nullable(),
      userAgent: z.string().nullable(),
    }),
    via: BillableSwitchViaSchema,
    entryNodeId: z.string().nullable(),
    timerMs: z.number().nullable(),
    unloggedMs: z.number().nullable(),
    loggedKnown: z.boolean(),
    label: z.record(z.string(), z.unknown()).nullable(),
    // #6778 PR-B (3.2): the whole record before and after, the write's origin
    // and the tracking start. Absent on a row a build before PR-B wrote, and
    // left out of the feed for a puller that does not ask with `schema=2`.
    // Loose, so a newer node's snapshot never fails a page here.
    settingsBefore: z.record(z.string(), z.unknown()).nullable().optional(),
    settingsAfter: z.record(z.string(), z.unknown()).nullable().optional(),
    origin: z.string().nullable().optional(),
    trackFrom: z.number().nullable().optional(),
  })
  .passthrough();
export type BillableSwitchEvent = z.infer<typeof BillableSwitchEventSchema>;

/**
 * One page of a node's record, as the event feed answers it (Task 7b): the rows
 * after `cursor`, ascending, each whole. `incarnation` names the database (its
 * ids are a per-database counter), and `maxEventId` lets a puller see a counter
 * that a restored database rewound under the same incarnation.
 */
export const BillableSwitchEventFeedPageSchema = z.object({
  incarnation: z.string().min(1),
  maxEventId: z.number().int().nonnegative(),
  events: z.array(BillableSwitchEventSchema),
  nextCursor: z.number().int().nonnegative(),
  // #6778 PR-B (S14): on a `schema=2` page only, the `at` of the row whose id is
  // the request's cursor (null when this node holds no such row). Absent from
  // an older origin's page and from a page without `schema=2`, so an older
  // puller, which strips unknown keys here, never sees it.
  cursorAt: z.number().nullable().optional(),
});

/** #6778 PR-B (6.3): the feed version a puller asks for to get every kind and field. */
export const BILLABLE_SWITCH_FEED_SCHEMA = 2;
export type BillableSwitchEventFeedPage = z.infer<
  typeof BillableSwitchEventFeedPageSchema
>;

// ---------------------------------------------------------------------------
// The start context

/**
 * The start context as it crosses the federation spawn hop
 * (`FederationSpawnBodySchema.billableSwitchStart`). A plain `z.object` that
 * strips unknown keys, with every field caught: nodes do not update in step, so
 * a strict nested object would make every receiver on the previous build answer
 * 400 after the first later change. An unknown kind reads as `unattended`.
 * `fromSessionId` is server-only and is never accepted here.
 */
export const BillableSwitchStartWireSchema = z.object({
  kind: BillableSwitchStartKindSchema.catch("unattended"),
  choice: BillableSwitchStartChoiceSchema.optional().catch(undefined),
  actor: BillableSwitchActorSchema.optional().catch(undefined),
  entryNodeId: z.string().max(200).optional().catch(undefined),
  via: BillableSwitchViaSchema.optional().catch(undefined),
  // #6778 (4.1): the validated settings and the claimed parent. The receiver
  // parses `tracking` with the strict schema itself (a node before PR-C drops
  // both fields, which is why the hub sends them only to a node that can take a
  // tracked start).
  tracking: z.unknown().optional(),
  inheritedFrom: z
    .object({
      sessionId: z.string().min(1).max(200),
      nodeId: z.string().max(200).nullable(),
      claimed: z.literal(true),
      headerBound: z.boolean(),
    })
    .optional()
    .catch(undefined),
  // #6778 PR-C (Task 15; PR-B's moved item 2): an agent's copy of a parent on
  // the entry node, parsed strictly by the receiver like `tracking`.
  inheritedCopy: z.unknown().optional(),
});
export type BillableSwitchStartWire = z.infer<
  typeof BillableSwitchStartWireSchema
>;

/**
 * #6778 PR-C (Task 15b; section 4.3, ruling 5, rulings PRC-R5 and PRC-R6): what
 * a branch, a successor or a transcript resume says about its `inherit` start.
 * `person` (a branch or a resume a person starts in the app) and `successor` (the
 * hand-off the server fires between turns, with no request) take the parent's
 * confirm state (row 6a). Every other `inherit` copies and waits under "To
 * confirm" (row 6b): the CLI's verb, a tool, another node's hop, and a start that
 * names no claim at all. Server-only: never on the federation wire, so a hub
 * cannot claim it for the owning node.
 */
export type BillableSwitchInheritClaim = "person" | "successor";

/**
 * #6778 PR-C (Task 15b): the hub's claim as it crosses the branch hop (`claim`
 * beside `branchLabel` in `POST /api/federation/sessions/:id/branch`). Every
 * field caught, like the start wire, so a later change never makes an older
 * receiver refuse. It has no `inheritClaim`, so a branch that arrives over the
 * hop always waits (ruling 5: the owning node cannot check the hub's claim). A
 * receiver before PR-C reads only `branchLabel` and ignores it.
 */
export const BillableSwitchBranchClaimWireSchema = z.object({
  actor: BillableSwitchActorSchema.optional().catch(undefined),
  via: BillableSwitchViaSchema.optional().catch(undefined),
  entryNodeId: z.string().max(200).optional().catch(undefined),
});

/**
 * The start context on the server (the required `billableSwitchStart` spawn
 * option). The actor, the entry node and the channel are set by the entry hub
 * and never taken from a client body. `fromSessionId` names the parent of an
 * `inherit` start; `namespace` is the caller's, when the route knows it, so a
 * registration from another namespace under the same tag does not consume it.
 */
export type BillableSwitchStartContext = {
  kind: BillableSwitchStartKind;
  choice?: BillableSwitchStartChoice;
  actor?: BillableSwitchActor;
  entryNodeId?: string;
  via?: BillableSwitchVia;
  fromSessionId?: string;
  namespace?: string;
  /** Server-only: the schedule that started a `schedule` start (for the record's label). */
  scheduleId?: string;
  /** #6778: validated settings (a person's start, row 2; a schedule's carried settings, row 8b). */
  tracking?: TrackingStartValues;
  /** #6778: the parent an agent start copies; always a claim (4.1). */
  inheritedFrom?: {
    sessionId: string;
    nodeId: string | null;
    claimed: true;
    headerBound: boolean;
  };
  /** #6778 PR-C: that parent's record, carried when the parent is on another node (4.2, the one rule). */
  inheritedCopy?: TrackingCarriedCopy;
  /** #6778 PR-C (Task 15b): who asked for an `inherit` start; none waits (PRC-R5). */
  inheritClaim?: BillableSwitchInheritClaim;
};

/** #6778 PR-C (Task 15b): what a branch's route or hop adds to its `inherit` start. */
export type BillableSwitchBranchClaim = Pick<
  BillableSwitchStartContext,
  "actor" | "via" | "entryNodeId" | "inheritClaim"
>;

// ---------------------------------------------------------------------------
// The project key

/**
 * The metadata fields the project key reads. Structural, so the server's
 * `Metadata` and the web's summary metadata both fit.
 */
export type ProjectKeyMetadata =
  | {
      repoIdentity?: { name?: string | null } | null;
      worktree?: { basePath?: string | null } | null;
      path?: string | null;
    }
  | null
  | undefined;

/** A value that is not blank (#6778 PR-B review, finding 8988bf65). */
function present(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * The node-blind key of a session's project: `repoIdentity.name` (owner/repo)
 * for a git-backed session, else `worktree.basePath`, else the raw path, else
 * "Other". A blank value counts as absent, so the key is never empty: the
 * tracking writer refuses an empty key, and a session with one would never get
 * its record (review finding 8988bf65). The web groups the session list by it
 * (`grouping.ts`) and the server keys a session's tracking project by it.
 */
export function projectBaseKey(metadata: ProjectKeyMetadata): string {
  return (
    present(metadata?.repoIdentity?.name) ??
    present(metadata?.worktree?.basePath) ??
    present(metadata?.path) ??
    "Other"
  );
}

/** `repo` when the key came from a repository identity, else `path`. */
export function projectKeyKind(
  metadata: ProjectKeyMetadata
): BillableSwitchKeyKind {
  return present(metadata?.repoIdentity?.name) ? "repo" : "path";
}

// ---------------------------------------------------------------------------
// The node view of `GET /api/billable-switch/headers` (its header lists are
// empty from #6778 PR-A on: no header decides a start)

export type BillableSwitchNodeView = {
  nodeId: string;
  nodeLabel: string;
  /** The checking node's own table: always fresh. */
  isLocal: boolean;
  /** When this node's last report arrived; null when it never reported. */
  reportedAt: number | null;
  headers: ReadonlyArray<
    Pick<
      BillableSwitchHeader,
      "namespace" | "projectKey" | "keyKind" | "billable"
    >
  >;
};

// ---------------------------------------------------------------------------
// The amount (the swap point, section 5; EARLY-1)

/**
 * What switching a session would move into or out of billing: the session
 * timer less the minutes already logged. `loggedMs` is null until the time
 * entry record (#6204) supplies it, and every place that shows the amount then
 * names the timer (ruling AMT-1). Never below 0.
 */
export function unloggedAmount(input: {
  timerMs: number;
  loggedMs: number | null;
}): { ms: number; loggedKnown: boolean } {
  const timerMs = Number.isFinite(input.timerMs) ? input.timerMs : 0;
  const logged =
    input.loggedMs !== null && Number.isFinite(input.loggedMs)
      ? input.loggedMs
      : 0;
  return {
    ms: Math.max(0, timerMs - logged),
    loggedKnown: input.loggedMs !== null,
  };
}
