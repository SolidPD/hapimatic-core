// SPDX-License-Identifier: AGPL-3.0-only
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import {
  BILLING_CATEGORIES_UNAVAILABLE_REASONS,
  BillableConfirmSchema,
  BillableSwitchActorSchema,
  BillableSwitchViaSchema,
  TrackingBillingStatusSchema,
  TrackingCategorySchema,
  TrackingCategoryUnavailableError,
  TrackingSettingsInputSchema,
  TrackingStatusOnlyInputSchema,
  defineCapability,
  keepsTrackingCategory,
  projectSwitch,
  recordFromStartValues,
  redactTrackingEventForAgent,
  redactTrackingForAgent,
  timeBillingStatus,
  trackingProjectOf,
  unloggedAmount,
  validateTrackingSettings,
  type BillableSwitchActor,
  type BillableSwitchEvent,
  type BillableSwitchEventKind,
  type BillableSwitchMode,
  type BillableSwitchVia,
  type BillingCategoriesUnavailableReason,
  type ProjectKeyMetadata,
  type TrackingCategory,
  type TrackingCategoryLookup,
  type TrackingCategoryRef,
  type TrackingOrigin,
  type TrackingRecord,
  type TrackingRecordDraft,
  type TrackingStartValues,
} from "@hapi/protocol";

import { BillableSwitchService } from "../../billableSwitch/billableSwitchService";
import {
  isTrackingReconcilePending,
  retryTrackingReconcileFor,
} from "../../billableSwitch/trackingStartup";
import { cataloged } from "../../capabilities/cataloged";
import type { BillableSwitchNodeRegistryView } from "../../federation/nodeRegistry";
import type { SessionService } from "../../services/sessionService";
import type { Store } from "../../store";
import { TrackingDomainError } from "../../store/billableTrackingStore";
import type { StoredSession } from "../../store/types";
import type { SyncEngine } from "../../sync/syncEngine";
import type { WebAppEnv } from "../middleware/auth";
import { billableSwitchGate } from "../middleware/billableSwitchGate";
import {
  billableSwitchActor,
  billableSwitchVia,
  isAgentRequest,
  refuseAgentBillableWrite,
  SYNC_UNAVAILABLE_MESSAGE,
} from "./agentEscalation";
import {
  BillableSwitchHistoryResponseSchema,
  closedRefusal,
  describeIssue,
  proxyBillableSwitchRequest,
  reconcilePendingRefusal,
} from "./billableSwitch";
import {
  mirrorRead,
  placeTrackingSession,
  proxiedTrackingResponse,
  remoteReachability,
  sessionNotFound,
  summaryRead,
  TokenSchema,
  TrackingRecordAnswerSchema,
  trackingUnsupported,
  type TrackingRegistry,
} from "./billableTrackingRemote";

export { trackingUnsupported } from "./billableTrackingRemote";

/**
 * A session's time-tracking record, its hub routes (issue #6778 PR-C, Task 13;
 * the plan's section 7): `GET` and `PUT /api/sessions/:id/tracking` and
 * `GET /api/sessions/:id/tracking/history`. Written by hand on the pattern of
 * `billableSwitch.ts`, behind the same gate (`billableSwitchGate`): off answers
 * the bare 404 and drops the three from the served catalog.
 *
 * The record of a session on this node is read and written here, through the
 * one writer (`writeTrackingState`). A session on another node is never read
 * from this node's store or written here: it goes to its owning node through the
 * session proxy when that node advertises `billable:tracking-carry`; any other
 * node's session is read from the hub's cached summary (`source: "summary"`,
 * 3.3 item 6), and a write to it answers 409 `tracking_unsupported`. A remote
 * session the hub no longer lists is read from the hub's copy of its node's
 * rows (`source: "mirror"`, never writable) only when that node is online and
 * its list is newer than the copy (ruling Q4). The peer-incoming half is
 * `federation/billableTrackingReceivers.ts` (Task 14), which runs the same
 * local write (`writeLocalTracking`) as this node's own route.
 * Where a session lives, the proxy's answer mapping and the summary and
 * copy reads are `billableTrackingRemote.ts`'s.
 *
 * The agent rule (7.2, C7 = a): an agent's request is refused every write but
 * the status-only form to Non-billable, before the token and before any
 * validation, and every answer an agent receives that carries a record or a
 * snapshot leaves out the rate, the default rate and the note. A rate or a note
 * never reaches an error body or a log line, and the category's name and default
 * are never taken from a request (R3).
 */

// ─── wire schemas ──────────────────────────────────────────────────────────

/** `{ token, tracked: false }`: tracking off (7.3). */
export const TrackingOffBodySchema = z
  .object({ token: TokenSchema, tracked: z.literal(false) })
  .strict();

/**
 * A person's full settings (7.3). `includeEarlier` answers R8's question when
 * the write turns tracking on; `origin` is a claim, honoured only for a person
 * (7.4).
 */
export const TrackingSettingsBodySchema = z
  .object({
    token: TokenSchema,
    tracked: z.literal(true),
    settings: TrackingSettingsInputSchema,
    includeEarlier: z.boolean().optional(),
    origin: z.literal("session-controls").optional(),
  })
  .strict();

/** `PUT /api/sessions/:id/tracking` from a client: one of the three forms of 7.1. */
export const TrackingPutBodySchema = z.union([
  TrackingOffBodySchema,
  TrackingStatusOnlyInputSchema,
  TrackingSettingsBodySchema,
]);
export type TrackingPutBody = z.infer<typeof TrackingPutBodySchema>;

/** Where a read came from (3.3 item 5). */
export const TRACKING_READ_SOURCES = [
  "local",
  "deleted",
  "origin",
  "mirror",
  "summary",
] as const;

/**
 * The read (7.1). `tracked` is null only for a summary that cannot say (the
 * owning node reports no switch). `earlierMs` (rulings PRC-R1, PRC-R7) is R8's
 * untracked earlier time, present for every live session of this node, with a
 * record or without one (a session never tracked: its whole timer). The old
 * switch dialog shows it for a session with no record, the time the old
 * switch-on covers; a deleted session carries no field.
 */
export const TrackingReadResponseSchema = z.object({
  sessionId: z.string(),
  tracked: z.boolean().nullable(),
  record: TrackingRecordAnswerSchema.nullable(),
  confirm: BillableConfirmSchema,
  timeStatus: TrackingBillingStatusSchema.nullable(),
  token: TokenSchema,
  source: z.enum(TRACKING_READ_SOURCES),
  nodeId: z.string().nullable(),
  reconcilePending: z.boolean(),
  earlierMs: z.number().nonnegative().optional(),
});
export type TrackingReadResponse = z.infer<typeof TrackingReadResponseSchema>;

/** The answer of a write (7.1). */
export const TrackingPutResponseSchema = z.object({
  ok: z.literal(true),
  changed: z.boolean(),
  record: TrackingRecordAnswerSchema.nullable(),
  token: TokenSchema,
});
export type TrackingPutResponse = z.infer<typeof TrackingPutResponseSchema>;

/**
 * One history row: #6646's fields (section 6 item 4: no user agent, project key,
 * label or path), every kind, and the four fields of 3.2. A snapshot is read
 * loosely, so a newer node's record never fails the page.
 */
const TrackingHistoryEventSchema =
  BillableSwitchHistoryResponseSchema.shape.events.element.extend({
    settingsBefore: z.record(z.string(), z.unknown()).nullable(),
    settingsAfter: z.record(z.string(), z.unknown()).nullable(),
    origin: z.string().nullable(),
    trackFrom: z.number().nullable(),
  });

export const TrackingHistoryResponseSchema = z.object({
  sessionId: z.string(),
  source: z.enum(["local", "deleted", "origin", "mirror"]),
  originNodeId: z.string().nullable(),
  mirrorSyncedAt: z.number().nullable(),
  events: z.array(TrackingHistoryEventSchema),
});
export type TrackingHistoryResponse = z.infer<
  typeof TrackingHistoryResponseSchema
>;

/**
 * The hub → owning node body of a write (7.1). The hub is the entry node: it
 * sets the actor, the channel, the entry node and the origin, and for a settings
 * body it sends its own lookup's answer (ruling 12; #6779 N2): the category
 * (null when the list does not know it), or why the list could not be read. The
 * owning node alone decides whether the category is kept or changed.
 */
export const FederationTrackingPutBodySchema = z
  .object({
    request: TrackingPutBodySchema,
    actor: BillableSwitchActorSchema.strict(),
    via: BillableSwitchViaSchema,
    entryNodeId: z.string().min(1).max(200).nullable(),
    origin: z.enum(["session-controls", "api"]),
    resolvedCategory: TrackingCategorySchema.nullable().optional(),
    categoryUnavailable: z
      .object({
        reason: z.enum(BILLING_CATEGORIES_UNAVAILABLE_REASONS).nullable(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type FederationTrackingPutBody = z.infer<
  typeof FederationTrackingPutBodySchema
>;

// ─── refusals ──────────────────────────────────────────────────────────────

/** 409 `categories_unavailable` (7.3): no category list, or a list that could not be read. */
export function categoriesUnavailable(
  c: Context,
  reason: BillingCategoriesUnavailableReason | null
): Response {
  return c.json(
    {
      error:
        "The billing categories cannot be read right now, so a category cannot be set or changed. Try again later.",
      code: "categories_unavailable",
      ...(reason ? { reason } : {}),
    },
    409
  );
}

/** 400 `invalid_field` (7.3): the field and the rule, never the value. */
export function invalidField(
  c: Context,
  field: string,
  reason: string
): Response {
  return c.json(
    {
      error: `The tracking settings were refused: ${field} (${reason}).`,
      code: "invalid_field",
      field,
      reason,
    },
    400
  );
}

/** The words a person sees for tracking off on a waiting copy (7.3, ruling X2). */
export const CONFIRM_PENDING_MESSAGE =
  "This session is waiting under To confirm. Keep or Reverse it there before you turn tracking off.";

function trackingRefusal(
  c: Context,
  status: ContentfulStatusCode,
  code: string,
  error: string,
  extra: Record<string, unknown> = {}
): Response {
  return c.json({ error, code, ...extra }, status);
}

/**
 * The agent rule (7.2), checked before the token and before any validation, so
 * no answer tells an agent a rate. An agent may send only the status-only form
 * with `billingStatus` Non-billable; Billable answers `agent_cannot_switch_on`,
 * and every other body (a rate, a category, a currency, a note, sync,
 * `includeEarlier`, Pending, a full settings body, tracking off, or one that
 * does not parse) answers 403 `agent_billable_refused`. A request whose named
 * session does not resolve is refused first, as on every billable write.
 */
function refuseAgentTrackingWrite(
  c: Context<WebAppEnv>,
  engine: SyncEngine,
  raw: unknown
): Response | null {
  if (!isAgentRequest(c)) return null;
  const statusOnly = TrackingStatusOnlyInputSchema.safeParse(raw);
  const refused = refuseAgentBillableWrite(
    c,
    engine,
    statusOnly.success && statusOnly.data.billingStatus === "billable"
      ? "on"
      : "off"
  );
  if (refused) return refused;
  if (statusOnly.success && statusOnly.data.billingStatus === "non-billable") {
    return null;
  }
  return c.json(
    {
      ok: false,
      error:
        "An agent may only set a tracked session to Non-billable. Change its tracking in the app.",
      code: "agent_billable_refused",
    },
    403
  );
}

// ─── shared parts ──────────────────────────────────────────────────────────

export type BillableTrackingRoutesOptions = {
  billableSwitchMode: BillableSwitchMode;
  /** This node's store: the record, the history and the session rows. */
  store: Store;
  getSessionService: () => Pick<SessionService, "proxyPinRequest"> | null;
  getNodeRegistry: () => Partial<TrackingRegistry> | null;
  /** #6779's lookup for a namespace (ruling P-8); null: this node has no category service. */
  getTrackingCategoryLookup?: (
    namespace: string
  ) => TrackingCategoryLookup | null;
};

export type Ready = { engine: SyncEngine; service: BillableSwitchService };

function requireTracking(
  c: Context<WebAppEnv>,
  getSyncEngine: () => SyncEngine | null
): Ready | Response {
  const engine = getSyncEngine();
  const service = engine?.getBillableSwitchService?.() ?? null;
  if (!engine || !service) {
    return c.json({ error: "Not connected" }, 503);
  }
  return { engine, service };
}

/** The record an agent's request may see (C7 = a). */
function recordFor<T extends Record<string, unknown> | null>(
  agent: boolean,
  record: T
): T {
  if (record === null || !agent) return record;
  return redactTrackingForAgent(record) as T;
}

/** The session timer now, from the cache when the session is there (no refresh). */
function timerNowFor(
  ready: Ready,
  live: StoredSession,
  namespace: string,
  now: number
): number {
  const cached = ready.engine.getSessionByNamespace(live.id, namespace);
  return cached
    ? ready.service.timerMsFor(cached, now)
    : live.serverAccumulatedMs;
}

/** A local session's read (7.1): live (`local`) or gone with its record kept (`deleted`). */
export function localRead(
  ready: Ready,
  store: Store,
  live: StoredSession | null,
  sessionId: string,
  namespace: string
): TrackingReadResponse {
  const record =
    store.billableTracking.get(sessionId, namespace)?.record ?? null;
  const answer: TrackingReadResponse = {
    sessionId,
    tracked: record !== null,
    record,
    confirm: record?.confirm ?? null,
    timeStatus: timeBillingStatus(record),
    token: store.billableTracking.token(sessionId, namespace),
    source: live ? "local" : "deleted",
    nodeId: ready.service.localNodeId(),
    reconcilePending: isTrackingReconcilePending(sessionId),
  };
  if (live) {
    answer.earlierMs = ready.service.earlierMsFor(sessionId, namespace, {
      timerNowMs: timerNowFor(ready, live, namespace, Date.now()),
      startedAt: live.createdAt,
    });
  }
  return answer;
}

/** A local session's history (7.1), every kind, by event id, never by `at` alone (3.5; review S10). */
export function localHistory(
  ready: Ready,
  store: Store,
  live: StoredSession | null,
  sessionId: string,
  namespace: string
): TrackingHistoryResponse {
  return {
    sessionId,
    source: live ? "local" : "deleted",
    originNodeId: ready.service.localNodeId(),
    mirrorSyncedAt: null,
    events: store.billableSwitch
      .listEvents(sessionId, namespace)
      .sort((a, b) => a.id - b.id)
      .map(historyItem),
  };
}

/** One history row as the tracking history answers it (7.1). */
function historyItem(e: BillableSwitchEvent) {
  return {
    ...BillableSwitchService.toHistoryEvent(e),
    settingsBefore: (e.settingsBefore ?? null) as Record<
      string,
      unknown
    > | null,
    settingsAfter: (e.settingsAfter ?? null) as Record<string, unknown> | null,
    origin: e.origin ?? null,
    trackFrom: e.trackFrom ?? null,
  };
}

/** The values of a record that a full settings write replaces (7.3). */
function settingsFields(v: TrackingStartValues) {
  return {
    billingStatus: v.billingStatus,
    categorySource: v.categorySource,
    categoryId: v.categoryId,
    categoryName: v.categoryName,
    defaultRateMinor: v.defaultRateMinor,
    defaultCurrency: v.defaultCurrency,
    rateMinor: v.rateMinor,
    currency: v.currency,
    rateNote: v.rateNote,
    sync: v.sync,
  };
}

/** A stored record as a draft (the writer stamps the times). */
function draftOf(record: TrackingRecord): TrackingRecordDraft {
  const { createdAt: _c, updatedAt: _u, ...draft } = record;
  return draft;
}

/** The form of a write body. */
type WriteForm = "off" | "status" | "settings";

function formOf(body: TrackingPutBody): WriteForm {
  if (!body.tracked) return "off";
  return "settings" in body ? "settings" : "status";
}

/** Whether a write only lowers billing, which `closed` allows (7.2). */
export function lowersBilling(body: TrackingPutBody): boolean {
  if (!body.tracked) return true;
  return !("settings" in body) && body.billingStatus === "non-billable";
}

/** The reason of the row a write appends, for the kind the writer chose (3.2). */
function reasonFor(
  form: WriteForm,
  kind: BillableSwitchEventKind,
  prior: TrackingRecord | null
): string {
  switch (kind) {
    case "on":
      return prior === null ? "tracking-on" : "status-change";
    case "off":
      return form === "off" ? "tracking-off" : "status-change";
    // A waiting Billable copy lowered by a status or settings write: the
    // projection reads it as #6646's reverse; the record still waits.
    case "reverse":
    case "keep":
      return "switch";
    default:
      return "settings";
  }
}

/** A category's answer: resolved (null: the list does not know it), or why the list could not be read. */
export type CategoryAnswer =
  | { ok: true; category: TrackingCategory | null }
  | { ok: false; reason: BillingCategoriesUnavailableReason | null };

/** The lookup's answer for a category the write sets or changes (7.3). */
export async function lookUpCategory(
  getLookup: BillableTrackingRoutesOptions["getTrackingCategoryLookup"],
  namespace: string,
  ref: TrackingCategoryRef
): Promise<CategoryAnswer> {
  const lookup = getLookup?.(namespace) ?? null;
  if (!lookup) return { ok: false, reason: null };
  try {
    return { ok: true, category: await lookup.get(ref) };
  } catch (err) {
    if (err instanceof TrackingCategoryUnavailableError) {
      return { ok: false, reason: err.reason };
    }
    console.error(
      `[BillableTracking] the category lookup failed: ${err instanceof Error ? err.name : "unknown error"}`
    );
    return { ok: false, reason: null };
  }
}

/** A write to a session of this node: the hub's own route and the peer receiver. */
export type LocalTrackingWrite = {
  live: StoredSession;
  sessionId: string;
  namespace: string;
  body: TrackingPutBody;
  actor: BillableSwitchActor;
  via: BillableSwitchVia;
  /** The node the person's request reached (this node, or the forwarding hub). */
  entryNodeId: string | null;
  origin: "session-controls" | "api";
  /** The category answer for a set or changed category: this node's lookup, or the entry node's (ruling 12). */
  resolveCategory: (ref: TrackingCategoryRef) => Promise<CategoryAnswer>;
  /** Whether the answer's record leaves out the money fields (C7 = a). */
  agent: boolean;
};

/**
 * The write itself, after the agent rule, the body's parse and the gate (7.2,
 * 7.3): the reconcile retry, ruling X2, the status-only rule, the category
 * (kept: no lookup), the validator, R8's earlier time, then the one writer
 * with the token compared inside it. Called by `PUT /sessions/:id/tracking` for
 * a session of this node and by the owning node's receiver (Task 14), so the
 * two answer every refusal alike.
 */
export async function writeLocalTracking(
  c: Context,
  ready: Ready,
  store: Store,
  w: LocalTrackingWrite
): Promise<Response> {
  const { live, sessionId, namespace, body, actor, via, origin, agent } = w;
  const form = formOf(body);
  // 3.4 step 6: a session the start-up reconcile could not settle is
  // retried before the write, and refused while it stays unsettled.
  if (!retryTrackingReconcileFor(store, sessionId)) {
    return reconcilePendingRefusal(c);
  }
  const prior =
    store.billableTracking.get(sessionId, namespace)?.record ?? null;

  // Ruling X2: tracking off on a waiting copy decides nothing by accident.
  // After the agent rule, before the token, so a stale form gets the reason.
  if (form === "off" && prior?.confirm === "pending") {
    return trackingRefusal(c, 409, "confirm_pending", CONFIRM_PENDING_MESSAGE);
  }
  if (form === "status" && prior === null) {
    return trackingRefusal(
      c,
      409,
      "not_tracked",
      "This session is not tracked: turn tracking on with its settings first."
    );
  }

  const now = Date.now();
  const timerMs = timerNowFor(ready, live, namespace, now);
  let values: TrackingStartValues | null = null;
  let trackFrom = now;
  if ("settings" in body) {
    const input = body.settings;
    const kept = keepsTrackingCategory(input.category, prior);
    let category: TrackingCategory | null | undefined;
    // Ruling 12: no lookup when the write keeps the record's category.
    if (!kept) {
      const looked = await w.resolveCategory(input.category);
      if (!looked.ok) return categoriesUnavailable(c, looked.reason);
      category = looked.category;
    }
    const checked = validateTrackingSettings(input, category, prior);
    if (!checked.ok) {
      if (checked.reason === "sync_unavailable") {
        return trackingRefusal(
          c,
          409,
          "sync_unavailable",
          SYNC_UNAVAILABLE_MESSAGE
        );
      }
      return invalidField(c, checked.field, checked.reason);
    }
    values = checked.values;
    if (prior === null) {
      // R8: turning tracking on asks about the untracked earlier time.
      const earlierMs = ready.service.earlierMsFor(sessionId, namespace, {
        timerNowMs: timerMs,
        startedAt: live.createdAt,
      });
      if (earlierMs > 0 && body.includeEarlier === undefined) {
        return trackingRefusal(
          c,
          409,
          "early_choice_required",
          "This session has untracked earlier time: say whether to include it.",
          { earlierMs, basis: "timer" }
        );
      }
      // From the session's start: the timeline clamps it to the untracked
      // stretch before this write, never over tracked time (3.5).
      if (body.includeEarlier) trackFrom = live.createdAt;
    }
  }

  const meta = live.metadata as ProjectKeyMetadata;
  const project = trackingProjectOf(meta);
  const amount = unloggedAmount({
    timerMs,
    loggedMs: ready.service.loggedMsFor(sessionId),
  });
  const next = (p: TrackingRecord | null): TrackingRecordDraft | null => {
    if (!body.tracked) return null;
    if (!("settings" in body)) {
      return p ? { ...draftOf(p), billingStatus: body.billingStatus } : null;
    }
    const v = values as TrackingStartValues;
    if (p) return { ...draftOf(p), ...settingsFields(v), complete: true };
    return recordFromStartValues({
      values: v,
      project,
      confirm: null,
      createdVia: origin satisfies TrackingOrigin,
      trackFrom,
    });
  };
  let result;
  try {
    result = store.billableTracking.write({
      namespace,
      sessionId,
      token: body.token,
      origin,
      next,
      reasonFor: (kind, p) => reasonFor(form, kind, p),
      event: {
        projectKey: meta ? project.key : null,
        keyKind: meta ? project.kind : null,
        actorKind: actor.kind,
        actorSessionId: actor.sessionId ?? null,
        actorUserAgent: actor.userAgent ?? null,
        via,
        entryNodeId: w.entryNodeId,
        timerMs,
        unloggedMs: amount.ms,
        loggedKnown: amount.loggedKnown,
        label: null,
        at: now,
      },
      now,
    });
  } catch (err) {
    if (err instanceof TrackingDomainError) {
      return invalidField(c, err.field, "outside_domain");
    }
    throw err;
  }
  if (!result.ok) {
    // #6779 point 5: the new token only; no record travels in an error body.
    return trackingRefusal(
      c,
      409,
      "stale_token",
      "The session's tracking changed since it was read. Read it again.",
      { token: result.code === "stale_token" ? result.token : 0 }
    );
  }
  if (result.projectionChanged) {
    ready.engine.refreshBillableSwitchSession(sessionId);
  }
  return c.json({
    ok: true,
    changed: result.changed,
    record: recordFor(agent, result.record),
    token: result.token,
  });
}

// ─── the routes ────────────────────────────────────────────────────────────

export function createBillableTrackingRoutes(
  getSyncEngine: () => SyncEngine | null,
  options: BillableTrackingRoutesOptions
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  const gate = billableSwitchGate(options.billableSwitchMode);
  const closed = options.billableSwitchMode === "closed";
  const store = options.store;

  // ─── GET /sessions/:id/tracking ──────────────────────────────────
  app.get(
    "/sessions/:id/tracking",
    cataloged(
      defineCapability({
        id: "session-lifecycle.tracking",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Read a session's time-tracking record: whether it is tracked, its billing status, category and rate, and whether it waits for a person's confirmation.",
        whenToUse:
          "When showing or editing how a session's time is billed, on whichever node owns it, including after the session was deleted.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/sessions/:id/tracking",
        },
        auth: "jwt",
        // Mutating at birth (7.1, review A6): a readonly route is open to every
        // agent through hapi_call, and the record holds rates.
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    gate,
    async c => {
      const ready = requireTracking(c, getSyncEngine);
      if (ready instanceof Response) return ready;
      const sessionId = c.req.param("id");
      const namespace = c.get("namespace");
      const agent = isAgentRequest(c);
      const registry = options.getNodeRegistry();
      const place = placeTrackingSession(c, store, registry, sessionId);
      if (place.kind === "response") return place.response;

      if (place.kind === "local") {
        const answer = localRead(
          ready,
          store,
          place.live,
          sessionId,
          namespace
        );
        return c.json({ ...answer, record: recordFor(agent, answer.record) });
      }
      if (place.kind === "mirror") {
        const answer = mirrorRead(sessionId, place);
        return c.json({ ...answer, record: recordFor(agent, answer.record) });
      }

      const unreachable = remoteReachability(c, place.view);
      if (unreachable) return unreachable;
      const view = place.view as BillableSwitchNodeRegistryView;
      if (!place.carries || (!view.on && !view.closed)) {
        return c.json(summaryRead(sessionId, place.nodeId, place.summary));
      }
      const sessionService = options.getSessionService();
      if (!sessionService) {
        return c.json({ error: "Session service not available" }, 503);
      }
      const result = await proxyBillableSwitchRequest(
        sessionService,
        sessionId,
        "/tracking",
        "GET",
        namespace
      );
      return proxiedTrackingResponse(
        c,
        result,
        TrackingReadResponseSchema,
        view.nodeLabel,
        data => ({
          ...data,
          // A proxied read forwards no actor: the hub redacts (7.1).
          record: recordFor(agent, data.record),
          source: data.source === "local" ? "origin" : data.source,
          nodeId: data.nodeId ?? place.nodeId,
        })
      );
    }
  );

  // ─── PUT /sessions/:id/tracking ──────────────────────────────────
  app.put(
    "/sessions/:id/tracking",
    cataloged(
      defineCapability({
        id: "session-lifecycle.tracking-set",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Turn a session's time tracking on or off, or change its billing status, category, rate and note, on whichever node owns it; the change is recorded with who made it.",
        whenToUse:
          "When a person sets or changes how a session's time is billed. An agent may only set a tracked session to Non-billable.",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/api/sessions/:id/tracking",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    gate,
    async c => {
      const ready = requireTracking(c, getSyncEngine);
      if (ready instanceof Response) return ready;
      // `undefined`, never `null`, for an unparseable body, so no schema reads it as empty.
      const raw: unknown = await c.req.json().catch(() => undefined);
      const sessionId = c.req.param("id");
      const namespace = c.get("namespace");
      const agent = isAgentRequest(c);
      const registry = options.getNodeRegistry();
      const place = placeTrackingSession(c, store, registry, sessionId);
      if (place.kind === "response") return place.response;
      const agentRefused = refuseAgentTrackingWrite(c, ready.engine, raw);
      if (agentRefused) return agentRefused;
      // The hub's copy of a deleted remote session is read-only (Q4, R11).
      if (place.kind === "mirror") return sessionNotFound(c);

      if (
        raw !== null &&
        typeof raw === "object" &&
        (raw as { tracked?: unknown }).tracked === false &&
        Object.keys(raw).some(k => k !== "token" && k !== "tracked")
      ) {
        return trackingRefusal(
          c,
          400,
          "settings_with_tracking_off",
          "Tracking off takes no settings: send only the token."
        );
      }
      const parsed = TrackingPutBodySchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: describeIssue(parsed.error) }, 400);
      }
      const body = parsed.data;
      if (closed && !lowersBilling(body)) {
        return closedRefusal(c, ready.service.localNodeLabel());
      }
      const actor = billableSwitchActor(c, ready.engine);
      const via = billableSwitchVia(c);
      const origin: "session-controls" | "api" =
        !agent && "origin" in body && body.origin === "session-controls"
          ? "session-controls"
          : "api";

      if (place.kind === "remote") {
        const unreachable = remoteReachability(c, place.view);
        if (unreachable) return unreachable;
        const view = place.view as BillableSwitchNodeRegistryView;
        if (!place.carries) return trackingUnsupported(c, view.nodeLabel);
        if (lowersBilling(body) ? !view.on && !view.closed : !view.on) {
          return view.closed
            ? closedRefusal(c, view.nodeLabel)
            : trackingUnsupported(c, view.nodeLabel);
        }
        const sessionService = options.getSessionService();
        if (!sessionService) {
          return c.json({ error: "Session service not available" }, 503);
        }
        let resolution: Pick<
          FederationTrackingPutBody,
          "resolvedCategory" | "categoryUnavailable"
        > = {};
        if ("settings" in body) {
          // The hub is the entry node (ruling 12): it resolves the category and
          // sends the answer; the owning node decides kept or changed.
          const looked = await lookUpCategory(
            options.getTrackingCategoryLookup,
            namespace,
            body.settings.category
          );
          resolution = looked.ok
            ? { resolvedCategory: looked.category }
            : { categoryUnavailable: { reason: looked.reason } };
        }
        const result = await proxyBillableSwitchRequest(
          sessionService,
          sessionId,
          "/tracking",
          "PUT",
          namespace,
          {
            request: body,
            actor,
            via,
            entryNodeId: ready.service.localNodeId(),
            origin,
            ...resolution,
          } satisfies FederationTrackingPutBody
        );
        return proxiedTrackingResponse(
          c,
          result,
          TrackingPutResponseSchema,
          view.nodeLabel,
          data => {
            if (data.changed) {
              const p = projectSwitch(data.record);
              registry?.updateCachedSessionBillable?.(
                sessionId,
                p.billable,
                p.billableConfirm
              );
            }
            return { ...data, record: recordFor(agent, data.record) };
          }
        );
      }

      // A deleted session's kept record is read-only (R11).
      if (!place.live) return sessionNotFound(c);
      return writeLocalTracking(c, ready, store, {
        live: place.live,
        sessionId,
        namespace,
        body,
        actor,
        via,
        entryNodeId: ready.service.localNodeId(),
        origin,
        resolveCategory: ref =>
          lookUpCategory(options.getTrackingCategoryLookup, namespace, ref),
        agent,
      });
    }
  );

  // ─── GET /sessions/:id/tracking/history ──────────────────────────
  app.get(
    "/sessions/:id/tracking/history",
    cataloged(
      defineCapability({
        id: "session-lifecycle.tracking-history",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Read every change to a session's time-tracking record, oldest first, each with the record before and after and who made it.",
        whenToUse:
          "When showing or checking how a session's billing changed over time, for a bill or an audit, including after the session was deleted.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/sessions/:id/tracking/history",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    gate,
    async c => {
      const ready = requireTracking(c, getSyncEngine);
      if (ready instanceof Response) return ready;
      const sessionId = c.req.param("id");
      const namespace = c.get("namespace");
      const agent = isAgentRequest(c);
      const redact = <T extends Record<string, unknown>>(e: T): T =>
        agent ? redactTrackingEventForAgent(e) : e;
      const registry = options.getNodeRegistry();
      const place = placeTrackingSession(c, store, registry, sessionId);
      if (place.kind === "response") return place.response;

      if (place.kind === "local") {
        const answer = localHistory(
          ready,
          store,
          place.live,
          sessionId,
          namespace
        );
        return c.json({ ...answer, events: answer.events.map(e => redact(e)) });
      }
      if (place.kind === "mirror") {
        return c.json({
          sessionId,
          source: "mirror",
          originNodeId: place.originNodeId,
          mirrorSyncedAt:
            store.billableSwitch.getMirrorCursor(place.originNodeId)
              ?.lastSyncAt ?? null,
          events: place.rows.map(e => redact(historyItem(e))),
        } satisfies TrackingHistoryResponse);
      }

      const unreachable = remoteReachability(c, place.view);
      if (unreachable) return unreachable;
      const view = place.view as BillableSwitchNodeRegistryView;
      if (!place.carries || (!view.on && !view.closed)) {
        return trackingUnsupported(c, view.nodeLabel);
      }
      const sessionService = options.getSessionService();
      if (!sessionService) {
        return c.json({ error: "Session service not available" }, 503);
      }
      const result = await proxyBillableSwitchRequest(
        sessionService,
        sessionId,
        "/tracking/history",
        "GET",
        namespace
      );
      return proxiedTrackingResponse(
        c,
        result,
        TrackingHistoryResponseSchema,
        view.nodeLabel,
        data => ({
          ...data,
          source: data.source === "local" ? "origin" : data.source,
          originNodeId: place.nodeId,
          mirrorSyncedAt: null,
          events: data.events.map(e => redact(e)),
        })
      );
    }
  );

  return app;
}
