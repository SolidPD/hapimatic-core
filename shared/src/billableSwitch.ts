// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

// The billable switch (issue #6646, epic #6585): whether a session's time is
// billed. (#6586 says how much time there is; this module never measures time.)
//
// This module is the single cross-package contract: the store, the start rule,
// the routes, the federation hop and the screens all validate against it. Every
// rule that decides a session's start value lives in `resolveBillableSwitchStart`,
// one pure function over the truth table of the plan (Task 1), so the server's
// insert path and its tests read the same table.

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

/** A person's answer to the question at Create (POP-1). */
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
 * How old another node's header report may be before the start rule stops
 * using it: 7 days. Older, it counts as never reported (unknown), so a node
 * that missed a peer's eviction stops being steered by its stale report.
 */
export const BILLABLE_SWITCH_REPORT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// The event record (section 6 item 3 of the plan, as data)

export const BILLABLE_SWITCH_EVENT_KINDS = [
  "start",
  "on",
  "off",
  "keep",
  "reverse",
  "header-on",
  "header-off",
] as const;
export type BillableSwitchEventKind =
  (typeof BILLABLE_SWITCH_EVENT_KINDS)[number];

/** The reasons a `start` event may carry, one per row of the truth table. */
export const BILLABLE_SWITCH_START_REASONS = [
  "explicit-header-and-session",
  "explicit-session-only",
  "explicit-not-billable",
  "inherit",
  "system",
  "header",
  // Row 8: a person switched this node's header off. The plan wrote this reason
  // as `header-off`, which is also the name of a kind; the plan's own rule says
  // no reason shares a name with a kind, so the reason carries this name.
  "header-switched-off",
  "cross-node",
  "cross-node-unasked",
  "default",
] as const;
export type BillableSwitchStartReason =
  (typeof BILLABLE_SWITCH_START_REASONS)[number];

/** Which reasons each kind may carry. The store and the service refuse any other pair. */
export const BILLABLE_SWITCH_REASONS_BY_KIND = {
  start: BILLABLE_SWITCH_START_REASONS,
  on: ["switch", "pick"],
  off: ["switch", "switch-off-and-delete", "never-bill"],
  keep: ["confirm", "confirm-all", "switch"],
  reverse: ["confirm-reverse", "switch", "switch-off-and-delete", "never-bill"],
  "header-on": ["switch", "create-choice"],
  "header-off": ["switch"],
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
});
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
});
export type BillableSwitchStartWire = z.infer<
  typeof BillableSwitchStartWireSchema
>;

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
};

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

/**
 * The node-blind key of a session's project: `repoIdentity.name` (owner/repo)
 * for a git-backed session, else `worktree.basePath`, else the raw path, else
 * "Other". The web groups the session list by it (`grouping.ts`) and the server
 * keys a project's header by it.
 */
export function projectBaseKey(metadata: ProjectKeyMetadata): string {
  return (
    metadata?.repoIdentity?.name ??
    metadata?.worktree?.basePath ??
    metadata?.path ??
    "Other"
  );
}

/** `repo` when the key came from a repository identity, else `path`. */
export function projectKeyKind(
  metadata: ProjectKeyMetadata
): BillableSwitchKeyKind {
  return metadata?.repoIdentity?.name ? "repo" : "path";
}

/**
 * The key two nodes compare for the same project: a `repo` key, lower-cased
 * (A3). A `path` key never matches across nodes (X1), even when two nodes share
 * the path.
 */
export function crossNodeMatchKey(
  key: string,
  kind: BillableSwitchKeyKind
): string | null {
  return kind === "repo" ? key.toLowerCase() : null;
}

// ---------------------------------------------------------------------------
// "Billable on another node"

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

export type BillableSwitchCauseNode = {
  nodeId: string;
  nodeLabel: string;
  reportedAt: number | null;
};

export type CrossNodeBillableState = "yes" | "no" | "unknown";

export type CrossNodeBillable = {
  state: CrossNodeBillableState;
  /** The nodes whose report has the project on (empty unless `state` is `yes`). */
  nodes: BillableSwitchCauseNode[];
};

/**
 * Is the project billable on a node other than `targetNodeId`?
 *
 * `views` holds one entry per node; the target is always excluded. With
 * `maxAgeMs`, another node's report older than that counts as never reported
 * (the local entry is always fresh). `yes`: some other node has a `repo` header
 * on with this match key in this namespace. `no`: every other node has a usable
 * report and none has it on. `unknown`: no other node, a null match key, or
 * nothing on while at least one other node has no usable report. The start
 * rule passes `maxAgeMs`; the Create dialog does not, and shows "last seen".
 */
export function crossNodeBillable(
  views: readonly BillableSwitchNodeView[],
  matchKey: string | null,
  namespace: string,
  targetNodeId: string,
  opts?: { now?: number; maxAgeMs?: number }
): CrossNodeBillable {
  if (matchKey === null) return { state: "unknown", nodes: [] };
  const others = views.filter(v => v.nodeId !== targetNodeId);
  if (others.length === 0) return { state: "unknown", nodes: [] };

  const now = opts?.now ?? Date.now();
  const usable = (v: BillableSwitchNodeView): boolean => {
    if (v.isLocal) return true;
    if (v.reportedAt === null) return false;
    if (opts?.maxAgeMs !== undefined && now - v.reportedAt > opts.maxAgeMs) {
      return false;
    }
    return true;
  };

  const nodes: BillableSwitchCauseNode[] = [];
  let anyUnusable = false;
  for (const view of others) {
    if (!usable(view)) {
      anyUnusable = true;
      continue;
    }
    const on = view.headers.some(
      h =>
        h.billable &&
        h.keyKind === "repo" &&
        h.namespace === namespace &&
        h.projectKey.toLowerCase() === matchKey
    );
    if (on) {
      nodes.push({
        nodeId: view.nodeId,
        nodeLabel: view.nodeLabel,
        reportedAt: view.reportedAt,
      });
    }
  }
  if (nodes.length > 0) return { state: "yes", nodes };
  if (anyUnusable) return { state: "unknown", nodes: [] };
  return { state: "no", nodes: [] };
}

// ---------------------------------------------------------------------------
// The start rule (the truth table of the plan's Task 1, first matching row wins)

export type BillableSwitchStartInput = {
  mode: BillableSwitchMode;
  context: Pick<BillableSwitchStartContext, "kind" | "choice">;
  /** The parent row's switch, for kind `inherit`; null when it was not found. */
  parent: { billable: boolean; confirm: BillableConfirm } | null;
  /**
   * This node's header for the project: `off` only when a row exists with
   * billable 0 (a person switched it off), `unset` when there is no row.
   */
  header: "on" | "off" | "unset";
  crossNode: CrossNodeBillable;
};

export type BillableSwitchStartResult = {
  billable: boolean;
  confirm: BillableConfirm;
  /** Null for row 1 (the gate is not `on`): no event is written. */
  reason: BillableSwitchStartReason | null;
  /** Row 2: the node's header for the project goes on in the same transaction. */
  headerOn?: true;
  /** Rows 9 and 10: the nodes whose report made the session start billable. */
  causeNodes?: BillableSwitchCauseNode[];
};

/**
 * The start value of a new session row. Rows, first match wins:
 *  1. gate not `on` → off, no event
 *  2-4. kind `person` with an answer → that answer
 *  5. kind `inherit`, parent found → the parent's switch and confirm state
 *  6. kind `system` (support, self-update, heartbeat) → off, whatever else (SYS-1)
 *  7. this node's header on → on
 *  8. this node's header off (a person switched it off) → off (HOFF-1)
 *  9. billable on another node, kind `agent` or `schedule` → on, waiting (AG-1)
 *  10. billable on another node, any other kind that reaches here → on, waiting (CLI-1)
 *  11. otherwise → off
 * A choice counts only for kind `person`; `follow-header` is no answer.
 * `unknown` never starts a session billable.
 */
export function resolveBillableSwitchStart(
  input: BillableSwitchStartInput
): BillableSwitchStartResult {
  const { mode, context, parent, header, crossNode } = input;
  if (mode !== "on") return { billable: false, confirm: null, reason: null };

  if (context.kind === "person") {
    switch (context.choice) {
      case "header-and-session":
        return {
          billable: true,
          confirm: null,
          reason: "explicit-header-and-session",
          headerOn: true,
        };
      case "session-only":
        return {
          billable: true,
          confirm: null,
          reason: "explicit-session-only",
        };
      case "not-billable":
        return {
          billable: false,
          confirm: null,
          reason: "explicit-not-billable",
        };
      default:
        break; // no answer, or `follow-header`: on to row 7
    }
  }

  if (context.kind === "inherit" && parent) {
    return {
      billable: parent.billable,
      confirm: parent.billable ? parent.confirm : null,
      reason: "inherit",
    };
  }

  if (context.kind === "system") {
    return { billable: false, confirm: null, reason: "system" };
  }

  if (header === "on")
    return { billable: true, confirm: null, reason: "header" };
  if (header === "off") {
    return { billable: false, confirm: null, reason: "header-switched-off" };
  }

  if (crossNode.state === "yes") {
    const asked = context.kind === "agent" || context.kind === "schedule";
    return {
      billable: true,
      confirm: "pending",
      reason: asked ? "cross-node" : "cross-node-unasked",
      causeNodes: crossNode.nodes,
    };
  }

  return { billable: false, confirm: null, reason: "default" };
}

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
