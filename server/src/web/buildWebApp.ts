// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines -- The fully-mounted Hono web-app composition root;
   it grows one route/service block per feature and re-reached the 1500-line
   ceiling when #3809 (epic #3345) threaded the sibling ProviderUsageService
   through the accounts + federation route factories. Same #2077 convention as
   `shared/src/schemas.ts` and `web/src/api/client.ts`. The file was ALREADY split
   out of `server/src/web/server.ts` at that ceiling (#3743); a second decomposition
   (extract the account/usage route mounts into a sibling `mountAccountRoutes`) is
   the candidate follow-up. */
/**
 * `buildWebApp` — constructs the fully-mounted Hono web application (every route
 * and service) and returns it WITHOUT binding a socket. Split verbatim out of
 * `server/src/web/server.ts` (issue #3743, ruling D1): that file sat at its
 * 1500-line `max-lines` ceiling, so the capability-catalog collector hook and the
 * downstream mounts in #3744 / #3751 (which import `buildWebApp` by name) had no
 * headroom. This is a PURE MOVE — the function body, its private helpers
 * (`findWebappDistDir`, `serveEmbeddedAsset`) and every construction-time side
 * effect are byte-for-byte the former `createWebApp`; only the name and the
 * `export` are new. `startWebServer` (the `Bun.serve` binder) stays in `server.ts`
 * and calls this.
 */
import { Hono } from "hono";
import { defineCapability } from "@hapi/protocol";
import { cataloged } from "../capabilities/cataloged";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Database } from "bun:sqlite";
import { serveStatic } from "hono/bun";
import { configuration } from "../configuration";
import type { SyncEngine } from "../sync/syncEngine";
import { createAuthMiddleware, type WebAppEnv } from "./middleware/auth";
import {
  buildCatalogProvider,
  warnUncatalogedExtensionRoutes,
  type LiveCatalog,
} from "../capabilities/catalogCollector";
import {
  buildAuditProvider,
  type ServerAuditResult,
} from "../capabilities/auditCollector";
import type { RpcRegistry } from "../socket/rpcRegistry";
import { createAuthRoutes } from "./routes/auth";
import { createGoogleOAuthRoutes } from "./routes/google-oauth";
import { createBindRoutes } from "./routes/bind";
import { createExtAssetsRoutes } from "./routes/extAssets";
import { createExtensionPrefsRoutes } from "./routes/extensionPrefs";
import { createExtensionAdminRoutes } from "./routes/extensionAdmin";
import { createBookmarksRoutes } from "./routes/bookmarks";
import {
  createAdminVmRoutes,
  resolveVmParityLedgerPath,
} from "./routes/adminVms";
import { AuditLog, initProvisioner, SYSTEM_ACTOR } from "../provisioner";
import { createExtWebRoutes } from "./routes/extWeb";
import type { HonoRouteFactory } from "@hapi/protocol/ext";
import type { CatalogEntry } from "@hapi/protocol";
import { createEventsRoutes } from "./routes/events";
import { createSessionsRoutes } from "./routes/sessions";
import { createCapabilitiesRoutes } from "./routes/capabilities";
import { createCapabilityCatalogRoutes } from "./routes/capabilityCatalog";
import { createCapabilityAuditRoutes } from "./routes/capabilityAudit";
import { createCapabilityCallRoutes } from "./routes/capabilityCall";
import { detectCapabilities } from "../federation/capabilityDetector";
import {
  buildAvailabilityContext,
  type Caller,
  type SessionLike,
} from "../capabilities/availabilityContext";
import type { AvailabilityContext } from "@hapi/protocol";
import { SessionService } from "../services/sessionService";
import { createAccountsRoutes } from "./routes/accounts";
import { readProviderAuthState } from "../services/providerAuthState";
import { CodexLoginService } from "../services/codexLoginService";
import { readSettings } from "../config/settings";
import { createNodesRoutes } from "./routes/nodes";
import { createAboutRoutes } from "./routes/about";
import { createNodeCapacityRoutes } from "./routes/nodeCapacity";
import { createSystemJobsRoutes } from "./routes/systemJobs";
import { AccountService } from "../services/accountService";
import { AccountLoginService } from "../services/accountLoginService";
import { UsageService } from "../accounts/usageService";
import type { ProviderUsageService } from "../accounts/providerUsageService";
import { NicknameStore } from "../accounts/nicknameStore";
import { MonogramStore } from "../accounts/monogramStore";
import { SystemJobsService } from "../systemJobs/service";
import { readHostCrontab } from "../systemJobs/osCronReader";
import { LoopCronReader } from "../systemJobs/loopCronReader";
import { LoopCronController } from "../systemJobs/loopCronController";
import { LoopCronLifecycleCoupler } from "../sync/loopCronLifecycle";
import {
  RotationLeaseService,
  DEFAULT_ROTATION_LEASE_TTL_MS,
} from "../services/rotationLeaseService";
import { createMessagesRoutes } from "./routes/messages";
import { createApprovalsRoutes } from "./routes/approvals";
import { createPermissionsRoutes } from "./routes/permissions";
import { createMachinesRoutes } from "./routes/machines";
import { createCliRoutes } from "./routes/cli";
import { createPushRoutes } from "./routes/push";
import { createTimeLogRoutes } from "./routes/timeLog";
import { createGitBranchesRoutes } from "./routes/gitBranches";
import { createSessionMetadataRoutes } from "./routes/sessionMetadata";
import { createTranscriptRoutes } from "./routes/transcripts";
import { createBackgroundAgentsRoutes } from "./routes/backgroundAgents";
import { createSpawnRosterRoutes } from "./routes/spawnRoster";
import { createVersionRoutes } from "./routes/version";
import { createLauncherRoutes } from "./routes/launcher";
import { createHealthRoutes } from "./routes/health";
import { createUpdateRoutes } from "./routes/update";
import { createUploadRoutes } from "./routes/upload";
import { createWatermarkRoutes } from "./routes/watermark";
import { createJobsRoutes } from "./routes/jobs";
import { createImpactArtifactRoutes } from "./routes/impactArtifact";
import { createHarnessAnalysisRoutes } from "./routes/harnessAnalysis";
import type { ImpactService } from "../selfUpdate/impactService";
import type { UpdateService } from "../selfUpdate/updateService";
import { createHarnessUpdateRoutes } from "./routes/harnessUpdate";
import { createHarnessRoutes } from "./routes/harness";
import { createHarnessChangelogRoutes } from "./routes/harnessChangelog";
import type { JobRegistry, JobStatus } from "@hapi/protocol";
import { createErrorReportRoutes } from "./routes/errorReports";
import { createFeedbackRoutes } from "./routes/feedback";
import { resolveFeedbackSenderConfig } from "../config/serverSettings";
import { createFileClaimsRoutes } from "./routes/fileClaims";
import { createInitiativesRoutes } from "./routes/initiatives";
import { createGitHubWebhookRoutes } from "./routes/githubWebhook";
import { loadGitHubWebhookConfig } from "../config/githubWebhookConfig";
import type { WebhookGapDetector } from "../workflow/webhookGapDetector";
import { createPredictionAccuracyRoutes } from "./routes/predictionAccuracy";
import { createConflictCheckRoutes } from "./routes/conflictCheck";
import { liveSessionIdSet } from "../store/fileClaimLifecycle";
import { createErrorLogRoutes } from "./routes/errorLogs";
import { createPreferencesRoutes } from "./routes/preferences";
import { createOnboardingPreferenceRoutes } from "./routes/onboardingPreference";
import { createClaudeModelsRoutes } from "./routes/claudeModels";
import { createOutputStylesRoutes } from "./routes/outputStyles";
import { createHarnessManifestsRoutes } from "./routes/harnessManifests";
import { createOutputStyleUploadRoutes } from "./routes/outputStyleUpload";
import {
  resolveOutputStylesDir,
  type OutputStyleSyncService,
} from "../services/outputStyleSyncService";
import type { SettingsSyncService } from "../services/settingsSyncService";
import type { HarnessPollService } from "../harness/harnessPollService";
import { harnessRegistry } from "../harness/registry";
import { ClaudeModelCatalogService } from "../services/claudeModelCatalog";
import { createApiKeysRoutes } from "./routes/apiKeys";
import { createPorterKeyRoutes } from "./routes/porterKey";
import { createPorterStatusRoutes } from "./routes/porterStatus";
import { createPorterExposureGate } from "./middleware/porterExposure";
import { createBackupIdentityRoutes } from "./routes/backupIdentity";
import {
  createPorterImportRoutes,
  type PlanStore,
  type PorterLastImportBox,
} from "./routes/porterImport";
import { createPorterInstalledRoutes } from "./routes/porterInstalled";
import { mountPorterOnelinerRoutes } from "./routes/porterOneliner";
import { createPorterTokenStore } from "../porter/porterToken";
import { createPorterStagingSweeper } from "../porter/porterStagingSweeper";
import { createOpenRouterRoutes } from "./routes/openrouter";
import {
  createTelemetryRoutes,
  createTelemetryIngestRoute,
} from "./routes/telemetry";
import {
  createScorecardRoutes,
  createScorecardIngestRoute,
} from "./routes/scorecard";
import { createFederationRoutes } from "./routes/federation";
import type { NodeRegistry } from "../federation/nodeRegistry";
import type { FileClaimSync } from "../federation/fileClaimSync";
import type { HealthAggregator } from "../federation/healthAggregator";
import type { PeerAnnouncer } from "../federation/peerAnnouncer";
import type { FederationConfig } from "@hapi/protocol";
import type { HeartbeatService } from "../extensions/heartbeat/heartbeatService";
import type { SchedulerService } from "../extensions/scheduler/scheduler/schedulerService";
import type { ContextWatermarkService } from "../watermark/contextWatermarkService";
import type { SSEManager } from "../sse/sseManager";
import type { EmbeddedWebAsset } from "./embeddedAssets";
import { pollMcpStatusOnDemand } from "../utils/mcpPoller";
import type { Store } from "../store";
import type { ErrorLogger } from "../logging/errorLogger";
import { HTTPException } from "hono/http-exception";
import { scrubString } from "../sentry";
import { devManifestResponse, MANIFEST_PATH } from "./instanceManifest";

function findWebappDistDir(): { distDir: string; indexHtmlPath: string } {
  const candidates = [
    join(process.cwd(), "..", "web", "dist"),
    join(import.meta.dir, "..", "..", "..", "web", "dist"),
    join(process.cwd(), "web", "dist"),
  ];

  for (const distDir of candidates) {
    const indexHtmlPath = join(distDir, "index.html");
    if (existsSync(indexHtmlPath)) {
      return { distDir, indexHtmlPath };
    }
  }

  const distDir = candidates[0];
  return { distDir, indexHtmlPath: join(distDir, "index.html") };
}

function serveEmbeddedAsset(asset: EmbeddedWebAsset): Response {
  return new Response(Bun.file(asset.sourcePath), {
    headers: {
      "Content-Type": asset.mimeType,
    },
  });
}

/**
 * The `logError` sink for `GET /admin-vms/parity-history` (#4392): forwards
 * each 500's content-free meta to the ErrorLogger under its own category. A
 * no-op when no ErrorLogger is configured. Exported so the forwarding contract
 * is unit-tested (the admin-VM routes 404 in a test build — no provisioner).
 */
export function parityHistoryLogSink(
  errorLogger: ErrorLogger | null | undefined
): (message: string, meta: Record<string, unknown>) => void {
  return (message, meta) =>
    errorLogger?.error(message, {
      category: "admin-vms-parity-history",
      context: meta,
    });
}

export function buildWebApp(options: {
  /** Extension-contributed Hono route factories (issue #1270, locked §5f). */
  extensionRouteFactories?: readonly HonoRouteFactory[];
  /**
   * Extension-contributed capability-catalog entries (#3752), drained + stamped by
   * the loader, merged into the live catalog by `buildCatalogProvider`.
   */
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
  /** Shared push-to-cache usage service (constructed in index.ts, #1909). */
  usageService: UsageService;
  /** Issue #3809: the sibling non-Anthropic provider usage service (OpenAI
   *  codex snapshots + Google spend counter), constructed in index.ts. Optional
   *  — an instance without it serves an empty providerUsage[] (D5 = C). */
  providerUsageService?: ProviderUsageService | null;
  /**
   * #1294: filesystem runtime-web-extension serving. `extensionsDir` is
   * `${HAPI_HOME}/extensions` (= `join(config.dataDir, "extensions")`);
   * `fsExtensionsEnabled` mirrors the `HAPI_FS_EXTENSIONS` gate. With the flag
   * OFF the `/ext-assets` route 404s and `/api/ext-web-manifests` returns `[]`,
   * so the runtime web path is inert (byte-identical to pre-#1294).
   */
  extensionsDir: string;
  fsExtensionsEnabled: boolean;
  embeddedAssetMap: Map<string, EmbeddedWebAsset> | null;
  errorLogger?: ErrorLogger | null;
  getTelemetryStore?: () =>
    | import("../store/telemetryStore").TelemetryStore
    | null;
  /** Issue #3128: the Harness Scorecard store (run/gate/conformance/rating). */
  getScorecardStore?: () =>
    | import("../store/scorecardStore").ScorecardStore
    | null;
  /**
   * Skill-revamp 3.2 (#2157): the drain endpoint's queue-health source
   * (constructed in index.ts next to the reconcile poller). Late-bound.
   */
  getWebhookGapDetector?: () => WebhookGapDetector | null;
  /**
   * #3743 (Sub-Issue C): per-session RPC registry accessor, for the live
   * capability catalog's RPC section (N1). Threaded from `index.ts` alongside the
   * extension host's existing `getRpcRegistry`. Absent/null → the catalog serves
   * `rpc: []` (the zero-connected-sessions state of every fresh boot and of CI).
   */
  getRpcRegistry?: () => RpcRegistry | null;
}): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  /**
   * #3743 (Sub-Issue C): the boot-time live-capability-catalog provider. Declared
   * here and ASSIGNED at the single pinned line after the last `app.route()` mount
   * (below), so it is late-bound by the catalog route (`/api/capabilities/catalog`)
   * and the federation receiver, both mounted before that line, via getters over
   * this variable — the same late-binding idiom the services above use.
   */
  let liveCatalogProvider: (() => LiveCatalog) | null = null;

  /**
   * #3749 (Sub-Issue I): the shared per-session AvailabilityContext factory. The
   * server is the SOLE context producer (R4 / KD-2) — it reads the frozen session
   * metadata, the node capability detector, the local version, and derives the
   * caller-keyed scope. Shared by the catalog route AND the federation receiver
   * so the annotate / hard-filter path cannot diverge between them.
   *
   * `capabilitiesDetectedAt` is a boot-time staleness anchor (KD-3): the detector
   * caches its base set at/near boot, so a fixed boot timestamp is a faithful
   * "when was this node's capability set observed" marker for consumers to judge
   * staleness against.
   */
  const capabilitiesDetectedAt = new Date().toISOString();
  const availabilityContextFactory = (args: {
    session?: SessionLike;
    caller: Caller;
    nodeVersion?: string;
  }): AvailabilityContext =>
    buildAvailabilityContext({
      session: args.session,
      caller: args.caller,
      nodeCapabilities: detectCapabilities({
        role: options.federationConfig?.role,
      }),
      nodeCapabilitiesDetectedAt: capabilitiesDetectedAt,
      nodeVersion: args.nodeVersion,
    });
  // #3744 (Sub-Issue D): the boot-time runtime self-audit provider. Assigned after
  // the last route mount (below buildCatalogProvider) so it walks the FULL route
  // table; late-bound by the audit route + the federation receiver dep.
  let auditProvider: (() => ServerAuditResult) | null = null;

  // Skill-revamp 3.2 (#2157): the GitHub webhook receiver config, read once at
  // boot (DEFAULT DISABLED — R7). Shared by the pre-JWT receiver mount below.
  const githubWebhookConfig = loadGitHubWebhookConfig();

  // Global error handler — captures unhandled route errors
  app.onError((err, c) => {
    // Let HTTPExceptions pass through with their intended response
    if (err instanceof HTTPException) {
      if (options.errorLogger) {
        options.errorLogger.warn(err.message, {
          category: "http",
          statusCode: err.status,
          requestPath: c.req.path,
          requestMethod: c.req.method,
        });
      }
      return err.getResponse();
    }

    // NOTE: Sentry capture is handled via options.errorLogger.error() below,
    // which forwards error+fatal severities to Sentry. Do NOT captureException
    // directly here — it would double-emit (once as real error, once as a
    // synthetic Error rehydrated from the message inside errorLogger.error()).

    // Log unexpected errors
    if (options.errorLogger) {
      options.errorLogger.error(err.message, {
        category: "http",
        stack: err.stack,
        requestPath: c.req.path,
        requestMethod: c.req.method,
        statusCode: 500,
        userAgent: c.req.header("user-agent"),
      });
    }

    return c.json({ error: "Internal Server Error" }, 500);
  });

  // #1062 M-2: Hono's default `logger()` prints the full request URL —
  // including query params — to stdout. If a client sends `?token=...`,
  // the bearer token lands in the systemd journal. We pass a custom
  // `printFn` that scrubs known token shapes (?token=, Bearer X, JWT)
  // from every log line before stdout. See `scrubString` in `sentry.ts`.
  const scrubbingLogger = (message: string, ...rest: string[]): void => {
    const scrubbed = rest.map(r =>
      typeof r === "string" ? scrubString(r) : r
    );
    console.log(scrubString(message), ...scrubbed);
  };
  app.use("*", logger(scrubbingLogger));

  // Health check endpoint (no auth required)
  app.get("/health", c => c.json({ status: "ok" }));

  const corsOrigins = configuration.corsOrigins;
  const corsOriginOption = corsOrigins.includes("*") ? "*" : corsOrigins;
  const corsMiddleware = cors({
    origin: corsOriginOption,
    // #1775: "PUT" added so PUT /api/harness/poll-config (and the pre-existing
    // PUT /api/heartbeat/config, PUT /api/preferences/* routes) pass the
    // cross-origin preflight. Same-origin (the PWA served by this server) works
    // either way; this only affects non-same-origin callers (federation nodes,
    // external dev tooling). Additive + low-risk.
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["authorization", "content-type"],
  });
  app.use("/api/*", corsMiddleware);
  app.use("/cli/*", corsMiddleware);

  // Issue #1644: the cross-machine rotation-lease service. Serve-local on the
  // hub, proxy-to-coordinator on a peer, fail-open everywhere (the spawn and
  // scheduler hot paths depend on it never blocking). Constructed once per
  // server; dormant unless the daemon's feature-gated client calls it — so when
  // the HAPI_ROTATION_LEASE gate is off, zero lease traffic reaches it (R6).
  const rotationLeaseTtlMs =
    Number(process.env.HAPI_ROTATION_LEASE_TTL_MS) ||
    DEFAULT_ROTATION_LEASE_TTL_MS;
  const rotationLeaseService = new RotationLeaseService({
    leaseStore: options.store.leases,
    federationConfig: options.federationConfig,
    getPeerAnnouncer: options.getPeerAnnouncer,
    federationApiToken: options.federationApiToken,
    ttlMs: rotationLeaseTtlMs,
  });

  app.route(
    "/cli",
    createCliRoutes(options.getSyncEngine, {
      store: options.store,
      errorLogger: options.errorLogger,
      rotationLeaseService,
    })
  );

  // #1772: the impact-analysis SUBMIT endpoint (peer → server), a sibling /cli
  // route with its own CLI-token bearer auth. Kept a separate factory (not folded
  // into createCliRoutes) so its coordinator dep is isolated.
  app.route(
    "/cli",
    createImpactArtifactRoutes(options.getSyncEngine, {
      getStore: () => options.store,
      getCoordinator: options.getImpactService,
    })
  );

  app.route(
    "/api",
    createAuthRoutes(options.jwtSecret, options.store, options.errorLogger)
  );
  // Issue #1003: Google SSO handoff exchange (final path /api/auth/google/handoff).
  // Auth for this route IS the handoff token — it is on the middleware skip list.
  app.route("/api", createGoogleOAuthRoutes(options.errorLogger));
  app.route("/api", createBindRoutes(options.jwtSecret, options.store));
  app.route("/api", createVersionRoutes());
  app.route("/api", createLauncherRoutes());
  app.route("/api", createHealthRoutes(options.jwtSecret, options.errorLogger));

  // GET /api/update-status (public, reads local staged marker) + POST
  // /api/update-trigger (JWT, systemd-run transient unit). Mounted PRE-AUTH so
  // update-status stays public like /version; auth is applied inline to
  // /update-trigger inside the factory (mirrors health.ts). Issue #1006 (D999-10).
  app.route(
    "/api",
    createUpdateRoutes({
      jwtSecret: options.jwtSecret,
      errorLogger: options.errorLogger,
      // Issue #2589: session-aware live fields (sessionImpact/deferred) + the
      // machine name for the honest-copy dialog (R5). dataDir pins the marker
      // path to the authoritative HAPI_HOME (not the route's env fallback).
      dataDir: configuration.dataDir,
      getSyncEngine: options.getSyncEngine,
      machineName: options.federationConfig?.nodeLabel,
    })
  );

  // GET /api/extension-prefs (issue #1270, locked §5a) — read-only extension
  // enable-state, mounted PRE-AUTH so the Telegram Mini App (#1283) can resolve
  // enablement before login. No mutation surface.
  app.route("/api", createExtensionPrefsRoutes(options.store));

  // #1294: GET /api/ext-web-manifests — runtime WEB-extension discovery, mounted
  // PRE-AUTH alongside extension-prefs (low-sensitivity id/path/styles list; the
  // web loader runs before login). Returns [] when HAPI_FS_EXTENSIONS is off.
  app.route(
    "/api",
    createExtWebRoutes(options.store, {
      extensionsDir: options.extensionsDir,
      fsEnabled: options.fsExtensionsEnabled,
    })
  );

  // Account store access for issue #1451 (Sub-Issue E). One instance per
  // server; reads/writes <dataDir>/accounts — the same directory the cli
  // AccountStore writes (both HAPI_HOME-rooted). Shared by the accounts,
  // nodes, session-account, AND federation active-account (#1452) routes.
  const accountService = new AccountService(configuration.dataDir);

  // Issue #2456: live Claude model catalog (GET /api/claude/models). Fetches
  // Anthropic's /v1/models with an account OAuth token (account-independent),
  // cached with graceful cache/fallback degradation. Mounted in the authed
  // section below.
  const claudeModelCatalog = new ClaudeModelCatalogService(
    accountService,
    options.errorLogger
  );

  // Per-account nickname store (epic #1855 follow-up). Backs the nickname PATCH
  // route below. File-backed (read fresh per get), so it stays coherent with the
  // shared UsageService's own NicknameStore in index.ts (#1909) — a nickname
  // write here is visible to the shared service's next refresh after clearCache.
  const nicknameStore = new NicknameStore(
    join(configuration.dataDir, "account-nicknames.json")
  );
  // Per-account monogram override store (issue #3621). Backs the monogram PATCH
  // route and the GET /accounts merge. A sidecar file mirroring the nickname
  // store — NEVER the token-bearing credentials record.
  const monogramStore = new MonogramStore(
    join(configuration.dataDir, "account-monograms.json")
  );
  // Per-account usage service (epic #1855, Sub-Issue B / #1857; #1909
  // push-to-cache). Constructed ONCE in index.ts with the real nodeLabel and
  // shared between the background sampler and these routes — the routes read its
  // getLatest() snapshot. The previous per-server `new UsageService(...)` here
  // was the duplicate-cache instance removed by #1909.
  const usageService = options.usageService;
  const providerUsageService = options.providerUsageService ?? null;

  // Web-initiated OAuth login (issue #1263). Holds short-lived PKCE state in
  // this process and persists new accounts via accountService.add(). One
  // instance per server (the in-memory PKCE map must be shared across requests).
  // `isolatedSyncOptions.dataDir` lets the post-login write-through also cover
  // the per-instance `HAPI_ACCOUNT_CONFIG_SHARED=0` layout; the machine-global
  // dir is resolved from XDG by default. Without this, a fresh token would land
  // only in the store while every reader still resolves the isolated dir first.
  const accountLoginService = new AccountLoginService(accountService, {
    isolatedSyncOptions: { dataDir: configuration.dataDir },
  });

  // Issue #1536 (Sub-Issue B): per-node system-jobs engine (runtime registry
  // store + idempotent reconciler). dataDir mirrors AccountService above
  // (configuration.dataDir, HAPI_HOME-rooted); nodeId reuses the same closure
  // createNodesRoutes uses below. Consumed by the federation system-jobs
  // receivers. NOTE: importing the service pulls the reconciler into the server
  // binary (previously tree-shaken to the standalone runner) — deploy to all
  // federation nodes after merge (scripts/deploy-federation-nodes.sh).
  const systemJobsService = new SystemJobsService({
    dataDir: configuration.dataDir,
    getLocalNodeId: () => options.federationConfig?.nodeId ?? null,
    errorLogger: options.errorLogger,
    // #1964 (Sub-D): the runtime job registry getter feeds in-process-loop rows
    // into listJobs() — the System Jobs portal's in-process-loop data source.
    // Without this, listJobs() yields zero loop rows even though the registry
    // (and the #1963 /api/jobs route) is populated.
    getJobRegistry: options.getJobRegistry,
    getDaemonJobs: options.getDaemonJobs,
    // #1964 (Sub-D PR3): the real host crontab runner enables OS-cron discovery.
    runCrontab: readHostCrontab,
    // #2453: first-class loop-cron. The reader joins `# LOOP-CRON:<id>` crontab
    // markers with `~/.claude/state/loop-cron/<id>/`; the controller is the sole
    // write path (shells out to loop-cron.sh). getListenPort is the D5
    // own-instance discriminator for the header-badge summary (all live loop
    // configs are localhost:3008, so a port compare is the only workable filter).
    loopCronReader: new LoopCronReader({ errorLogger: options.errorLogger }),
    loopCronController: new LoopCronController({
      errorLogger: options.errorLogger,
    }),
    getListenPort: () => configuration.webappPort,
  });

  // #2453 (Task 7/14): loop-cron ↔ session lifecycle coupler. Auto-pauses a
  // session's bound loops on a terminal end, auto-resumes ONLY what it paused on
  // reconnect (emitting the R6 "loops-resuming" SSE event → the bottom-center
  // toast), and purges them on delete. The SystemJobsService is the host
  // (satisfies LoopCronLifecycleHost).
  const syncEngineForCoupler = options.getSyncEngine();
  if (syncEngineForCoupler) {
    syncEngineForCoupler.setLoopCronCoupler(
      new LoopCronLifecycleCoupler({
        getHost: () => systemJobsService,
        errorLogger: options.errorLogger,
        emitResumeSignal: signal =>
          syncEngineForCoupler.emitLoopsResuming(signal),
      })
    );
  }

  // Issue #1456 (Sub-Issue J): give the SyncEngine the account validator so
  // switchAccount() can validate the target account before killing the
  // session. AccountService post-dates SyncEngine construction (index.ts),
  // so this is a setter rather than a constructor arg.
  options.getSyncEngine()?.setAccountService(accountService);

  // Issue #3806 (epic #3345): the LOCAL-node provider auth-state reader, shared by
  // the local /api/accounts/provider-auth-state route and the federation
  // aggregator/receiver. Constructed once here so both surfaces use identical
  // derivation. Gemini `keySource`: vault (a `gemini`/`google` apiKeys entry) →
  // daemon-env (the local machine record's providerEnv carries GEMINI_API_KEY,
  // Task 0) → none. NEVER reads process.env in the server. [ER 2026-09-19: D11]
  const getProviderAuthState = () =>
    readProviderAuthState({
      getVaultProviders: async () => {
        const settings = await readSettings(configuration.settingsFile);
        const providers = new Set<string>();
        for (const k of settings?.apiKeys ?? []) {
          if (k.provider) providers.add(k.provider.toLowerCase());
        }
        return providers;
      },
      getDaemonProviderEnv: () => {
        try {
          // The LOCAL daemon's machine record: the StoredMachine whose
          // metadata.happyHomeDir equals this server's HAPI_HOME (configuration.dataDir).
          const local = options.store.machines
            .getMachines()
            .find(
              m =>
                (m.metadata as { happyHomeDir?: string } | null)
                  ?.happyHomeDir === configuration.dataDir
            );
          const md = local?.metadata as { providerEnv?: string[] } | null;
          return md?.providerEnv ?? null;
        } catch {
          return null;
        }
      },
    });

  // Issue #3807 (epic #3345): the LOCAL-node Codex login driver, shared by the
  // local /api/accounts/openai/login/* routes and the peer-incoming
  // /api/federation/openai-login/* receivers. `accountConfigsDir` is LEFT to its
  // default — byte-identical to the #3806 reader's default — so writer/reader
  // cannot diverge; `hapiHome` powers the K-CODEX-HOME guard; the log records
  // only paths/states, never a key. [ER 2026-09-19: 3807-2]
  const codexLoginService = new CodexLoginService({
    hapiHome: configuration.dataDir,
    log: msg => console.log(`[codex-login] ${msg}`),
  });

  // Federation routes — mounted before JWT middleware.
  // Node-to-node endpoints use federation token auth internally.
  // Web client endpoints apply JWT auth per-route.
  app.route(
    "/api",
    createFederationRoutes({
      getSyncEngine: options.getSyncEngine,
      getSseManager: options.getSseManager,
      getNodeRegistry: options.getNodeRegistry,
      getHealthAggregator: options.getHealthAggregator,
      getPeerAnnouncer: options.getPeerAnnouncer,
      getAccountService: () => accountService,
      // Epic #1855 (Sub-Issue C #1858): local usage source for the federation
      // /accounts/usage aggregator + peer receiver.
      getUsageService: () => usageService,
      // Issue #3809 (epic #3345, D5 = C): local providerUsage[] source for the
      // federation /accounts/usage aggregator + peer receiver (sibling of usage[]).
      getProviderUsageService: () => providerUsageService,
      // Issue #3806 (epic #3345): local provider auth-state reader for the
      // /federation/provider-auth-state aggregator + peer receiver.
      getProviderAuthState,
      // Issue #3807 (epic #3345): local Codex login driver for the peer-incoming
      // /federation/openai-login/* receivers (node-side codex auth runs on the
      // owning node, R4).
      getCodexLoginService: () => codexLoginService,
      // Issue #1644: the hub's authoritative lease ledger for peer-incoming
      // /federation/account-lease/* receivers.
      getLeaseStore: () => options.store.leases,
      // Issue #1536: per-node system-jobs engine for the peer-incoming
      // /federation/system-jobs/* receivers.
      getSystemJobsService: () => systemJobsService,
      // #2627 (Sub-Issue E): the peer-incoming output-style-sync receiver +
      // digest read this store.
      getOutputStyleSyncService: options.getOutputStyleSyncService,
      // #2624 (Sub-Issue B): the peer-incoming settings-sync receiver + digest
      // read this store.
      getSettingsSyncService: options.getSettingsSyncService,
      // #3743 (Sub-Issue C): this node's live catalog for the peer-incoming
      // /federation/capabilities/catalog receiver (the owning binary's catalog).
      getCapabilityCatalog: () => liveCatalogProvider?.() ?? null,
      // #3744 (Sub-Issue D): this node's audit result for the peer-incoming
      // /federation/capabilities/audit receiver (the owning binary's audit).
      getCapabilityAudit: () => auditProvider?.() ?? null,
      // #3749 (Sub-Issue I): the context factory so the peer-incoming
      // /federation/capabilities/catalog receiver annotates + hard-filters with
      // the owning binary's context (never relays a raw catalog).
      getAvailabilityContext: availabilityContextFactory,
      federationConfig: options.federationConfig,
      apiToken: options.federationApiToken,
      jwtSecret: options.jwtSecret,
      errorLogger: options.errorLogger,
    })
  );

  // Telemetry ingestion — mounted BEFORE JWT middleware so hooks can POST
  // with CLI token auth (fire-and-forget, no JWT overhead).
  if (options.getTelemetryStore) {
    app.route("/api", createTelemetryIngestRoute(options.getTelemetryStore));
  }

  // Issue #3128: scorecard producer transports (run + conformance) — mounted
  // BEFORE JWT (CLI-token auth, same posture as telemetry ingestion). The run
  // route joins the session against the telemetry store to supply the skill
  // dimension (KD4), so both getters are threaded in.
  if (options.getScorecardStore) {
    app.route(
      "/api",
      createScorecardIngestRoute(
        options.getScorecardStore,
        options.getTelemetryStore ?? (() => null)
      )
    );
  }

  // Skill-revamp 3.2 (#2157): the GitHub webhook receiver — mounted BEFORE the
  // JWT middleware because GitHub delivers from the public internet and cannot
  // present a JWT. It authenticates by HMAC alone (see githubWebhook.ts); when
  // the feature flag is off it returns 404, so mounting it is inert (R7).
  // Issue #3128: also threads the scorecard store so a gate-bot checkpoint-label
  // revert is recorded as a gate_violation (fire-and-forget, KD3).
  app.route(
    "/api",
    createGitHubWebhookRoutes(() => options.store, githubWebhookConfig, {
      errorLogger: options.errorLogger,
      getScorecardStore: options.getScorecardStore,
    })
  );

  app.use(
    "/api/*",
    createAuthMiddleware(options.jwtSecret, options.errorLogger)
  );

  // Mount extension-contributed route factories (issue #1270, locked §5f) at ONE
  // defined point AFTER the JWT auth middleware — so extension routes require
  // auth. Empty for the empty registry. Pre-auth routes are NOT expressible via
  // routes.add and stay in core (e.g. GET /api/extension-prefs mounted above).
  for (const factory of options.extensionRouteFactories ?? []) {
    try {
      const sub = factory(undefined) as Hono<WebAppEnv>;
      // #3752 (ruling D12): warn on any untagged extension route BEFORE mounting.
      // Warn-only — the route still mounts (a throw here would be swallowed and
      // silently un-mount the whole extension).
      warnUncatalogedExtensionRoutes(sub, options.errorLogger);
      app.route("/api", sub);
    } catch (err) {
      console.error("[ext:loader] Failed to mount extension route:", err);
    }
  }

  // Runtime job registry snapshot (#1963). Mounted AFTER the global JWT gate so
  // GET /api/jobs requires auth: it exposes internal supervised-loop status,
  // federation node IDs, and lastError strings. Previously sat in the pre-gate
  // block, which left it publicly readable (security fix — see review of v1.0.644).
  app.route("/api", createJobsRoutes(options.getJobRegistry));

  // #1772 (Sub C, epic #1769): impact-analysis consumer API. Mounted AFTER the
  // global JWT gate (above) so /api/harness/:id/analyze + .../analysis require
  // auth. nodeId resolved from the SAME federationConfig literal the poll uses (R4).
  app.route(
    "/api",
    createHarnessAnalysisRoutes({
      getImpactService: options.getImpactService,
      getStore: () => options.store,
      nodeId: options.federationConfig?.nodeId ?? "standalone",
    })
  );

  // Harness self-update detection routes (#1770, epic #1769). Mounted AFTER the
  // global JWT gate so GET /api/harness/status + POST /api/harness/check require
  // auth — the mount position IS the auth mechanism (R6/R7). The privileged
  // descriptor commands are redacted in the service's getStatus().
  app.route(
    "/api",
    createHarnessRoutes(options.getHarnessPollService, {
      errorLogger: options.errorLogger,
    })
  );

  // Harness self-update APPLY routes (#1774, Sub E, epic #1769): POST
  // /api/harness/:id/update + /rollback. 🔴 The MOUNT POSITION *IS* the auth for
  // these PRIVILEGED, host-mutating routes and MUST stay BELOW the global JWT
  // gate above — a pre-gate mount ships an unauthenticated host-mutating route
  // (the v1.0.644 precedent). The command is resolved server-side from the
  // code-defined registry and NEVER echoed to the client (R11). Per-node dispatch
  // returns 501 for a remote node in v1 (the KD-4 seam).
  app.route(
    "/api",
    createHarnessUpdateRoutes({
      getUpdateService: options.getUpdateService,
      getLocalNodeId: () => options.federationConfig?.nodeId ?? null,
      getNodeRegistry: options.getNodeRegistry,
      errorLogger: options.errorLogger,
    })
  );

  // Raw changelog display route (#1771, epic #1769). Mounted AFTER the global
  // JWT gate — same posture as /api/harness/status above: the response carries
  // this node's installed/latest version state. The data seam is assembled at
  // the mount site from #1770's store.harness accessors + the committed
  // registry, keyed by the SAME node_id the poll persists under
  // (federationConfig?.nodeId ?? "standalone", server/src/index.ts). No
  // createWebApp signature change — options already carry store + federationConfig.
  app.route(
    "/api",
    createHarnessChangelogRoutes(() => ({
      node_id: options.federationConfig?.nodeId ?? "standalone",
      registry: harnessRegistry,
      getDetectionState: (n, h) =>
        options.store.harness.getDetectionState(n, h),
      getChangelogText: (n, h) => options.store.harness.getChangelogText(n, h),
    }))
  );

  // Extension control plane (#2329): GET /api/extension-registry +
  // PUT /api/extension-prefs/:id. 🔴 The MOUNT POSITION *IS* the auth mechanism —
  // this MUST stay BELOW the global JWT gate above. `createExtensionAdminRoutes`
  // takes no jwtSecret and applies no inline middleware, so moving this line above
  // the gate would make an unauthenticated caller able to disable extensions.
  // Deliberately a SEPARATE factory from `createExtensionPrefsRoutes` (mounted
  // pre-auth further up, locked §5a): a mutation added to that factory would
  // inherit its pre-auth registration position. Guarded by the auth-differential
  // test in `routes/extensionAdmin.test.ts`.
  const nodeId = options.federationConfig?.nodeId ?? "standalone";
  app.route("/api", createExtensionAdminRoutes(options.store, nodeId));

  // Server-side chat bookmarks (#3115, epic #3133): session-scoped GET/PUT/DELETE
  // under /api/sessions/:id/bookmarks. 🔴 The MOUNT POSITION *IS* the auth — these
  // are MUTATION routes and MUST stay BELOW the global JWT gate above (beside
  // createExtensionAdminRoutes), NOT beside the pre-auth createExtensionPrefsRoutes.
  // The factory takes no jwtSecret and applies no inline middleware; each handler
  // re-asserts caller-namespace ownership (#1097). Node-local (RULING D2=A) — no
  // federation proxy. Guarded by the auth-differential test in routes/bookmarks.test.ts.
  app.route("/api", createBookmarksRoutes(options.store));

  // Admin VM provisioning control plane (#2469, epic #2467 Sub B). 🔴 The MOUNT
  // POSITION *IS* the auth — this MUST stay BELOW the global JWT gate above,
  // beside createExtensionAdminRoutes. The factory takes no jwtSecret; a
  // separate path-scoped capability guard inside it 404s every route on a
  // non-operator VM. This is the server-startup `initProvisioner` wiring that
  // #2468 deliberately deferred. initProvisioner runs the capability verdict
  // ONCE and returns an inert {enabled:false} handle on any non-operator
  // instance (no HAPI_VM_ADMIN / no ~/.oci creds), so mounting is safe
  // everywhere — the routes 404 unless this is the operator. repoRoot/instance/
  // logDir come from config + env; the inventory path is ABSOLUTE (an env
  // override, else the per-machine canonical file — see `inventoryPath` below).
  const vmRepoRoot = process.env.HAPI_VM_REPO_ROOT ?? process.cwd();
  // #2471 R3: the audit trail lives in its OWN SQLite file, distinct from the job
  // store's DB, so a change to the job store can never reach the audit rows.
  const vmAuditLog = new AuditLog(
    new Database(join(configuration.dataDir, "provisioner-audit.sqlite"))
  );
  const vmProvisioner = initProvisioner({
    db: options.store.getRawDb(),
    instance: String(configuration.webappPort),
    repoRoot: vmRepoRoot,
    logDir: join(configuration.dataDir, "provisioner-logs"),
    // #2471 R3: audit every terminal state with the `system` actor — the runner
    // has no request context (a terminal can fire from a startup re-attach).
    onTerminal: record =>
      vmAuditLog.append({
        actor: SYSTEM_ACTOR,
        action: "terminal",
        jobId: record.id,
        kind: record.kind,
        flags: record.argv,
        state: record.state,
      }),
    // #2561: an audit-append failure inside onTerminal/onPersist is swallowed by
    // the runner (a genuinely-terminal job must never rethrow), but must not be
    // SILENT — surface it through the structured error logger.
    logError: (message, meta) =>
      options.errorLogger?.error(message, {
        category: "provisioner-audit",
        context: meta,
      }),
  });
  if (vmProvisioner.enabled) {
    // Re-bind persisted `running` jobs from a prior process (finalize exited
    // units; re-adopt the fleet lock for a still-running mutating job). Best-
    // effort — a reattach failure must never block server startup.
    void vmProvisioner.runner.reattach().catch(err => {
      console.warn("[provisioner] reattach on startup failed:", err);
    });
  }
  app.route(
    "/api",
    createAdminVmRoutes({
      provisioner: vmProvisioner,
      auditLog: vmAuditLog,
      // #2552: single-source the inventory path. HAPI_VM_INVENTORY_FILE stays the
      // server's ABSOLUTE override; INVENTORY_FILE (the provisioning scripts' env
      // name) is honored as an ALIAS so setting EITHER name configures BOTH the
      // read-path (here) and the write-path (provision-helpers.sh), killing the
      // two-env-var drift class (#2473 OOS-2). Resolution stays HERE (not moved
      // into a helper) so #2566's reconcile-job threading of this exact
      // `inventoryPath` value into `--inventory` is unaffected. #3414: the fallback
      // is the per-machine canonical file the provisioning scripts default to, not
      // a path under this checkout — dev, prod and every worktree read ONE fleet.
      inventoryPath:
        process.env.HAPI_VM_INVENTORY_FILE ??
        process.env.INVENTORY_FILE ??
        join(
          homedir(),
          ".local/state/hapimatic-provision/cloud-instances.json"
        ),
      // #2552: OPT-IN staleness bound (ms) for the read-path divergence verdict.
      // Unset ⇒ the endpoint never emits a `stale` verdict, so a quiet-but-healthy
      // fleet is never false-flagged (OR-1). Tune to the provisioning cadence.
      inventoryStaleAfterMs: (() => {
        const raw = Number(process.env.HAPI_VM_INVENTORY_STALE_MS);
        return Number.isFinite(raw) && raw > 0 ? raw : undefined;
      })(),
      // #3593: Sub F's append-only parity ledger (#3556, ruling D1(a)), resolved
      // exactly as F's writer resolves it — `HAPI_VM_PARITY_STATE` names the state
      // DIRECTORY and defaults under $HOME (RP1 runtime state, never
      // checkout-relative: the homedir() idiom of `secretEnvPath`, not vmRepoRoot).
      // #3557 reads each VM's `<subdomain>.json` from this path's directory.
      vmParityLedgerPath: resolveVmParityLedgerPath(process.env, homedir()),
      // #2471 R4: value-maskable secret source for live-log masking — the same
      // path the capability preflight checks (~/.oci/hapimatic-infra.env); env
      // override for the dev/prod split-checkout.
      secretEnvPath:
        process.env.HAPI_VM_INFRA_ENV_FILE ??
        join(homedir(), ".oci/hapimatic-infra.env"),
      // #4392: parity-history's 500s are logged through the ErrorLogger when one
      // is configured (the #2561 pattern). Its per-category rate limit (#1141)
      // may drop repeats of a polled fault.
      logError: parityHistoryLogSink(options.errorLogger),
    })
  );

  app.route(
    "/api",
    createEventsRoutes(options.getSseManager, options.getSyncEngine, {
      getNodeRegistry: options.getNodeRegistry,
      federationApiToken: options.federationApiToken,
    })
  );
  app.route(
    "/api",
    createSessionsRoutes(options.getSyncEngine, {
      getNodeRegistry: options.getNodeRegistry,
      federationApiToken: options.federationApiToken,
      errorLogger: options.errorLogger,
      getSessionService: () => {
        const engine = options.getSyncEngine();
        if (!engine) return null;
        return new SessionService(
          engine,
          options.getNodeRegistry(),
          options.federationApiToken
        );
      },
      getAccountService: () => accountService,
    })
  );
  // Issue #2418 (epic #2416 B): capability enumeration read path. Same federation
  // deps as the sessions routes so the local route + node-registry passthrough
  // ship together (#1099). Mounted behind the same JWT gate as its siblings.
  app.route(
    "/api",
    createCapabilitiesRoutes(options.getSyncEngine, {
      getNodeRegistry: options.getNodeRegistry,
      federationApiToken: options.federationApiToken,
      // Issue #2419: audit sink for the generic-invoke policy gate.
      errorLogger: options.errorLogger,
    })
  );
  // #3743 (Sub-Issue C / R7): the live capability-catalog read route. Mounted
  // behind the same JWT gate as its siblings (mount position IS the auth). Reads
  // the boot-time catalog via the late-bound provider assigned after the last
  // route mount below; `?nodeId=` proxies to the peer's federation receiver.
  app.route(
    "/api",
    createCapabilityCatalogRoutes({
      getCatalog: () => liveCatalogProvider?.() ?? null,
      getNodeRegistry: options.getNodeRegistry,
      federationApiToken: options.federationApiToken,
      errorLogger: options.errorLogger,
      // #3749 (Sub-Issue I): session lookup + the context factory for the
      // `?sessionId=` annotate + scope hard-filter.
      getSyncEngine: options.getSyncEngine,
      getAvailabilityContext: availabilityContextFactory,
    })
  );
  // #3744 (Sub-Issue D / R5): the runtime self-audit read route. Same JWT gate as
  // its siblings (mount position IS the auth). Reads the boot-time audit via the
  // late-bound provider assigned after the last route mount below; `?nodeId=`
  // proxies to the peer's federation receiver following the `about.ts` precedent.
  app.route(
    "/api",
    createCapabilityAuditRoutes({
      getAudit: () => auditProvider?.() ?? null,
      getNodeRegistry: options.getNodeRegistry,
      getLocalNodeId: () => options.federationConfig?.nodeId ?? null,
      federationApiToken: options.federationApiToken,
      errorLogger: options.errorLogger,
    })
  );
  // #3751 (Sub-Issue K / R2, R8, D11): the generic tier-gated REST invoker
  // (`POST /api/capabilities/call`). Same JWT gate as its siblings (mount position
  // IS the auth). `getApp: () => app` is the in-process `app.fetch` re-entry target
  // (D11) — lazy so it late-binds the fully-mounted app; reuses the SAME catalog
  // provider + availability-context factory as the catalog route so the gate cannot
  // diverge from what the catalog advertises. Federation (`--node`) is HELD (R6).
  app.route(
    "/api",
    createCapabilityCallRoutes({
      getApp: () => app,
      getCatalog: () => liveCatalogProvider?.() ?? null,
      getAvailabilityContext: availabilityContextFactory,
      errorLogger: options.errorLogger,
    })
  );
  app.route(
    "/api",
    createAccountsRoutes({
      getAccountService: () => accountService,
      getLoginService: () => accountLoginService,
      getUsageService: () => usageService,
      // Issue #3809 (epic #3345, D5 = C): the sibling providerUsage[] source for
      // the /api/accounts/usage route.
      getProviderUsageService: () => providerUsageService,
      getUsageHistoryStore: () => options.store.usageHistory,
      getNicknameStore: () => nicknameStore,
      getMonogramStore: () => monogramStore,
      // Issue #3806 (epic #3345): the local provider auth-state reader, shared
      // with the federation aggregator above.
      getProviderAuthState,
      // Issue #3807: Codex login driver + federation dispatch for the in-app
      // "Add OpenAI account" wizard (proxies to the node owning the dir, R4).
      getCodexLoginService: () => codexLoginService,
      getNodeRegistry: options.getNodeRegistry,
      getLocalNodeId: () => options.federationConfig?.nodeId ?? null,
      errorLogger: options.errorLogger,
    })
  );
  app.route(
    "/api",
    createNodesRoutes({
      getAccountService: () => accountService,
      getLocalNodeId: () => options.federationConfig?.nodeId ?? null,
      getNodeRegistry: options.getNodeRegistry,
      // Issue #2054: usage snapshot buster for the local-branch account removal.
      getUsageService: () => usageService,
      federationApiToken: options.federationApiToken,
      errorLogger: options.errorLogger,
    })
  );
  // Issue #1984 (Epic #1981 B3): About-page host-info + harness-enumeration.
  // Mounted AFTER the JWT gate (KD-2 → R2 auth automatic); needs
  // getNodeRegistry/getLocalNodeId for the `?nodeId=` federation proxy (R6).
  app.route(
    "/api",
    createAboutRoutes({
      getNodeRegistry: options.getNodeRegistry,
      getLocalNodeId: () => options.federationConfig?.nodeId ?? null,
      errorLogger: options.errorLogger,
      // #3119: gateway-managed cloud VM (handoff secret present) ⇒ backup-key
      // custody eligible. Per-request read of the config Proxy singleton, same
      // idiom as version.ts's ssoEnabled surfacing.
      getBackupKeyEligible: () => configuration.googleOAuthEnabled,
    })
  );
  // Issue #1805: per-machine spawn-capacity meter source + per-node settable
  // max-concurrency. JWT-gated (mounted after the auth middleware). Reuses the
  // node-scoped proxy pattern from createNodesRoutes for remote nodes.
  app.route(
    "/api",
    createNodeCapacityRoutes({
      settingsFile: configuration.settingsFile,
      getLocalNodeId: () => options.federationConfig?.nodeId ?? null,
      getNodeRegistry: options.getNodeRegistry,
      errorLogger: options.errorLogger,
    })
  );
  // Issue #1537 (Sub-Issue C): hub web-client system-jobs routes — per-node
  // read/mutate (`/api/nodes/:nodeId/system-jobs/*`) + the cross-node aggregate
  // (`/api/system-jobs/all`). Reuses the systemJobsService constructed above and
  // the node-scoped proxy pattern from createNodesRoutes. Mounted under `/api`
  // AFTER the JWT auth middleware → JWT-gated (R5).
  app.route(
    "/api",
    createSystemJobsRoutes({
      getSystemJobsService: () => systemJobsService,
      getLocalNodeId: () => options.federationConfig?.nodeId ?? null,
      getNodeRegistry: options.getNodeRegistry,
    })
  );
  app.route(
    "/api",
    createMessagesRoutes(options.getSyncEngine, {
      getNodeRegistry: options.getNodeRegistry,
      federationApiToken: options.federationApiToken,
    })
  );
  // #3331 (Task 11 / GAP-1): approval-state read surface consumed by #3333's card.
  app.route(
    "/api",
    createApprovalsRoutes(options.getSyncEngine, {
      getNodeRegistry: options.getNodeRegistry,
      federationApiToken: options.federationApiToken,
    })
  );
  app.route(
    "/api",
    createPermissionsRoutes(options.getSyncEngine, {
      getNodeRegistry: options.getNodeRegistry,
      federationApiToken: options.federationApiToken,
    })
  );
  app.route(
    "/api",
    createMachinesRoutes(options.getSyncEngine, {
      errorLogger: options.errorLogger,
      getSseManager: options.getSseManager,
    })
  );
  // hapimatic-private#4481: Create-page Branch control listing (local + federated).
  app.route(
    "/api",
    createGitBranchesRoutes({
      getNodeRegistry: options.getNodeRegistry,
      errorLogger: options.errorLogger,
    })
  );
  app.route("/api", createPushRoutes(options.store, options.vapidPublicKey));
  app.route(
    "/api",
    createTimeLogRoutes(() => options.store, options.getSyncEngine, {
      errorLogger: options.errorLogger,
      getLocalNodeId: () => options.federationConfig?.nodeId ?? null,
    })
  );
  // Issue #1675 (Sub M): admin session-metadata query surface (node-local,
  // read-only, JWT-gated). Mounted after the JWT middleware above.
  app.route("/api", createSessionMetadataRoutes(options.getSyncEngine));
  app.route("/api", createTranscriptRoutes(options.getSyncEngine));
  app.route(
    "/api",
    // Issue #4387: pass getSessionService so a federated session's peek proxies
    // to the owning node (same inline factory as createSessionsRoutes above).
    createBackgroundAgentsRoutes(options.getSyncEngine, undefined, () => {
      const engine = options.getSyncEngine();
      if (!engine) return null;
      return new SessionService(
        engine,
        options.getNodeRegistry(),
        options.federationApiToken
      );
    })
  );
  // Issue #1936 (producer for rp1-home#1054): PM spawn-roster node-local CRUD
  // (POST/PATCH/GET), JWT-gated. Cross-node view via the federation aggregate.
  app.route(
    "/api",
    createSpawnRosterRoutes(options.getSyncEngine, {
      errorLogger: options.errorLogger,
      // Issue #2010 (Option B): federation-aware WRITE — a spawn registered with a
      // remote nodeId is proxied to that node so the row lands on the spawned
      // session's own node (where its finalize pmReconcileStep reconciles it).
      getNodeRegistry: options.getNodeRegistry,
      getLocalNodeId: () => options.federationConfig?.nodeId ?? null,
    })
  );
  app.route(
    "/api",
    createWatermarkRoutes(options.getContextWatermarkService, {
      errorLogger: options.errorLogger,
      // #2587: settings.json persistence for the enable/disable toggle.
      dataDir: configuration.dataDir,
    })
  );
  app.route(
    "/api",
    createUploadRoutes(options.getSyncEngine, {
      getNodeRegistry: options.getNodeRegistry,
      federationApiToken: options.federationApiToken,
      errorLogger: options.errorLogger,
    })
  );
  app.route("/api", createErrorReportRoutes(options.store));
  // Issue #2664 (epic #2663): in-app user feedback → persist-first + best-effort
  // AgentMail email. Sender config resolved from env (off when unconfigured).
  app.route(
    "/api",
    createFeedbackRoutes(options.store, resolveFeedbackSenderConfig())
  );
  // Issue #1967 (Epic #1965 Sub B): file-claim write/release/query API,
  // JWT-gated, store-direct (observe-first MVP — no SSE until #1971/#1969).
  app.route(
    "/api",
    createFileClaimsRoutes(() => options.store, {
      errorLogger: options.errorLogger,
      // #1968 (R4): live-session predicate. null when the engine is unavailable
      // (fail-open). Both id AND tag are included — the claim's sessionId is
      // client-supplied and may be either.
      getLiveSessionIds: () => {
        const engine = options.getSyncEngine();
        if (!engine) return null;
        return liveSessionIdSet(engine.getActiveSessions());
      },
      // #1969 (R1): publish a file-claim-delta to peers after any local claim
      // mutation. Fail-soft — a null engine at startup skips the emit (the
      // anti-entropy poll backstops it).
      onClaimsChanged: () => options.getSyncEngine()?.emitFileClaimDelta(),
      // #1969 (R5): the cross-node claim-sync replica for the mesh "who claims
      // (repo, path)" union.
      getFileClaimSync: options.getFileClaimSync,
    })
  );
  // Issue #1972 (Epic #1965 Sub G): prediction-accuracy dataset + read/write API,
  // JWT-gated (mounted after the auth middleware), store-direct.
  app.route(
    "/api",
    createPredictionAccuracyRoutes(() => options.store, {
      errorLogger: options.errorLogger,
    })
  );
  // Issue #2156 (skill-revamp 3.1, epic rp1-home#1319): first-class initiative
  // object — CRUD + roster/phase/reconcile + append-only event log. JWT-gated
  // (mounted after the auth middleware), store-direct. A CACHE over GitHub label
  // truth, never authoritative.
  app.route(
    "/api",
    createInitiativesRoutes(() => options.store, {
      errorLogger: options.errorLogger,
      // Skill-revamp 3.2 (#2157): the drain endpoint's queue-health source.
      getWebhookGapDetector: options.getWebhookGapDetector,
    })
  );
  // Issue #1970 (Epic #1965 Sub E): orchestrator-local batch-conflict endpoint —
  // stateless, pure overlap + severity-hint computation. JWT-gated (mounted after
  // auth). No store.
  app.route(
    "/api",
    createConflictCheckRoutes({ errorLogger: options.errorLogger })
  );
  app.route("/api", createErrorLogRoutes(options.store));
  // #2624 (B): thread the settings-sync service so A's two preference PUTs
  // write through the federation-global layer (inherit-aware) and the
  // /preferences/federation-settings 🌐 surface is live.
  app.route(
    "/api",
    createPreferencesRoutes(configuration.settingsFile, {
      getSettingsSyncService: options.getSettingsSyncService,
      // #3018: thread the SyncEngine + SSEManager so a chat-sections write can
      // publish a host-global (federation + local) or node-local invalidation.
      getSyncEngine: options.getSyncEngine,
      getSseManager: options.getSseManager,
    })
  );
  // Issue #3865: node-local in-app onboarding tour state (its own file —
  // preferences.ts is at its line ceiling). After the JWT gate, like its sibling.
  app.route(
    "/api",
    createOnboardingPreferenceRoutes(configuration.settingsFile)
  );
  // Issue #2456: live Claude model catalog (authed).
  app.route("/api", createClaudeModelsRoutes(claudeModelCatalog));
  // Issue #3121 (epic #3117 Sub-Issue E): harness capability-manifest catalog for
  // the Create-page disclosure chips. Mounted HERE, after the global JWT gate →
  // the catalog read requires auth (the mount position IS the auth mechanism,
  // exactly like createClaudeModelsRoutes above). A thin static pass-through over
  // the #3118 registry (shared/), so it takes no dependencies.
  app.route("/api", createHarnessManifestsRoutes());
  // Issue #2626 (D): output-style catalog for the Create-page selector. Mounted
  // HERE, after the global JWT gate → the catalog read requires auth (the mount
  // position IS the auth mechanism, exactly like createClaudeModelsRoutes above).
  // #2627 (E): read from the SAME dir E's upload writes to, so an uploaded style
  // is enumerated by D's catalog. Both resolve to
  // `resolveClaudeConfigDir()/output-styles` in the server process; passing it
  // explicitly makes read-dir == write-dir by construction.
  const outputStylesDir = resolveOutputStylesDir();
  app.route("/api", createOutputStylesRoutes({ stylesDir: outputStylesDir }));
  // #2627 (E): upload + delete routes — JWT-only (mount position IS the auth
  // mechanism, like the catalog above). Skipped only when the service is absent
  // (test stubs); index.ts always constructs it in production.
  const outputStyleSyncSvc = options.getOutputStyleSyncService();
  if (outputStyleSyncSvc) {
    app.route(
      "/api",
      createOutputStyleUploadRoutes({
        service: outputStyleSyncSvc,
        settingsFile: configuration.settingsFile,
        getSyncEngine: options.getSyncEngine,
      })
    );
  }
  app.route("/api", createApiKeysRoutes(configuration.settingsFile));
  // Issues #4533 and #5165: the Porter exposure gate — exposed by default;
  // `HAPI_PORTER_EXPOSED=0` makes it answer 404 `porter_withheld` on BOTH Porter
  // prefixes. Registered BEFORE every Porter mount below (Hono runs handlers in
  // registration order); see the middleware.
  const porterExposureGate = createPorterExposureGate();
  app.use("/api/porter/*", porterExposureGate);
  app.use("/p/*", porterExposureGate);
  app.route("/api", createPorterStatusRoutes());
  // Issue #2341 (Config Porter epic #2339, Sub B): GET /api/porter/recipient —
  // publishes the instance's PUBLIC age recipient (never the identity) for Sub C
  // (#2342) to embed in the extraction prompt. 🔴 Mounted HERE, after the global
  // JWT gate above → the recipient read requires auth. The mount position IS the
  // auth mechanism (createPorterKeyRoutes applies no inline middleware).
  app.route("/api", createPorterKeyRoutes(configuration.settingsFile));
  // Issue #2507 (epic #2493): per-VM backup age identity — one-time authenticated
  // reveal + force-ack + delete. GET /api/backup/identity/status, POST /reveal,
  // POST /acknowledge. 🔴 Mounted HERE, after the global JWT gate above → all three
  // require auth (the mount position IS the auth mechanism; the factory applies no
  // inline middleware). The SECRET identity never touches settings.json; it lives
  // transiently at ~/.config/hapimatic/age-identity.pending.txt and is shredded on ack.
  app.route("/api", createBackupIdentityRoutes(configuration.settingsFile));
  // Porter import + installed routes (auth by mount position after the JWT gate).
  // #3446 shared PlanStore + token store (K6); #3590 last-import box (K6/D7).
  const porterPlanStore: PlanStore = new Map();
  const porterLastImport: PorterLastImportBox = { current: null };
  const porterTokenStore = createPorterTokenStore();
  // #5170: ONE staging sweeper over the shared plan store — plan expiry first,
  // then staging/backup dirs after a grace — on an unref'd 5-minute timer that
  // sweeps only while Porter is exposed, so an uncommitted upload is reaped
  // without any further request. The plan route and upload leg also kick it.
  const porterStagingSweeper = createPorterStagingSweeper({
    dataDir: configuration.dataDir,
    planStore: porterPlanStore,
    intervalMs: 5 * 60 * 1000,
  });
  app.route(
    "/api",
    createPorterImportRoutes({
      settingsFile: configuration.settingsFile,
      dataDir: configuration.dataDir,
      errorLogger: options.errorLogger,
      planStore: porterPlanStore,
      lastImport: porterLastImport,
      stagingSweeper: porterStagingSweeper,
    })
  );
  app.route(
    "/api",
    createPorterInstalledRoutes({ lastImport: porterLastImport })
  );
  // Mint/status (/api, JWT by mount position) + public /p/* (root, token-auth,
  // registered before the SPA catch-all). See docs/internal/architecture/auth.md.
  mountPorterOnelinerRoutes(app, {
    tokenStore: porterTokenStore,
    planStore: porterPlanStore,
    stagingSweeper: porterStagingSweeper,
    settingsFile: configuration.settingsFile,
    dataDir: configuration.dataDir,
    errorLogger: options.errorLogger,
    getSseManager: options.getSseManager,
  });
  app.route("/api", createOpenRouterRoutes());
  if (options.getTelemetryStore) {
    app.route(
      "/api",
      createTelemetryRoutes(options.getTelemetryStore, {
        errorLogger: options.errorLogger,
        // Issue #1889 (Sub K2): give the count-shaped telemetry endpoints a
        // turn_events source for skill/subagent/mcp_call. The reader lives on
        // the already-threaded Store (it needs the private db handle), so no
        // index.ts wiring is required.
        getTurnAnalytics: () => options.store.turnAnalytics,
      })
    );
  }

  // Issue #3128: scorecard rating + admin read + #3132 export — mounted AFTER
  // the JWT middleware (authenticated web client).
  if (options.getScorecardStore) {
    app.route("/api", createScorecardRoutes(options.getScorecardStore));
  }

  // MCP server health status (per-project). #3546 (R9): `url` echo ACCEPTED under #2600 (JWT-gated); porter preview redacts it — see ADR-0006 read-back decision.
  app.get(
    "/api/mcp-status",
    cataloged(
      defineCapability({
        id: "mcp.project-status",
        domain: "mcp",
        surface: "rest",
        description:
          "Return the aggregated per-project MCP server health status.",
        whenToUse: "When the UI shows MCP connection health.",
        invocation: { kind: "rest", method: "GET", path: "/api/mcp-status" },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    c => {
      const engine = options.getSyncEngine();
      const projectDir = c.req.query("projectDir") ?? undefined;
      const status = engine?.getMcpStatus(projectDir) ?? null;
      if (!status) {
        return c.json({ servers: [], checkedAt: null });
      }

      // Apply per-project filtering when projectDir is given but data comes
      // from the global cache (no per-project poll data available yet).
      // Read ~/.claude.json → projects[projectDir].disabledMcpServers to
      // filter out disabled servers for this project.
      if (projectDir && !status.disabledServers) {
        try {
          const cfgPath = join(homedir(), ".claude.json");
          const raw = readFileSync(cfgPath, "utf-8");
          const config = JSON.parse(raw);
          const projects = config?.projects;
          if (projects && typeof projects === "object") {
            // Use exact-match on `projects[projectDir]` only — mirrors Claude
            // Code's runtime scoping. A previous longest-prefix-match fallback
            // (a session at `<root>/.worktrees/X` inheriting `<root>`'s list)
            // displayed servers as Disabled even though Claude treats them as
            // Enabled at the worktree cwd, making toggles look like no-ops to
            // the user. See #1177.
            const disabled = projects[projectDir]?.disabledMcpServers;
            if (Array.isArray(disabled) && disabled.length > 0) {
              const disabledSet = new Set(
                disabled.filter(
                  (s: unknown): s is string => typeof s === "string"
                )
              );
              return c.json({
                ...status,
                servers: status.servers.filter(s => !disabledSet.has(s.name)),
                disabledServers: Array.from(disabledSet),
              });
            }
          }
        } catch {
          // Graceful degradation — return unfiltered data
        }
      }
      return c.json(status);
    }
  );

  // On-demand MCP status refresh (runs `claude mcp list` server-side)
  app.post(
    "/api/mcp-status/refresh",
    cataloged(
      defineCapability({
        id: "mcp.project-status-refresh",
        domain: "mcp",
        surface: "rest",
        description:
          "Force a refresh of the per-project MCP server health status.",
        whenToUse: "When the user re-checks MCP health.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/mcp-status/refresh",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = options.getSyncEngine();
      const projectDir = c.req.query("projectDir") ?? undefined;

      const status = await pollMcpStatusOnDemand(projectDir);
      if (!status) {
        // Poll failed or already in progress — return cached data
        const cached = engine?.getMcpStatus(projectDir) ?? null;
        return c.json({
          servers: cached?.servers ?? [],
          checkedAt: cached?.checkedAt ?? null,
          disabledServers: cached?.disabledServers,
          fromCache: true,
        });
      }

      // Update sync engine cache (also broadcasts SSE event to all clients)
      engine?.updateMcpStatus(status);

      return c.json({
        servers: status.servers,
        checkedAt: status.checkedAt,
        disabledServers: status.disabledServers,
        fromCache: false,
      });
    }
  );

  // #1294: /ext-assets/<id>/* — serve runtime extension bundles from
  // ${HAPI_HOME}/extensions/<id>/dist/. 🔴 MOUNTED BEFORE the embedded-assets
  // compiled branch below (which `return app`s), so it is reachable in BOTH the
  // compiled binary AND dev — mounting it inside the dev-only branch would make
  // it dev-only. Not under /api → public (the JWT middleware is /api/*-scoped).
  app.route(
    "/",
    createExtAssetsRoutes({
      extensionsDir: options.extensionsDir,
      fsEnabled: options.fsExtensionsEnabled,
    })
  );

  // #3743 (Sub-Issue C / R5 / NEW-3746-17): collect the live capability catalog
  // HERE — the single line after the last `app.route()` mount and BEFORE the
  // `if (options.embeddedAssetMap)` branch below, which precedes ALL FOUR
  // `return app` exits. Every build mode (compiled single-exe, dev checkout)
  // therefore collects the IDENTICAL route set; hooking a later `return app`
  // would ship an EMPTY catalog in the production single-exe. The SPA fallbacks
  // registered inside the branches below are correctly excluded (infra, not
  // capabilities). Fail-soft by construction (see catalogCollector).
  liveCatalogProvider = buildCatalogProvider(app, {
    getRpcRegistry: options.getRpcRegistry,
    errorLogger: options.errorLogger,
    extensionEntries: options.extensionCatalogEntries,
  });
  // #3744 (Sub-Issue D): build the audit provider on the SAME fully-mounted `app`
  // (walks the identical route table `buildCatalogProvider` sees), for the same
  // build-mode-invariant reason (NEW-3746-17). Fail-soft by construction.
  auditProvider = buildAuditProvider(app, {
    getRpcRegistry: options.getRpcRegistry,
    errorLogger: options.errorLogger,
  });

  if (options.embeddedAssetMap) {
    const embeddedAssetMap = options.embeddedAssetMap;
    const indexHtmlAsset = embeddedAssetMap.get("/index.html");

    if (!indexHtmlAsset) {
      app.get("*", c => {
        return c.text(
          "Embedded Mini App is missing index.html. Rebuild the executable after running bun run build:web.",
          503
        );
      });
      return app;
    }

    app.use("*", async (c, next) => {
      if (c.req.path.startsWith("/api")) {
        return await next();
      }

      if (c.req.method !== "GET" && c.req.method !== "HEAD") {
        return await next();
      }

      // #4797: the dev instance serves the manifest with its own identity.
      const devManifest = await devManifestResponse(
        c.req.path,
        c.req.url,
        configuration.webappPort,
        async () => {
          const manifestAsset = embeddedAssetMap.get(MANIFEST_PATH);
          return manifestAsset
            ? await Bun.file(manifestAsset.sourcePath).text()
            : null;
        }
      );
      if (devManifest) {
        return devManifest;
      }

      const asset = embeddedAssetMap.get(c.req.path);
      if (asset) {
        return serveEmbeddedAsset(asset);
      }

      return await next();
    });

    app.get("*", async (c, next) => {
      if (c.req.path.startsWith("/api")) {
        await next();
        return;
      }

      return serveEmbeddedAsset(indexHtmlAsset);
    });

    return app;
  }

  const { distDir, indexHtmlPath } = findWebappDistDir();

  if (!existsSync(indexHtmlPath)) {
    app.get("/", c => {
      return c.text(
        "Mini App is not built.\n\nRun:\n  cd web\n  bun install\n  bun run build\n",
        503
      );
    });
    return app;
  }

  app.use("/assets/*", serveStatic({ root: distDir }));

  app.use("*", async (c, next) => {
    if (c.req.path.startsWith("/api")) {
      await next();
      return;
    }

    // #4797: the dev instance serves the manifest with its own identity.
    if (c.req.method === "GET" || c.req.method === "HEAD") {
      const devManifest = await devManifestResponse(
        c.req.path,
        c.req.url,
        configuration.webappPort,
        async () => {
          const manifestFile = join(distDir, "manifest.webmanifest");
          return existsSync(manifestFile)
            ? readFileSync(manifestFile, "utf8")
            : null;
        }
      );
      if (devManifest) {
        return devManifest;
      }
    }

    return await serveStatic({ root: distDir })(c, next);
  });

  app.get("*", async (c, next) => {
    if (c.req.path.startsWith("/api")) {
      await next();
      return;
    }

    return await serveStatic({ root: distDir, path: "index.html" })(c, next);
  });

  return app;
}
