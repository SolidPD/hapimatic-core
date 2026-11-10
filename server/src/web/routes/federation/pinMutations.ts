// SPDX-License-Identifier: AGPL-3.0-only
import { Hono, type Context } from "hono";
import {
  defineCapability,
  describePinIssues,
  parsePinUpsert,
  PinDeadlineRequestSchema,
  PinKeySchema,
  PinListQuerySchema,
  PinResolveRequestSchema,
  PinStarRequestSchema,
  PIN_SUBMISSION_REQUEST_MAX_BYTES,
  PinSubmissionRequestSchema,
} from "@hapi/protocol";

import { cataloged } from "../../../capabilities/cataloged";
import {
  browserOrHostTimeZone,
  submitPinAnswers,
} from "../../../sync/pinSubmission";
import type { Session, SyncEngine } from "../../../sync/syncEngine";
import type { WebAppEnv } from "../../middleware/auth";
import { pinsGate } from "../../middleware/pinsGate";
import {
  forwardedOrigin,
  pinAnswerResponse,
  pinDeadlineInput,
  pinDeadlineRangeError,
  pinDeadlineResponse,
  pinFolderResponse,
  pinSaveResponse,
  pinSubmissionResponse,
  pinUpsertResponse,
  pinWriteResponse,
  readPinBody,
  refuseReservedPinKey,
  withPinErrors,
} from "../pinRouteHelpers";
import {
  checkCallerNamespace,
  checkFederationToken,
  type FederationDeps,
} from "./shared";

/**
 * Peer-incoming pin receivers (issue #6447, epic #6446): the owning node's half of
 * every proxied pin request. A pin lives here, beside its session.
 *
 * Every route checks, in order: the gate, the federation token (401), the engine
 * (503), the session (404), then the STRICT caller namespace, which a receiver
 * added after #6224 must use (server/CLAUDE.md). All of that runs before any body
 * is read or anything is written.
 *
 * These call `engine.pins` directly and never `SessionService`, because a peer
 * does not proxy to itself (#1063). `app.METHOD(literal path, cataloged(...))` stays
 * at each site, because the catalog generator reads route sites.
 */
export function createPinMutationRoutes(deps: FederationDeps): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  const gate = pinsGate(deps.pinsEnabled === true);

  type Local =
    | { ok: true; engine: SyncEngine; session: Session }
    | { ok: false; response: Response };

  const requireLocalSession = (c: Context<WebAppEnv>): Local => {
    if (!checkFederationToken(deps, c.req.header("authorization"))) {
      return { ok: false, response: c.json({ error: "Unauthorized" }, 401) };
    }
    const engine = deps.getSyncEngine();
    if (!engine) {
      return { ok: false, response: c.json({ error: "Not connected" }, 503) };
    }
    const session = engine.getSession(c.req.param("id") as string);
    if (!session) {
      return {
        ok: false,
        response: c.json({ error: "Session not found" }, 404),
      };
    }
    const refused = checkCallerNamespace(c, session);
    if (refused) return { ok: false, response: refused };
    return { ok: true, engine, session };
  };

  const errors = deps.errorLogger ?? null;
  // #6452: this node's zone, because its loop fires the pick.
  const preferenceZone = async () =>
    (await deps.getPinPreferenceTimeZone?.()) ?? null;

  app.get(
    "/federation/sessions/:id/pins",
    cataloged(
      defineCapability({
        id: "session-introspection.api-federation-sessions-pins-list",
        domain: "session-introspection",
        surface: "rest",
        description:
          "List a session's pins on the node that owns it. Peer-incoming; the hub proxies here for a remote-owned session.",
        whenToUse:
          "When listing the pins of a session whose process lives on a remote federation node.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/federation/sessions/:id/pins",
        },
        auth: "federation-token",
        riskTier: "readonly",
        availability: { scope: "operator" },
      })
    ),
    gate,
    c =>
      withPinErrors(c, errors, "federation-pins-list", async () => {
        const local = requireLocalSession(c);
        if (!local.ok) return local.response;
        const query = PinListQuerySchema.safeParse(c.req.query());
        if (!query.success) {
          return c.json({ error: describePinIssues(query.error) }, 400);
        }
        return c.json({
          ...local.engine.pins.list(local.session.id, query.data),
          timeZone: await preferenceZone(),
        });
      })
  );

  app.get(
    "/federation/sessions/:id/pins/:key",
    cataloged(
      defineCapability({
        id: "session-introspection.api-federation-sessions-pins-get",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Read one of a session's pins on the node that owns it. Peer-incoming; the hub proxies here for a remote-owned session.",
        whenToUse:
          "When reading a pin of a session whose process lives on a remote federation node.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/federation/sessions/:id/pins/:key",
        },
        auth: "federation-token",
        riskTier: "readonly",
        availability: { scope: "operator" },
      })
    ),
    gate,
    c =>
      withPinErrors(c, errors, "federation-pins-get", async () => {
        const local = requireLocalSession(c);
        if (!local.ok) return local.response;
        const found = local.engine.pins.get(
          local.session.id,
          c.req.param("key")
        );
        return found
          ? c.json({ ...found, timeZone: await preferenceZone() })
          : c.json({ error: "Pin not found" }, 404);
      })
  );

  app.put(
    "/federation/sessions/:id/pins/:key",
    cataloged(
      defineCapability({
        id: "session-introspection.api-federation-sessions-pins-put",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Post or update a pin on the node that owns the session. Peer-incoming; a hub's CLI route proxies here for a remote-owned session.",
        whenToUse:
          "When posting a pin to a session whose process lives on a remote federation node.",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/api/federation/sessions/:id/pins/:key",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    gate,
    c =>
      withPinErrors(c, errors, "federation-pins-put", async () => {
        const local = requireLocalSession(c);
        if (!local.ok) return local.response;
        const read = await readPinBody(c);
        if (!read.ok) return read.response;
        const parsed = parsePinUpsert(c.req.param("key"), read.body);
        if (!parsed.ok) return c.json({ error: parsed.error }, 400);
        return pinUpsertResponse(
          c,
          local.engine.pins.upsert(local.session, parsed.content, {
            reopen: parsed.reopen,
            mustExist: c.req.query("mustExist") === "1",
          })
        );
      })
  );

  app.post(
    "/federation/sessions/:id/pins/:key/withdraw",
    cataloged(
      defineCapability({
        id: "session-introspection.api-federation-sessions-pins-withdraw",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Withdraw a pin on the node that owns the session. Peer-incoming; a hub's CLI route proxies here for a remote-owned session.",
        whenToUse:
          "When withdrawing a pin of a session whose process lives on a remote federation node.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/sessions/:id/pins/:key/withdraw",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    gate,
    c =>
      withPinErrors(c, errors, "federation-pins-withdraw", () => {
        const local = requireLocalSession(c);
        if (!local.ok) return local.response;
        const reserved = refuseReservedPinKey(c, c.req.param("key"));
        if (reserved) return reserved;
        return pinWriteResponse(
          c,
          local.engine.pins.withdraw(local.session, c.req.param("key"))
        );
      })
  );

  app.post(
    "/federation/sessions/:id/pins/:key/resolve",
    cataloged(
      defineCapability({
        id: "session-introspection.api-federation-sessions-pins-resolve",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Record a decision an agent reports on a pin, on the node that owns the session. Peer-incoming; a hub's CLI route proxies here for a remote-owned session.",
        whenToUse:
          "When resolving a pin of a session whose process lives on a remote federation node.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/sessions/:id/pins/:key/resolve",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    gate,
    c =>
      withPinErrors(c, errors, "federation-pins-resolve", async () => {
        const local = requireLocalSession(c);
        if (!local.ok) return local.response;
        const reserved = refuseReservedPinKey(c, c.req.param("key"));
        if (reserved) return reserved;
        const read = await readPinBody(c);
        if (!read.ok) return read.response;
        const body = PinResolveRequestSchema.safeParse(read.body);
        if (!body.success) {
          return c.json({ error: describePinIssues(body.error) }, 400);
        }
        return pinAnswerResponse(
          c,
          local.engine.pins.answer(local.session, c.req.param("key"), {
            ...body.data,
            by: "agent",
            via: "chat",
          })
        );
      })
  );

  app.post(
    "/federation/sessions/:id/pins/:key/dismiss",
    cataloged(
      defineCapability({
        id: "session-introspection.api-federation-sessions-pins-dismiss",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Dismiss a pin on the node that owns the session. Peer-incoming; the hub proxies here for a remote-owned session.",
        whenToUse:
          "When dismissing a pin of a session whose process lives on a remote federation node.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/sessions/:id/pins/:key/dismiss",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    gate,
    c =>
      withPinErrors(c, errors, "federation-pins-dismiss", () => {
        const local = requireLocalSession(c);
        if (!local.ok) return local.response;
        return pinWriteResponse(
          c,
          local.engine.pins.dismissForOperator(
            local.session,
            c.req.param("key")
          )
        );
      })
  );

  app.put(
    "/federation/sessions/:id/pins/:key/star",
    cataloged(
      defineCapability({
        id: "session-introspection.api-federation-sessions-pins-star",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Star or unstar a pin on the node that owns the session. Peer-incoming; the hub proxies here for a remote-owned session.",
        whenToUse:
          "When starring a pin of a session whose process lives on a remote federation node.",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/api/federation/sessions/:id/pins/:key/star",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    gate,
    c =>
      withPinErrors(c, errors, "federation-pins-star", async () => {
        const local = requireLocalSession(c);
        if (!local.ok) return local.response;
        const read = await readPinBody(c);
        if (!read.ok) return read.response;
        const body = PinStarRequestSchema.safeParse(read.body);
        if (!body.success) {
          return c.json({ error: describePinIssues(body.error) }, 400);
        }
        return pinWriteResponse(
          c,
          local.engine.pins.setStarred(
            local.session,
            c.req.param("key"),
            body.data.starred
          )
        );
      })
  );

  app.put(
    "/federation/sessions/:id/pins/:key/seen",
    cataloged(
      defineCapability({
        id: "session-introspection.api-federation-sessions-pins-seen",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Mark a pin seen on the node that owns the session. Peer-incoming; the hub proxies here for a remote-owned session.",
        whenToUse:
          "When marking a pin seen on a session whose process lives on a remote federation node.",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/api/federation/sessions/:id/pins/:key/seen",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    gate,
    c =>
      withPinErrors(c, errors, "federation-pins-seen", () => {
        const local = requireLocalSession(c);
        if (!local.ok) return local.response;
        return pinWriteResponse(
          c,
          local.engine.pins.markSeen(local.session, c.req.param("key"))
        );
      })
  );

  app.put(
    "/federation/sessions/:id/pins/:key/deadline",
    cataloged(
      defineCapability({
        id: "session-introspection.api-federation-sessions-pins-deadline",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Move, stop, or restart a pin's automatic pick on the node that owns the session. Peer-incoming; the hub proxies here for a remote-owned session.",
        whenToUse:
          "When changing the automatic pick of a pin whose session lives on a remote federation node.",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/api/federation/sessions/:id/pins/:key/deadline",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    gate,
    c =>
      withPinErrors(c, errors, "federation-pins-deadline", async () => {
        const local = requireLocalSession(c);
        if (!local.ok) return local.response;
        const read = await readPinBody(c);
        if (!read.ok) return read.response;
        const body = PinDeadlineRequestSchema.safeParse(read.body);
        if (!body.success) {
          return c.json({ error: describePinIssues(body.error) }, 400);
        }
        // Checked again here, against this node's clock, which the loop uses.
        const now = Date.now();
        const range = pinDeadlineRangeError(body.data, now);
        if (range) {
          return c.json(
            { error: range, code: "pin_deadline_out_of_range" },
            400
          );
        }
        return pinDeadlineResponse(
          c,
          local.engine.pins.setDeadline(
            local.session,
            c.req.param("key"),
            pinDeadlineInput(body.data),
            now
          )
        );
      })
  );

  app.post(
    "/federation/sessions/:id/pin-answers",
    cataloged(
      defineCapability({
        id: "session-introspection.api-federation-sessions-pin-answers",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Send the operator's staged pin answers as one user message and record them, on the node that owns the session. Peer-incoming; the hub proxies here for a remote-owned session.",
        whenToUse:
          "When submitting pin answers to a session whose process lives on a remote federation node.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/sessions/:id/pin-answers",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    gate,
    c =>
      withPinErrors(c, errors, "federation-pin-answers", async () => {
        const local = requireLocalSession(c);
        if (!local.ok) return local.response;
        const read = await readPinBody(c, PIN_SUBMISSION_REQUEST_MAX_BYTES);
        if (!read.ok) return read.response;
        // The hub adds `origin` beside the operator's request; the request
        // itself is strict, so the two are read apart.
        const { origin, ...rest } =
          read.body && typeof read.body === "object"
            ? (read.body as Record<string, unknown>)
            : {};
        const body = PinSubmissionRequestSchema.safeParse(rest);
        if (!body.success) {
          return c.json({ error: describePinIssues(body.error) }, 400);
        }
        return pinSubmissionResponse(
          c,
          await submitPinAnswers(local.engine, local.session, body.data, {
            origin: forwardedOrigin(origin),
            timeZone: await (deps.getPinAnswersTimeZone?.(body.data.timeZone) ??
              browserOrHostTimeZone(body.data.timeZone)),
          })
        );
      })
  );

  app.post(
    "/federation/sessions/:id/pins/:key/save",
    cataloged(
      defineCapability({
        id: "session-introspection.api-federation-sessions-pins-save",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Copy a pin's files into its folder under GeneratedFiles/pins/ and record the save, on the node that owns the session. Peer-incoming; the hub proxies here for a remote-owned session.",
        whenToUse:
          "When saving a pin's files for a session whose process lives on a remote federation node.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/sessions/:id/pins/:key/save",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    gate,
    c =>
      withPinErrors(c, errors, "federation-pins-save", async () => {
        const local = requireLocalSession(c);
        if (!local.ok) return local.response;
        return pinSaveResponse(
          c,
          local.engine.pins,
          local.session,
          c.req.param("key")
        );
      })
  );

  app.post(
    "/federation/sessions/:id/pins/:key/folder",
    cataloged(
      defineCapability({
        id: "session-introspection.api-federation-sessions-pins-folder",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Make a pin's folder in the session's folder and name it, on the node that owns the session. Peer-incoming; the hub proxies here for a remote-owned session.",
        whenToUse:
          "When an agent asks for a pin folder for a session whose process lives on a remote federation node.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/sessions/:id/pins/:key/folder",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    gate,
    c =>
      withPinErrors(c, errors, "federation-pins-folder", async () => {
        const local = requireLocalSession(c);
        if (!local.ok) return local.response;
        const key = c.req.param("key");
        const parsedKey = PinKeySchema.safeParse(key);
        if (!parsedKey.success) {
          return c.json(
            { error: `The pin key ${describePinIssues(parsedKey.error)}` },
            400
          );
        }
        return pinFolderResponse(c, local.session, key);
      })
  );

  return app;
}
