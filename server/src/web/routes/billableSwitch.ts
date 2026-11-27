// SPDX-License-Identifier: AGPL-3.0-only
import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import {
  BILLABLE_SWITCH_EVENT_KINDS,
  BILLABLE_SWITCH_LEGACY_EVENT_KINDS,
  BILLABLE_TRACKING_CARRY_CAPABILITY,
  BillableConfirmSchema,
  BillableSwitchActorSchema,
  BillableSwitchViaSchema,
  defineCapability,
  redactTrackingEventForAgent,
  TrackingBillingStatusSchema,
  type BillableSwitchActor,
  type BillableSwitchEvent,
  type BillableSwitchMode,
} from "@hapi/protocol";

import { BillableSwitchService } from "../../billableSwitch/billableSwitchService";
import { cataloged, markClosedGate } from "../../capabilities/cataloged";
import type {
  BillableSwitchNodeRegistryView,
  NodeRegistry,
} from "../../federation/nodeRegistry";
import type { SessionService } from "../../services/sessionService";
import type { SyncEngine } from "../../sync/syncEngine";
import type { WebAppEnv } from "../middleware/auth";
import { billableSwitchGate } from "../middleware/billableSwitchGate";
import {
  billableSwitchActor,
  billableSwitchVia,
  isAgentRequest,
  refuseAgentBillableWrite,
} from "./agentEscalation";
import {
  dedupeIds,
  resolveTarget,
  settleWithin,
  BULK_SESSION_DEADLINE_MS,
} from "./bulkSessionActions";
import type { ProxyResult } from "./sessionMutationHandlers";

/**
 * The billable switch's hub routes (issue #6646, Task 7): switch, confirm, the
 * history, the headers read (the header write is closed for good, #6778 PR-A)
 * and the event list, plus the Keep all fan-out that `sessions.ts` mounts
 * beside the other bulk routes. Written by hand
 * on the Pins pattern (`pinRouteHelpers.ts`), never through the generic field
 * descriptor, because that path drops the peer's reply, relays a peer's 401 to
 * the browser, and its one schema would let a client body carry an actor.
 *
 * The hub sets the actor, the channel and the entry node from the request; a
 * client body that names them fails the strict schema. The peer-incoming half
 * is `federation/billableSwitchReceivers.ts`; the wire schemas of the hop are
 * here, so both ends parse one definition.
 */

// ─── wire schemas ──────────────────────────────────────────────────────────

const WriteReasonSchema = z.enum([
  "switch",
  "switch-off-and-delete",
  "never-bill",
]);
const SessionIdSchema = z.string().min(1).max(200);
const LoggedMsSchema = z.number().int().nonnegative().nullable();
const EntryNodeIdSchema = z.string().min(1).max(200).nullable();

/** `PUT /api/sessions/:id/billable` from a client: no actor, no channel. */
export const BillableSwitchSetRequestSchema = z
  .object({ billable: z.boolean(), reason: WriteReasonSchema.optional() })
  .strict();

/** `POST /api/sessions/:id/billable/confirm` from a client. */
export const BillableSwitchConfirmRequestSchema = z
  .object({ decision: z.enum(["keep", "reverse"]) })
  .strict();

/** `POST /api/sessions/bulk-billable-keep`. */
export const BillableSwitchKeepAllRequestSchema = z
  .object({ ids: z.array(SessionIdSchema).min(1).max(200) })
  .strict();

/** What the hub claims on every forwarded write (one shared mesh token). */
const ForwardedActorFields = {
  actor: BillableSwitchActorSchema.strict(),
  via: BillableSwitchViaSchema,
  entryNodeId: EntryNodeIdSchema,
  loggedMs: LoggedMsSchema,
};

/** The hub → owning node body of a switch. */
export const FederationBillableSetBodySchema = z
  .object({
    billable: z.boolean(),
    reason: WriteReasonSchema,
    ...ForwardedActorFields,
  })
  .strict();

/** The hub → owning node body of a confirm (Keep, Reverse, or Keep all's per-id call). */
export const FederationBillableConfirmBodySchema = z
  .object({
    decision: z.enum(["keep", "reverse"]),
    reason: z.enum(["confirm", "confirm-all", "confirm-reverse"]),
    ...ForwardedActorFields,
  })
  .strict();

/** The answer of a switch or a confirm, from either end. */
export const BillableSwitchSetResponseSchema = z.object({
  ok: z.literal(true),
  changed: z.boolean(),
  billable: z.boolean(),
  billableConfirm: BillableConfirmSchema,
  timerMs: z.number(),
  unloggedMs: z.number(),
  loggedKnown: z.boolean(),
});

/** The history answer (section 6 item 4), as the owning node sends it. */
export const BillableSwitchHistoryResponseSchema = z.object({
  sessionId: z.string(),
  source: z.enum(["local", "origin", "mirror"]),
  originNodeId: z.string().nullable(),
  mirrorSyncedAt: z.number().nullable(),
  events: z.array(
    z
      .object({
        id: z.number(),
        at: z.number(),
        kind: z.enum(BILLABLE_SWITCH_EVENT_KINDS),
        reason: z.string().nullable(),
        billableBefore: z.boolean().nullable(),
        billableAfter: z.boolean().nullable(),
        confirmBefore: BillableConfirmSchema,
        confirmAfter: BillableConfirmSchema,
        startKind: z.string().optional(),
        actor: z
          .object({ kind: z.string(), sessionId: z.string().optional() })
          .strip(),
        via: z.string(),
        entryNodeId: z.string().nullable(),
        timerMs: z.number().nullable(),
        unloggedMs: z.number().nullable(),
        loggedKnown: z.boolean(),
        // #6646 (Task 14): a start's cause nodes, label and report time only.
        // Optional: an older peer's answer, and a start with no cause, lack it.
        causeNodes: z
          .array(
            z
              .object({
                nodeLabel: z.string(),
                reportedAt: z.number().nullable(),
              })
              .strip()
          )
          .optional(),
      })
      // A newer peer's added field never reaches the browser: built field by field.
      .strip()
  ),
});

// ─── shared checks ─────────────────────────────────────────────────────────

/** The first issue of a failed parse, as one line. */
export function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Invalid body";
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

/**
 * 409 `tracking_reconcile_pending` (#6778 PR-B, 3.4 step 6): the start-up
 * reconcile has not settled this session yet; a retry runs before each write
 * and on a five-minute timer.
 */
export function reconcilePendingRefusal(c: Context): Response {
  return c.json(
    {
      error:
        "This session's tracking record is not settled yet after the server started. Try again in a few minutes.",
      code: "tracking_reconcile_pending",
    },
    409
  );
}

/** 409 `billable_feature_closed`, naming the node. */
export function closedRefusal(c: Context, nodeLabel: string): Response {
  return c.json(
    {
      error: `Billable sessions are closed on ${nodeLabel}: a session there can be switched off, not on.`,
      code: "billable_feature_closed",
      nodeLabel,
    },
    409
  );
}

function unsupportedRefusal(c: Context, nodeLabel: string): Response {
  return c.json(
    {
      error: `${nodeLabel} runs a Hapimatic without billable sessions.`,
      code: "billable_feature_unsupported",
      nodeLabel,
    },
    409
  );
}

export function notReachableYet(c: Context, nodeLabel: string): Response {
  return c.json(
    {
      error: `${nodeLabel} has not answered this node yet. Try again in a moment.`,
      code: "node_not_reachable_yet",
      nodeLabel,
    },
    503
  );
}

/** What a write asks of the owning node: an on-direction write needs `billable:switch`. */
type Direction = "on" | "off" | "read";

/**
 * The remote-node gate of every proxied call, before any request: a node the hub
 * has not polled yet (its own first poll, not the registry-wide window) or that is
 * offline → 503 `node_not_reachable_yet`, never "unsupported", because its tags
 * are empty until its first successful poll. Then its tags: an off-direction write
 * or a read needs `billable:switch` or `billable:switch-closed`; an on-direction
 * write needs `billable:switch`.
 */
export function remoteNodeRefusal(
  c: Context,
  view: BillableSwitchNodeRegistryView | undefined,
  direction: Direction
): Response | null {
  if (!view) {
    return c.json({ error: "Node not found", code: "node_not_found" }, 404);
  }
  if (view.awaitingInitialPoll || view.status === "offline") {
    return notReachableYet(c, view.nodeLabel);
  }
  if (direction === "on") {
    if (view.on) return null;
    return view.closed
      ? closedRefusal(c, view.nodeLabel)
      : unsupportedRefusal(c, view.nodeLabel);
  }
  if (view.on || view.closed) return null;
  return unsupportedRefusal(c, view.nodeLabel);
}

/**
 * The peer has no billable routes to serve: an older binary answers 401 `Invalid
 * token` for a route it lacks (#4461 K13), and a gate-off peer answers a non-JSON
 * 404, which the proxy words `Remote node returned 404` (the rule of
 * `pinRouteHelpers.isPeerWithoutPins`). A JSON `Session not found` is neither.
 */
export function isPeerWithoutBillableSwitch(
  result: Extract<ProxyResult, { type: "error" }>
): boolean {
  return (
    (result.status === 401 && result.message === "Invalid token") ||
    (result.status === 404 && result.message === "Remote node returned 404")
  );
}

/**
 * The session forward to its owning node. `SessionService.proxyPinRequest` is the
 * one generic forward that keeps the peer's body (its own comment says so);
 * `sessionService.ts` is at its 1,500-line limit, so the billable routes call it
 * through this name rather than add a twin there.
 */
export function proxyBillableSwitchRequest(
  service: Pick<SessionService, "proxyPinRequest">,
  sessionId: string,
  pathSuffix: string,
  method: "GET" | "PUT" | "POST",
  namespace: string,
  body?: unknown
): Promise<ProxyResult> {
  return service.proxyPinRequest(
    sessionId,
    pathSuffix,
    method,
    namespace,
    body
  );
}

/**
 * Map a proxied answer: a peer without the routes → 409 unsupported; any other
 * 401 → 502 `peer_unauthorized` (a 401 never reaches the browser, which reads it
 * as an expired login); a peer's 409 `billable_feature_closed` keeps its code and
 * gains the node's label; a success is parsed with the shared schema (502
 * `peer_bad_response` on a mismatch).
 */
export function proxiedBillableResponse<T>(
  c: Context,
  result: ProxyResult,
  schema: z.ZodType<T>,
  nodeLabel: string,
  onData?: (data: T) => void
): Response {
  if (result.type === "not-found") {
    return c.json({ error: "Session not found" }, 404);
  }
  if (result.type === "error") {
    if (isPeerWithoutBillableSwitch(result)) {
      return unsupportedRefusal(c, nodeLabel);
    }
    if (result.status === 401) {
      return c.json(
        {
          error: "The session's node refused this node's federation token",
          code: "peer_unauthorized",
        },
        502
      );
    }
    if (result.code === "billable_feature_closed") {
      return closedRefusal(c, nodeLabel);
    }
    return c.json(
      {
        error: result.message,
        ...(result.code ? { code: result.code } : {}),
      },
      result.status as ContentfulStatusCode
    );
  }
  const parsed = schema.safeParse(result.data);
  if (!parsed.success) {
    return c.json(
      {
        error: "The session's node returned an unexpected answer",
        code: "peer_bad_response",
      },
      502
    );
  }
  onData?.(parsed.data);
  return c.json(parsed.data as Record<string, unknown>);
}

/** The answer of a local switch or confirm. */
function setAnswer(result: {
  changed: boolean;
  billable: boolean;
  billableConfirm: "pending" | null;
  timerMs: number;
  unloggedMs: number;
  loggedKnown: boolean;
}): z.infer<typeof BillableSwitchSetResponseSchema> {
  return {
    ok: true,
    changed: result.changed,
    billable: result.billable,
    billableConfirm: result.billableConfirm,
    timerMs: result.timerMs,
    unloggedMs: result.unloggedMs,
    loggedKnown: result.loggedKnown,
  };
}

// ─── the hub routes ────────────────────────────────────────────────────────

type BillableRegistry = Pick<
  NodeRegistry,
  | "locateSession"
  | "getBillableSwitchNodeViews"
  | "nodeSupports"
  | "updateCachedSessionBillable"
  | "callBillableSwitchPeerRoute"
  | "advanceBillableSwitchReportCounter"
>;

export type BillableSwitchRoutesOptions = {
  billableSwitchMode: BillableSwitchMode;
  getSessionService: () => Pick<SessionService, "proxyPinRequest"> | null;
  getNodeRegistry: () => Partial<BillableRegistry> | null;
};

type Ready = {
  engine: SyncEngine;
  service: BillableSwitchService;
};

function requireBillable(
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

async function readBody<T>(
  c: Context<WebAppEnv>,
  schema: z.ZodType<T>
): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
  // `undefined`, never `null`, for an unparseable body, so no schema reads it as empty.
  const raw = await c.req.json().catch(() => undefined);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      response: c.json({ error: describeIssue(parsed.error) }, 400),
    };
  }
  return { ok: true, data: parsed.data };
}

function registryView(
  registry: Partial<BillableRegistry> | null,
  nodeId: string
): BillableSwitchNodeRegistryView | undefined {
  return registry
    ?.getBillableSwitchNodeViews?.()
    .find(v => v.nodeId === nodeId);
}

/** Where a session lives for a write: here, on another node, or nowhere. */
type SessionPlace =
  | { kind: "local" }
  | {
      kind: "remote";
      nodeId: string;
      view: BillableSwitchNodeRegistryView | undefined;
    }
  | { kind: "response"; response: Response };

function placeSession(
  c: Context<WebAppEnv>,
  engine: SyncEngine,
  registry: Partial<BillableRegistry> | null,
  sessionId: string
): SessionPlace {
  const local = engine.getSession(sessionId);
  if (local) {
    // #1097: no existence leak across namespaces.
    if (local.namespace !== c.get("namespace")) {
      return {
        kind: "response",
        response: c.json({ error: "Session not found" }, 404),
      };
    }
    return { kind: "local" };
  }
  const located = registry?.locateSession?.(sessionId) ?? null;
  if (!located) {
    return {
      kind: "response",
      response: c.json({ error: "Session not found" }, 404),
    };
  }
  return {
    kind: "remote",
    nodeId: located.nodeId,
    view: registryView(registry, located.nodeId),
  };
}

/** The two fields of an owner's tracking answer that a Keep needs (newer fields ignored). */
const OwnerRecordSchema = z.object({
  record: z
    .object({
      confirm: BillableConfirmSchema,
      billingStatus: TrackingBillingStatusSchema,
    })
    .nullable(),
});

/**
 * #6778 PR-C (moved item 5): whether a Keep of a copy on another node would raise
 * billing, from the owner's record, read through its tracking receiver
 * (`GET /api/federation/sessions/:id/tracking`, Task 14). Only a waiting copy that
 * is not Billable raises nothing. An owner that cannot be asked (no
 * `billable:tracking-carry`, not reachable, gate off) or whose answer is an error
 * or unreadable counts as raising, so the Keep is refused as before.
 */
async function remoteKeepRaisesBilling(
  registry: Partial<BillableRegistry> | null,
  place: Extract<SessionPlace, { kind: "remote" }>,
  sessionService: Pick<SessionService, "proxyPinRequest"> | null,
  sessionId: string,
  namespace: string
): Promise<boolean> {
  const view = place.view;
  if (!view || view.awaitingInitialPoll || view.status === "offline") {
    return true;
  }
  if (!view.on && !view.closed) return true;
  if (
    !registry?.nodeSupports?.(place.nodeId, BILLABLE_TRACKING_CARRY_CAPABILITY)
  ) {
    return true;
  }
  if (!sessionService) return true;
  const result = await proxyBillableSwitchRequest(
    sessionService,
    sessionId,
    "/tracking",
    "GET",
    namespace
  );
  if (result.type !== "success") return true;
  const parsed = OwnerRecordSchema.safeParse(result.data);
  if (!parsed.success) return true;
  const record = parsed.data.record;
  return (
    record === null ||
    record.confirm !== "pending" ||
    record.billingStatus === "billable"
  );
}

export function createBillableSwitchRoutes(
  getSyncEngine: () => SyncEngine | null,
  options: BillableSwitchRoutesOptions
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  const mode = options.billableSwitchMode;
  const gate = billableSwitchGate(mode);
  const closed = mode === "closed";
  // #6778 PR-A: the header write, closed in every gate state.
  const retiredRoute = markClosedGate<MiddlewareHandler<WebAppEnv>>(async c =>
    c.notFound()
  );

  // ─── PUT /sessions/:id/billable ──────────────────────────────────
  app.put(
    "/sessions/:id/billable",
    cataloged(
      defineCapability({
        id: "session-lifecycle.billable",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Switch a session billable or not billable, on whichever node owns it; the change is recorded with who made it.",
        whenToUse:
          "When a person switches a session's time on or off for billing, or switches it off before deleting it.",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/api/sessions/:id/billable",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    gate,
    async c => {
      const ready = requireBillable(c, getSyncEngine);
      if (ready instanceof Response) return ready;
      const body = await readBody(c, BillableSwitchSetRequestSchema);
      if (!body.ok) return body.response;
      const reason = body.data.reason ?? "switch";
      if (reason !== "switch" && body.data.billable) {
        return c.json(
          { error: `The reason "${reason}" is only for switching off` },
          400
        );
      }
      const sessionId = c.req.param("id");
      const namespace = c.get("namespace");
      const registry = options.getNodeRegistry();
      const place = placeSession(c, ready.engine, registry, sessionId);
      if (place.kind === "response") return place.response;
      const refused = refuseAgentBillableWrite(
        c,
        ready.engine,
        body.data.billable ? "on" : "off"
      );
      if (refused) return refused;
      if (closed && body.data.billable) {
        return closedRefusal(c, ready.service.localNodeLabel());
      }
      const actor = billableSwitchActor(c, ready.engine);
      const via = billableSwitchVia(c);
      const entryNodeId = ready.service.localNodeId();
      const loggedMs = ready.service.loggedMsFor(sessionId);

      if (place.kind === "local") {
        const result = ready.service.setSwitch(sessionId, namespace, {
          billable: body.data.billable,
          reason,
          actor,
          via,
          entryNodeId,
          loggedMs,
        });
        if (!result.found) {
          if (result.reconcilePending) return reconcilePendingRefusal(c);
          return c.json({ error: "Session not found" }, 404);
        }
        return c.json(setAnswer(result));
      }

      const nodeRefused = remoteNodeRefusal(
        c,
        place.view,
        body.data.billable ? "on" : "off"
      );
      if (nodeRefused) return nodeRefused;
      const sessionService = options.getSessionService();
      if (!sessionService) {
        return c.json({ error: "Session service not available" }, 503);
      }
      const result = await proxyBillableSwitchRequest(
        sessionService,
        sessionId,
        "/billable",
        "PUT",
        namespace,
        {
          billable: body.data.billable,
          reason,
          actor,
          via,
          entryNodeId,
          loggedMs,
        } satisfies z.infer<typeof FederationBillableSetBodySchema>
      );
      return proxiedBillableResponse(
        c,
        result,
        BillableSwitchSetResponseSchema,
        place.view?.nodeLabel ?? place.nodeId,
        data =>
          registry?.updateCachedSessionBillable?.(
            sessionId,
            data.billable,
            data.billableConfirm
          )
      );
    }
  );

  // ─── POST /sessions/:id/billable/confirm ─────────────────────────
  app.post(
    "/sessions/:id/billable/confirm",
    cataloged(
      defineCapability({
        id: "session-lifecycle.billable-confirm",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Decide a session that started billable without a person's answer: keep it billable, or reverse it to not billable.",
        whenToUse:
          "When a person keeps or reverses a session that is waiting for a billable confirmation.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/sessions/:id/billable/confirm",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    gate,
    async c => {
      const ready = requireBillable(c, getSyncEngine);
      if (ready instanceof Response) return ready;
      const body = await readBody(c, BillableSwitchConfirmRequestSchema);
      if (!body.ok) return body.response;
      const decision = body.data.decision;
      const sessionId = c.req.param("id");
      const namespace = c.get("namespace");
      const registry = options.getNodeRegistry();
      const place = placeSession(c, ready.engine, registry, sessionId);
      if (place.kind === "response") return place.response;
      const refused = refuseAgentBillableWrite(
        c,
        ready.engine,
        decision === "keep" ? "keep" : "reverse"
      );
      if (refused) return refused;
      // #6778 PR-B (3.3; review G5): a Keep only clears the wait, so `closed`
      // refuses it only when it would raise billing: a waiting Billable copy.
      // A copy on another node is judged by its owner's record (PR-C, moved
      // item 5), read only when a closed gate needs it, here or there.
      const keepRaises =
        decision !== "keep"
          ? false
          : place.kind === "local"
            ? ready.service.keepRaisesBilling(sessionId, namespace)
            : closed || (place.view?.closed === true && !place.view.on)
              ? await remoteKeepRaisesBilling(
                  registry,
                  place,
                  options.getSessionService(),
                  sessionId,
                  namespace
                )
              : true;
      if (closed && keepRaises) {
        return closedRefusal(c, ready.service.localNodeLabel());
      }
      const actor = billableSwitchActor(c, ready.engine);
      const via = billableSwitchVia(c);
      const entryNodeId = ready.service.localNodeId();
      const loggedMs = ready.service.loggedMsFor(sessionId);
      const reason = decision === "keep" ? "confirm" : "confirm-reverse";

      if (place.kind === "local") {
        const outcome = ready.service.confirm(sessionId, namespace, {
          decision,
          reason,
          actor,
          via,
          entryNodeId,
          loggedMs,
        });
        if (outcome.outcome === "not_found") {
          return c.json({ error: "Session not found" }, 404);
        }
        if (outcome.outcome === "reconcile_pending") {
          return reconcilePendingRefusal(c);
        }
        if (outcome.outcome === "not_pending") {
          return c.json(
            {
              error: "The session is not waiting for a billable confirmation",
              code: "not_pending",
            },
            409
          );
        }
        return c.json(setAnswer(outcome.result));
      }

      // A Keep that raises nothing lowers no billing either: it goes to a
      // closed owner, whose receiver applies the same rule.
      const nodeRefused = remoteNodeRefusal(
        c,
        place.view,
        keepRaises ? "on" : "off"
      );
      if (nodeRefused) return nodeRefused;
      const sessionService = options.getSessionService();
      if (!sessionService) {
        return c.json({ error: "Session service not available" }, 503);
      }
      const result = await proxyBillableSwitchRequest(
        sessionService,
        sessionId,
        "/billable/confirm",
        "POST",
        namespace,
        {
          decision,
          reason,
          actor,
          via,
          entryNodeId,
          loggedMs,
        } satisfies z.infer<typeof FederationBillableConfirmBodySchema>
      );
      return proxiedBillableResponse(
        c,
        result,
        BillableSwitchSetResponseSchema,
        place.view?.nodeLabel ?? place.nodeId,
        data =>
          registry?.updateCachedSessionBillable?.(
            sessionId,
            data.billable,
            data.billableConfirm
          )
      );
    }
  );

  // ─── GET /sessions/:id/billable/history ──────────────────────────
  app.get(
    "/sessions/:id/billable/history",
    cataloged(
      defineCapability({
        id: "session-lifecycle.billable-history",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Read a session's billable switch history, oldest first, from this node, the owning node, or this node's copy.",
        whenToUse:
          "When showing who switched a session billable or not, and when, including after the session was deleted.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/sessions/:id/billable/history",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    gate,
    async c => {
      const ready = requireBillable(c, getSyncEngine);
      if (ready instanceof Response) return ready;
      const sessionId = c.req.param("id");
      const namespace = c.get("namespace");
      const live = ready.engine.getSession(sessionId);
      if (live && live.namespace !== namespace) {
        return c.json({ error: "Session not found" }, 404);
      }
      // Steps 1 and 2: a live local row, or the events of a deleted local session.
      const local = ready.service.localHistory(sessionId, namespace);
      if (local) return c.json(local);

      // Step 3: the owning node, when it can be reached and serves the history.
      const registry = options.getNodeRegistry();
      const located = registry?.locateSession?.(sessionId) ?? null;
      const sessionService = options.getSessionService();
      if (located && sessionService) {
        const view = registryView(registry, located.nodeId);
        if (!remoteNodeRefusal(c, view, "read")) {
          const result = await proxyBillableSwitchRequest(
            sessionService,
            sessionId,
            "/billable/history",
            "GET",
            namespace
          );
          if (result.type === "success") {
            const parsed = BillableSwitchHistoryResponseSchema.safeParse(
              result.data
            );
            if (parsed.success) {
              return c.json({
                ...parsed.data,
                source: "origin",
                originNodeId: located.nodeId,
                mirrorSyncedAt: null,
              });
            }
          }
          // Unsupported, unreachable or not found there: the copy below.
        }
      }

      // Step 4: this node's copy of the owning node's events.
      const mirror = ready.service.mirrorHistory(sessionId, namespace);
      if (mirror) return c.json(mirror);
      return c.json({ error: "Session not found" }, 404);
    }
  );

  // ─── GET /billable-switch/headers ────────────────────────────────
  app.get(
    "/billable-switch/headers",
    cataloged(
      defineCapability({
        id: "session-lifecycle.billable-switch-headers",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "List every node with its billable state and last report time. Header lists are empty since #6778 PR-A: no project header decides a start. ?history=1 adds the recorded header changes.",
        whenToUse:
          "When reading which nodes have billable sessions on, closed or off (the web's Create reads each node's on flag).",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/billable-switch/headers",
        },
        auth: "jwt",
        // K15: a read that names projects is not readonly.
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    gate,
    c => {
      const ready = requireBillable(c, getSyncEngine);
      if (ready instanceof Response) return ready;
      const namespace = c.get("namespace");
      const nodes = ready.service.crossNodeView().map(entry => ({
        nodeId: entry.nodeId,
        nodeLabel: entry.nodeLabel,
        status: entry.status,
        isLocal: entry.isLocal,
        on: entry.on,
        closed: entry.closed,
        reportedAt: entry.reportedAt,
        headers: entry.headers
          .filter(h => h.namespace === namespace)
          .map(h => ({
            projectKey: h.projectKey,
            keyKind: h.keyKind,
            billable: h.billable,
            updatedAt: h.updatedAt,
          })),
      }));
      if (c.req.query("history") !== "1") return c.json({ nodes });
      const history = ready.service
        .headerHistory(namespace)
        .map(({ originNodeId, event }) =>
          headerHistoryItem(event, originNodeId)
        );
      return c.json({ nodes, history });
    }
  );

  // ─── POST /billable-switch/headers (closed for good, #6778 PR-A) ──
  // R12: no header decides a start, so nothing writes one. The route stays
  // mounted and cataloged (the catalog ratchet sees no drift); the closed gate
  // answers 404 in every gate state and drops it from the served catalog.
  app.post(
    "/billable-switch/headers",
    cataloged(
      defineCapability({
        id: "session-lifecycle.billable-switch-header",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Switch a project's billable header on or off on one node, and switch the picked sessions of that project on with it, in one step.",
        whenToUse:
          "When a person makes a project billable (or not) on a node and picks which of its running sessions to bill.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/billable-switch/headers",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    retiredRoute,
    c => c.notFound()
  );

  // ─── GET /billable-switch/events ─────────────────────────────────
  app.get(
    "/billable-switch/events",
    cataloged(
      defineCapability({
        id: "session-lifecycle.billable-switch-events",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "List the caller's namespace's billable switch events from this node and from its copy of the other nodes' records, after two cursors, optionally by kind.",
        whenToUse:
          "When a billing reader looks for every switch-off and reversal since its last read, without knowing session ids.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/billable-switch/events",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    gate,
    c => {
      const ready = requireBillable(c, getSyncEngine);
      if (ready instanceof Response) return ready;
      const after = parseEventCursor(c.req.query("after"));
      if (!after) {
        return c.json(
          { error: "after is <local id> or <local id>:<copy sequence>" },
          400
        );
      }
      const kinds = parseKinds(c.req.query("kinds"));
      if (!kinds) {
        return c.json(
          {
            error: `kinds is a comma-separated list of ${BILLABLE_SWITCH_EVENT_KINDS.join(", ")}`,
          },
          400
        );
      }
      const namespace = c.get("namespace");
      const localId = ready.service.localNodeId();
      // #6778 PR-B (7.1): no `kinds` reads the seven old kinds, as before;
      // `tracking` rows come only when `kinds` names them.
      const { local, mirror } = ready.service.eventsSince(
        namespace,
        after,
        kinds.length > 0 ? kinds : BILLABLE_SWITCH_LEGACY_EVENT_KINDS
      );
      // From PR-B the old kinds carry the record's snapshots too: an agent's
      // request never reads a rate, a default rate or a note (C7 = a, S5).
      const agent = isAgentRequest(c);
      const shown = <T extends Record<string, unknown>>(e: T): T =>
        agent ? redactTrackingEventForAgent(e) : e;
      return c.json({
        events: [
          ...local.map(e => shown({ ...e, originNodeId: localId })),
          ...mirror.map(e => shown({ ...e })),
        ],
        next: {
          local: local.at(-1)?.id ?? after.local,
          mirror: mirror.at(-1)?.mirrorSeq ?? after.mirror,
        },
      });
    }
  );

  return app;
}

/** A header change for `?history=1`: no user agent, no label. */
function headerHistoryItem(
  e: BillableSwitchEvent,
  originNodeId: string
): Record<string, unknown> {
  return {
    originNodeId,
    id: e.id,
    at: e.at,
    kind: e.kind,
    reason: e.reason,
    projectKey: e.projectKey,
    keyKind: e.keyKind,
    billableBefore: e.billableBefore,
    billableAfter: e.billableAfter,
    actor: BillableSwitchService.toHistoryEvent(e).actor,
    via: e.via,
    entryNodeId: e.entryNodeId,
  };
}

/** `after` is `<local>` or `<local>:<mirror>`; absent is the start of both. */
function parseEventCursor(
  raw: string | undefined
): { local: number; mirror: number } | null {
  if (raw === undefined || raw === "") return { local: 0, mirror: 0 };
  const match = /^(\d{1,15})(?::(\d{1,15}))?$/.exec(raw);
  if (!match) return null;
  return { local: Number(match[1]), mirror: Number(match[2] ?? 0) };
}

/** `kinds` is a comma-separated list; an unknown kind is refused, never dropped. */
function parseKinds(raw: string | undefined): string[] | null {
  if (raw === undefined || raw === "") return [];
  const kinds = raw.split(",").map(k => k.trim());
  const known = BILLABLE_SWITCH_EVENT_KINDS as readonly string[];
  return kinds.every(k => known.includes(k)) ? kinds : null;
}

// ─── Keep all (mounted in sessions.ts) ───────────────────────────────────────

export type BillableKeepAllOutcome =
  | "ok"
  | "not_pending"
  | "not_found"
  | "forbidden"
  | "node_offline"
  | "unsupported"
  | "timeout"
  | "failed";

/**
 * Keep all: confirm every waiting session of `ids`, on any node, one outcome per
 * unique id in request order. A session on another node goes to that node's
 * per-session confirm receiver with the reason `confirm-all`, so the owning node
 * records it as Keep all. A failure on one session never stops the batch.
 *
 * PR-2 item E1: a session that does not answer within the deadline is
 * `timeout`, not `failed`, because a slow remote Keep may still apply (a retry
 * then answers `not_pending`); a rejection stays `failed`. Each of the two, and
 * every other `failed`, logs its reason.
 */
export async function runBillableKeepAll(params: {
  ids: readonly string[];
  engine: SyncEngine;
  service: BillableSwitchService;
  namespace: string;
  registry: Partial<BillableRegistry> | null;
  sessionService: Pick<SessionService, "proxyPinRequest"> | null;
  actor: BillableSwitchActor;
  via: "tool" | "direct";
  deadlineMs?: number;
}): Promise<Array<{ id: string; outcome: BillableKeepAllOutcome }>> {
  const { engine, service, namespace, registry } = params;
  const deadlineMs = params.deadlineMs ?? BULK_SESSION_DEADLINE_MS;
  const entryNodeId = service.localNodeId();
  const ids = dedupeIds(params.ids);

  const one = async (id: string): Promise<BillableKeepAllOutcome> => {
    const target = resolveTarget(
      id,
      engine,
      namespace,
      (registry ?? null) as NodeRegistry | null,
      false
    );
    if (target.kind === "done") {
      const code = target.result.ok ? undefined : target.result.code;
      return code === "forbidden" || code === "node_offline"
        ? code
        : "not_found";
    }
    const loggedMs = service.loggedMsFor(id);
    if (target.kind === "local") {
      const outcome = service.confirm(id, namespace, {
        decision: "keep",
        reason: "confirm-all",
        actor: params.actor,
        via: params.via,
        entryNodeId,
        loggedMs,
      });
      // The bulk answer keeps its schema (3.3: #6646's screens see no new
      // value), so a session the start-up reconcile has not settled is `failed`.
      return outcome.outcome === "reconcile_pending"
        ? "failed"
        : outcome.outcome;
    }
    const view = registryView(registry, target.nodeId);
    if (!view || view.awaitingInitialPoll || view.status === "offline") {
      return "node_offline";
    }
    if (!view.on) return "unsupported";
    if (!params.sessionService) {
      logKeepAllFailure(id, "no session service to reach its node");
      return "failed";
    }
    const result = await proxyBillableSwitchRequest(
      params.sessionService,
      id,
      "/billable/confirm",
      "POST",
      namespace,
      {
        decision: "keep",
        reason: "confirm-all",
        actor: params.actor,
        via: params.via,
        entryNodeId,
        loggedMs,
      } satisfies z.infer<typeof FederationBillableConfirmBodySchema>
    );
    if (result.type === "not-found") return "not_found";
    if (result.type === "error") {
      if (isPeerWithoutBillableSwitch(result)) return "unsupported";
      if (result.code === "billable_feature_closed") return "unsupported";
      if (result.code === "not_pending") return "not_pending";
      if (result.status === 404) return "not_found";
      logKeepAllFailure(
        id,
        `its node answered ${result.status ?? "an error"}${result.code ? ` ${result.code}` : ""}`
      );
      return "failed";
    }
    const parsed = BillableSwitchSetResponseSchema.safeParse(result.data);
    if (!parsed.success) {
      logKeepAllFailure(id, "its node's answer did not parse");
      return "failed";
    }
    registry?.updateCachedSessionBillable?.(
      id,
      parsed.data.billable,
      parsed.data.billableConfirm
    );
    return "ok";
  };

  const settled = await Promise.allSettled(
    ids.map(id =>
      settleWithin<BillableKeepAllOutcome>(one(id), deadlineMs, "timeout")
    )
  );
  return settled.map((s, i) => {
    const id = ids[i] as string;
    if (s.status === "rejected") {
      logKeepAllFailure(id, describeRejection(s.reason));
      return { id, outcome: "failed" };
    }
    if (s.value === "timeout") {
      console.warn(
        `[billable-switch] Keep all: ${id} did not answer within ${deadlineMs} ms; its Keep may still apply, and a retry then answers not_pending`
      );
    }
    return { id, outcome: s.value };
  });
}

function logKeepAllFailure(id: string, reason: string): void {
  console.warn(`[billable-switch] Keep all: ${id} failed: ${reason}`);
}

function describeRejection(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
