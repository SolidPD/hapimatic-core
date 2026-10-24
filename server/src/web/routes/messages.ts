// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { SyncEngine } from "../../sync/syncEngine";
import type { NodeRegistry } from "../../federation/nodeRegistry";
import type { ErrorLogger } from "../../logging/errorLogger";
import { proxyTransportFailure } from "./routeErrorHelper";
import {
  federationReadSignal,
  readProxyJson,
} from "../../federation/proxyFetchSignal";
import type { WebAppEnv } from "../middleware/auth";
import type { MessageOrigin } from "../../sync/sentFrom";
import { defineCapability } from "@hapi/protocol";
import { requireSessionFromParam, requireSyncEngine } from "./guards";
import { cataloged } from "../../capabilities/cataloged";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  beforeSeq: z.coerce.number().int().min(1).optional(),
  afterSeq: z.coerce.number().int().min(0).optional(),
});

/** #3331: origin-class provenance carried ONLY on the federation forward body
 *  (hub → owning node, peer-token-authenticated). A client's own POST never
 *  supplies this — the local route DERIVES origin from the authenticated context
 *  (headers + JWT) so a client cannot forge it. `.passthrough()` forward-compat. */
const messageOriginSchema = z
  .object({
    class: z.enum(["web-user", "cli-api", "federation", "bare-terminal"]),
    uid: z.number().optional(),
    sessionId: z.string().optional(),
  })
  .passthrough();

const sendMessageBodySchema = z.object({
  text: z.string().min(1),
  localId: z.string().min(1).optional(),
  origin: messageOriginSchema.optional(),
});

/**
 * Derive the origin-class of a client send from the AUTHENTICATED context
 * (ruling D6(a)) — never from the request body (a client cannot forge it). A CLI
 * caller carries its own `X-Hapi-Session-Id`; a web caller has only the JWT
 * `uid` (web and CLI mint identical JWTs, so the header is the sole
 * discriminator). An omitted header degrades a CLI send to `web-user` — the
 * documented, NON-adversarial-proof limitation (registry §5.3).
 */
function deriveClientOrigin(c: Context<WebAppEnv>): MessageOrigin {
  const cliSessionId = c.req.header("X-Hapi-Session-Id");
  if (cliSessionId) {
    return { class: "cli-api", sessionId: cliSessionId };
  }
  return { class: "web-user", uid: c.get("userId") };
}

export function createMessagesRoutes(
  getSyncEngine: () => SyncEngine | null,
  options?: {
    getNodeRegistry?: () => NodeRegistry | null;
    federationApiToken?: string | null;
    /** Logs federation proxy transport failures (#5404). */
    errorLogger?: ErrorLogger | null;
  }
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  app.get(
    "/sessions/:id/messages",
    cataloged(
      defineCapability({
        id: "messaging.list-messages",
        domain: "messaging",
        surface: "rest",
        description:
          "Return a page of a session's message transcript (its conversation history), oldest- or newest-anchored via limit/beforeSeq/afterSeq.",
        whenToUse: "When the user wants to read a session's past messages.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/sessions/:id/messages",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) {
        return engine;
      }

      const sessionResult = requireSessionFromParam(c, engine);
      if (!(sessionResult instanceof Response)) {
        // Local session found — serve locally
        const parsed = querySchema.safeParse(c.req.query());
        const limit = parsed.success ? (parsed.data.limit ?? 50) : 50;
        const afterSeq = parsed.success ? (parsed.data.afterSeq ?? null) : null;
        const beforeSeq = parsed.success
          ? (parsed.data.beforeSeq ?? null)
          : null;

        if (afterSeq !== null) {
          const messages = engine.getMessagesAfter(sessionResult.sessionId, {
            afterSeq,
            limit,
          });
          return c.json({ messages });
        }

        return c.json(
          engine.getMessagesPage(sessionResult.sessionId, { limit, beforeSeq })
        );
      }

      // Federation fallback: proxy to remote node
      const registry = options?.getNodeRegistry?.();
      if (registry) {
        const sessionId = c.req.param("id");
        const node = registry.findNodeForSession(sessionId);
        if (node) {
          const headers: Record<string, string> = {};
          if (options?.federationApiToken) {
            headers["Authorization"] = `Bearer ${options.federationApiToken}`;
          }
          // Forward query parameters to the remote node
          const url = new URL(
            `/api/federation/sessions/${encodeURIComponent(sessionId)}/messages`,
            node.url
          );
          const query = c.req.query();
          if (query.limit) url.searchParams.set("limit", query.limit);
          if (query.beforeSeq)
            url.searchParams.set("beforeSeq", query.beforeSeq);
          if (query.afterSeq) url.searchParams.set("afterSeq", query.afterSeq);

          try {
            // #5375: bounded read-only proxy fetch.
            const resp = await fetch(url.toString(), {
              headers,
              signal: federationReadSignal(c.req.raw.signal),
            });
            if (resp.ok) {
              // #5433: an empty OK body reads as {} on every Bun version; a
              // cut or unparseable one rethrows into the catch below.
              const body = (await readProxyJson(resp)) ?? {};
              return c.json(body as Record<string, unknown>);
            }
            const body = (await readProxyJson(resp)) ?? {};
            return c.json(
              body as Record<string, unknown>,
              resp.status as 400 | 404 | 409 | 500 | 503
            );
          } catch (error) {
            return proxyTransportFailure(c, error, {
              errorLogger: options?.errorLogger,
              nodeId: node.nodeId,
            });
          }
        }
      }

      return sessionResult;
    }
  );

  app.post(
    "/sessions/:id/messages",
    cataloged(
      defineCapability({
        id: "messaging.send-message",
        domain: "messaging",
        surface: "rest",
        description:
          "Send a text message to a session; a gate-class message hook may deny delivery and the denial is returned to the caller.",
        whenToUse: "When the user wants to send a message to a session.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/sessions/:id/messages",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
        example: '{"text":"run the test suite and report failures"}',
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) {
        return engine;
      }

      const sessionResult = requireSessionFromParam(c, engine, {
        requireActive: true,
      });
      if (!(sessionResult instanceof Response)) {
        // Local session found — handle locally
        const body = await c.req.json().catch(() => null);
        const parsed = sendMessageBodySchema.safeParse(body);
        if (!parsed.success) {
          return c.json({ error: "Invalid body" }, 400);
        }

        const result = await engine.sendMessage(sessionResult.sessionId, {
          text: parsed.data.text,
          localId: parsed.data.localId,
          sentFrom: "webapp",
          // #3331 (Task 5): origin derived from the authenticated context, never
          // the client body. The hardcoded sentFrom stays "webapp"; the origin
          // field is what fixes the CLI-mislabel and carries provenance.
          origin: deriveClientOrigin(c),
        });
        // #3124: a gate-class message hook can DENY delivery. Surface the typed
        // denial instead of a bare {ok:true} — a silent {ok:true} would vanish the
        // user's message with no signal. The prompt-blocked toast also fires from
        // MessageService, so the denial is user-visible either way.
        if (result.delivered === false) {
          // #3579: carry the server-resolved outcome + copy params so the client
          // renders the catalogue title/copy + recovery chip (the web never
          // re-resolves — Key Decision: resolve server-side).
          return c.json({
            ok: false,
            denied: {
              hookId: result.hookId,
              reason: result.reason,
              outcome: result.outcome,
              ...(result.params ? { params: result.params } : {}),
            },
          });
        }
        // #2357: additive delivery-signal fields. `ok:true` is preserved for
        // existing consumers (R4). `accepted` = the send succeeded (persisted +
        // emitted on the /cli socket); it is deliberately NOT "delivered" — the
        // server cannot know at response time whether the CLI-side consumer has
        // injected the message. A mid-turn target (`thinking`) receives it at its
        // next turn boundary; `queueDepth` is the #1325 UI-queue backlog this
        // POSTed message jumps ahead of (0 on the common immediate path).
        const { session } = sessionResult;
        return c.json({
          ok: true,
          accepted: true,
          targetThinking: session.thinking,
          expectedInjection: session.thinking ? "next-turn-boundary" : "now",
          queueDepth: engine.listQueuedMessages(
            sessionResult.sessionId,
            session.namespace
          ).length,
          message: { id: result.message.id, seq: result.message.seq },
        });
      }

      // Federation fallback: proxy to remote node
      const registry = options?.getNodeRegistry?.();
      if (registry) {
        const sessionId = c.req.param("id");
        const node = registry.findNodeForSession(sessionId);
        if (node) {
          const headers: Record<string, string> = {
            "Content-Type": "application/json",
          };
          if (options?.federationApiToken) {
            headers["Authorization"] = `Bearer ${options.federationApiToken}`;
          }

          // Read the body once for forwarding
          const body = await c.req.json().catch(() => null);
          const parsed = sendMessageBodySchema.safeParse(body);
          if (!parsed.success) {
            return c.json({ error: "Invalid body" }, 400);
          }

          try {
            // [perf] issue #2147 (interaction, send-hop): time the hub→remote
            // message-proxy fetch — the send half of a remote session's TTFT.
            // (This bare fetch has NO timeout/AbortSignal — recorded as a Task 5
            // follow-up candidate.) grep `[perf][interact]`.
            const perfSendT0 = Date.now();
            const resp = await fetch(
              `${node.url}/api/federation/sessions/${encodeURIComponent(sessionId)}/messages`,
              {
                method: "POST",
                headers,
                // #3331 (Task 10): forward the origin the hub derived from the
                // authenticated client — otherwise zod strips it and the owning
                // node mints an empty approved_by. The receiver re-classes it
                // `federation` while preserving the original uid/session id.
                body: JSON.stringify({
                  ...parsed.data,
                  origin: deriveClientOrigin(c),
                }),
              }
            );
            console.log(
              `[perf][interact] series=send-hop node=${node.nodeId} key=${sessionId} ms=${Date.now() - perfSendT0}`
            );
            if (resp.ok) {
              // #3124: forward the remote node's actual body — the owning node runs
              // the message-hook stage, so a gate denial arrives as {ok:false,
              // denied} at HTTP 200. Returning a bare {ok:true} here would mask it.
              const okBody = await resp.json().catch(() => ({ ok: true }));
              return c.json(okBody as Record<string, unknown>);
            }
            // #5433: a body cut off mid-read rethrows into the catch below
            // (logged 502); an empty or unparseable error body keeps {}.
            const respBody = (await readProxyJson(resp)) ?? {};
            return c.json(
              respBody as Record<string, unknown>,
              resp.status as 400 | 404 | 409 | 500 | 503
            );
          } catch (error) {
            return proxyTransportFailure(c, error, {
              errorLogger: options?.errorLogger,
              nodeId: node.nodeId,
            });
          }
        }
      }

      return sessionResult;
    }
  );

  return app;
}
