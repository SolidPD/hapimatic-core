// SPDX-License-Identifier: AGPL-3.0-only
import type { SyncEvent } from "../sync/syncEngine";
import type { ErrorLogger } from "../logging/errorLogger";
import { JOB_KIND_IN_PROCESS_LOOP, type JobRegistry } from "@hapi/protocol";

// Host-global SyncEvent types are delivered to EVERY SSE connection regardless of
// namespace — they carry no session/namespace audience. The membership check runs
// BEFORE the namespace guard in `shouldSend()`, so both `{ all: true }` subscribers
// and normal browser subscribers in any namespace receive them. `chat-sections-changed`
// (#3018) joins the pre-existing `connection-changed` / `mcp-status-updated` exemptions:
// a global chat-sections write must reach every open browser to trigger its
// authoritative refetch. A single set keeps the exemption's two use-sites in `shouldSend()`
// from drifting out of sync.
const HOST_GLOBAL_EVENT_TYPES: ReadonlySet<SyncEvent["type"]> = new Set([
  "connection-changed",
  "mcp-status-updated",
  "chat-sections-changed",
]);

export type SSESubscription = {
  id: string;
  namespace: string;
  all: boolean;
  sessionId: string | null;
  machineId: string | null;
};

type SSEConnection = SSESubscription & {
  send: (event: SyncEvent) => void | Promise<void>;
  sendHeartbeat: () => void | Promise<void>;
};

export class SSEManager {
  private readonly connections: Map<string, SSEConnection> = new Map();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly heartbeatMs: number;
  private readonly errorLogger: ErrorLogger | null;
  private readonly jobRegistry: JobRegistry | null;
  private readonly jobNode: string;
  // #3202: optional hook fired ONLY while browsers are attached (on subscribe
  // and on each heartbeat tick while ≥1 connection is live). The web server
  // wires this to record browser-presence recency for the worktree TTL
  // idle-reaper, whose "idle" signal is otherwise blind to web-UI-only
  // instances (0 tmux sessions by construction).
  private presenceHook: (() => void) | null = null;

  constructor(
    heartbeatMs = 30_000,
    errorLogger?: ErrorLogger | null,
    jobOpts?: { node?: string; jobRegistry?: JobRegistry | null }
  ) {
    this.heartbeatMs = heartbeatMs;
    this.errorLogger = errorLogger ?? null;
    this.jobRegistry = jobOpts?.jobRegistry ?? null;
    this.jobNode = jobOpts?.node ?? "standalone";
  }

  /**
   * #3202: register a hook invoked while a browser is attached — on subscribe
   * and on each heartbeat tick while ≥1 connection is live. The web server uses
   * it to touch a per-instance presence sidecar so the worktree TTL idle-reaper
   * spares web-UI-only instances that have a browser attached. Pass null to
   * clear. The daemon never opens `GET /api/events`, so this fires for real
   * browsers only — the discriminator the reaper needs (see #3202 directive).
   */
  setPresenceHook(hook: (() => void) | null): void {
    this.presenceHook = hook;
  }

  private firePresenceHook(): void {
    // A presence-hook bug must never break SSE delivery (#3202) — swallow it.
    try {
      this.presenceHook?.();
    } catch {
      /* intentionally ignored */
    }
  }

  subscribe(options: {
    id: string;
    namespace: string;
    all?: boolean;
    sessionId?: string | null;
    machineId?: string | null;
    send: (event: SyncEvent) => void | Promise<void>;
    sendHeartbeat: () => void | Promise<void>;
  }): SSESubscription {
    const subscription: SSEConnection = {
      id: options.id,
      namespace: options.namespace,
      all: Boolean(options.all),
      sessionId: options.sessionId ?? null,
      machineId: options.machineId ?? null,
      send: options.send,
      sendHeartbeat: options.sendHeartbeat,
    };

    this.connections.set(subscription.id, subscription);
    this.ensureHeartbeat();
    // #3202: a browser just attached — record presence for the TTL idle reaper.
    this.firePresenceHook();
    return {
      id: subscription.id,
      namespace: subscription.namespace,
      all: subscription.all,
      sessionId: subscription.sessionId,
      machineId: subscription.machineId,
    };
  }

  unsubscribe(id: string): void {
    this.connections.delete(id);
    if (this.connections.size === 0) {
      this.stopHeartbeat();
    }
  }

  broadcast(event: SyncEvent): void {
    for (const connection of this.connections.values()) {
      if (!this.shouldSend(connection, event)) {
        continue;
      }

      void Promise.resolve(connection.send(event)).catch(error => {
        if (this.errorLogger) {
          this.errorLogger.warn(
            `Send failed for connection ${connection.id}, unsubscribing`,
            { category: "sse", context: { error: String(error) } }
          );
        } else {
          console.warn(
            `[SSE] Send failed for connection ${connection.id}, unsubscribing:`,
            error
          );
        }
        this.unsubscribe(connection.id);
      });
    }
  }

  stop(): void {
    this.stopHeartbeat();
    this.connections.clear();
  }

  private ensureHeartbeat(): void {
    if (this.heartbeatTimer || this.heartbeatMs <= 0) {
      return;
    }

    // #1963: register-only — the SSE heartbeat is demand-started and
    // lifecycle-coupled to connections, so it gets NO boot-start watchdog;
    // just surface it in the runtime job registry for Sub-D (#1964).
    this.jobRegistry?.register({
      name: "sse-heartbeat",
      node: this.jobNode,
      kind: JOB_KIND_IN_PROCESS_LOOP,
      intervalMs: this.heartbeatMs,
      lastTickAt: null,
      status: "ok",
      lastError: null,
    });
    this.heartbeatTimer = setInterval(() => {
      this.jobRegistry?.update("sse-heartbeat", { lastTickAt: Date.now() });
      // #3202: browsers are still attached this tick — refresh presence
      // recency so a long-open UI keeps its instance out of the idle reap.
      if (this.connections.size > 0) this.firePresenceHook();
      for (const connection of this.connections.values()) {
        void Promise.resolve(connection.sendHeartbeat()).catch(error => {
          if (this.errorLogger) {
            this.errorLogger.warn(
              `Heartbeat failed for connection ${connection.id}, unsubscribing`,
              { category: "sse", context: { error: String(error) } }
            );
          } else {
            console.warn(
              `[SSE] Heartbeat failed for connection ${connection.id}, unsubscribing:`,
              error
            );
          }
          this.unsubscribe(connection.id);
        });
      }
    }, this.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) {
      return;
    }

    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.jobRegistry?.update("sse-heartbeat", { status: "stopped" });
  }

  private shouldSend(connection: SSEConnection, event: SyncEvent): boolean {
    const isHostGlobal = HOST_GLOBAL_EVENT_TYPES.has(event.type);
    if (!isHostGlobal) {
      const eventNamespace = event.namespace;
      if (!eventNamespace || eventNamespace !== connection.namespace) {
        return false;
      }
    }

    if (event.type === "message-received") {
      // Allow all-subscribed connections to receive messages for any session.
      // This eliminates the SSE subscription transition gap when navigating
      // between session list and session detail views.
      return connection.all || connection.sessionId === event.sessionId;
    }

    if (isHostGlobal) {
      return true;
    }

    if (connection.all) {
      return true;
    }

    if ("sessionId" in event && connection.sessionId === event.sessionId) {
      return true;
    }

    if ("machineId" in event && connection.machineId === event.machineId) {
      return true;
    }

    return false;
  }
}
