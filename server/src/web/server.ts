// SPDX-License-Identifier: AGPL-3.0-only
import { configuration } from "../configuration";
import { constantTimeEquals } from "../utils/crypto";
import type { SyncEngine } from "../sync/syncEngine";
import type { HonoRouteFactory } from "@hapi/protocol/ext";
import type { CatalogEntry } from "@hapi/protocol";
import { UsageService } from "../accounts/usageService";
import type { ProviderUsageService } from "../accounts/providerUsageService";
import type { ImpactService } from "../selfUpdate/impactService";
import type { UpdateService } from "../selfUpdate/updateService";
import type { JobRegistry, JobStatus } from "@hapi/protocol";
import type { WebhookGapDetector } from "../workflow/webhookGapDetector";
import type { OutputStyleSyncService } from "../services/outputStyleSyncService";
import type { SettingsSyncService } from "../services/settingsSyncService";
import type { HarnessPollService } from "../harness/harnessPollService";
import type { NodeRegistry } from "../federation/nodeRegistry";
import type { FileClaimSync } from "../federation/fileClaimSync";
import type { HealthAggregator } from "../federation/healthAggregator";
import type { PeerAnnouncer } from "../federation/peerAnnouncer";
import type { FederationConfig } from "@hapi/protocol";
import type { HeartbeatService } from "../extensions/heartbeat/heartbeatService";
import type { SchedulerService } from "../extensions/scheduler/scheduler/schedulerService";
import type { ContextWatermarkService } from "../watermark/contextWatermarkService";
import type { SSEManager } from "../sse/sseManager";
import type { Server as BunServer, ServerWebSocket } from "bun";
import type { Server as SocketEngine } from "@socket.io/bun-engine";
import type { WebSocketData } from "@socket.io/bun-engine";
import { loadEmbeddedAssetMap } from "./embeddedAssets";
import { isBunCompiled } from "../utils/bunCompiled";
import type { Store } from "../store";
import type { RpcRegistry } from "../socket/rpcRegistry";
import type { FederationTerminalNodeHandler } from "../federation/federationTerminalNode";
import {
  authenticateDesktopUpgrade,
  isDesktopUpgradePath,
  type DesktopProxyHandler,
  type DesktopWsData,
} from "./desktopProxy";
import type { ErrorLogger } from "../logging/errorLogger";
import { buildWebApp } from "./buildWebApp";

// Re-exported for compatibility so downstream mounts (#3744, #3751) can import
// `buildWebApp` from either module (issue #3743, ruling D1).
export { buildWebApp } from "./buildWebApp";

/**
 * WebSocket data for federation terminal connections.
 * Discriminated from Socket.IO's WebSocketData by the `type` field.
 */
type FederationTerminalWsData = { type: "federation-terminal" };

/** Union of all WebSocket data types for Bun.serve multiplexing. */
type CombinedWsData = WebSocketData | FederationTerminalWsData | DesktopWsData;

function isFederationTerminalWs(
  data: CombinedWsData
): data is FederationTerminalWsData {
  return (
    "type" in data &&
    (data as FederationTerminalWsData).type === "federation-terminal"
  );
}

// Web-desktop raw-WS connections (issue #2693) — discriminated by `type: "desktop"`.
function isDesktopWs(data: CombinedWsData): data is DesktopWsData {
  return "type" in data && (data as DesktopWsData).type === "desktop";
}

export async function startWebServer(options: {
  /** Extension-contributed Hono route factories (issue #1270, locked §5f). */
  extensionRouteFactories?: readonly HonoRouteFactory[];
  /** Extension-contributed capability-catalog entries (#3752), merged into the live catalog. */
  extensionCatalogEntries?: readonly CatalogEntry[];
  getSyncEngine: () => SyncEngine | null;
  getSseManager: () => SSEManager | null;
  getHeartbeatService: () => HeartbeatService | null;
  getSchedulerService: () => SchedulerService | null;
  /** Issue #2158: context-watermark successor-handoff status/override service. */
  getContextWatermarkService: () => ContextWatermarkService | null;
  getNodeRegistry: () => NodeRegistry | null;
  getHealthAggregator: () => HealthAggregator | null;
  getPeerAnnouncer: () => PeerAnnouncer | null;
  /** #1969 (R5): the federation claim-sync replica for the /file-claims union. */
  getFileClaimSync: () => FileClaimSync | null;
  /** #2627 (Sub-Issue E): custom output-style store + federation replicator, for
   * the upload/delete routes and the peer-incoming output-style-sync receiver. */
  getOutputStyleSyncService: () => OutputStyleSyncService | null;
  /** #2624 (Sub-Issue B): federation-global settings store + replicator, for the
   * preference-route fan-out and the peer-incoming settings-sync receiver/digest. */
  getSettingsSyncService: () => SettingsSyncService | null;
  /** #1770 (epic #1769): the harness self-update detection poll service, for
   * GET /api/harness/status + POST /api/harness/check. */
  getHarnessPollService: () => HarnessPollService | null;
  /** #1772 (Sub C, epic #1769): the impact-analysis orchestrator/coordinator,
   * for POST /api/harness/:id/analyze + GET .../analysis + the /cli submit route. */
  getImpactService: () => ImpactService | null;
  /** #1774 (Sub E, epic #1769): the privileged update/rollback facade, for the
   * JWT-gated per-node POST /api/harness/:id/update + /rollback routes. */
  getUpdateService: () => UpdateService | null;
  /** #1963 runtime job registry — the Sub-D (#1964) producer contract. */
  getJobRegistry: () => JobRegistry | null;
  /** #1964 (Sub-D): cached daemon job rows for the System Jobs portal merge. */
  getDaemonJobs: () => JobStatus[];
  federationConfig: FederationConfig | null;
  federationApiToken: string | null;
  jwtSecret: Uint8Array;
  store: Store;
  vapidPublicKey: string;
  /** Shared push-to-cache usage service (forwarded to createWebApp, #1909). */
  usageService: UsageService;
  /** Issue #3809: sibling non-Anthropic provider usage service, forwarded to
   *  buildWebApp (constructed in index.ts). */
  providerUsageService?: ProviderUsageService | null;
  socketEngine: SocketEngine;
  /** #1294: forwarded to createWebApp for /ext-assets + /api/ext-web-manifests. */
  extensionsDir: string;
  fsExtensionsEnabled: boolean;
  /** Federation terminal WebSocket handler (both hub and node). */
  federationTerminalHandler?: FederationTerminalNodeHandler | null;
  /** Web-desktop raw-WS proxy handler (issue #2693; null when not a cloud VM). */
  desktopProxyHandler?: DesktopProxyHandler | null;
  errorLogger?: ErrorLogger | null;
  getTelemetryStore?: () =>
    | import("../store/telemetryStore").TelemetryStore
    | null;
  /** Issue #3128: the Harness Scorecard store, forwarded to createWebApp. */
  getScorecardStore?: () =>
    | import("../store/scorecardStore").ScorecardStore
    | null;
  /** Skill-revamp 3.2 (#2157): drain-endpoint queue-health source. */
  getWebhookGapDetector?: () => WebhookGapDetector | null;
  /** #3743 (Sub-Issue C): per-session RPC registry, forwarded to buildWebApp for
   * the live capability catalog's RPC section. */
  getRpcRegistry?: () => RpcRegistry | null;
}): Promise<BunServer<CombinedWsData>> {
  const isCompiled = isBunCompiled();
  const embeddedAssetMap = isCompiled ? await loadEmbeddedAssetMap() : null;
  const app = buildWebApp({
    getSyncEngine: options.getSyncEngine,
    getSseManager: options.getSseManager,
    getHeartbeatService: options.getHeartbeatService,
    getSchedulerService: options.getSchedulerService,
    getContextWatermarkService: options.getContextWatermarkService,
    getNodeRegistry: options.getNodeRegistry,
    getHealthAggregator: options.getHealthAggregator,
    getPeerAnnouncer: options.getPeerAnnouncer,
    getFileClaimSync: options.getFileClaimSync,
    getOutputStyleSyncService: options.getOutputStyleSyncService,
    getSettingsSyncService: options.getSettingsSyncService,
    getHarnessPollService: options.getHarnessPollService,
    getImpactService: options.getImpactService,
    getUpdateService: options.getUpdateService,
    getJobRegistry: options.getJobRegistry,
    getDaemonJobs: options.getDaemonJobs,
    federationConfig: options.federationConfig,
    federationApiToken: options.federationApiToken,
    jwtSecret: options.jwtSecret,
    store: options.store,
    extensionRouteFactories: options.extensionRouteFactories,
    extensionCatalogEntries: options.extensionCatalogEntries,
    vapidPublicKey: options.vapidPublicKey,
    usageService: options.usageService,
    providerUsageService: options.providerUsageService,
    extensionsDir: options.extensionsDir,
    fsExtensionsEnabled: options.fsExtensionsEnabled,
    embeddedAssetMap,
    errorLogger: options.errorLogger,
    getTelemetryStore: options.getTelemetryStore,
    getScorecardStore: options.getScorecardStore,
    getWebhookGapDetector: options.getWebhookGapDetector,
    getRpcRegistry: options.getRpcRegistry,
  });

  const socketHandler = options.socketEngine.handler();
  const fedTermHandler = options.federationTerminalHandler ?? null;
  const desktopHandler = options.desktopProxyHandler ?? null;
  const fedApiToken = options.federationApiToken;

  /**
   * Validate federation API token from the WebSocket upgrade request.
   *
   * Preferred: token carried in the Sec-WebSocket-Protocol header as
   * "hapi-fed-auth.<token>" (avoids leaking token in URL/access logs).
   * Fallback: query param ?token=... for backward compat with old nodes.
   */
  function checkFederationWsToken(req: Request, url: URL): boolean {
    // Fail-closed: a missing apiToken used to allow all WS upgrades. That's a
    // latent auth bypass — mirroring checkFederationToken in
    // routes/federation/shared.ts. With federation enabled, a missing token
    // is a configuration error; reject the upgrade.
    if (!fedApiToken) return false;

    // Try Sec-WebSocket-Protocol header first (new method)
    const protocolHeader = req.headers.get("sec-websocket-protocol") ?? "";
    const protocols = protocolHeader.split(",").map(p => p.trim());
    const authProtocol = protocols.find(p => p.startsWith("hapi-fed-auth."));
    if (authProtocol) {
      const token = authProtocol.slice("hapi-fed-auth.".length);
      return constantTimeEquals(token, fedApiToken);
    }

    // Fallback: query param (backward compat for nodes not yet upgraded)
    const queryToken = url.searchParams.get("token");
    return queryToken ? constantTimeEquals(queryToken, fedApiToken) : false;
  }

  // Build composite WebSocket handler that multiplexes between Socket.IO
  // and federation terminal connections based on ws.data type.
  const socketWs = socketHandler.websocket;
  const compositeWebsocket = {
    open(ws: ServerWebSocket<CombinedWsData>) {
      if (isDesktopWs(ws.data)) {
        desktopHandler?.handleOpen(ws as ServerWebSocket<DesktopWsData>);
      } else if (isFederationTerminalWs(ws.data)) {
        fedTermHandler?.handleOpen(ws);
      } else {
        socketWs.open(ws as ServerWebSocket<WebSocketData>);
      }
    },
    message(ws: ServerWebSocket<CombinedWsData>, message: string | Buffer) {
      if (isDesktopWs(ws.data)) {
        desktopHandler?.handleMessage(
          ws as ServerWebSocket<DesktopWsData>,
          message
        );
      } else if (isFederationTerminalWs(ws.data)) {
        fedTermHandler?.handleMessage(ws, message);
      } else {
        socketWs.message(ws as ServerWebSocket<WebSocketData>, message);
      }
    },
    close(ws: ServerWebSocket<CombinedWsData>, code: number, reason: string) {
      if (isDesktopWs(ws.data)) {
        desktopHandler?.handleWsClose(ws as ServerWebSocket<DesktopWsData>);
      } else if (isFederationTerminalWs(ws.data)) {
        fedTermHandler?.handleWsClose(ws);
      } else {
        socketWs.close(ws as ServerWebSocket<WebSocketData>, code, reason);
      }
    },
    drain(ws: ServerWebSocket<CombinedWsData>) {
      // Socket.IO's bun-engine handler doesn't expose a drain callback,
      // so we only need this for Bun.serve's interface completeness.
      void ws;
    },
  };

  const server = Bun.serve<CombinedWsData>({
    port: configuration.webappPort,
    idleTimeout: Math.max(30, socketHandler.idleTimeout),
    maxRequestBodySize: socketHandler.maxRequestBodySize,
    websocket: compositeWebsocket,
    fetch: async (req, server) => {
      const url = new URL(req.url);

      // Web-desktop WebSocket upgrade (issue #2693) — per-VM JWT-gated proxy.
      // Authenticate + authorize (tier gate → token → HS256 {uid,ns} → same-namespace
      // session) BEFORE server.upgrade(). The token rides the auth subprotocol; a
      // safe non-token protocol is echoed back so no token leaks in the response.
      if (
        isDesktopUpgradePath(url.pathname) &&
        desktopHandler &&
        req.headers.get("upgrade")?.toLowerCase() === "websocket"
      ) {
        const auth = await authenticateDesktopUpgrade({
          req,
          url,
          jwtSecret: options.jwtSecret,
          store: options.store,
        });
        if (!auth.ok) {
          return new Response(auth.reason, { status: auth.status });
        }
        const upgraded = server.upgrade(req, {
          data: auth.data,
          headers: { "sec-websocket-protocol": "hapi-desktop-v1" },
        });
        return upgraded
          ? undefined
          : new Response("Upgrade failed", { status: 500 });
      }

      // Federation terminal WebSocket upgrade
      if (
        url.pathname === "/api/federation/terminal" &&
        fedTermHandler &&
        req.headers.get("upgrade")?.toLowerCase() === "websocket"
      ) {
        if (!checkFederationWsToken(req, url)) {
          return new Response("Unauthorized", { status: 401 });
        }
        // Echo back the non-auth protocol so the client knows we accepted
        const upgraded = server.upgrade(req, {
          data: { type: "federation-terminal" } as FederationTerminalWsData,
          headers: { "sec-websocket-protocol": "hapi-fed-v1" },
        });
        return upgraded
          ? undefined
          : new Response("Upgrade failed", { status: 500 });
      }

      // Socket.IO WebSocket upgrade and polling
      if (url.pathname.startsWith("/socket.io/")) {
        return socketHandler.fetch(req, server);
      }

      return app.fetch(req);
    },
  });

  console.log(
    `[Web] Mini App server listening on :${configuration.webappPort}`
  );
  console.log(`[Web] Mini App public URL: ${configuration.miniAppUrl}`);

  if (fedTermHandler) {
    console.log("[Web] Federation terminal WebSocket endpoint enabled");
  }

  return server;
}
