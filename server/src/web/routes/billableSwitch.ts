// SPDX-License-Identifier: AGPL-3.0-only
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import {
  BILLABLE_SWITCH_EVENT_KINDS,
  BillableConfirmSchema,
  BillableSwitchActorSchema,
  BillableSwitchKeyKindSchema,
  BillableSwitchViaSchema,
  defineCapability,
  LOCAL_NODE_ID,
  type BillableSwitchActor,
  type BillableSwitchEvent,
  type BillableSwitchMode,
} from "@hapi/protocol";

import { BillableSwitchService } from "../../billableSwitch/billableSwitchService";
import { cataloged } from "../../capabilities/cataloged";
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
 * history, the headers read and write, and the event list, plus the Keep all
 * fan-out that `sessions.ts` mounts beside the other bulk routes. Written by hand
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

/** `POST /api/billable-switch/headers` from a client. */
export const BillableSwitchHeaderRequestSchema = z
  .object({
    nodeId: z.string().min(1).max(200),
    projectKey: z.string().min(1).max(500),
    keyKind: BillableSwitchKeyKindSchema,
    billable: z.boolean(),
    sessionIds: z.array(SessionIdSchema).max(200).optional(),
  })
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

/** The hub → owning node body of a header write. */
export const FederationBillableHeaderBodySchema = z
  .object({
    projectKey: z.string().min(1).max(500),
    keyKind: BillableSwitchKeyKindSchema,
    billable: z.boolean(),
    picks: z
      .array(
        z
          .object({ sessionId: SessionIdSchema, loggedMs: LoggedMsSchema })
          .strict()
      )
      .max(200),
    actor: BillableSwitchActorSchema.strict(),
    via: BillableSwitchViaSchema,
    entryNodeId: EntryNodeIdSchema,
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

/** The answer of a header write, from either end. */
export const BillableSwitchHeaderResponseSchema = z.object({
  ok: z.literal(true),
  header: z.object({
    projectKey: z.string(),
    keyKind: BillableSwitchKeyKindSchema,
    billable: z.boolean(),
    updatedAt: z.number(),
  }),
  sessions: z.array(
    z.object({
      id: z.string(),
      outcome: z.enum(["ok", "unchanged", "not_found", "not_in_project"]),
    })
  ),
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
      })
      // A newer peer's added field never reaches the browser: built field by field.
      .strip()
  ),
});

// ─── shared checks ─────────────────────────────────────────────────────────

/**
 * A project key as a header write may name it: a `repo` key has two or more
 * non-empty segments and no leading slash (GitLab subgroups give three or more);
 * its case is never changed. Null when it is acceptable.
 */
export function projectKeyProblem(
  projectKey: string,
  keyKind: "repo" | "path"
): string | null {
  if (keyKind !== "repo") return null;
  if (projectKey.startsWith("/")) {
    return "A repository key has no leading slash";
  }
  const segments = projectKey.split("/");
  if (segments.length < 2 || segments.some(s => s.trim() === "")) {
    return "A repository key names an owner and a repository (owner/name)";
  }
  return null;
}

/** The first issue of a failed parse, as one line. */
export function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Invalid body";
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
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

function notReachableYet(c: Context, nodeLabel: string): Response {
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
function isPeerWithoutBillableSwitch(
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

export function createBillableSwitchRoutes(
  getSyncEngine: () => SyncEngine | null,
  options: BillableSwitchRoutesOptions
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  const mode = options.billableSwitchMode;
  const gate = billableSwitchGate(mode);
  const closed = mode === "closed";

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
      if (closed && decision === "keep") {
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

      const nodeRefused = remoteNodeRefusal(
        c,
        place.view,
        decision === "keep" ? "on" : "off"
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
          "List every node's billable project headers for the caller's namespace, with each node's state and report time; ?history=1 adds the header changes.",
        whenToUse:
          "When showing which projects are billable on this node and on the other nodes.",
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

  // ─── POST /billable-switch/headers ───────────────────────────────
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
    gate,
    async c => {
      const ready = requireBillable(c, getSyncEngine);
      if (ready instanceof Response) return ready;
      const body = await readBody(c, BillableSwitchHeaderRequestSchema);
      if (!body.ok) return body.response;
      const req = body.data;
      const sessionIds = dedupeIds(req.sessionIds ?? []);
      if (!req.billable && sessionIds.length > 0) {
        return c.json(
          { error: "Sessions are picked only when a header goes on" },
          400
        );
      }
      const keyProblem = projectKeyProblem(req.projectKey, req.keyKind);
      if (keyProblem) return c.json({ error: keyProblem }, 400);
      const refused = refuseAgentBillableWrite(c, ready.engine, "header");
      if (refused) return refused;
      if (closed) return closedRefusal(c, ready.service.localNodeLabel());

      const namespace = c.get("namespace");
      const actor = billableSwitchActor(c, ready.engine);
      const via = billableSwitchVia(c);
      const entryNodeId = ready.service.localNodeId();
      const picks = sessionIds.map(sessionId => ({
        sessionId,
        loggedMs: ready.service.loggedMsFor(sessionId),
      }));

      if (req.nodeId === LOCAL_NODE_ID || req.nodeId === entryNodeId) {
        const result = ready.service.applyHeader({
          namespace,
          projectKey: req.projectKey,
          keyKind: req.keyKind,
          billable: req.billable,
          picks,
          actor,
          via,
          entryNodeId,
        });
        return c.json({
          ok: true,
          header: {
            projectKey: result.header.projectKey,
            keyKind: result.header.keyKind,
            billable: result.header.billable,
            updatedAt: result.header.updatedAt,
          },
          sessions: result.sessions,
        } satisfies z.infer<typeof BillableSwitchHeaderResponseSchema>);
      }

      const registry = options.getNodeRegistry();
      const view = registryView(registry, req.nodeId);
      const nodeRefused = remoteNodeRefusal(c, view, "on");
      if (nodeRefused) return nodeRefused;
      const nodeLabel = view?.nodeLabel ?? req.nodeId;
      const outcome = await registry?.callBillableSwitchPeerRoute?.(
        req.nodeId,
        "/api/federation/billable-switch/headers",
        {
          projectKey: req.projectKey,
          keyKind: req.keyKind,
          billable: req.billable,
          picks,
          actor,
          via,
          entryNodeId,
        } satisfies z.infer<typeof FederationBillableHeaderBodySchema>,
        { namespace }
      );
      if (!outcome || outcome.kind === "offline") {
        return notReachableYet(c, nodeLabel);
      }
      if (outcome.kind === "unsupported") {
        return unsupportedRefusal(c, nodeLabel);
      }
      if (outcome.kind === "unreachable") {
        if (outcome.code === "billable_feature_closed") {
          return closedRefusal(c, nodeLabel);
        }
        if (outcome.reason === "auth") {
          return c.json(
            {
              error: "The node refused this node's federation token",
              code: "peer_unauthorized",
            },
            502
          );
        }
        const status = outcome.status;
        if (status !== undefined && status >= 400 && status < 500) {
          return c.json(
            {
              error: outcome.message,
              ...(outcome.code ? { code: outcome.code } : {}),
            },
            status as ContentfulStatusCode
          );
        }
        return c.json(
          { error: `${nodeLabel} did not answer`, code: "node_unreachable" },
          502
        );
      }
      const parsed = BillableSwitchHeaderResponseSchema.safeParse(outcome.body);
      if (!parsed.success) {
        return c.json(
          {
            error: "The node returned an unexpected answer",
            code: "peer_bad_response",
          },
          502
        );
      }
      // The federation rule: the hub's own view follows the write at once, and
      // the advanced report counter keeps an older poll from undoing it.
      for (const s of parsed.data.sessions) {
        if (s.outcome === "ok") {
          registry?.updateCachedSessionBillable?.(s.id, true, null);
        }
      }
      ready.service.recordRemoteHeader(req.nodeId, {
        namespace,
        ...parsed.data.header,
      });
      registry?.advanceBillableSwitchReportCounter?.(req.nodeId);
      return c.json(parsed.data);
    }
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
      const { local, mirror } = ready.service.eventsSince(
        namespace,
        after,
        kinds
      );
      return c.json({
        events: [
          ...local.map(e => ({ ...e, originNodeId: localId })),
          ...mirror.map(e => ({ ...e })),
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
  | "failed";

/**
 * Keep all: confirm every waiting session of `ids`, on any node, one outcome per
 * unique id in request order. A session on another node goes to that node's
 * per-session confirm receiver with the reason `confirm-all`, so the owning node
 * records it as Keep all. A failure on one session never stops the batch.
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
      return outcome.outcome;
    }
    const view = registryView(registry, target.nodeId);
    if (!view || view.awaitingInitialPoll || view.status === "offline") {
      return "node_offline";
    }
    if (!view.on) return "unsupported";
    if (!params.sessionService) return "failed";
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
      return "failed";
    }
    const parsed = BillableSwitchSetResponseSchema.safeParse(result.data);
    if (!parsed.success) return "failed";
    registry?.updateCachedSessionBillable?.(
      id,
      parsed.data.billable,
      parsed.data.billableConfirm
    );
    return "ok";
  };

  const settled = await Promise.allSettled(
    ids.map(id =>
      settleWithin<BillableKeepAllOutcome>(one(id), deadlineMs, "failed")
    )
  );
  return settled.map((s, i) => ({
    id: ids[i] as string,
    outcome: s.status === "fulfilled" ? s.value : "failed",
  }));
}
