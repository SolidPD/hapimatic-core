// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { randomUUID } from "node:crypto";
import { defineCapability } from "@hapi/protocol";
import type { WebAppEnv } from "../../middleware/auth";
import { cataloged } from "../../../capabilities/cataloged";
import type { FederationDeps } from "./shared";
import { checkFederationToken } from "./shared";

export function createFederationEventRoutes(
  deps: FederationDeps
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  // ─── Node-to-node endpoint: GET /federation/events (all events) ─
  // SSE stream for ALL events on this node. The hub's NodeRegistry
  // maintains one persistent connection per node to receive real-time
  // updates and re-broadcast them through the hub's SSEManager.
  app.get(
    "/federation/events",
    cataloged(
      defineCapability({
        id: "session-introspection.federation-events",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Open a Server-Sent Events stream of every real-time event on this node, which the hub keeps one persistent connection to and re-broadcasts.",
        whenToUse:
          "When the hub subscribes to a peer node's live event feed to mirror its sessions in real time.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/federation/events",
        },
        auth: "federation-token",
        riskTier: "readonly",
        availability: { scope: "operator" },
        probe: "skip",
        telemetry: "off",
      })
    ),
    c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const engine = deps.getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not connected" }, 503);
      }

      return streamSSE(c, async stream => {
        const unsubscribe = engine.subscribe(event => {
          void stream.writeSSE({ data: JSON.stringify(event) }).catch(err => {
            console.warn("[Federation] Failed to write SSE event:", err);
          });
        });

        // Heartbeat every 30s to keep connection alive
        const heartbeat = setInterval(() => {
          void stream.write(": heartbeat\n\n").catch(err => {
            console.warn("[Federation] Failed to write SSE heartbeat:", err);
          });
        }, 30_000);

        await new Promise<void>(resolve => {
          const done = () => resolve();
          c.req.raw.signal.addEventListener("abort", done, { once: true });
          stream.onAbort(done);
        });

        clearInterval(heartbeat);
        unsubscribe();
      });
    }
  );

  // ─── Node-to-node endpoint: GET /federation/sessions/:id/events ─
  // SSE stream for a single session's real-time events.
  app.get(
    "/federation/sessions/:id/events",
    cataloged(
      defineCapability({
        id: "session-introspection.federation-session-events",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Open a Server-Sent Events stream scoped to one session's real-time events on this node.",
        whenToUse:
          "When the hub subscribes to a single remote session's live event feed.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/federation/sessions/:id/events",
        },
        auth: "federation-token",
        riskTier: "readonly",
        availability: { scope: "operator" },
        probe: "skip",
        telemetry: "off",
      })
    ),
    c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const sseManager = deps.getSseManager();
      if (!sseManager) {
        return c.json({ error: "Not connected" }, 503);
      }

      const engine = deps.getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not connected" }, 503);
      }

      const sessionId = c.req.param("id");
      const session = engine.getSession(sessionId);
      if (!session) {
        return c.json({ error: "Session not found" }, 404);
      }

      const subscriptionId = randomUUID();

      return streamSSE(c, async stream => {
        sseManager.subscribe({
          id: subscriptionId,
          namespace: session.namespace,
          all: false,
          sessionId,
          send: event => stream.writeSSE({ data: JSON.stringify(event) }),
          sendHeartbeat: async () => {
            await stream.write(": heartbeat\n\n");
          },
        });

        await new Promise<void>(resolve => {
          const done = () => resolve();
          c.req.raw.signal.addEventListener("abort", done, { once: true });
          stream.onAbort(done);
        });

        sseManager.unsubscribe(subscriptionId);
      });
    }
  );

  return app;
}
