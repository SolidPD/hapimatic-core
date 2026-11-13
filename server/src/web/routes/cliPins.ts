// SPDX-License-Identifier: AGPL-3.0-only
import { Hono, type Context, type MiddlewareHandler } from "hono";
import {
  DECISION_SIGNAL_MAX_CHARS,
  defineCapability,
  describePinIssues,
  normalizePinId,
  parsePinUpsert,
  PinFolderResponseSchema,
  PinGetResponseSchema,
  PinKeySchema,
  PinListQuerySchema,
  PinListResponseSchema,
  PinMutationResponseSchema,
  PinResolveRequestSchema,
} from "@hapi/protocol";
import { z } from "zod";

import { cataloged } from "../../capabilities/cataloged";
import { configuration } from "../../configuration";
import type { NodeRegistry } from "../../federation/nodeRegistry";
import type { ErrorLogger } from "../../logging/errorLogger";
import type { SessionService } from "../../services/sessionService";
import { enginePinByIdDeps, lookupPinById } from "../../sync/pinById";
import type { PinSessionRef, PinService } from "../../sync/pinService";
import type { SyncEngine } from "../../sync/syncEngine";
import { parseAccessToken } from "../../utils/accessToken";
import { constantTimeEquals } from "../../utils/crypto";
import { pinsGate } from "../middleware/pinsGate";
import { createRateLimiter } from "../middleware/rateLimit";
import { resolveSessionForNamespace, type CliEnv } from "./cli";
import {
  invalidPinIdResponse,
  PIN_FILES_MISSING_ROUTE,
  pinAnswerResponse,
  pinByIdLimiters,
  pinByIdResponse,
  pinFolderResponse,
  pinPath,
  pinUpsertResponse,
  pinWriteResponse,
  proxiedPinResponse,
  readPinBody,
  refuseForeignPinWrite,
  refuseReservedPinKey,
  withPinErrors,
} from "./pinRouteHelpers";

const bearerSchema = z.string().regex(/^Bearer\s+\S.*$/i);

/** #6455: the turn check's body. Strict, so a detect request cannot carry text. */
const TurnEndRequestSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("nudge"),
    text: z.string().max(DECISION_SIGNAL_MAX_CHARS),
    turnStartedAt: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({
    mode: z.literal("detect"),
    turnStartedAt: z.number().int().nonnegative().optional(),
  }),
]);

/**
 * CLI-token pin routes (issue #6447, epic #6446), what #6448's MCP tools call. A
 * sibling of `cli.ts`, which is at its `max-lines` ceiling.
 *
 * An update is a full replace rather than a merge: `pin_post` is this `PUT`, and
 * `pin_update` adds `?mustExist=1`. A merge could leave the plain-text rendition
 * stale, and the agent re-posts a few hundred tokens at most.
 *
 * Agents post to their own node, so the session is local today. A session owned by
 * another node goes there through the same receivers the web routes use, because a
 * pin lives beside its session.
 */
export function createCliPinRoutes(
  getSyncEngine: () => SyncEngine | null,
  options: {
    pinsEnabled: boolean;
    getSessionService: () => Pick<SessionService, "proxyPinRequest"> | null;
    getNodeRegistry: () => Pick<
      NodeRegistry,
      | "locateSession"
      | "locateSessionByTag"
      | "updateCachedSessionOpenPinCount"
      // #6574: the by-ID read's fan-out.
      | "getNodeSummaries"
      | "getPinByIdOnNode"
      | "isAwaitingInitialPoll"
      | "getAllRemoteSessions"
    > | null;
    /** #6574: this node, named on a local by-ID hit. */
    localNode?: () => { nodeId: string; nodeLabel: string } | null;
    /** #6574: this node's pin time zone, for a local by-ID hit. */
    getPreferenceTimeZone?: () => Promise<string | null>;
    errorLogger?: ErrorLogger | null;
  }
): Hono<CliEnv> {
  const app = new Hono<CliEnv>();
  const gate = pinsGate(options.pinsEnabled);
  const { errorLogger } = options;

  // Bearer auth — DELIBERATELY replicated from createCliRoutes, as impactArtifact.ts
  // does. In buildWebApp that router's `*` middleware also covers these paths, but
  // only because it is mounted first, and these routes must not depend on the order.
  // #6574: one named check for both route families.
  const requireCliToken: MiddlewareHandler<CliEnv> = async (c, next) => {
    if (!options.pinsEnabled) return next();
    const raw = c.req.header("authorization");
    if (!raw) return c.json({ error: "Missing Authorization header" }, 401);
    const parsed = bearerSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "Invalid Authorization header" }, 401);
    }
    const token = parsed.data.replace(/^Bearer\s+/i, "");
    const parsedToken = parseAccessToken(token);
    if (
      !parsedToken ||
      !constantTimeEquals(parsedToken.baseToken, configuration.cliApiToken)
    ) {
      return c.json({ error: "Invalid token" }, 401);
    }
    c.set("namespace", parsedToken.namespace);
    return await next();
  };
  app.use("/sessions/:id/pins/*", requireCliToken);
  app.use("/pins/by-id/*", requireCliToken);

  // Keyed per session: the default key is the namespace, and a node has one, so one
  // looping session would otherwise exhaust every lane on it. Keyed on the resolved
  // id, because an id, a tag, and a Claude session id all name the same session.
  const writeLimiter = createRateLimiter({
    name: "cli-pins",
    limit: 120,
    keyFn: c => {
      const namespace = c.get("namespace");
      const idOrTag = c.req.param("id") as string;
      const engine = getSyncEngine();
      const resolved = engine
        ? resolveSessionForNamespace(engine, idOrTag, namespace)
        : null;
      return `${namespace}:${resolved?.ok ? resolved.session.id : idOrTag}`;
    },
  });

  /** A proxied write: the hub's cached count follows the peer's answer (R10). */
  const followCount =
    (sessionId: string) =>
    (data: { openPinCount: number }): void => {
      options
        .getNodeRegistry()
        ?.updateCachedSessionOpenPinCount(sessionId, data.openPinCount);
    };

  // #6574: each target carries its session's tag, for the owner-only write floor.
  type Target =
    | {
        kind: "local";
        pins: PinService;
        session: PinSessionRef;
        tag: string | null;
      }
    | {
        kind: "remote";
        service: Pick<SessionService, "proxyPinRequest">;
        sessionId: string;
        tag: string | null;
      }
    | { kind: "response"; response: Response };

  /** The write floor's view of a resolved target, or null for a response target. */
  const ownerOf = (target: Target) =>
    target.kind === "local"
      ? { id: target.session.id, tag: target.tag }
      : target.kind === "remote"
        ? { id: target.sessionId, tag: target.tag }
        : null;

  const resolveTarget = (c: Context): Target => {
    const engine = getSyncEngine();
    if (!engine) {
      return {
        kind: "response",
        response: c.json({ error: "Not ready" }, 503),
      };
    }
    const namespace = c.get("namespace") as string;
    const idOrTag = c.req.param("id") as string;
    const resolved = resolveSessionForNamespace(engine, idOrTag, namespace);
    if (resolved.ok) {
      // Always the id, because HAPI_SESSION_ID is a tag and the foreign key needs it.
      return {
        kind: "local",
        pins: engine.pins,
        session: { id: resolved.session.id, namespace },
        tag: resolved.session.tag ?? null,
      };
    }
    const notFound: Target = {
      kind: "response",
      response: c.json({ error: "Session not found" }, 404),
    };
    // resolveSessionForNamespace answers 403 for another namespace's session, an
    // existence signal #1097 forbids on a new route.
    if (resolved.status === 403) return notFound;
    const registry = options.getNodeRegistry();
    const located =
      registry?.locateSession(idOrTag) ??
      registry?.locateSessionByTag(idOrTag) ??
      null;
    if (!located) return notFound;
    if (located.status === "offline") {
      return {
        kind: "response",
        response: c.json(
          {
            error: `The session's node ${located.nodeId} is offline, so the pin request was not applied`,
            code: "node_offline",
          },
          503
        ),
      };
    }
    const service = options.getSessionService();
    if (!service) return notFound;
    return {
      kind: "remote",
      service,
      sessionId: located.session.id,
      tag: located.session.tag ?? null,
    };
  };

  app.get(
    "/sessions/:id/pins",
    cataloged(
      defineCapability({
        id: "session-introspection.cli-list-pins",
        domain: "session-introspection",
        surface: "rest",
        description:
          "List a session's pins with their answer history, so an agent that lost its context can re-read instead of asking again.",
        whenToUse:
          "When an agent re-reads the pins it has raised, for example after a compaction.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/cli/sessions/:id/pins",
        },
        auth: "cli-token",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    gate,
    c =>
      withPinErrors(c, errorLogger, "cli-pins-list", async () => {
        const query = PinListQuerySchema.safeParse(c.req.query());
        if (!query.success) {
          return c.json({ error: describePinIssues(query.error) }, 400);
        }
        const target = resolveTarget(c);
        if (target.kind === "response") return target.response;
        if (target.kind === "local") {
          return c.json(target.pins.list(target.session.id, query.data));
        }
        const params = new URLSearchParams({
          limit: String(query.data.limit),
          ...(query.data.status ? { status: query.data.status } : {}),
        });
        const result = await target.service.proxyPinRequest(
          target.sessionId,
          `/pins?${params.toString()}`,
          "GET",
          c.get("namespace")
        );
        return proxiedPinResponse(c, result, PinListResponseSchema);
      })
  );

  app.get(
    "/sessions/:id/pins/:key",
    cataloged(
      defineCapability({
        id: "session-introspection.cli-get-pin",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Read one of a session's pins by its key, with its answer history.",
        whenToUse: "When an agent re-reads one pin it has raised.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/cli/sessions/:id/pins/:key",
        },
        auth: "cli-token",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    gate,
    c =>
      withPinErrors(c, errorLogger, "cli-pins-get", async () => {
        const target = resolveTarget(c);
        if (target.kind === "response") return target.response;
        const key = c.req.param("key");
        if (target.kind === "local") {
          const found = target.pins.get(target.session.id, key);
          return found
            ? c.json(found)
            : c.json({ error: "Pin not found" }, 404);
        }
        const result = await target.service.proxyPinRequest(
          target.sessionId,
          pinPath(key),
          "GET",
          c.get("namespace")
        );
        return proxiedPinResponse(c, result, PinGetResponseSchema);
      })
  );

  app.put(
    "/sessions/:id/pins/:key",
    cataloged(
      defineCapability({
        id: "session-introspection.cli-put-pin",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Post a pin, or replace one, by its key: a decision or steps that need the operator. A re-post with the same content changes nothing. With mustExist=1 an absent key is an error.",
        whenToUse:
          "When an agent raises or updates a decision for the operator.",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/cli/sessions/:id/pins/:key",
        },
        auth: "cli-token",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    gate,
    writeLimiter,
    c =>
      withPinErrors(c, errorLogger, "cli-pins-put", async () => {
        // #6574: the target and the owner floor come before the body, so a
        // refused write never reads one.
        const target = resolveTarget(c);
        if (target.kind === "response") return target.response;
        const foreign = refuseForeignPinWrite(c, ownerOf(target));
        if (foreign) return foreign;
        const read = await readPinBody(c);
        if (!read.ok) return read.response;
        const key = c.req.param("key");
        const parsed = parsePinUpsert(key, read.body);
        if (!parsed.ok) return c.json({ error: parsed.error }, 400);
        const mustExist = c.req.query("mustExist") === "1";
        if (target.kind === "local") {
          return pinUpsertResponse(
            c,
            target.pins.upsert(target.session, parsed.content, {
              reopen: parsed.reopen,
              mustExist,
            })
          );
        }
        const result = await target.service.proxyPinRequest(
          target.sessionId,
          pinPath(key, mustExist ? "?mustExist=1" : ""),
          "PUT",
          c.get("namespace"),
          { ...parsed.content, ...(parsed.reopen ? { reopen: true } : {}) }
        );
        return proxiedPinResponse(
          c,
          result,
          PinMutationResponseSchema,
          followCount(target.sessionId)
        );
      })
  );

  app.post(
    "/sessions/:id/pins/:key/folder",
    cataloged(
      defineCapability({
        id: "session-introspection.cli-pin-folder",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Make the folder for one pin's files in the session's folder, kept out of git and deleted with the session, and name it and the GeneratedFiles/pins/ folder Save copies into.",
        whenToUse:
          "When an agent is about to write files a pin will show (pin_folder).",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/cli/sessions/:id/pins/:key/folder",
        },
        auth: "cli-token",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    gate,
    writeLimiter,
    c =>
      withPinErrors(c, errorLogger, "cli-pins-folder", async () => {
        const key = c.req.param("key");
        // #6453: before any path is built from it.
        const parsedKey = PinKeySchema.safeParse(key);
        if (!parsedKey.success) {
          return c.json(
            { error: `The pin key ${describePinIssues(parsedKey.error)}` },
            400
          );
        }
        const target = resolveTarget(c);
        if (target.kind === "response") return target.response;
        const foreign = refuseForeignPinWrite(c, ownerOf(target));
        if (foreign) return foreign;
        if (target.kind === "local") {
          const record = getSyncEngine()?.getSession(target.session.id);
          if (!record) return c.json({ error: "Session not found" }, 404);
          return pinFolderResponse(
            c,
            { ...target.session, metadata: record.metadata },
            key
          );
        }
        const result = await target.service.proxyPinRequest(
          target.sessionId,
          pinPath(key, "/folder"),
          "POST",
          c.get("namespace")
        );
        return proxiedPinResponse(
          c,
          result,
          PinFolderResponseSchema,
          undefined,
          PIN_FILES_MISSING_ROUTE
        );
      })
  );

  app.post(
    "/sessions/:id/pins/:key/withdraw",
    cataloged(
      defineCapability({
        id: "session-introspection.cli-withdraw-pin",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Withdraw a pin an agent raised, when the question no longer applies.",
        whenToUse: "When an agent no longer needs the operator's answer.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/cli/sessions/:id/pins/:key/withdraw",
        },
        auth: "cli-token",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    gate,
    writeLimiter,
    c =>
      withPinErrors(c, errorLogger, "cli-pins-withdraw", async () => {
        const key = c.req.param("key");
        const reserved = refuseReservedPinKey(c, key);
        if (reserved) return reserved;
        const target = resolveTarget(c);
        if (target.kind === "response") return target.response;
        const foreign = refuseForeignPinWrite(c, ownerOf(target));
        if (foreign) return foreign;
        if (target.kind === "local") {
          return pinWriteResponse(c, target.pins.withdraw(target.session, key));
        }
        const result = await target.service.proxyPinRequest(
          target.sessionId,
          pinPath(key, "/withdraw"),
          "POST",
          c.get("namespace")
        );
        return proxiedPinResponse(
          c,
          result,
          PinMutationResponseSchema,
          followCount(target.sessionId)
        );
      })
  );

  app.post(
    "/sessions/:id/pins/:key/resolve",
    cataloged(
      defineCapability({
        id: "session-introspection.cli-resolve-pin",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Record a decision the operator made in free text in the chat, so the pin does not go stale. Always recorded as reported by the agent, never as the operator's own answer.",
        whenToUse:
          "When an agent acts on a decision the operator gave in the chat rather than on the pin.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/cli/sessions/:id/pins/:key/resolve",
        },
        auth: "cli-token",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    gate,
    writeLimiter,
    c =>
      withPinErrors(c, errorLogger, "cli-pins-resolve", async () => {
        const key = c.req.param("key");
        const reserved = refuseReservedPinKey(c, key);
        if (reserved) return reserved;
        const target = resolveTarget(c);
        if (target.kind === "response") return target.response;
        const foreign = refuseForeignPinWrite(c, ownerOf(target));
        if (foreign) return foreign;
        const read = await readPinBody(c);
        if (!read.ok) return read.response;
        const body = PinResolveRequestSchema.safeParse(read.body);
        if (!body.success) {
          return c.json({ error: describePinIssues(body.error) }, 400);
        }
        if (target.kind === "local") {
          return pinAnswerResponse(
            c,
            target.pins.answer(target.session, key, {
              ...body.data,
              by: "agent",
              via: "chat",
            })
          );
        }
        const result = await target.service.proxyPinRequest(
          target.sessionId,
          pinPath(key, "/resolve"),
          "POST",
          c.get("namespace"),
          body.data
        );
        return proxiedPinResponse(
          c,
          result,
          PinMutationResponseSchema,
          followCount(target.sessionId)
        );
      })
  );

  // #6455: the Stop-hook turn check. `nudge` takes the final message's text and
  // writes nothing; `detect` takes NO text and reads the turn from the stored
  // messages, because `detected` is a kind only the server creates and the agent
  // holds this token. Under `/pins/*` for the bearer middleware; no POST exists on
  // `/pins/:key`, so a pin keyed `turn-end` stays readable and writable.
  app.post(
    "/sessions/:id/pins/turn-end",
    cataloged(
      defineCapability({
        id: "session-introspection.cli-pin-turn-end",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Check whether a turn ends on an ask no pin covers: nudge mode answers block or none; detect mode pins the unpinned ask from the stored messages.",
        whenToUse:
          "When Hapimatic's Stop hook decides whether to nudge the agent to pin a decision, or pins it anyway.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/cli/sessions/:id/pins/turn-end",
        },
        auth: "cli-token",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    gate,
    writeLimiter,
    c =>
      withPinErrors(c, errorLogger, "cli-pins-turn-end", async () => {
        const target = resolveTarget(c);
        if (target.kind === "response") return target.response;
        const foreign = refuseForeignPinWrite(c, ownerOf(target));
        if (foreign) return foreign;
        const read = await readPinBody(c);
        if (!read.ok) return read.response;
        const body = TurnEndRequestSchema.safeParse(read.body);
        if (!body.success) {
          return c.json({ error: describePinIssues(body.error) }, 400);
        }
        const engine = getSyncEngine();
        // Agents post to their own node; a session another node owns is not checked.
        if (target.kind === "remote" || !engine) {
          return c.json({ action: "none", why: "remote_session" });
        }
        if (body.data.mode === "nudge") {
          return c.json(engine.pinTurns.checkNudge(target.session, body.data));
        }
        return c.json(engine.pinTurns.detect(target.session, body.data));
      })
  );

  // #6574: read a pin by its ID, on this node or a peer, read-only. The same
  // lookup and answer as `GET /api/pins/by-id/:pinId`; route arguments are
  // `cataloged, gate, limiters`, so with Pins off it answers 404, never 429.
  const [byIdNamespaceLimiter, byIdSessionLimiter] = pinByIdLimiters(
    "cli-pins-by-id",
    getSyncEngine
  );
  app.get(
    "/pins/by-id/:pinId",
    cataloged(
      defineCapability({
        id: "session-introspection.cli-get-pin-by-id",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Read a pin by its ID (pin- and ten characters), read-only, wherever its session lives in the caller's namespace. Approval tokens in the pin are blanked.",
        whenToUse:
          "When an agent reads a pin another session raised, named by its ID (pin_get({id})).",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/cli/pins/by-id/:pinId",
        },
        auth: "cli-token",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    gate,
    byIdNamespaceLimiter,
    byIdSessionLimiter,
    c =>
      withPinErrors(c, errorLogger, "cli-pins-by-id", async () => {
        const pinId = normalizePinId(c.req.param("pinId"));
        if (!pinId) return invalidPinIdResponse(c);
        const engine = getSyncEngine();
        if (!engine) return c.json({ error: "Not ready" }, 503);
        const outcome = await lookupPinById(
          enginePinByIdDeps(engine, {
            registry: options.getNodeRegistry(),
            getTimeZone: options.getPreferenceTimeZone,
            localNode: options.localNode?.() ?? null,
          }),
          c.get("namespace"),
          pinId
        );
        return pinByIdResponse(c, outcome);
      })
  );
  return app;
}
