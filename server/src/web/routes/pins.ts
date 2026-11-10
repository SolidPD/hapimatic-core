// SPDX-License-Identifier: AGPL-3.0-only
import { Hono, type Context } from "hono";
import {
  defineCapability,
  describePinIssues,
  PinGetResponseSchema,
  PinListQuerySchema,
  PinListResponseSchema,
  PinDeadlineRequestSchema,
  PinMutationResponseSchema,
  PinStarRequestSchema,
  PIN_SUBMISSION_REQUEST_MAX_BYTES,
  PinSubmissionRequestSchema,
  PinSubmissionResponseSchema,
} from "@hapi/protocol";

import { cataloged } from "../../capabilities/cataloged";
import type { NodeRegistry } from "../../federation/nodeRegistry";
import type { ErrorLogger } from "../../logging/errorLogger";
import type { SessionService } from "../../services/sessionService";
import type { PinSessionRef, PinService } from "../../sync/pinService";
import {
  browserOrHostTimeZone,
  submitPinAnswers,
} from "../../sync/pinSubmission";
import type { Session, SyncEngine } from "../../sync/syncEngine";
import type { WebAppEnv } from "../middleware/auth";
import { pinsGate } from "../middleware/pinsGate";
import { createRateLimiter } from "../middleware/rateLimit";
import {
  isPeerWithoutPins,
  pinDeadlineInput,
  pinDeadlineRangeError,
  pinDeadlineResponse,
  PIN_FILES_MISSING_ROUTE,
  pinPath,
  pinSaveResponse,
  pinSubmissionResponse,
  pinWriteResponse,
  proxiedPinResponse,
  readPinBody,
  refuseAgentPinAnswers,
  refuseAgentPinDeadline,
  refuseSelfPinAction,
  withPinErrors,
} from "./pinRouteHelpers";

/**
 * Session-scoped pin routes for the web client (issue #6447, epic #6446).
 *
 * ## 🔴 Auth comes from the MOUNT POSITION
 *
 * Mounted below the global JWT gate in `buildWebApp.ts`, beside the bookmark
 * routes, so every route here is JWT-gated positionally and `namespace` is set.
 *
 * ## Federation: the shape of the bookmark routes, the behavior of `linked-issue`
 *
 * A pin lives on the node that owns its session, so a peer-owned session goes to
 * that node through `SessionService` (server/CLAUDE.md "Federation Authorization
 * Model"), and the receiver re-asserts the namespace. A local session in another
 * namespace answers 404 `Session not found`, the exact text the availability guard
 * recognises. A missing pin answers `Pin not found`, so the guard leaves it alone.
 *
 * ## Closed gate
 *
 * Each route takes the gate as a route argument after `cataloged(...)`, so a closed
 * instance answers 404 and omits the route from the served catalog.
 */
export function createPinsRoutes(
  getSyncEngine: () => SyncEngine | null,
  options: {
    pinsEnabled: boolean;
    getSessionService: () => Pick<SessionService, "proxyPinRequest"> | null;
    getNodeRegistry: () => Pick<
      NodeRegistry,
      "updateCachedSessionOpenPinCount"
    > | null;
    errorLogger?: ErrorLogger | null;
    /**
     * The zone for a Submit's summary line (#6450): the operator's Time Log
     * zone, else the zone the browser sent, else the host's.
     */
    getTimeZone?: (browserZone?: string) => Promise<string>;
    /**
     * The operator's Time Log zone, or null when none is set (#6452). Pin reads
     * carry it as `timeZone`, so deadlines show in the zone of the automatic
     * pick's message. A proxied read carries the owning node's, whose loop fires.
     */
    getPreferenceTimeZone?: () => Promise<string | null>;
    now?: () => number;
  }
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  const gate = pinsGate(options.pinsEnabled);
  const { errorLogger } = options;
  // Per session, like the CLI routes (R18). These take a server id, never a tag. A
  // person cannot reach this limit by opening or starring pins by hand.
  const writeLimiter = createRateLimiter({
    name: "pins",
    limit: 120,
    keyFn: c => `${c.get("namespace")}:${c.req.param("id")}`,
  });
  // #6450: a Submit has its own bucket, so star and mark-seen writes in the shared
  // one can never starve the operator's answers.
  const submitLimiter = createRateLimiter({
    name: "pin-answers",
    limit: 30,
    keyFn: c => `${c.get("namespace")}:${c.req.param("id")}`,
  });
  // #6453: Save copies files, so it has its own, smaller bucket.
  const saveLimiter = createRateLimiter({
    name: "pins-save",
    limit: 20,
    keyFn: c => `${c.get("namespace")}:${c.req.param("id")}`,
  });
  const getTimeZone =
    options.getTimeZone ??
    (async (browserZone?: string) => browserOrHostTimeZone(browserZone));
  const getPreferenceTimeZone =
    options.getPreferenceTimeZone ?? (async () => null);
  const clock = options.now ?? Date.now;

  type Target =
    | {
        kind: "local";
        pins: PinService;
        session: PinSessionRef;
        engine: SyncEngine;
        record: Session;
      }
    | { kind: "remote"; service: Pick<SessionService, "proxyPinRequest"> }
    | { kind: "response"; response: Response };

  const resolveTarget = (c: Context<WebAppEnv>): Target => {
    const engine = getSyncEngine();
    if (!engine) {
      return {
        kind: "response",
        response: c.json({ error: "Not connected" }, 503),
      };
    }
    const namespace = c.get("namespace");
    const session = engine.getSession(c.req.param("id") as string);
    if (session) {
      // #1097: no existence leak across namespaces.
      if (session.namespace !== namespace) {
        return {
          kind: "response",
          response: c.json({ error: "Session not found" }, 404),
        };
      }
      return {
        kind: "local",
        pins: engine.pins,
        session: { id: session.id, namespace },
        engine,
        record: session,
      };
    }
    const service = options.getSessionService();
    if (!service) {
      return {
        kind: "response",
        response: c.json({ error: "Session not found" }, 404),
      };
    }
    return { kind: "remote", service };
  };

  /** A proxied write: the hub's cached count follows the peer's answer. */
  const proxyWrite = async (
    c: Context<WebAppEnv>,
    service: Pick<SessionService, "proxyPinRequest">,
    suffix: string,
    method: string,
    body?: unknown,
    /** The 501 for a peer without this route (#6453). */
    missingRoute?: { error: string; code: string }
  ): Promise<Response> => {
    const sessionId = c.req.param("id") as string;
    const result = await service.proxyPinRequest(
      sessionId,
      suffix,
      method,
      c.get("namespace"),
      body
    );
    return proxiedPinResponse(
      c,
      result,
      PinMutationResponseSchema,
      data => {
        options
          .getNodeRegistry()
          ?.updateCachedSessionOpenPinCount(sessionId, data.openPinCount);
      },
      missingRoute
    );
  };

  app.get(
    "/sessions/:id/pins",
    cataloged(
      defineCapability({
        id: "session-introspection.list-pins",
        domain: "session-introspection",
        surface: "rest",
        description:
          "List a session's pins: the decisions, steps, and dashboards it has raised for the operator, with the open count.",
        whenToUse: "When rendering a session's Pins tab.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/sessions/:id/pins",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    gate,
    c =>
      withPinErrors(c, errorLogger, "pins-list", async () => {
        const query = PinListQuerySchema.safeParse(c.req.query());
        if (!query.success) {
          return c.json({ error: describePinIssues(query.error) }, 400);
        }
        const target = resolveTarget(c);
        if (target.kind === "response") return target.response;
        if (target.kind === "local") {
          return c.json({
            ...target.pins.list(target.session.id, query.data),
            timeZone: await getPreferenceTimeZone(),
          });
        }
        const params = new URLSearchParams({
          limit: String(query.data.limit),
          ...(query.data.status ? { status: query.data.status } : {}),
        });
        const result = await target.service.proxyPinRequest(
          c.req.param("id"),
          `/pins?${params.toString()}`,
          "GET",
          c.get("namespace")
        );
        // An older peer's session simply has no pins to show: an empty list the
        // tab can render, rather than an error, while nodes upgrade at their pace.
        if (result.type === "error" && isPeerWithoutPins(result)) {
          return c.json({
            pins: [],
            openPinCount: 0,
            hasMore: false,
            peerUnsupported: true,
          });
        }
        return proxiedPinResponse(c, result, PinListResponseSchema);
      })
  );

  app.get(
    "/sessions/:id/pins/:key",
    cataloged(
      defineCapability({
        id: "session-introspection.get-pin",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Read one of a session's pins by its key, with its answer history.",
        whenToUse: "When showing a single pin.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/sessions/:id/pins/:key",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    gate,
    c =>
      withPinErrors(c, errorLogger, "pins-get", async () => {
        const target = resolveTarget(c);
        if (target.kind === "response") return target.response;
        const key = c.req.param("key");
        if (target.kind === "local") {
          const found = target.pins.get(target.session.id, key);
          return found
            ? c.json({ ...found, timeZone: await getPreferenceTimeZone() })
            : c.json({ error: "Pin not found" }, 404);
        }
        const result = await target.service.proxyPinRequest(
          c.req.param("id"),
          pinPath(key),
          "GET",
          c.get("namespace")
        );
        return proxiedPinResponse(c, result, PinGetResponseSchema);
      })
  );

  app.put(
    "/sessions/:id/pins/:key/star",
    cataloged(
      defineCapability({
        id: "session-introspection.star-pin",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Star or unstar one of a session's pins, which floats it to the top of the session's Action Items.",
        whenToUse: "When the user stars or unstars a pin.",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/api/sessions/:id/pins/:key/star",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    gate,
    writeLimiter,
    c =>
      withPinErrors(c, errorLogger, "pins-star", async () => {
        const read = await readPinBody(c);
        if (!read.ok) return read.response;
        const body = PinStarRequestSchema.safeParse(read.body);
        if (!body.success) {
          return c.json({ error: describePinIssues(body.error) }, 400);
        }
        const target = resolveTarget(c);
        if (target.kind === "response") return target.response;
        const key = c.req.param("key");
        if (target.kind === "local") {
          return pinWriteResponse(
            c,
            target.pins.setStarred(target.session, key, body.data.starred)
          );
        }
        return proxyWrite(
          c,
          target.service,
          pinPath(key, "/star"),
          "PUT",
          body.data
        );
      })
  );

  app.put(
    "/sessions/:id/pins/:key/deadline",
    cataloged(
      defineCapability({
        id: "session-introspection.set-pin-deadline",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Move, stop, or restart the automatic pick on one of a session's open pins: an instant at least a minute and at most a year away, or off. Refuses an agent caller.",
        whenToUse:
          "When the user changes or turns off a pin's automatic pick in the deadline dialog.",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/api/sessions/:id/pins/:key/deadline",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    gate,
    writeLimiter,
    c =>
      withPinErrors(c, errorLogger, "pins-deadline", async () => {
        const agent = refuseAgentPinDeadline(c);
        if (agent) return agent;
        const read = await readPinBody(c);
        if (!read.ok) return read.response;
        const body = PinDeadlineRequestSchema.safeParse(read.body);
        if (!body.success) {
          return c.json({ error: describePinIssues(body.error) }, 400);
        }
        const range = pinDeadlineRangeError(body.data, clock());
        if (range) {
          return c.json(
            { error: range, code: "pin_deadline_out_of_range" },
            400
          );
        }
        const target = resolveTarget(c);
        if (target.kind === "response") return target.response;
        const key = c.req.param("key");
        if (target.kind === "local") {
          return pinDeadlineResponse(
            c,
            target.pins.setDeadline(
              target.session,
              key,
              pinDeadlineInput(body.data),
              clock()
            )
          );
        }
        const sessionId = c.req.param("id");
        const result = await target.service.proxyPinRequest(
          sessionId,
          pinPath(key, "/deadline"),
          "PUT",
          c.get("namespace"),
          body.data
        );
        // A peer built before #6452 serves pins but not this route.
        if (result.type === "error" && isPeerWithoutPins(result)) {
          return c.json(
            {
              error: "The session's node cannot change automatic picks yet",
              code: "pin_deadline_unsupported",
            },
            501
          );
        }
        return proxiedPinResponse(
          c,
          result,
          PinMutationResponseSchema,
          data => {
            options
              .getNodeRegistry()
              ?.updateCachedSessionOpenPinCount(sessionId, data.openPinCount);
          }
        );
      })
  );

  app.put(
    "/sessions/:id/pins/:key/seen",
    cataloged(
      defineCapability({
        id: "session-introspection.mark-pin-seen",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Mark one of a session's pins seen at its current revision, which clears its New marker until it changes again.",
        whenToUse: "When the user opens a pin.",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/api/sessions/:id/pins/:key/seen",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    gate,
    writeLimiter,
    c =>
      withPinErrors(c, errorLogger, "pins-seen", async () => {
        const target = resolveTarget(c);
        if (target.kind === "response") return target.response;
        const key = c.req.param("key");
        if (target.kind === "local") {
          return pinWriteResponse(c, target.pins.markSeen(target.session, key));
        }
        return proxyWrite(c, target.service, pinPath(key, "/seen"), "PUT");
      })
  );

  app.post(
    "/sessions/:id/pins/:key/dismiss",
    cataloged(
      defineCapability({
        id: "session-introspection.dismiss-pin",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Dismiss one of a session's pins on the operator's behalf, which closes it without an answer. A session cannot dismiss its own pins.",
        whenToUse: "When the user dismisses a pin.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/sessions/:id/pins/:key/dismiss",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    gate,
    writeLimiter,
    c =>
      withPinErrors(c, errorLogger, "pins-dismiss", async () => {
        const selfRefusal = refuseSelfPinAction(c, getSyncEngine());
        if (selfRefusal) return selfRefusal;
        const target = resolveTarget(c);
        if (target.kind === "response") return target.response;
        const key = c.req.param("key");
        if (target.kind === "local") {
          return pinWriteResponse(
            c,
            target.pins.dismissForOperator(target.session, key)
          );
        }
        return proxyWrite(c, target.service, pinPath(key, "/dismiss"), "POST");
      })
  );

  app.post(
    "/sessions/:id/pins/:key/save",
    cataloged(
      defineCapability({
        id: "session-introspection.save-pin-files",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Copy one pin's files into its folder under GeneratedFiles/pins/ in the session's folder and record it, so the next Submit tells the agent. A session cannot save its own pins.",
        whenToUse: "When the user presses Save to session folder on a pin.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/sessions/:id/pins/:key/save",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    gate,
    saveLimiter,
    c =>
      withPinErrors(c, errorLogger, "pins-save", async () => {
        // #6453: the operator's action; the agent's own kept assets are reported
        // through the derived savedTo, never through this route.
        const selfRefusal = refuseSelfPinAction(c, getSyncEngine());
        if (selfRefusal) return selfRefusal;
        const target = resolveTarget(c);
        if (target.kind === "response") return target.response;
        const key = c.req.param("key");
        if (target.kind === "local") {
          return pinSaveResponse(c, target.pins, target.record, key);
        }
        return proxyWrite(
          c,
          target.service,
          pinPath(key, "/save"),
          "POST",
          undefined,
          PIN_FILES_MISSING_ROUTE
        );
      })
  );

  app.post(
    "/sessions/:id/pin-answers",
    cataloged(
      defineCapability({
        id: "session-introspection.submit-pin-answers",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Send the operator's staged pin answers to a session as one user message and record them on its pins, each against the revision it was made on. Refuses an agent caller.",
        whenToUse: "When the user submits staged pin answers.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/sessions/:id/pin-answers",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    gate,
    submitLimiter,
    c =>
      withPinErrors(c, errorLogger, "pin-answers", async () => {
        const agent = refuseAgentPinAnswers(c);
        if (agent) return agent;
        const read = await readPinBody(c, PIN_SUBMISSION_REQUEST_MAX_BYTES);
        if (!read.ok) return read.response;
        const body = PinSubmissionRequestSchema.safeParse(read.body);
        if (!body.success) {
          return c.json({ error: describePinIssues(body.error) }, 400);
        }
        const target = resolveTarget(c);
        if (target.kind === "response") return target.response;
        // From the authenticated context, never the body (#3331).
        const origin = { class: "web-user" as const, uid: c.get("userId") };
        if (target.kind === "local") {
          return pinSubmissionResponse(
            c,
            await submitPinAnswers(target.engine, target.record, body.data, {
              origin,
              timeZone: await getTimeZone(body.data.timeZone),
            })
          );
        }
        const sessionId = c.req.param("id");
        const result = await target.service.proxyPinRequest(
          sessionId,
          "/pin-answers",
          "POST",
          c.get("namespace"),
          { ...body.data, origin }
        );
        // A peer running A to C serves pins but not this route, so "does not
        // support pins" would be false; nothing was sent.
        if (result.type === "error" && isPeerWithoutPins(result)) {
          return c.json(
            {
              error: "The session's node cannot receive pin answers yet",
              code: "pin_answers_unsupported",
            },
            501
          );
        }
        return proxiedPinResponse(
          c,
          result,
          PinSubmissionResponseSchema,
          data => {
            options
              .getNodeRegistry()
              ?.updateCachedSessionOpenPinCount(sessionId, data.openPinCount);
          }
        );
      })
  );

  return app;
}
