// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { randomUUID } from "node:crypto";
import { defineCapability } from "@hapi/protocol";
import type { SSEManager } from "../../sse/sseManager";
import type { SyncEngine } from "../../sync/syncEngine";
import type { NodeRegistry } from "../../federation/nodeRegistry";
import type { WebAppEnv } from "../middleware/auth";
import { cataloged } from "../../capabilities/cataloged";
import {
  resolveLocalNodeIdentity,
  stampAccountUnrefreshable,
} from "../../config/nodeLabel";

function parseOptionalId(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  return value.trim() ? value : null;
}

function parseBoolean(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return value === "true" || value === "1";
}

export function createEventsRoutes(
  getSseManager: () => SSEManager | null,
  getSyncEngine: () => SyncEngine | null,
  options?: {
    getNodeRegistry?: () => NodeRegistry | null;
    federationApiToken?: string | null;
    // Issue #4461 (R7): THIS node's identity, stamped on its own
    // account-unrefreshable events on egress. Absent ⇒ the non-federated one.
    getLocalNode?: () => { nodeId: string; nodeLabel: string };
  }
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  const getLocalNode =
    options?.getLocalNode ?? (() => resolveLocalNodeIdentity(null));

  app.get(
    "/events",
    cataloged(
      defineCapability({
        id: "session-introspection.subscribe-events",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Open a Server-Sent-Events stream of the caller's namespace session and machine events (including message-received events). Long-lived subscription.",
        whenToUse:
          "When the client needs a live event feed for a session, a machine, or the whole namespace.",
        invocation: { kind: "rest", method: "GET", path: "/api/events" },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
        probe: "skip",
        telemetry: "off",
      })
    ),
    c => {
      const manager = getSseManager();
      if (!manager) {
        return c.json({ error: "Not connected" }, 503);
      }

      const query = c.req.query();
      const all = parseBoolean(query.all);
      const sessionId = parseOptionalId(query.sessionId);
      const machineId = parseOptionalId(query.machineId);
      const namespace = c.get("namespace");

      // Federation fallback: if this is a session-specific SSE subscription
      // and the session is not local, proxy to the remote node.
      if (sessionId) {
        const engine = getSyncEngine();
        if (engine) {
          const session = engine.getSession(sessionId);
          if (!session) {
            // Session not found locally — check remote nodes
            const registry = options?.getNodeRegistry?.();
            if (registry) {
              const node = registry.findNodeForSession(sessionId);
              if (node) {
                return streamRemoteSSE(c, node.url, sessionId, options);
              }
            }
            return c.json({ error: "Session not found" }, 404);
          }
          // Local session — verify namespace access
          if (session.namespace !== namespace) {
            return c.json({ error: "Session access denied" }, 403);
          }
        } else {
          return c.json({ error: "Not connected" }, 503);
        }
      }

      // Local session or broadcast subscription
      if (sessionId || machineId) {
        const engine = getSyncEngine();
        if (!engine) {
          return c.json({ error: "Not connected" }, 503);
        }
        if (machineId) {
          const machine = engine.getMachine(machineId);
          if (!machine) {
            return c.json({ error: "Machine not found" }, 404);
          }
          if (machine.namespace !== namespace) {
            return c.json({ error: "Machine access denied" }, 403);
          }
        }
      }

      const subscriptionId = randomUUID();

      return streamSSE(c, async stream => {
        manager.subscribe({
          id: subscriptionId,
          namespace,
          all,
          sessionId,
          machineId,
          // Issue #4461 (R7): an account-unrefreshable event that carries no node
          // is this node's own (a peer's arrives already stamped by the hub's
          // bridge), so name this node — the browser never guesses which node
          // refused. Every other event is written unchanged.
          send: event =>
            stream.writeSSE({
              data: JSON.stringify(
                stampAccountUnrefreshable(event, getLocalNode())
              ),
            }),
          sendHeartbeat: async () => {
            await stream.write(": heartbeat\n\n");
          },
        });

        await new Promise<void>(resolve => {
          const done = () => resolve();
          c.req.raw.signal.addEventListener("abort", done, { once: true });
          stream.onAbort(done);
        });

        manager.unsubscribe(subscriptionId);
      });
    }
  );

  return app;
}

/**
 * Bridge SSE events from a remote node to the web client.
 * Opens an HTTP SSE connection to the remote node's federation endpoint
 * and re-emits each event to the client's SSE stream.
 */
function streamRemoteSSE(
  c: Context<WebAppEnv>,
  nodeUrl: string,
  sessionId: string,
  options?: {
    federationApiToken?: string | null;
  }
): Response | Promise<Response> {
  const url = `${nodeUrl}/api/federation/sessions/${encodeURIComponent(sessionId)}/events`;
  const headers: Record<string, string> = {};
  if (options?.federationApiToken) {
    headers["Authorization"] = `Bearer ${options.federationApiToken}`;
  }

  return streamSSE(c, async stream => {
    const abortController = new AbortController();

    // Abort upstream when client disconnects
    const onAbort = () => abortController.abort();
    c.req.raw.signal.addEventListener("abort", onAbort, { once: true });
    stream.onAbort(onAbort);

    try {
      const resp = await fetch(url, {
        headers,
        signal: abortController.signal,
      });

      if (!resp.ok || !resp.body) {
        await stream.writeSSE({
          data: JSON.stringify({
            type: "federation-error",
            message: `Remote node returned ${resp.status}`,
          }),
        });
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE frames from the buffer
        const lines = buffer.split("\n");
        // Keep the last incomplete line in the buffer
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            // Re-emit the data line as an SSE event
            await stream.writeSSE({ data: line.slice(6) });
          } else if (line.startsWith(": heartbeat")) {
            // Forward heartbeat comments
            await stream.write(": heartbeat\n\n");
          }
          // Ignore other SSE fields (id:, event:, retry:) for now
        }
      }
    } catch (err) {
      // Don't log abort errors — they're expected when client disconnects
      if (err instanceof Error && err.name !== "AbortError") {
        console.warn(
          `[Federation] SSE proxy error for session ${sessionId}:`,
          err.message
        );
        await stream
          .writeSSE({
            data: JSON.stringify({
              type: "federation-error",
              message: "Remote SSE connection lost",
            }),
          })
          .catch(err => {
            console.warn("[Events] Failed to write federation-error SSE:", err);
          });
      }
    }
  });
}
