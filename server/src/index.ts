// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines -- The server composition root (init order + graceful
   shutdown); it was exactly at the 1500-line ceiling when #4913 wired the notify()
   service and its purge loop. The loop body lives in notifications/notificationPurge.ts
   to keep the growth to the wiring itself. Same #2077 convention as
   web/buildWebApp.ts; splitting the maintenance loops into a sibling module is the
   candidate follow-up. */
/**
 * HAPI Server - Main Entry Point
 *
 * Provides:
 * - Web app + HTTP API
 * - Socket.IO for CLI connections
 * - SSE updates for the web UI
 * - Optional Telegram bot for notifications and Mini App entrypoint
 */

import { join } from "node:path";
import { createConfiguration, type ConfigSource } from "./configuration";
import { Store } from "./store";
import { TelemetryStore } from "./store/telemetryStore";
import { setCapabilityTelemetrySink } from "./capabilities/cataloged";
import { writeBootSelfKnowledge } from "./capabilities/selfKnowledgeBootWriter";
import { ScorecardStore } from "./store/scorecardStore";
import { TurnWriteService } from "./store/turns/turnWriteService";
import { TurnErrorMirrorService } from "./store/turns/turnErrorMirror";
import { TurnLifecycle } from "./sync/turnLifecycle";
import {
  createParseStep,
  lastMessageTsMs,
} from "./sync/transcript/transcriptParser";
import { createPmReconcileStep } from "./sync/pmReconcileStep";
import { createBackgroundAgentSeedStep } from "./sync/backgroundAgentSeed";
import {
  createCliUsageStep,
  createEnrichStep,
  createOpenEnrichStep,
} from "./sync/turnEnrichment";
import { SyncEngine, type SyncEvent } from "./sync/syncEngine";
import { QueueDrainObserver } from "./sync/queueDrainObserver";
import { OrphanGrantObserver } from "./sync/orphanGrantObserver";
import { SpendLimitNoticeObserver } from "./sync/spendLimitNoticeObserver";
import { createOrphanGrantStep } from "./sync/orphanGrantStep";
import { createCostStep } from "./sync/costStep";
import { NotificationHub } from "./notifications/notificationHub";
import { NotificationService } from "./notifications/notificationService";
import { resolveLocalNodeIdentity } from "./config/nodeLabel";
import { createNotificationPurgeLoop } from "./notifications/notificationPurge";
import { NotifyPmNotifier } from "./notifications/notifier";
import { loadSessionFatalConfig } from "./config/sessionFatalConfig";
import { startWebServer } from "./web/server";
import { readAutoSelectOptimalAccountPreference } from "./web/routes/preferences";
import { getOrCreateJwtSecret } from "./config/jwtSecret";
import { createSocketServer } from "./socket/server";
import { MessageWriteRetryQueue } from "./socket/handlers/cli/messageWriteRetryQueue";
import { SSEManager } from "./sse/sseManager";
import { createWorktreePresenceTouch } from "./web/worktreePresence";
import { getOrCreateVapidKeys } from "./config/vapidKeys";
import { PushService } from "./push/pushService";
import {
  loadServerExtensions,
  type LoadedServerExtensions,
} from "./ext/loader";
import { scanFilesystemExtensions } from "./ext/fsLoader";
import { extensions as builtinServerExtensions } from "./extensions.generated";
import type { HeartbeatService } from "./extensions/heartbeat/heartbeatService";
import { SystemEventQueue } from "./heartbeat/systemEvents";
import { WorkflowReconcileService } from "./workflow/workflowReconcileService";
import { loadWorkflowReconcileConfig } from "./config/workflowReconcileConfig";
import { InitiativeEventObserver } from "./sync/initiativeEventObserver";
import { WebhookGapDetector } from "./workflow/webhookGapDetector";
import { loadGitHubWebhookConfig } from "./config/githubWebhookConfig";
// #1274: SchedulerService now lives in `builtin.scheduler` and is constructed by
// that extension. Core imports the TYPE only, to hand the heartbeat routes a
// resolver until #1275 moves them into `builtin.heartbeat` too.
import type { SchedulerService } from "./extensions/scheduler/scheduler/schedulerService";
import { AutoRecoveryService } from "./services/autoRecoveryService";
import { loadAutoRecoveryConfig } from "./config/autoRecoveryConfig";
import { AutoSwitchOnRateLimitService } from "./services/autoSwitchOnRateLimit";
import { loadAutoSwitchConfig } from "./config/autoSwitchConfig";
import { ContextWatermarkService } from "./watermark/contextWatermarkService";
import { loadContextWatermarkConfig } from "./config/contextWatermarkConfig";
import { DeferredApplyWatcher } from "./update/deferredApply";
import {
  computeStatus,
  launchUpdater,
  resolveLauncherConfig,
} from "./web/routes/update";
import { createSuccessorHandoffStep } from "./sync/successorHandoffStep";
import { createCeilingGuardStep } from "./sync/ceilingGuardStep";
import { loadCeilingGuardConfig } from "./config/ceilingGuardConfig";
import { buildSuccessorHandoffDeps } from "./watermark/successorHandoffWiring";
import { readMaxConcurrency } from "./config/maxConcurrency";
import {
  UsageSampler,
  DEFAULT_SAMPLER_INTERVAL_MS,
  DEFAULT_HISTORY_PERSIST_MS,
} from "./accounts/usageHistory";
import {
  DEFAULT_PRESERVE_STALE_MS,
  DEFAULT_USAGE_STALE_AFTER_MS,
  UsageService,
} from "./accounts/usageService";
import { ProviderUsageService } from "./accounts/providerUsageService";
import { NicknameStore } from "./accounts/nicknameStore";
import { UsageAlertService } from "./accounts/usageAlertService";
import { AccountService } from "./services/accountService";
import { OutputStyleSyncService } from "./services/outputStyleSyncService";
import { SettingsSyncService } from "./services/settingsSyncService";
import { HarnessPollService } from "./harness/harnessPollService";
import { UpdateService } from "./selfUpdate/updateService";
import { setDaemonSpawnPaused } from "./utils/daemonControlClient";
import { harnessRegistry } from "./harness/registry";
import { ImpactService } from "./selfUpdate/impactService";
import { loadHarnessPollConfig } from "./config/harnessPollConfig";
import {
  loadFederationConfig,
  getFederationApiToken,
} from "./config/federationConfig";
import { NodeRegistry } from "./federation/nodeRegistry";
import { FileClaimSync } from "./federation/fileClaimSync";
import { FederationTerminalNodeHandler } from "./federation/federationTerminalNode";
import { DesktopProxyHandler } from "./web/desktopProxy";
import { RemoteTerminalProxy } from "./federation/remoteTerminalProxy";
import { PeerAnnouncer } from "./federation/peerAnnouncer";
import { HealthAggregator } from "./federation/healthAggregator";
import { AlertGenerator } from "./federation/alertGenerator";
import { AlertRingBuffer } from "./federation/alertRingBuffer";
import {
  gatherSystemHealth,
  SystemHealthMetricsSchema,
  type SystemHealthMetrics,
} from "./metrics/systemHealth";
import { parseEnvInt } from "./utils/rateLimitCounter";
import {
  DEFAULT_FEDERATION_HEALTH_THRESHOLDS,
  FederationHealthThresholdsSchema,
  JobRegistry,
  SupervisedLoop,
} from "@hapi/protocol";
import { getSettingsFile, readSettingsOrThrow } from "./config/settings";
import * as transcriptIndexer from "./services/transcriptIndexer";
import * as turnMirrorWiring from "./federation/turnMirrorWiring";
import { JobAlertRouter } from "./systemJobs/jobAlertRouter";
import {
  DaemonJobsReader,
  DaemonJobsMonitor,
} from "./systemJobs/daemonJobsReader";
import type { Server as BunServer } from "bun";
import { ErrorLogger } from "./logging/errorLogger";
import { createErrorLogCleanupLoop } from "./logging/errorLogCleanupLoop";
import { startSinkReconciler } from "./feedback/sinkForward";
import { resolveFeedbackSinkConfig } from "./config/serverSettings";
import { initSentry } from "./sentry";
import { VERSION } from "./version.generated"; // eslint-disable-line -- generated file

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyBunServer = BunServer<any>;

/**
 * Parse HAPI_USAGE_ALERT_THRESHOLDS (comma-separated, e.g. "80,90") into a sorted
 * unique number[] in (0,100]. Falls back to [80, 90] when unset/empty/invalid
 * (epic #1855, Sub H / #1863).
 */
function parseUsageAlertThresholds(raw: string | undefined): number[] {
  const fallback = [80, 90];
  if (!raw || raw.trim() === "") return fallback;
  const parsed = Array.from(
    new Set(
      raw
        .split(",")
        .map(s => parseInt(s.trim(), 10))
        .filter(n => Number.isFinite(n) && n > 0 && n <= 100)
    )
  ).sort((a, b) => a - b);
  return parsed.length > 0 ? parsed : fallback;
}

/** Format config source for logging */
function formatSource(source: ConfigSource | "generated"): string {
  switch (source) {
    case "env":
      return "environment";
    case "file":
      return "settings.json";
    case "default":
      return "default";
    case "generated":
      return "generated";
  }
}

let syncEngine: SyncEngine | null = null;
let queueDrainObserver: QueueDrainObserver | null = null;
let orphanGrantObserver: OrphanGrantObserver | null = null;
let spendNoticeObserver: SpendLimitNoticeObserver | null = null;
let initiativeEventObserver: InitiativeEventObserver | null = null;
let webhookGapDetector: WebhookGapDetector | null = null;
let turnWriteService: TurnWriteService | null = null;
let messageWriteRetryQueue: MessageWriteRetryQueue | null = null;
let turnLifecycle: TurnLifecycle | null = null;
let webServer: AnyBunServer | null = null;
let sseManager: SSEManager | null = null;
let notificationHub: NotificationHub | null = null;
let loadedExtensions: LoadedServerExtensions | null = null;
let workflowReconcileService: WorkflowReconcileService | null = null;
let autoRecoveryService: AutoRecoveryService | null = null;
let autoSwitchService: AutoSwitchOnRateLimitService | null = null;
let contextWatermarkService: ContextWatermarkService | null = null;
let deferredApplyWatcher: DeferredApplyWatcher | null = null;
let usageSampler: UsageSampler | null = null;
// Issue #3809: constructed alongside usageService (below), but referenced earlier
// by the createSocketServer onProviderUsageSnapshot closure — a `let` + lazy
// closure, mirroring turnLifecycle. Non-null by the time any codex session runs.
let providerUsageService: ProviderUsageService | null = null;
let nodeRegistry: NodeRegistry | null = null;
// #1969 (File Conflict Monitor Sub D): the federation claim-sync replica. Built
// unconditionally (even standalone — the /file-claims union route reads it), and
// passed to NodeRegistry (merge/drop) when federation is enabled.
let fileClaimSync: FileClaimSync | null = null;
let peerAnnouncer: PeerAnnouncer | null = null;
// #2627 (Sub-Issue E): custom output-style store + cross-node replicator.
let outputStyleSyncService: OutputStyleSyncService | null = null;
// #2624 (Sub-Issue B): federation-global settings store + cross-node replicator.
let settingsSyncService: SettingsSyncService | null = null;
// #1770 (epic #1769): server-side daily harness self-update detection poll.
let harnessPollService: HarnessPollService | null = null;
// #1772 (Sub C, epic #1769): on-demand impact-analysis orchestrator + coordinator.
let impactService: ImpactService | null = null;
// #1774 (Sub E, epic #1769): the privileged update/rollback orchestrator facade.
let updateService: UpdateService | null = null;
let healthAggregator: HealthAggregator | null = null;
let remoteTerminalProxy: RemoteTerminalProxy | null = null;
// #1963: index.ts maintenance loops are supervised (self-heal + registry rows).
let cleanupLoop: SupervisedLoop | null = null;
let walCheckpointLoop: SupervisedLoop | null = null;
let notificationPurgeLoop: SupervisedLoop | null = null; // #4913
let feedbackSinkLoop: SupervisedLoop | null = null; // #2911
let notificationService: NotificationService | null = null;

async function main() {
  console.log("HAPI Server starting...");

  // Load configuration (async - loads from env/file with persistence)
  const config = await createConfiguration();

  // Display CLI API token information
  if (config.cliApiTokenIsNew) {
    console.log("");
    console.log("=".repeat(70));
    console.log("  NEW CLI_API_TOKEN GENERATED");
    console.log("=".repeat(70));
    console.log("");
    console.log(`  Token: ${config.cliApiToken}`);
    console.log("");
    console.log(`  Saved to: ${config.settingsFile}`);
    console.log("");
    console.log("=".repeat(70));
    console.log("");
  } else {
    console.log(
      `[Server] CLI_API_TOKEN: loaded from ${formatSource(config.sources.cliApiToken)}`
    );
  }

  // Display other configuration sources
  console.log(
    `[Server] WEBAPP_PORT: ${config.webappPort} (${formatSource(config.sources.webappPort)})`
  );
  console.log(
    `[Server] WEBAPP_URL: ${config.miniAppUrl} (${formatSource(config.sources.webappUrl)})`
  );

  if (!config.telegramEnabled) {
    console.log("[Server] Telegram: disabled (no TELEGRAM_BOT_TOKEN)");
  } else {
    const tokenSource = formatSource(config.sources.telegramBotToken);
    console.log(`[Server] Telegram: enabled (${tokenSource})`);
  }

  const store = new Store(config.dbPath);
  const telemetryStore = new TelemetryStore(
    join(config.dataDir, "telemetry.db")
  );
  // Issue #3742: wire the cataloged() middleware's capability-invocation tap to
  // the TelemetryStore. Registered here (NOT web/server.ts, which is at its
  // max-lines ceiling — KD-6). With no sink the tap is a silent no-op, so a
  // capability event is only persisted once this line runs at boot.
  setCapabilityTelemetrySink(event => {
    telemetryStore.insertEvent({
      filePath: event.filePath,
      fileType: event.fileType,
      eventType: event.eventType,
      sessionId: event.sessionId,
    });
  });
  // Backfill any missing daily aggregates on startup
  try {
    const days = telemetryStore.aggregateMissing();
    if (days > 0)
      console.log(`[TelemetryStore] Backfilled ${days} day(s) of aggregates`);
  } catch (err) {
    console.error("[TelemetryStore] Aggregation backfill failed:", err);
  }
  // Issue #3128: the Harness Scorecard store (its own scorecard.db, mirroring the
  // telemetry wiring). Rebuild the rollup snapshot from any events persisted
  // across the last restart.
  const scorecardStore = new ScorecardStore(
    join(config.dataDir, "scorecard.db")
  );
  try {
    const cells = scorecardStore.aggregateMissing();
    if (cells > 0)
      console.log(`[ScorecardStore] Rebuilt ${cells} rollup row(s)`);
  } catch (err) {
    console.error("[ScorecardStore] Rollup rebuild failed:", err);
  }
  const errorLogger = new ErrorLogger(store.errorLogs);
  const jwtSecret = await getOrCreateJwtSecret();
  const vapidKeys = await getOrCreateVapidKeys(config.dataDir);
  const vapidSubject = process.env.VAPID_SUBJECT ?? "mailto:admin@hapi.run";
  const pushService = new PushService(
    vapidKeys,
    vapidSubject,
    store,
    errorLogger
  );
  errorLogger.setPushService(pushService);
  // #3631: deferred re-attempt queue for a SQLITE_BUSY `socket.on("message")`
  // write (ruling D1) — constructed before the socket server so the CLI handlers
  // can hand busy writes to it; flushed at shutdown next to turnWriteService.
  messageWriteRetryQueue = new MessageWriteRetryQueue(errorLogger);

  // #1963: one runtime job registry per process. The node-local services
  // below are constructed before federationConfig loads, so resolve the
  // federation nodeId early for correct per-node grouping in the System Jobs
  // portal (Sub-D #1964). Re-resolved (cheap file read) by the federation
  // block further down.
  const jobRegistry = new JobRegistry();
  const jobNodeId =
    loadFederationConfig(
      await readSettingsOrThrow(getSettingsFile(config.dataDir))
    )?.nodeId ?? "standalone";
  // #1963 R6: route stall/death events to ErrorLogger — the durable,
  // non-Toast producer side Sub-D (#1964) escalates. One sink for all loops.
  // #1964 (Sub-D): durable non-Toast alert router (push + notify-pm) on
  // stall/death — the "fail loudly" channel. Augments (does NOT replace) the
  // ErrorLogger record below; both share the single registry event sink.
  const jobAlertRouter = new JobAlertRouter({ pushService, errorLogger });
  jobRegistry.setEventSink(event => {
    errorLogger.warn(
      `Supervised loop ${event.name} ${event.status}: ${event.error ?? "no detail"}`,
      {
        category: "supervised-loop",
        context: {
          job: event.name,
          node: event.node,
          status: event.status,
          lastError: event.error,
        },
      }
    );
    jobAlertRouter.route(event);
  });

  // #1964 (Sub-D): pull the daemon process's job registry (a co-located separate
  // process) so the System Jobs portal shows daemon loops, and drive their stall
  // alerts server-side (the daemon has no push channel). Best-effort — a down
  // daemon never breaks the portal.
  const daemonJobsReader = new DaemonJobsReader({
    dataDir: config.dataDir,
    getLocalNodeId: () => jobNodeId,
    errorLogger,
  });
  const daemonJobsMonitor = new DaemonJobsMonitor(daemonJobsReader, event => {
    errorLogger.warn(
      `Daemon loop ${event.name} ${event.status}: ${event.error ?? "no detail"}`,
      {
        category: "supervised-loop",
        context: {
          job: event.name,
          node: event.node,
          status: event.status,
          lastError: event.error,
        },
      }
    );
    jobAlertRouter.route(event);
  });
  const daemonJobsPollLoop = new SupervisedLoop({
    name: "daemon-jobs-poll",
    node: jobNodeId,
    intervalMs: 15_000,
    registry: jobRegistry,
    tick: () => daemonJobsMonitor.tick(),
  });
  daemonJobsPollLoop.start();

  sseManager = new SSEManager(30_000, errorLogger, {
    node: jobNodeId,
    jobRegistry,
  });
  // #3202: on a worktree instance, record browser presence (SSE) into a
  // per-instance sidecar so the TTL idle-reaper spares web-UI-only instances
  // with a browser attached. Returns null (no-op) on prod/dev.
  sseManager.setPresenceHook(createWorktreePresenceTouch(config));

  const socketServer = createSocketServer({
    store,
    jwtSecret,
    errorLogger,
    messageWriteRetryQueue,
    getSession: sessionId =>
      syncEngine?.getSession(sessionId) ?? store.sessions.getSession(sessionId),
    onWebappEvent: (event: SyncEvent) => syncEngine?.handleRealtimeEvent(event),
    onSessionAlive: payload => syncEngine?.handleSessionAlive(payload),
    onSessionEnd: payload => syncEngine?.handleSessionEnd(payload),
    onMachineAlive: payload => syncEngine?.handleMachineAlive(payload),
    // Epic #1662, Sub B (#1664): per-turn telemetry boundaries. Lazy closures
    // (mirrors onSessionAlive) — turnLifecycle is constructed after the
    // federation nodeId is resolved, well before the HTTP server accepts
    // connections, so it is non-null by the time any turn event arrives.
    onTurnOpen: event => turnLifecycle?.openTurn(event),
    onTurnFinalize: event => turnLifecycle?.finalizeTurn(event),
    // Issue #3809: a codex pacing snapshot → ProviderUsageService (lazy closure
    // over the `let` above, mirroring the turn handlers; the service is
    // constructed alongside usageService before the HTTP server accepts codex
    // sessions). NEVER reaches turnLifecycle — provider usage stays out of turns.
    onProviderUsageSnapshot: event =>
      providerUsageService?.recordCodexSnapshot(
        event.accountUuid,
        event.windows
      ),
    // Archive session after CLI disconnect grace timeout (Issue #849)
    onArchiveSession: sessionId => {
      // #1603: CLI-disconnect-grace archive is a TERMINAL archive (no respawn
      // follows) — reap the launcher's hapimatic-remote window B.
      void syncEngine?.archiveSession(sessionId, { reapRemoteWindow: true });
    },
    // Federation: late-bound getters for terminal proxy (hub only)
    getRemoteTerminalProxy: () => remoteTerminalProxy,
    findNodeForSession: sessionId =>
      nodeRegistry?.findNodeForSession(sessionId) ?? null,
  });

  syncEngine = new SyncEngine(
    store,
    socketServer.io,
    socketServer.rpcRegistry,
    sseManager,
    errorLogger,
    { node: jobNodeId, jobRegistry }
  );

  // Issue #1883: out-of-band session-fatal escalation (G3). The notifier shells
  // out to notify-pm.sh and no-ops (fail-open) if the script is absent. Wired via
  // setter (no construction-order dependency). Per-node (R32): detection +
  // escalation run on the node hosting the session (handleSessionAlive), so each
  // node escalates its own sessions and there is no hub double-notify.
  syncEngine.setNotifier(new NotifyPmNotifier({ errorLogger }));
  syncEngine.setSessionFatalConfig(
    await loadSessionFatalConfig(config.dataDir)
  );

  // #1969 (File Conflict Monitor Sub D): the federation claim-sync replica. The
  // own node id (`jobNodeId`, same one the SyncEngine reuses as `this.jobNode`)
  // feeds the self-merge defense in FileClaimSync.
  fileClaimSync = new FileClaimSync(jobNodeId, errorLogger);

  // Issue #1325: server-driven queue drain. Subscribes to syncEngine's event
  // stream and dispatches the next queued message when a session becomes idle
  // (thinking false-after-true) or reconnects (active false-after-true).
  // Runs once per process; federation peers each run their own observer.
  queueDrainObserver = new QueueDrainObserver(
    syncEngine,
    errorLogger,
    // Issue #2158: pause dispatch while a session's successor-handoff pipeline is
    // in flight (`handoffState === "handing_off"`) so drainOnce cannot pop-and-lose
    // a message to a soon-to-be-reaped predecessor. Late-bound — the watermark
    // service is constructed further down; the predicate reads it at drain time.
    sid => contextWatermarkService?.isHeld(sid) ?? false
  );
  queueDrainObserver.start();

  // Issue #3563: orphaned-grant `api-error` observer. Fires the orphaned-grant
  // check on the `api-error phase:"exhausted"` SyncEvent — the ONLY detector for a
  // non-429 terminal exhaustion and for local-mode sessions (no RateLimitDetector).
  // Remote-owned sessions are skipped (late-bound registry read; the empty-mint-store
  // guard already makes them a no-op). Each federation peer runs its own observer.
  orphanGrantObserver = new OrphanGrantObserver(
    syncEngine,
    errorLogger,
    sid => nodeRegistry?.findNodeForSession(sid) != null
  );
  orphanGrantObserver.start();
  spendNoticeObserver = new SpendLimitNoticeObserver(syncEngine, errorLogger);
  spendNoticeObserver.start();

  // Skill-revamp 3.2 (#2157): the peer-session event observer — the push half of
  // the event-driven PM queue (R4). DEFAULT DISABLED (R7): start() no-ops unless
  // HAPI_GITHUB_WEBHOOK_ENABLED=true, so with the feature off it never subscribes
  // and behavior is byte-identical to poll-only. Each federation peer runs its
  // own observer (a webhook lands on exactly one node).
  const githubWebhookConfig = loadGitHubWebhookConfig();
  initiativeEventObserver = new InitiativeEventObserver(
    syncEngine,
    store,
    githubWebhookConfig,
    errorLogger
  );
  initiativeEventObserver.start();

  // Epic #1662, Sub A (#1663): fail-open per-turn telemetry write service — the
  // published daemon-side write API (enqueueOpenTurn / enqueueFinalizeTurn /
  // enqueueAppendEvents) that Sub B/C/D/E call. A telemetry write failure never
  // blocks or crashes a session (R6). Constructed-but-idle here; Sub B wires the
  // turn-lifecycle callers (UserPromptSubmit open / Stop finalize). flush() drains
  // on graceful shutdown.
  turnWriteService = new TurnWriteService(store.turns, errorLogger);

  // Epic #1662, Sub K (#1673): mirror error_logs writes into turn_events
  // (kind=error/api_error) attributed to the session's open turn. Fail-open;
  // opt-in via the late-bound setter (ErrorLogStore is constructed before the
  // write service exists). Complements Sub C #1665's transcript-sourced
  // error/api_error events with Hapimatic operational errors (never in the
  // transcript). The analytics re-point half is #1889.
  store.errorLogs.setTurnErrorMirror(
    new TurnErrorMirrorService(store.turns, turnWriteService)
  );

  // Load enabled extensions (issue #1270, Sub-Issue F). loadServerExtensions
  // builds ONE ServerExtensionHost per extension internally (locked §5e) and
  // returns the aggregate. Runs AFTER Store is constructed (the enable check
  // reads extension_prefs) and BEFORE NotificationHub so extension channels join
  // the built-in channels. Core accessors are late-bound getters — resolved when
  // extensions' onStartup callbacks run post-boot, so a getter for a not-yet-
  // constructed service (heartbeat/nodeRegistry/federation token) is fine.
  // #1275: SystemEventQueue is core-owned shared infrastructure — HeartbeatService
  // (in builtin.heartbeat) drains it to build prompts, and the scheduler drains it
  // too. Core creates it BEFORE the extension load so getSystemEventQueue() resolves
  // a LIVE queue regardless of extension load order — append-only extensions.config.ts
  // means heartbeat loads after scheduler, which snapshots the queue at its onStartup.
  const systemEventQueue = new SystemEventQueue();

  // #1289: opt-in runtime filesystem extensions (ships gated OFF). When
  // HAPI_FS_EXTENSIONS is truthy, scan `${HAPI_HOME}/extensions/*/manifest.json`
  // and concatenate the discovered entries AFTER the build-time builtins (R6:
  // builtins in config order first, filesystem sorted by id second). Default OFF
  // → fsServerEntries is [] and this call is byte-identical to before (R3).
  // NOTE: filesystem loading is arbitrary host-privilege code execution until
  // #1291 (sandboxing) lands — hence the opt-in flag.
  const fsExtensionsEnabled = ["true", "1", "yes"].includes(
    process.env.HAPI_FS_EXTENSIONS?.toLowerCase() || ""
  );
  const builtinServerIds = new Set(
    builtinServerExtensions.map(e => e.manifest.id)
  );
  const fsServerEntries = fsExtensionsEnabled
    ? await scanFilesystemExtensions(
        join(config.dataDir, "extensions"),
        builtinServerIds
      )
    : [];

  loadedExtensions = await loadServerExtensions(
    {
      getStore: () => store,
      getErrorLogger: () => errorLogger,
      getExtensionPrefs: () => store.extensionPrefs,
      getSyncEngine: () => syncEngine,
      getPushService: () => pushService,
      getNotificationHub: () => notificationHub,
      getSystemEventQueue: () => systemEventQueue,
      getRpcRegistry: () => socketServer.rpcRegistry,
      getNodeRegistry: () => nodeRegistry,
      getFederationApiToken: () => federationApiToken,
      // #1274: the scheduler extension owns a SupervisedLoop and must register it
      // with the SAME process-wide registry core's loops use, or it disappears
      // from the System Jobs portal (#1963).
      getJobRegistry: () => jobRegistry,
      getJobNodeId: () => jobNodeId,
      getRawDb: () => store.getRawDb(),
      // #1271 contract amendment: CORE config for extensions that need server
      // settings (telegram's bot token, push's miniAppUrl). Distinct from
      // `host.config.get()`, which reads the extension's own extension_prefs row.
      getCoreConfig: () => config,
    },
    [...builtinServerExtensions, ...fsServerEntries]
  );

  // #1271: boot-time observability for the extension system. Without this the
  // only loader output is an error path, so a silently-skipped extension is
  // indistinguishable from a healthy load. Mirrors the `[Federation] …` boot
  // lines and is the primary signal for the remaining epic #1264 migrations.
  console.log(
    `[ext:loader] Loaded ${loadedExtensions.channels.length} notification channel(s), ` +
      `${loadedExtensions.routeFactories.length} route factory(ies), ` +
      `${loadedExtensions.onStartup.length} startup hook(s), ` +
      `${loadedExtensions.onShutdown.length} shutdown hook(s)`
  );
  // #1289: filesystem-extension boot signal (mirrors the aggregate log above).
  console.log(
    fsExtensionsEnabled
      ? `[ext:loader] Filesystem extensions: ${fsServerEntries.length} discovered under ${join(config.dataDir, "extensions")} (HAPI_FS_EXTENSIONS on)`
      : `[ext:loader] Filesystem extensions: disabled (HAPI_FS_EXTENSIONS off)`
  );

  // #1271 (Sub-Issue G): ALL notification channels now arrive from the loader —
  // push via `builtin.notifications-push` (requiredAtBuild, always on) and
  // telegram via `builtin.notifications-telegram` (opt-in through
  // extension_prefs, seeded enabled by #1269 when a bot token is configured).
  // The hub's construction + options shape are unchanged, and it still exists
  // BEFORE HeartbeatService/SchedulerService, which take it as a constructor arg.
  notificationHub = new NotificationHub(
    syncEngine,
    [...loadedExtensions.channels],
    { errorLogger }
  );

  // #4913 (epic #4912): the single notify() service. Producers migrate in #4914.
  notificationService = new NotificationService({
    store: store.notifications,
    getSyncEngine: () => syncEngine,
    getPushService: () => pushService,
    errorLogger,
  });
  // #4921: every push carries the sending node's unread count (app badge).
  const unreadCountSource = notificationService;
  pushService.setUnreadCountProvider(ns => unreadCountSource.countUnread(ns));

  // #1275: HeartbeatService is constructed and started by the
  // `builtin.heartbeat` extension's onStartup hook (drained further down), not
  // here — mirroring #1274's scheduler migration. Its SystemEventQueue is the
  // core-owned `systemEventQueue` above, injected via host.getSystemEventQueue().

  // #1274: SchedulerService is constructed and started by the
  // `builtin.scheduler` extension's onStartup hook (drained further down), not
  // here. The heartbeat hand-off that used to follow this block moved with it —
  // it reads scheduler state, so it must run after the scheduler exists.

  // Initialize the context-watermark successor-handoff monitor (issue #2158,
  // epic rp1-home#1319). DEFAULT DISABLED (R5): start() no-ops unless explicitly
  // enabled — this feature autonomously kills sessions. Constructed BEFORE
  // TurnLifecycle so its finalize step can be wired into the chain below.
  const cwEngine = syncEngine;
  const contextWatermarkConfig = await loadContextWatermarkConfig(
    config.dataDir
  );
  // The capacity pre-check is cooperative with the daemon's real clamp (which is
  // the actual OOM boundary) — an approximate cap read once at boot is fine.
  const contextWatermarkMaxConcurrent =
    (await readMaxConcurrency(getSettingsFile(config.dataDir))) ??
    (Number(process.env.HAPI_MAX_CONCURRENT_SESSIONS) || 10);
  contextWatermarkService = new ContextWatermarkService({
    getSessions: () => cwEngine.getSessions(),
    watermarkStore: store.watermark,
    config: contextWatermarkConfig,
    errorLogger,
    node: jobNodeId,
    jobRegistry,
  });
  contextWatermarkService.start();

  // Initialize federation (if enabled)
  const settingsFile = getSettingsFile(config.dataDir);
  const settings = await readSettingsOrThrow(settingsFile);

  // Issue #3611: inject the un-pinned optimal-account opt-in reader into the
  // SyncEngine so `spawnSession` can stamp the resolved boolean onto the spawn RPC
  // (the daemon then runs the pick). Wired here (NOT web/server.ts) over the
  // node's settingsFile — the #3618 no-post-construction-injection-from-web/server
  // precedent. Fail-closed to `false` (the reader never throws), so behavior is
  // byte-identical to #3023 until the operator opts in (R3).
  syncEngine.setAutoSelectOptimalAccountReader(() =>
    readAutoSelectOptimalAccountPreference(settingsFile)
  );
  const federationConfig = loadFederationConfig(settings);
  const federationApiToken = getFederationApiToken(settings);

  // #4914 (epic #4912): server producers raise user notifications through
  // syncEngine.notifyUser. Wired here, after federationConfig, so an
  // account-unrefreshable row names this node (the #4461 egress-stamp value).
  // Before this line producers raise no notification; their legacy SyncEvents
  // still fire.
  if (notificationService) {
    syncEngine.setNotificationService(notificationService, {
      getLocalNode: () => resolveLocalNodeIdentity(federationConfig),
    });
  }

  // Server-authoritative fresh-usage substrate (#1909). ONE shared UsageService
  // (push-to-cache): the sampler is its sole scheduled upstream caller via
  // refresh(); the HTTP routes read getLatest(). Constructed here — AFTER
  // federationConfig — so nodeLabel is the real per-row `machines` label, then
  // passed to BOTH the sampler and startWebServer (no duplicate cache). The
  // nickname store is file-backed (read fresh per get), so it stays coherent
  // with server.ts's own NicknameStore used by the nickname route.
  const usageNicknameStore = new NicknameStore(
    join(config.dataDir, "account-nicknames.json")
  );
  // #3618: hoist the AccountService into a local so the auto-switch service can
  // reuse the SAME instance (its getRaw is a fresh file read, so sharing it is
  // staleness-safe) via `getAccountService: () => usageAccountService` — no
  // post-construction injection from web/server.ts.
  const usageAccountService = new AccountService(config.dataDir);
  const usageService = new UsageService({
    accountService: usageAccountService,
    dataDir: config.dataDir,
    nodeLabel: federationConfig?.nodeLabel ?? null,
    nicknameLookup: uuid => usageNicknameStore.get(uuid),
    // #1962: re-arm a refresh on read when the cached snapshot is stale (default
    // 6 min = 3× the sampler interval), so a silently-stalled UsageSampler loop
    // self-corrects instead of serving a frozen value forever.
    staleAfterMs: parseEnvInt(
      process.env.HAPI_USAGE_STALE_AFTER_MS,
      DEFAULT_USAGE_STALE_AFTER_MS
    ),
    // Preserve an account's last-good usage across a transient upstream 429/5xx/
    // timeout for up to this window instead of blanking the row to an error
    // (Fallback Preservation Rule). Bounded so a genuinely-stuck account still
    // surfaces its error once the last-good data ages out.
    preserveStaleMs: parseEnvInt(
      process.env.HAPI_USAGE_PRESERVE_STALE_MS,
      DEFAULT_PRESERVE_STALE_MS
    ),
  });
  // Issue #3809 (epic #3345, D5 = C): the SIBLING non-Anthropic provider usage
  // service. Passive (no upstream fetch, no sampler) — it receives OpenAI codex
  // snapshots pushed by the socket receiver above and aggregates the Google spend
  // counter from `store.turns` on read. Reuses the hoisted usageAccountService +
  // nickname store so identity/nickname resolution matches the Anthropic path.
  providerUsageService = new ProviderUsageService({
    accountService: usageAccountService,
    turnsDb: store.getRawDb(),
    nodeLabel: federationConfig?.nodeLabel ?? null,
    nicknameLookup: uuid => usageNicknameStore.get(uuid),
  });
  // Usage history sampler (epic #1855, Sub I / #1864; #1909 push-to-cache). Each
  // tick calls usageService.refresh() (the single upstream fetch), runs threshold
  // alerts, and persists history rows on a gated (slower) cadence. Samples
  // immediately on start(). Env kill-switch: HAPI_USAGE_SAMPLER_ENABLED=0.
  // Epic #1855, Sub H (#1863): usage-threshold push alerts ride the same fetch.
  //   HAPI_USAGE_ALERT_ENABLED=0        → disable alerting only (history continues)
  //   HAPI_USAGE_ALERT_THRESHOLDS=80,90 → crossing thresholds (default 80,90)
  //   HAPI_USAGE_SAMPLER_INTERVAL_MS    → refresh + alert cadence (default 2 min)
  //   HAPI_USAGE_HISTORY_PERSIST_MS     → history persist cadence (default 10 min)
  const usageAlertService = new UsageAlertService({
    store: store.usageAlertState,
    pushService,
    thresholds: parseUsageAlertThresholds(
      process.env.HAPI_USAGE_ALERT_THRESHOLDS
    ),
    enabled: process.env.HAPI_USAGE_ALERT_ENABLED !== "0",
    errorLogger,
  });
  usageSampler = new UsageSampler({
    usageService,
    store: store.usageHistory,
    enabled: process.env.HAPI_USAGE_SAMPLER_ENABLED !== "0",
    intervalMs: parseEnvInt(
      process.env.HAPI_USAGE_SAMPLER_INTERVAL_MS,
      DEFAULT_SAMPLER_INTERVAL_MS
    ),
    historyPersistMs: parseEnvInt(
      process.env.HAPI_USAGE_HISTORY_PERSIST_MS,
      DEFAULT_HISTORY_PERSIST_MS
    ),
    errorLogger,
    alertService: usageAlertService,
    node: jobNodeId,
    jobRegistry,
  });
  usageSampler.start();

  // Epic #1662, Sub B (#1664): construct the turn-lifecycle orchestrator now
  // that the federation nodeId is resolved (turns are stamped with node_id for
  // cross-node aggregation). It consumes Sub A's fail-open write service. The
  // SyncEngine owns the orphan sweep (boot sweep runs inside setTurnLifecycle;
  // reconnect sweep at reconnectSession). This is before the HTTP server starts
  // accepting connections, so the socket-handler closures resolve a non-null ref.
  if (turnWriteService && syncEngine) {
    // Capture the narrowed non-null engine so the deferred openEnrichStep closure
    // (invoked later at turn-open) is not re-widened to `SyncEngine | null`.
    const engine = syncEngine;
    turnLifecycle = new TurnLifecycle(
      store.turns,
      turnWriteService,
      federationConfig?.nodeId ?? "standalone",
      errorLogger,
      {
        // Sub C (#1665): real transcript parse at finalize.
        parseStep: createParseStep(),
        // Issue #3352: map a non-claude runner's CLI-supplied usage block into
        // the token/model columns. Runs right after parseStep in the seam so
        // claude stays byte-identical (the block is absent on claude) and a
        // non-claude turn's empty parse is filled from the event.
        cliUsageStep: createCliUsageStep(),
        // Issue #2010: PM spawn-roster reconciliation at finalize (after parse).
        // Token-scan over this node's non-complete roster rows; fail-open.
        pmReconcileStep: createPmReconcileStep(store.pmRoster, errorLogger),
        // Issue #4385 fix round 1: write a row from the agent file as it is now
        // for each background agent the parse excluded and that has no row yet,
        // so an agent whose completion the hub never sees is still counted.
        // #4824: the args end with the finalizing turn's seq (its binding).
        backgroundAgentSeedStep: createBackgroundAgentSeedStep((...args) =>
          engine.seedBackgroundAgentUsage(...args)
        ),
        // Issue #2158: context-watermark successor handoff. SYNCHRONOUS evaluate +
        // detached async pipeline; contributes no enrichment. No-op when the
        // service is unavailable (it is always constructed above, but keep the
        // guard for narrowing). Everything no-ops when the feature is disabled.
        successorHandoffStep: contextWatermarkService
          ? createSuccessorHandoffStep(
              buildSuccessorHandoffDeps({
                syncEngine: engine,
                store,
                service: contextWatermarkService,
                getMaxConcurrent: () => contextWatermarkMaxConcurrent,
                errorLogger,
              })
            )
          : undefined,
        // Sub D (#1666): OPEN-time identity/account/repo enrichment from
        // session.metadata, plus finalize git passthrough (CLI-wire).
        openEnrichStep: createOpenEnrichStep(sid => engine.getSession(sid)),
        enrichStep: createEnrichStep(),
        // Sub E — LIVE per-turn cost snapshot (issue #3353, S-4). Wires the
        // previously-unplugged `costStep` seam so `turns.cost_total` is written at
        // finalize (was NULL-until-backfill). Runs AFTER parseStep/cliUsageStep,
        // so the token/model/provider columns it prices are in the accumulator;
        // fail-open like its siblings. The offline `backfill-costs` script is
        // preserved as the historical-repair path.
        costStep: createCostStep(store.getRawDb()),
        // Issue #2248: close orphaned turns at the transcript's last-message
        // timestamp (a strict lower-bound duration) instead of NULL. Fail-open —
        // `lastMessageTsMs` returns null on any read failure → the sweep floors.
        orphanWatermarkResolver: ctx => lastMessageTsMs(ctx),
        // Issue #3563: orphaned-grant detection at finalize (the `interrupted` /
        // raw-`errored` abort leg + the R3 clean-end drop). Reads the RAW
        // `event.outcome`; delegates post/drop to the engine (which owns the mint
        // store + MessageService). Gated on `hasOrphanRecords` so the common case
        // (no mint) is a single Map lookup.
        orphanGrantStep: createOrphanGrantStep({
          hasRecords: sid => engine.hasOrphanRecords(sid),
          checkOrphanGrant: sid => engine.checkOrphanGrant(sid),
          dropOnCleanTurnEnd: (sid, startedAtMs) =>
            engine.dropOrphanRecordsForCleanTurn(sid, startedAtMs),
          getOpenTurnStartedAtMs: (sid, seq) =>
            store.turns
              .getOpenTurns()
              .find(t => t.hapiSessionId === sid && t.seq === seq)
              ?.startedAtMs ?? null,
          log: (message, context) => errorLogger?.info(message, context),
        }),
        // Issue #3563: the account-switch / kill backstop (no `turn:finalize`)
        // sweeps the orphaned-grant check after orphaning the tracked turns.
        onSessionOrphaned: sid => engine.checkOrphanGrant(sid),
        // Issue #1905: runaway-session ceiling guard — a SYNCHRONOUS finalize
        // step that invokes the engine's public `checkSessionCeilings` (the
        // engine owns the metering + dedupe + hard-stop). Fail-open (1905-3).
        ceilingGuardStep: createCeilingGuardStep({
          check: sid => engine.checkSessionCeilings(sid),
          errorLogger,
        }),
      }
    );
    engine.setTurnLifecycle(turnLifecycle);

    // Issue #1905: seed the engine's cached ceiling-guard config (read
    // synchronously by the finalize step; refreshed at runtime by
    // PUT /preferences/ceiling-guard) and inject the G2 web-push dep. The G3
    // out-of-band page uses the shared #1883 Notifier (setNotifier, above).
    engine.setCeilingGuardConfig(await loadCeilingGuardConfig(settingsFile));
    engine.setCeilingGuardDeps({ pushService });
  }

  // Epic #1662, Sub J (#1672): workflow-state reconcile poller. Node-local
  // (syncEngine.getSessions() = this node's sessions); DEFAULT DISABLED (KD3) so
  // the read-path badge/chips ship independently. Constructed after federation
  // config so node_id matches the turn write service's stamping.
  if (syncEngine) {
    const reconcileEngine = syncEngine;
    workflowReconcileService = new WorkflowReconcileService({
      getSessions: () => reconcileEngine.getSessions(),
      turnStore: store.turns,
      nodeId: federationConfig?.nodeId ?? "standalone",
      config: loadWorkflowReconcileConfig(),
      errorLogger,
      jobRegistry,
    });
    workflowReconcileService.start();
  }

  // Skill-revamp 3.2 (#2157): the webhook gap detector — arbitrates push vs
  // poll-fallback for the drain endpoint's queue-health verdict (R6) and, on a
  // GENUINE gap, fire-and-forgets the EXISTING reconcile poller (reconcileNow)
  // rather than a second poller. Constructed AFTER the reconcile service so its
  // reconcile closure can reach it; both no-op when their flags are off (R7 /
  // HAPI_WORKFLOW_RECONCILE_ENABLED). Injected into the initiatives route via
  // startWebServer.
  webhookGapDetector = new WebhookGapDetector({
    config: githubWebhookConfig,
    getStore: () => store,
    reconcile: async repo => {
      await workflowReconcileService?.reconcileNow(repo);
    },
    errorLogger,
  });

  // Initialize Sentry error tracking (after federation config so node tags are available)
  initSentry({
    dsn: process.env.SENTRY_DSN,
    nodeId: federationConfig?.nodeId ?? "standalone",
    nodeLabel: federationConfig?.nodeLabel ?? "Local",
    environment: process.env.NODE_ENV ?? "production",
    release: VERSION,
  });

  // Federation terminal node handler — accepts incoming WS connections
  // from the hub (runs on all federation-enabled nodes, including the hub)
  let federationTerminalHandler: FederationTerminalNodeHandler | null = null;
  // Web-desktop raw-WS proxy (issue #2693). Constructed unconditionally — it is
  // inert on non-cloud instances (the tier gate 403s without a ~/.config/hapimatic/vm-tier
  // marker), so no federation/cloud guard is needed here.
  const desktopProxyHandler = new DesktopProxyHandler();

  if (federationConfig) {
    console.log(
      `[Federation] Enabled — role: ${federationConfig.role}, nodeId: ${federationConfig.nodeId}`
    );

    // Create the node-side terminal handler (all nodes accept terminal WS)
    federationTerminalHandler = new FederationTerminalNodeHandler({
      io: socketServer.io,
      terminalRegistry: socketServer.terminalRegistry,
      getSession: sessionId =>
        syncEngine?.getSession(sessionId) ??
        store.sessions.getSession(sessionId),
    });

    // NodeRegistry + RemoteTerminalProxy run on hub and peer roles.
    // "node" role remains headless (spoke-only, no registry/proxy).
    if (federationConfig.role !== "node") {
      nodeRegistry = new NodeRegistry({
        config: federationConfig,
        apiToken: federationApiToken,
        getLocalSessionCount: () => syncEngine?.getSessions().length ?? 0,
        peerStore: store.peers,
        // #1969 (R4/R6): merge bridged + polled peer claim snapshots; drop a
        // peer's register on eviction / the offline transition.
        fileClaimSync,
      });
      nodeRegistry.start();

      // Start event bridge: persistent SSE connections to remote nodes
      // that re-broadcast their events through the local SSEManager.
      if (sseManager) {
        nodeRegistry.startEventBridge(sseManager);
      }

      // Terminal proxy for outgoing WS to remote nodes
      remoteTerminalProxy = new RemoteTerminalProxy(federationApiToken);

      // Peer announcer for dynamic peer discovery (P2P mesh)
      peerAnnouncer = new PeerAnnouncer({
        config: federationConfig,
        apiToken: federationApiToken,
        peerStore: store.peers,
        jobRegistry,
      });
      peerAnnouncer.start();

      // Federation health aggregator (#1445): a SEPARATE poll loop that only
      // READS nodeRegistry.getNodeStates() — it never touches pollNode() (the
      // session-sync hot path). Samples the local node in-process and polls
      // each remote peer's /api/federation/node-metrics with the fed token.
      const healthPollIntervalMs = parseEnvInt(
        process.env.HAPI_FED_HEALTH_POLL_MS,
        30_000
      );
      const healthFetchTimeoutMs = parseEnvInt(
        process.env.HAPI_FED_HEALTH_FETCH_TIMEOUT_MS,
        8_000
      );
      const offlineGraceMult = parseEnvInt(
        process.env.HAPI_FED_HEALTH_OFFLINE_GRACE_MULT,
        2
      );
      const tsRetentionMinutes = parseEnvInt(
        process.env.HAPI_FED_HEALTH_TS_RETENTION_MIN,
        60
      );
      const alertCapacity = parseEnvInt(
        process.env.HAPI_FED_ALERT_BUFFER_CAPACITY,
        1_000
      );
      let healthThresholds = DEFAULT_FEDERATION_HEALTH_THRESHOLDS;
      if (process.env.HAPI_FED_HEALTH_THRESHOLDS) {
        try {
          const parsed = FederationHealthThresholdsSchema.safeParse(
            JSON.parse(process.env.HAPI_FED_HEALTH_THRESHOLDS)
          );
          if (parsed.success) {
            healthThresholds = parsed.data;
          } else {
            console.warn(
              "[Federation] HAPI_FED_HEALTH_THRESHOLDS invalid shape — using defaults"
            );
          }
        } catch {
          console.warn(
            "[Federation] HAPI_FED_HEALTH_THRESHOLDS not valid JSON — using defaults"
          );
        }
      }
      const healthFedToken = federationApiToken;
      const alertGenerator = new AlertGenerator(
        new AlertRingBuffer(alertCapacity)
      );
      healthAggregator = new HealthAggregator({
        getNodeStates: () => nodeRegistry?.getNodeStates() ?? [],
        gatherLocalMetrics: gatherSystemHealth,
        fetchPeerMetrics: async (url: string): Promise<SystemHealthMetrics> => {
          const headers: Record<string, string> = {};
          if (healthFedToken) {
            headers["Authorization"] = `Bearer ${healthFedToken}`;
          }
          const res = await fetch(url, {
            headers,
            signal: AbortSignal.timeout(healthFetchTimeoutMs),
          });
          if (!res.ok) {
            throw new Error(`node-metrics HTTP ${res.status}`);
          }
          // Validate the peer payload instead of blind-casting it (#1519). A
          // malformed payload throws here, routing the node through the same
          // catch → health=null → commitStale path as `!res.ok` above
          // (→ offline → critical), rather than being read as "healthy".
          const parsed = SystemHealthMetricsSchema.safeParse(await res.json());
          if (!parsed.success) {
            throw new Error(
              `node-metrics malformed payload: ${parsed.error.message}`
            );
          }
          return parsed.data;
        },
        localNodeId: federationConfig.nodeId,
        localNodeLabel: federationConfig.nodeLabel,
        alertGenerator,
        alertSource: alertGenerator,
        config: {
          healthPollIntervalMs,
          offlineGraceMs: offlineGraceMult * healthPollIntervalMs,
          tsRetentionMinutes,
          thresholds: healthThresholds,
        },
        jobRegistry,
      });
      healthAggregator.start();

      console.log(
        `[Federation] NodeRegistry + terminal proxy + peer announcer initialized (${federationConfig.role})`
      );
    }
  }

  // Auto-recovery service (#1234, Epic #1231 Sub-Issue C). Constructed AFTER
  // both SyncEngine AND the federation NodeRegistry so the owning-node check
  // (R8) is wired; nodeRegistry is null for the headless "node" role (single-
  // node semantics — the R8 check is skipped). The global toggle is read FRESH
  // per recovery decision via settingsFile (R6/LC-3) — NO startup caching, so
  // an admin toggle takes effect at the next decision without a restart.
  if (syncEngine) {
    const autoRecoveryConfig = await loadAutoRecoveryConfig(config.dataDir);
    autoRecoveryService = new AutoRecoveryService(
      syncEngine,
      nodeRegistry,
      autoRecoveryConfig,
      errorLogger,
      settingsFile
    );
    autoRecoveryService.start();

    // Auto-switch-on-rate-limit service (#3618). Same subscribe-based pattern as
    // AutoRecoveryService, constructed in the SAME `if (syncEngine)` guard so the
    // owning-node R4 check shares the wired nodeRegistry. The global toggle is
    // read FRESH per switch decision (an instant kill-switch) and defaults OFF —
    // so with the preference off this is byte-identical to before. Reuses the ONE
    // shared UsageService cache (getLatest only, never a hot-path refresh) and the
    // hoisted AccountService (getRaw, fresh file read) — no second cache, no
    // web/server.ts injection.
    const autoSwitchConfig = await loadAutoSwitchConfig(config.dataDir);
    autoSwitchService = new AutoSwitchOnRateLimitService(
      syncEngine,
      nodeRegistry,
      autoSwitchConfig,
      errorLogger,
      settingsFile,
      {
        usageService,
        getAccountService: () => usageAccountService,
      }
    );
    autoSwitchService.start();
  }

  // #2627 (Sub-Issue E): custom output-style store + federation replicator.
  // Constructed unconditionally so its constructor ensures `~/.claude/output-styles/`
  // exists (R6 — the account-config-dir symlink) and local uploads persist even
  // standalone. The reconcile pull loop (Task 3b) starts only when federation is
  // enabled — it has peers to pull from then.
  outputStyleSyncService = new OutputStyleSyncService({
    resolvePeers: () => [
      ...(federationConfig?.nodes ?? []).map(n => ({ id: n.id, url: n.url })),
      ...(peerAnnouncer?.getKnownPeers() ?? []).map(p => ({
        id: p.id,
        url: p.url,
      })),
    ],
    localNodeId: federationConfig?.nodeId ?? null,
    apiToken: federationApiToken,
  });
  if (federationConfig) {
    outputStyleSyncService.start();
  }

  // #3873: self-heal the on-node self-knowledge doc at boot. Every binary update
  // restarts the server, so (re)generating ~/.claude/agent-self-knowledge.md here
  // — from the compiled catalog + embedded preamble + running VERSION — keeps it
  // fresh BY CONSTRUCTION (the build-time reconcile push never re-runs on an
  // auto-update). Unconditional (NOT federation-gated): user VMs have no
  // federation but their doc must refresh too — the scope resolver handles
  // user-vs-operator. Fail-soft by construction (never throws), and `await`-ed so
  // the single small write completes before `listen`, off the request hot path.
  await writeBootSelfKnowledge({ errorLogger });

  // #2624 (Sub-Issue B): federation-global settings store + replicator.
  // Constructed unconditionally (mirrors E) so reads work standalone; the
  // reconcile pull loop starts only when federation is enabled (it has peers then).
  settingsSyncService = new SettingsSyncService({
    settingsFile: getSettingsFile(config.dataDir),
    resolvePeers: () => [
      ...(federationConfig?.nodes ?? []).map(n => ({ id: n.id, url: n.url })),
      ...(peerAnnouncer?.getKnownPeers() ?? []).map(p => ({
        id: p.id,
        url: p.url,
      })),
    ],
    localNodeId: federationConfig?.nodeId ?? null,
    apiToken: federationApiToken,
  });
  if (federationConfig) {
    settingsSyncService.start();
  }

  // #1770 (epic #1769): the harness self-update poll. Constructed AFTER
  // federationConfig — KD-10 needs `nodeId`, KD-5 needs `claudePath`. Started
  // UNCONDITIONALLY (KD-9): with `enabled:false` the SupervisedLoop registers a
  // visible "stopped" job row and never ticks, but the service is still
  // constructed and detectNow() still powers "check now" (R7) — so this is NOT
  // gated on `if (federationConfig)`. Passes the same `{ node, jobRegistry }`
  // jobOpts every supervised service uses (System Jobs portal + stall/death alerts).
  const harnessPollConfig = await loadHarnessPollConfig(config.dataDir);
  harnessPollService = new HarnessPollService(
    {
      store,
      registry: harnessRegistry,
      config: harnessPollConfig,
      // #1775: the data dir whose settings.json holds `harnessPoll`, so the
      // service's updateConfig()/setPollConfig() can re-read + persist the
      // user-configurable cadence at runtime (GET/PUT /api/harness/poll-config).
      dataDir: config.dataDir,
      nodeId: federationConfig?.nodeId ?? "standalone",
      claudePath: federationConfig?.claudePath,
      errorLogger,
    },
    { node: jobNodeId, jobRegistry }
  );
  harnessPollService.start();

  // #1772: the impact-analysis service — orchestrates the peer session + is the
  // submit endpoint's ImpactAnalysisCoordinator. nodeId matches the harness
  // poll's literal (R4) so (node_id, harness_id, version_range) lookups align.
  if (syncEngine) {
    impactService = new ImpactService({
      engine: syncEngine,
      store,
      nodeId: federationConfig?.nodeId ?? "standalone",
      // The directory the analysis peer spawns into. It should be a
      // hapimatic-private checkout so the peer can grep code for `file:line`
      // evidence. The server's own cwd is the systemd WorkingDirectory
      // (`/home/matt`, NOT a source checkout), so HAPI_IMPACT_ANALYSIS_REPO_ROOT
      // lets the operator point it at the right tree; process.cwd() is the
      // fallback (issue-based evidence via `gh` still works from anywhere).
      repoRoot: process.env.HAPI_IMPACT_ANALYSIS_REPO_ROOT ?? process.cwd(),
    });

    // #1774 (Sub E, epic #1769): the privileged update/rollback facade. Same
    // nodeId + registry as the poll (R4/R11); `detectNow` is the poll's
    // detection core, re-run after a successful apply. Spawn-quiesce (Task 10)
    // is wired to the daemon control endpoint so the symlink-flip spawn race is
    // narrowed during the exec.
    updateService = new UpdateService({
      engine: syncEngine,
      store,
      registry: harnessRegistry,
      nodeId: federationConfig?.nodeId ?? "standalone",
      // #1775: adapt to UpdateService's `() => Promise<void>` contract — discard
      // the coalesce flag detectNow now returns. The post-apply re-detection (R4)
      // only needs the pass to run, not whether it coalesced.
      detectNow: async harnessId => {
        await harnessPollService!.detectNow(harnessId);
      },
      pauseSpawning: async () => {
        const r = await setDaemonSpawnPaused(true);
        if ("error" in r) {
          errorLogger?.warn(
            `[harness-update] spawn-quiesce pause skipped: ${r.error}`,
            { category: "harness-update" }
          );
        }
      },
      resumeSpawning: async () => {
        const r = await setDaemonSpawnPaused(false);
        if ("error" in r) {
          errorLogger?.warn(
            `[harness-update] spawn-quiesce resume failed: ${r.error}`,
            { category: "harness-update" }
          );
        }
      },
    });
  }

  // Start HTTP server for Telegram Mini App
  webServer = await startWebServer({
    // #1294: filesystem runtime-web-extension serving (mirrors the server-side
    // fs-loader gate above). extensionsDir = ${HAPI_HOME}/extensions.
    extensionsDir: join(config.dataDir, "extensions"),
    fsExtensionsEnabled,
    getSyncEngine: () => syncEngine,
    getSseManager: () => sseManager,
    getHeartbeatService: () =>
      loadedExtensions?.getService<HeartbeatService>("heartbeat") ?? null,
    // #1274: resolved from the extension's cross-extension service registry
    // (locked §3d) rather than a core-owned binding. Lazy — `builtin.scheduler`
    // publishes the handle from its onStartup hook, which drains after the web
    // server is constructed. Returns null until then, and the heartbeat routes
    // already treat a null scheduler as "no DB heartbeat task".
    getSchedulerService: () =>
      loadedExtensions?.getService<SchedulerService>("scheduler") ?? null,
    getContextWatermarkService: () => contextWatermarkService,
    getNodeRegistry: () => nodeRegistry,
    getNotificationService: () => notificationService,
    getHealthAggregator: () => healthAggregator,
    getPeerAnnouncer: () => peerAnnouncer,
    // #1969 (R5): the /file-claims cross-node union reads this replica.
    getFileClaimSync: () => fileClaimSync,
    // #2627 (Sub-Issue E): the custom output-style store, for the upload route +
    // the federation output-style-sync receiver/digest.
    getOutputStyleSyncService: () => outputStyleSyncService,
    // #2624 (Sub-Issue B): the federation-global settings store, for the
    // preference PUT fan-out + the settings-sync receiver/digest.
    getSettingsSyncService: () => settingsSyncService,
    // #1770: the harness poll service, for GET /api/harness/status +
    // POST /api/harness/check.
    getHarnessPollService: () => harnessPollService,
    getImpactService: () => impactService,
    // #1774: the privileged update/rollback facade, for the JWT-gated per-node
    // POST /api/harness/:id/update + /rollback routes.
    getUpdateService: () => updateService,
    getJobRegistry: () => jobRegistry,
    getDaemonJobs: () => daemonJobsMonitor.getCached(),
    // #3743 (Sub-Issue C): the per-session RPC registry, for the live capability
    // catalog's RPC section (mirrors the extension-host getter above).
    getRpcRegistry: () => socketServer.rpcRegistry,
    usageService,
    // Issue #3809: the sibling providerUsage[] service (constructed above).
    providerUsageService,
    federationConfig,
    federationApiToken,
    jwtSecret,
    store,
    // Extension-contributed route factories (issue #1270, locked §5f) — mounted
    // under /api AFTER the auth middleware inside createWebApp.
    extensionRouteFactories: loadedExtensions?.routeFactories ?? [],
    // Extension-contributed capability-catalog entries (#3752) — merged into the
    // live catalog (owner + trusted already stamped by the loader drain).
    extensionCatalogEntries: loadedExtensions?.catalogEntries ?? [],
    vapidPublicKey: vapidKeys.publicKey,
    socketEngine: socketServer.engine,
    federationTerminalHandler,
    desktopProxyHandler,
    errorLogger,
    getTelemetryStore: () => telemetryStore,
    getScorecardStore: () => scorecardStore,
    getWebhookGapDetector: () => webhookGapDetector,
  });

  // #1271: the Telegram bot's start() moved into the extension's
  // `host.lifecycle.onStartup` hook, drained by the loader below.

  // Error log cleanup loop — every 24 hours, delete entries older than 30 days
  cleanupLoop = createErrorLogCleanupLoop({
    store,
    errorLogger,
    node: jobNodeId,
    registry: jobRegistry,
  });
  cleanupLoop.start();

  // #2911: retry feedback rows not yet in the gateway's central sink. Resolved
  // from the same federation identity buildWebApp's POST kick uses.
  feedbackSinkLoop = startSinkReconciler({
    store,
    sinkConfig: resolveFeedbackSinkConfig({
      nodeId: federationConfig?.nodeId ?? null,
      nodeLabel: federationConfig?.nodeLabel ?? null,
    }),
    node: jobNodeId,
    registry: jobRegistry,
  });
  feedbackSinkLoop?.start();

  // #4913: hourly 48-hour notification purge (see notificationPurge.ts).
  notificationPurgeLoop = createNotificationPurgeLoop({
    service: notificationService,
    node: jobNodeId,
    registry: jobRegistry,
    errorLogger,
  });
  notificationPurgeLoop.start();

  // WAL checkpoint loop — weekly passive checkpoint
  const WAL_CHECKPOINT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
  walCheckpointLoop = new SupervisedLoop({
    name: "wal-checkpoint",
    node: jobNodeId,
    intervalMs: WAL_CHECKPOINT_INTERVAL_MS,
    immediate: false,
    registry: jobRegistry,
    tick: () => {
      try {
        store.walCheckpoint();
        // #2447 (D7): refresh planner stats on the same weekly tick; fail-soft
        // so an optimize hiccup never kills the checkpoint loop.
        try {
          store.optimize();
        } catch (err) {
          console.warn("[walCheckpointLoop] PRAGMA optimize failed:", err);
        }
        telemetryStore.walCheckpoint();
        const aggregated = telemetryStore.aggregateMissing();
        if (aggregated > 0) {
          console.log(
            `[TelemetryStore] Aggregated ${aggregated} missing day(s)`
          );
        }
        // Issue #3128: refresh the scorecard rollup snapshot on the same tick.
        scorecardStore.walCheckpoint();
        scorecardStore.aggregateMissing();
        console.log("[Store] WAL checkpoint (passive) completed");
      } catch (err) {
        console.error("[Store] WAL checkpoint failed:", err);
        throw err;
      }
    },
  });
  walCheckpointLoop.start();
  transcriptIndexer.start({ config, jobNodeId, jobRegistry, syncEngine });

  turnMirrorWiring.startTurnMirrorPull({
    federationConfig,
    jobNodeId,
    jobRegistry,
    getNodeRegistry: () => nodeRegistry,
    turnMirror: store.turnMirror,
  });

  // Invoke extension startup callbacks (issue #1270, locked §3b) — AFTER all
  // core services are constructed. Long-running extension services start here,
  // never inside register(). Fail-soft: one bad callback does not abort boot.
  if (loadedExtensions) {
    for (const onStartup of loadedExtensions.onStartup) {
      try {
        await onStartup();
      } catch (err) {
        console.error("[ext:loader] onStartup callback failed:", err);
      }
    }
  }

  // Transition: disable the legacy HeartbeatService when a DB heartbeat task
  // exists. #1274 relocated this from immediately after the old inline
  // `schedulerService.start()` — it reads scheduler state, so it has to run
  // after `builtin.scheduler`'s onStartup hook has constructed and started the
  // service. A null scheduler (extension disabled) leaves the legacy service
  // running, exactly as it did before the migration.
  const migratedScheduler =
    loadedExtensions?.getService<SchedulerService>("scheduler") ?? null;
  const migratedHeartbeat =
    loadedExtensions?.getService<HeartbeatService>("heartbeat") ?? null;
  if (migratedScheduler && migratedHeartbeat) {
    const heartbeatTaskExists = migratedScheduler
      .getEnabledTasks()
      .some(t => t.heartbeatMode);
    if (heartbeatTaskExists) {
      migratedHeartbeat.stop();
      console.log(
        "[Heartbeat] Disabled old service — DB heartbeat task is active"
      );
    }
  }

  // Issue #2589 (epic #2586 Sub-Issue G): session-aware deferred update apply.
  // "Update when idle" writes a server-side marker; this watcher fires the SAME
  // apply the "Update now" path uses (launchUpdater) once no session is thinking
  // — surviving tab close AND this restart (it resumes from the on-disk marker).
  // R4: after N hours of a never-idle deferral it nudges the operator via the
  // scheduler (D4). Every leg is best-effort — a read/spawn error leaves the
  // deferral pending and never force-applies.
  const updaterLauncherConfig = resolveLauncherConfig({
    errorLogger,
    dataDir: config.dataDir,
  });
  deferredApplyWatcher = new DeferredApplyWatcher({
    dataDir: updaterLauncherConfig.dataDir,
    // #3735: gate on the ACTIVE (#1477 history-deflated) set — the same source the
    // badge's computeSessionImpact uses — so the gate count and the displayed
    // blocking count cannot diverge, and a stale/duplicate inactive record cannot
    // wedge the apply. The isBlockingThinking predicate excludes the tui-blocked /
    // rate-limited "perpetual thinking" classes on top of this.
    getActiveSessions: () => syncEngine?.getActiveSessions() ?? [],
    isUpdateAvailable: () =>
      computeStatus(updaterLauncherConfig.dataDir).updateAvailable,
    // #3057: the deferral is only created once the update is staged+ready, so the
    // idle-fire is an `--apply-only` (re-verify staged bytes → swap → restart),
    // NOT the combined fetch-and-apply. The watcher owns completion via the durable
    // job state, not this launch's acceptance.
    applyUpdate: () => launchUpdater(updaterLauncherConfig, "apply"),
    machineName: federationConfig?.nodeLabel,
    onNudge: async ctx => {
      // #3735: notify-only. The nudge previously spawned a check-back Claude session
      // via SchedulerService — but a spawned session is itself a node-local, thinking
      // session while it runs, momentarily ADDING to the very gate count the apply is
      // blocked on; and its prompt pointed the operator at a "force it now" control
      // that did not exist. A push is lighter and side-effect-free, and now references
      // the real "Apply anyway" control the pending dialog exposes. A throw here is
      // caught + logged by maybeNudge, which persists nudgedAt regardless (fires once).
      const hours = Math.round(ctx.ageMs / (60 * 60 * 1000));
      await pushService.sendToNamespace(ctx.namespace ?? "default", {
        title: "⏳ Update still pending",
        body:
          `The Hapimatic update for ${ctx.machineName ?? "this instance"} was ` +
          `deferred ~${hours}h ago and is still waiting for every Claude Code session ` +
          `to finish responding. Force it now with "Apply anyway" on the update badge, ` +
          `or cancel it there.`,
        tag: "deferred-update-pending",
        data: { type: "deferred-update-pending", url: "/" },
      });
    },
    errorLogger,
    jobRegistry,
    node: jobNodeId,
  });
  deferredApplyWatcher.start();

  console.log("\nHAPI Server is ready!");

  // Handle shutdown
  const shutdown = async () => {
    console.log("\nShutting down...");
    cleanupLoop?.stop();
    feedbackSinkLoop?.stop();
    notificationPurgeLoop?.stop();
    walCheckpointLoop?.stop();
    transcriptIndexer.stop();
    turnMirrorWiring.stopTurnMirrorPull(); // issue #4614
    // #1271: the Telegram bot's stop() moved into the extension's
    // `host.lifecycle.onShutdown` hook, drained further down this handler.
    remoteTerminalProxy?.stop();
    peerAnnouncer?.stop();
    outputStyleSyncService?.stop();
    settingsSyncService?.stop();
    harnessPollService?.stop();
    healthAggregator?.stop();
    nodeRegistry?.stop();
    usageSampler?.stop();
    autoRecoveryService?.stop();
    autoSwitchService?.stop();
    contextWatermarkService?.stop();
    deferredApplyWatcher?.stop();
    // #1274: the scheduler's stop() moved into `builtin.scheduler`'s
    // `host.lifecycle.onShutdown` hook, drained further down this handler —
    // still before `syncEngine?.stop()`, preserving the required ordering.
    workflowReconcileService?.stop();
    // #1275: heartbeatService.stop() moved into builtin.heartbeat's onShutdown
    // hook, drained further down this handler (safe after notificationHub.stop —
    // unregisterManagedSession is a plain Set.delete).
    notificationHub?.stop();
    // Invoke extension shutdown callbacks (issue #1270, locked §3b). Fail-soft.
    if (loadedExtensions) {
      for (const onShutdown of loadedExtensions.onShutdown) {
        try {
          await onShutdown();
        } catch (err) {
          console.error("[ext:loader] onShutdown callback failed:", err);
        }
      }
    }
    // #3631: land any deferred message writes while the socket server is alive.
    messageWriteRetryQueue?.flush();
    messageWriteRetryQueue?.stop();
    turnWriteService?.flush();
    turnWriteService?.stop();
    queueDrainObserver?.stop();
    orphanGrantObserver?.stop();
    spendNoticeObserver?.stop();
    initiativeEventObserver?.stop();
    syncEngine?.stop();
    sseManager?.stop();
    webServer?.stop();
    // #2447: refresh SQLite planner stats before exit — no Store.close() exists,
    // so this is the "before close" point. Fail-soft so a hiccup can't block
    // shutdown; ANALYZE writes land in the WAL and checkpoint on the next open.
    try {
      store.optimize();
    } catch (err) {
      console.warn("[shutdown] PRAGMA optimize failed:", err);
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep process running
  await new Promise(() => {});
}

main().catch(error => {
  console.error("Fatal error:", error);
  process.exit(1);
});
