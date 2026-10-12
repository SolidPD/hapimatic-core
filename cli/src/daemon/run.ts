// SPDX-License-Identifier: MIT
import { ApiClient } from "@/api/api";
import { accountStore } from "@/accounts/accountStore";
import { createUtilizationSampler } from "@/accounts/utilizationSampler";
import { CredentialsWatcher } from "@/accounts/credentialsWatcher";
import { fetchOauthProfile } from "@/accounts/oauthProfile";
import {
  seedAccountsAtBoot,
  decodeDeliveredIdentities,
  seedSkipLogLevel,
  type SeedBootResult,
} from "@/accounts/seedFromEnvToken";
import {
  recordAmbientTokenState,
  settleEnvSeedToken,
} from "./envSeedTokenDisposition";
import { buildDaemonBootRecord } from "./daemonBootRecord";
import { TrackedSession } from "./types";
import {
  collectLocalBindings,
  isSessionLiveForGuard,
  resolveLiveFreshnessWindowMs,
  type LocalBindingInput,
} from "./sessionLiveness";
import {
  isSessionBusyForRotation,
  type SessionBusySignal,
} from "@hapi/protocol/sessionBusy";
import { createBoundSessionRestarter } from "./boundSessionRestart";
import { DaemonState, type Machine, Metadata } from "@/api/types";
import {
  SpawnSessionOptions,
  SpawnSessionResult,
  RestartSummary,
  ForceRefreshReport,
} from "@/modules/common/rpcTypes";
import { runForceRefreshHarness } from "@/accounts/forceRefreshHarness";
import { probeAccessToken } from "@/accounts/isolatedSnapshotRecovery";
import { logger } from "@/ui/logger";
import { authAndSetupMachineIfNeeded } from "@/ui/auth";
import packageJson from "../../package.json";
import { getEnvironmentInfo } from "@/ui/doctor";
import {
  writeDaemonState,
  readDaemonStateSync,
  DaemonLocallyPersistedState,
  acquireDaemonLock,
  releaseDaemonLock,
  updateSettings,
} from "@/persistence";
import {
  JobRegistry,
  SupervisedLoop,
  harnessEgressHosts,
} from "@hapi/protocol";
import { isProcessAlive, isWindows } from "@/utils/process";
import {} from "@/utils/processTree";

import {
  cleanupDaemonState,
  getInstalledCliMtimeMs,
  isDaemonRunningCurrentlyInstalledHappyVersion,
  stopDaemon,
} from "./controlClient";
import { startDaemonControlServer } from "./controlServer";
import {
  startEgressBroker,
  setActiveEgressBrokerPort,
  type EgressBrokerHandle,
} from "@/sandbox/egressBroker";
import { resolveEgressAllowlist } from "@/sandbox/egressPolicy";
import { runSystemdInvariantsCheck } from "./systemdInvariants";
import { createOwnStateWriter } from "./daemonStateOwnership";
import {} from "./orphanCheckDecision";
import {} from "./worktree";
import {} from "./worktreeMeta";
import { buildMachineMetadata } from "@/agent/sessionFactory";
import {
  initializeRecovery,
  isTmuxPersistenceEnabled,
} from "./recoveryIntegration";
import {} from "./tmuxSpawnAdapter";
import { configuration } from "@/configuration";
import {
  TokenRefreshService,
  type LiveAccountKeys,
} from "@/accounts/tokenRefreshService";
import { rotationLeaseManager } from "@/accounts/rotationLeaseManager";
import {
  assessRemoteChainIndependence,
  defaultLocalChainFingerprint,
  makeRemoteChainFingerprintsFetcher,
} from "@/accounts/remoteChainIndependence";
import { TmuxManager } from "@/tmux";
import type { DaemonContext } from "./daemonContext";
import { createSessionTracker, resolveMaxConcurrent } from "./sessionTracker";
import { createSessionSpawner } from "./sessionSpawner";
import { createHealthScheduler } from "./healthScheduler";
import {
  createWorktreeCollector,
  runningInsideWorktreeInstanceDaemon,
} from "./worktreeCollector";
import {
  machineRotatorRoleLine,
  resolveMachineRotatorRole,
  scanSiblingBoundAccounts,
} from "@/accounts/machineRotator";

/**
 * Additive test seams for {@link startDaemon} (issue #2079, characterization
 * tests for the daemon lifecycle). Every field is OPTIONAL with a production
 * default that preserves the pre-change code path byte-for-byte:
 *  - `onReady` is invoked only when defined — production leaves it `undefined`,
 *    so the daemon never calls it;
 *  - `now` / `setTimeoutFn` / `clearTimeoutFn` are threaded ONLY into the two
 *    `SupervisedLoop` constructors, which already default each to the global
 *    (`opts.now ?? Date.now`, etc.), so passing `undefined` is identical to not
 *    passing the field at all.
 * No logic is moved and no closure is promoted out of `startDaemon` — the
 * `DaemonContext` DI struct is Sub-Issue D (#2081). See
 * `claudedocs/issue-2079-directives.md`.
 */
export interface StartDaemonTestSeams {
  /**
   * Invoked once, after full daemon setup (both `SupervisedLoop`s started,
   * `cleanupAndShutdown` defined) and BEFORE the daemon blocks on the shutdown
   * promise. Receives live handles to the daemon's internal closures + loop
   * instances so a characterization test can drive spawn/stop/track/heartbeat/
   * shutdown with all real I/O faked. `undefined` in production ⇒ never called.
   */
  onReady?: (handles: DaemonRuntimeHandles) => void | Promise<void>;
  /** Injectable clock for the two `SupervisedLoop`s (defaults to `Date.now`). */
  now?: () => number;
  /** Injectable `setTimeout` for the two `SupervisedLoop`s (defaults to global). */
  setTimeoutFn?: (
    handler: () => void,
    ms: number
  ) => ReturnType<typeof setTimeout>;
  /** Injectable `clearTimeout` for the two `SupervisedLoop`s (defaults to global). */
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * Live handles into a running `startDaemon`'s internal closures + loop
 * instances, passed to {@link StartDaemonTestSeams.onReady}. Exists ONLY to make
 * the lifecycle drivable under vitest — no production code path consumes it.
 */
export interface DaemonRuntimeHandles {
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  stopSession: (sessionId: string) => boolean;
  requestShutdown: (
    source: "hapi-app" | "hapi-cli" | "os-signal" | "exception",
    errorMessage?: string
  ) => void;
  getCurrentChildren: () => TrackedSession[];
  computeEffectiveCount: (
    // Issue #2299: optional own-slot credit id (a reused-window respawn's
    // hapiSessionId). Assignable to the pre-existing zero-arg callers.
    creditHapiSessionId?: string
  ) => Promise<{
    effectiveCount: number;
    trackedPids: number;
    activeTmuxWindows: number;
    max: number;
  }>;
  onHappySessionWebhook: (sessionId: string, sessionMetadata: Metadata) => void;
  maintenanceLoop: SupervisedLoop;
  daemonJobWatchdog: SupervisedLoop;
  collectorLoop: SupervisedLoop;
}

export async function startDaemon(
  testSeams: StartDaemonTestSeams = {}
): Promise<void> {
  // Defense #1: Sanitize inherited env vars from parent shell.
  // When daemon is started from within a Hapimatic session, it inherits
  // HAPI_SESSION_ID and HAPI_TMUX_WINDOW which would leak to all spawned
  // child processes, causing session collision. See issue #283.
  delete process.env.HAPI_SESSION_ID;
  delete process.env.HAPI_TMUX_WINDOW;

  // We don't have cleanup function at the time of server construction
  // Control flow is:
  // 1. Create promise that will resolve when shutdown is requested
  // 2. Setup signal handlers to resolve this promise with the source of the shutdown
  // 3. Once our setup is complete - if all goes well - we await this promise
  // 4. When it resolves we can cleanup and exit
  //
  // In case the setup malfunctions - our signal handlers will not properly
  // shut down. We will force exit the process with code 1.
  // Issue #4155 (R3): set FIRST by every shutdown request (signal, /stop,
  // hapi-app, exception, replacement). Once true, this daemon never writes
  // daemon.state.json again — see writeOwnState below and healthScheduler.
  let shutdownRequested = false;
  // #4755: armed once (first request); cleared before both terminal exits below.
  let shutdownFallbackTimer: ReturnType<typeof setTimeout> | undefined;
  let requestShutdown: (
    source: "hapi-app" | "hapi-cli" | "os-signal" | "exception",
    errorMessage?: string
  ) => void;
  let resolvesWhenShutdownRequested = new Promise<{
    source: "hapi-app" | "hapi-cli" | "os-signal" | "exception";
    errorMessage?: string;
  }>(resolve => {
    requestShutdown = (source, errorMessage) => {
      shutdownRequested = true;
      logger.debug(
        `[DAEMON RUN] Requesting shutdown (source: ${source}, errorMessage: ${errorMessage})`
      );

      // Fallback - in case startup malfunctions - we will force exit the process with code 1
      shutdownFallbackTimer ??= setTimeout(async () => {
        logger.debug(
          "[DAEMON RUN] Startup malfunctioned, forcing exit with code 1"
        );

        // Give time for logs to be flushed
        await new Promise(resolve => setTimeout(resolve, 100));

        process.exit(1);
      }, 1_000);

      // Start graceful shutdown
      resolve({ source, errorMessage });
    };
  });

  // Setup signal handlers
  process.on("SIGINT", () => {
    logger.debug("[DAEMON RUN] Received SIGINT");
    requestShutdown("os-signal");
  });

  process.on("SIGTERM", () => {
    logger.debug("[DAEMON RUN] Received SIGTERM");
    requestShutdown("os-signal");
  });

  if (isWindows()) {
    process.on("SIGBREAK", () => {
      logger.debug("[DAEMON RUN] Received SIGBREAK");
      requestShutdown("os-signal");
    });
  }

  process.on("uncaughtException", error => {
    logger.error("[DAEMON RUN] FATAL: Uncaught exception", error);
    logger.error(`[DAEMON RUN] Stack trace: ${error.stack}`);
    requestShutdown("exception", error.message);
  });

  process.on("unhandledRejection", (reason, promise) => {
    logger.error("[DAEMON RUN] FATAL: Unhandled promise rejection", reason);
    logger.error(`[DAEMON RUN] Rejected promise:`, promise);
    const error =
      reason instanceof Error
        ? reason
        : new Error(`Unhandled promise rejection: ${reason}`);
    logger.error(`[DAEMON RUN] Stack trace: ${error.stack}`);
    requestShutdown("exception", error.message);
  });

  process.on("exit", code => {
    logger.debug(`[DAEMON RUN] Process exiting with code: ${code}`);
  });

  process.on("beforeExit", code => {
    logger.debug(`[DAEMON RUN] Process about to exit with code: ${code}`);
  });

  // Sanitize environment: remove session-specific env vars that may have been
  // inherited from a parent Hapimatic session. If left in place, these leak into
  // every child process the daemon spawns, causing all "new" sessions to collide
  // into the same server-side session (see issue #283).
  const SESSION_ENV_VARS_TO_STRIP = ["HAPI_SESSION_ID", "HAPI_TMUX_WINDOW"];
  for (const key of SESSION_ENV_VARS_TO_STRIP) {
    if (process.env[key]) {
      logger.debug(
        `[DAEMON RUN] Stripping inherited env var: ${key}=${process.env[key]}`
      );
      delete process.env[key];
    }
  }

  logger.debug("[DAEMON RUN] Starting daemon process...");
  logger.debugLargeJson("[DAEMON RUN] Environment", getEnvironmentInfo());

  // Check if already running
  // Check if running daemon version matches current CLI version
  const runningDaemonVersionMatches =
    await isDaemonRunningCurrentlyInstalledHappyVersion();
  if (!runningDaemonVersionMatches) {
    logger.debug(
      "[DAEMON RUN] Daemon version mismatch detected, restarting daemon with current CLI version"
    );
    await stopDaemon();
  } else {
    logger.debug(
      "[DAEMON RUN] Daemon version matches, keeping existing daemon"
    );
    console.log("Daemon already running with matching version");
    process.exit(0);
  }

  // Validate systemd unit invariants required for tmux session survival
  // (hapimatic-private#418, hapimatic-private#1132). Default behavior is
  // log-only; set HAPI_DAEMON_ENFORCE_SYSTEMD_INVARIANTS=1 to escalate
  // to refusal-to-start. Placed AFTER the version-mismatch check (so we
  // don't fire on the legitimate exit(0) "already running" fast path) and
  // BEFORE acquireDaemonLock (so a refusal-to-start doesn't orphan the
  // lock file).
  runSystemdInvariantsCheck();

  // Acquire exclusive lock (proves daemon is running)
  const daemonLockHandle = await acquireDaemonLock(5, 200);
  if (!daemonLockHandle) {
    logger.debug(
      "[DAEMON RUN] Daemon lock file already held, another daemon is running"
    );
    process.exit(0);
  }

  // At this point we should be safe to startup the daemon:
  // 1. Not have a stale daemon state
  // 2. Should not have another daemon process running

  try {
    // Ensure auth and machine registration BEFORE anything else
    const { machineId } = await authAndSetupMachineIfNeeded();
    logger.debug("[DAEMON RUN] Auth and machine setup complete");

    // Persist tmux persistence setting to settings.json so manual daemon starts inherit it
    if (configuration.tmuxPersistenceEnabled) {
      try {
        await updateSettings(s => ({ ...s, tmuxPersistenceEnabled: true }));
        logger.debug(
          "[DAEMON RUN] Persisted tmuxPersistenceEnabled=true to settings.json"
        );
      } catch (error) {
        logger.debug("[DAEMON RUN] Failed to persist tmux setting", error);
      }
    }

    // Log tmux persistence resolution for debugging misconfiguration
    const tmuxEnabled = isTmuxPersistenceEnabled();
    const tmuxSource = configuration.tmuxPersistenceEnabled
      ? "HAPI_TMUX_PERSISTENCE env var"
      : tmuxEnabled
        ? "settings.json fallback"
        : "default (disabled)";
    if (tmuxEnabled) {
      logger.info(
        `[DAEMON RUN] tmux persistence: ENABLED (source: ${tmuxSource})`
      );
    } else {
      logger.warn(
        `[DAEMON RUN] tmux persistence: DISABLED (source: ${tmuxSource}). ` +
          `Sessions will spawn as direct child processes and won't survive daemon restarts. ` +
          `Set HAPI_TMUX_PERSISTENCE=true in systemd unit to enable.`
      );
    }

    // Initialize session recovery (for tmux-backed sessions)
    // Returns recovered sessions so we can populate the tracking map below. (Issue #603)
    const recoveredSessions = await initializeRecovery();

    // Setup state - key by PID
    const pidToTrackedSession = new Map<number, TrackedSession>();

    // Populate tracking map with recovered sessions so they count toward
    // the concurrency cap. Without this, the daemon believes it has 0
    // active sessions after every restart. (Issue #603)
    //
    // Sessions with needsReconnect=true are NOT added to the tracking map —
    // their zombie tmux windows have been killed and the server's reconnect
    // API will spawn new CLI processes that register via the normal webhook
    // flow. (Issue #774)
    const genuinelyRecovered = recoveredSessions.filter(s => !s.needsReconnect);
    const reconnecting = recoveredSessions.filter(s => s.needsReconnect);
    if (reconnecting.length > 0) {
      logger.info(
        `[DAEMON RUN] ${reconnecting.length} session(s) are auto-reconnecting (zombie shells killed, server spawning new processes)`
      );
    }
    if (genuinelyRecovered.length > 0 && isTmuxPersistenceEnabled()) {
      const tmux = new TmuxManager({
        sessionName: configuration.tmuxSessionName,
        socketName: configuration.tmuxSessionName,
      });
      for (const recovered of genuinelyRecovered) {
        // #3734 (V2 cross-adoption fix): resolve the recovered window's pid by
        // its @N so two same-titled recovered sessions each map to THEIR OWN
        // pane pid. A name first-match would map both to the first window's pid,
        // collapsing them to one tracking-map entry (the AC forbids this).
        const windowPid = await tmux.getWindowPid(
          recovered.tmuxWindowId ?? recovered.tmuxWindow
        );
        if (windowPid && isProcessAlive(windowPid)) {
          const trackedSession: TrackedSession = {
            startedBy: "daemon",
            pid: windowPid,
            tmuxSessionId: recovered.hapiSessionId,
            tmuxWindow: recovered.tmuxWindow,
            tmuxWindowIndex: recovered.tmuxWindowIndex, // #1316
            tmuxWindowId: recovered.tmuxWindowId, // #3734
            persistedHapiSessionId: recovered.hapiSessionId,
          };
          pidToTrackedSession.set(windowPid, trackedSession);
          logger.info(
            `[DAEMON RUN] Loaded recovered session into tracking map: ${recovered.hapiSessionId} (PID ${windowPid})`
          );
        }
      }
      logger.info(
        `[DAEMON RUN] Tracking map populated with ${pidToTrackedSession.size} recovered sessions (max: ${await resolveMaxConcurrent()})`
      );
    }

    // Session spawning awaiter system - keyed by shell PID for tmux sessions
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();

    // Track tmux shell PIDs separately for descendant matching
    // Maps shell PID -> TrackedSession (the session we're waiting to populate)
    const shellPidToTrackedSession = new Map<number, TrackedSession>();

    // #2081: assemble the injected DaemonContext (populated incrementally as
    // later members are created) and extract the tracked-session helpers, which
    // used to be nested closures here. The maps above are the stable-reference
    // members the tracker needs; late members (api, apiMachine, …) are assigned
    // onto `ctx` at their creation points below.
    const ctx: DaemonContext = {
      pidToTrackedSession,
      pidToAwaiter,
      shellPidToTrackedSession,
    } as DaemonContext;
    const tracker = createSessionTracker(ctx);
    const {
      getCurrentChildren,
      computeEffectiveCount,
      onHappySessionWebhook,
      isTmuxWindowWrapperAlive,
      stopSession,
    } = tracker;
    const { spawnSession } = createSessionSpawner(ctx, tracker);

    // Late-bound force-refresh handler (issue #1547). The control server starts
    // BEFORE tokenRefreshService + restartBoundSessions are constructed (further
    // down), so we pass a stable wrapper here and assign the real handler once the
    // service exists. The `/force-refresh-account` endpoint is never hit before
    // full daemon startup, so the "not ready" path is defensive only.
    let forceRefreshHandler:
      | ((accountUuid: string) => Promise<ForceRefreshReport>)
      | undefined;
    const forceRefreshAccount = (
      accountUuid: string
    ): Promise<ForceRefreshReport> => {
      if (!forceRefreshHandler) {
        return Promise.resolve({
          accountUuid,
          overall: "fail" as const,
          durationMs: 0,
          steps: [
            {
              name: "daemon readiness",
              status: "fail" as const,
              detail:
                "Token-refresh service not yet initialized — daemon still starting up. Retry shortly.",
            },
          ],
          warnings: [],
        });
      }
      return forceRefreshHandler(accountUuid);
    };

    // #1964 (Sub-D): one runtime job registry for this daemon process. Its
    // supervised loops register here; the server's System Jobs portal pulls the
    // snapshot via the control server's /jobs endpoint (the node is re-stamped
    // server-side on merge).
    const daemonJobRegistry = new JobRegistry();
    const daemonJobNode = machineId ?? "standalone";

    // #4153: what `hapi doctor` judges (socket path, accounts dir, token state),
    // for the boot write. It holds the instance credential (#3731 R0b) BEFORE the
    // control server can accept a spawn.
    const boot = buildDaemonBootRecord({
      env: process.env,
      holder: ctx,
      config: configuration,
      uid: process.getuid?.(),
    });

    // Start control server
    const {
      port: controlPort,
      token: controlToken,
      stop: stopControlServer,
    } = await startDaemonControlServer({
      getChildren: getCurrentChildren,
      stopSession,
      spawnSession,
      requestShutdown: () => requestShutdown("hapi-cli"),
      onHappySessionWebhook,
      forceRefreshAccount,
      getEffectiveCount: computeEffectiveCount,
      getJobs: () => daemonJobRegistry.list(),
    });

    const startedWithCliMtimeMs = getInstalledCliMtimeMs();

    // Write initial daemon state (no lock needed for state file)
    const fileState: DaemonLocallyPersistedState = {
      pid: process.pid,
      httpPort: controlPort,
      // issue #1738: local-only daemon-control token (kept out of the API
      // DaemonState below — see initialDaemonState).
      controlToken,
      startTime: new Date().toLocaleString(),
      startedWithCliVersion: packageJson.version,
      startedWithCliMtimeMs,
      daemonLogPath: logger.logFilePath,
      // #3731 (F2) + #4153: the daemon's OWN socket, accounts dir and token state.
      ...boot.record,
    };
    // Issue #4155 (R3/R11): the only path for a post-boot write of
    // daemon.state.json — a synchronous compare-and-write that yields to another
    // LIVE daemon (and requests shutdown) instead of overwriting its record.
    const ownStateWriter = createOwnStateWriter({
      self: { pid: process.pid, httpPort: controlPort, controlToken },
      isAlive: isProcessAlive,
      readState: readDaemonStateSync,
      writeState: writeDaemonState,
      isShutdownRequested: () => shutdownRequested,
      requestShutdown: (source, message) => requestShutdown(source, message),
      warn: message => logger.warn(`[DAEMON RUN] ${message}`),
    });
    // The boot write stays UNCONDITIONAL (bar the latch): this daemon just took
    // the lock, so it asserts ownership — the newest daemon wins, and an older
    // one yields at its next ownership check (#4155 D2).
    if (!shutdownRequested) {
      writeDaemonState(fileState);
      logger.debug("[DAEMON RUN] Daemon state written");
    } else {
      logger.debug(
        "[DAEMON RUN] Shutdown already requested — daemon state NOT written"
      );
    }

    // Prepare initial daemon state
    const initialDaemonState: DaemonState = {
      status: "offline",
      pid: process.pid,
      httpPort: controlPort,
      startedAt: Date.now(),
    };

    // Create API client and register machine — with retry for transient
    // server unavailability. On WSL, systemd service ordering may not
    // guarantee the server is ready when the daemon starts. (Issue #823)
    // Retry up to 5 times with increasing delays: 2s, 4s, 8s, 16s, 30s.
    const api = await ApiClient.create();
    let machine!: Machine;
    const MAX_REGISTRATION_ATTEMPTS = 5;
    for (let attempt = 1; attempt <= MAX_REGISTRATION_ATTEMPTS; attempt++) {
      try {
        machine = await api.getOrCreateMachine({
          machineId,
          metadata: buildMachineMetadata(),
          daemonState: initialDaemonState,
        });
        logger.debug(`[DAEMON RUN] Machine registered: ${machine.id}`);
        break;
      } catch (error) {
        const isLastAttempt = attempt === MAX_REGISTRATION_ATTEMPTS;
        const isNetworkError =
          error instanceof Error &&
          (error.message.includes("ECONNREFUSED") ||
            error.message.includes("timeout") ||
            error.message.includes("ECONNRESET") ||
            error.message.includes("ETIMEDOUT") ||
            error.message.includes("socket hang up"));

        if (isLastAttempt || !isNetworkError) {
          logger.error(
            `[DAEMON RUN] Machine registration failed after ${attempt} attempt(s)`,
            error
          );
          throw error;
        }

        const delayMs = Math.min(2000 * Math.pow(2, attempt - 1), 30_000);
        logger.warn(
          `[DAEMON RUN] Server unreachable (attempt ${attempt}/${MAX_REGISTRATION_ATTEMPTS}), ` +
            `retrying in ${delayMs / 1000}s: ${(error as Error).message}`
        );
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    // Create realtime machine session
    const apiMachine = api.machineSyncClient(machine);

    // Set RPC handlers
    apiMachine.setRPCHandlers({
      spawnSession,
      stopSession,
      requestShutdown: () => requestShutdown("hapi-app"),
      // Issue #1661: authoritative session-liveness probe for the server's
      // reconnect re-attach gate + the 5-min force-kill watchdog. Resolves the
      // tag to a tracked session, then checks pane liveness. Returns:
      //   true  — tracked AND pane not dead (re-attach; do NOT respawn)
      //   false — untracked OR dead (caller may respawn the bash-occupied pane)
      //   null  — tracked but no tmux window to probe, OR any fault (uncertain;
      //           caller falls through to respawn — Fallback Preservation Rule)
      isSessionAlive: async (sessionTag: string): Promise<boolean | null> => {
        try {
          let tracked: TrackedSession | undefined;
          for (const session of pidToTrackedSession.values()) {
            if (
              session.happySessionId === sessionTag ||
              session.persistedHapiSessionId === sessionTag ||
              session.tmuxSessionId === sessionTag
            ) {
              tracked = session;
              break;
            }
          }
          if (!tracked) return false;
          if (!tracked.tmuxWindow) return null;
          // #3734: probe by the tracked session's @N when known, so a
          // same-title collision reports on THIS window, not a sibling's.
          return await isTmuxWindowWrapperAlive(
            tracked.tmuxWindowId ?? tracked.tmuxWindow
          );
        } catch (error) {
          logger.warn(
            `[DAEMON RUN] isSessionAlive(${sessionTag}) failed: ${error instanceof Error ? error.message : String(error)}`
          );
          return null;
        }
      },
      // Issue #2299 (Task 3): read-only capacity probe for switchAccount's
      // pre-kill pre-check. Answers "would a reused-window respawn of
      // creditHapiSessionId be admitted right now?" WITHOUT spawning or killing —
      // it reuses the SAME credited computeEffectiveCount the spawn gate uses, so
      // the probe and the gate can never disagree (#1477 single-closure principle).
      // Because a currently-counted own slot is always self-creditable (KD-3),
      // wouldAdmit is true for the common switch-at-capacity case; it is false only
      // in a genuinely un-creditable state (the session no longer occupies a
      // countable slot). Never mutates session state.
      capacityProbe: async (
        creditHapiSessionId?: string
      ): Promise<{
        effectiveCount: number;
        maxConcurrent: number;
        wouldAdmit: boolean;
      }> => {
        const { effectiveCount, max } =
          await computeEffectiveCount(creditHapiSessionId);
        return {
          effectiveCount,
          maxConcurrent: max,
          wouldAdmit: effectiveCount < max,
        };
      },
    });

    // Connect to server
    apiMachine.connect();

    // Issue #1449: auto-capture new Anthropic accounts on a manual claude /login.
    // await accountStore.list() triggers + completes Sub-Issue A's lazy initial-
    // population migration BEFORE the watcher starts, so the watcher never fires
    // during migration (R6 suppression by construction). The watcher then live-
    // captures subsequent credential changes and relays a redacted notice to the
    // /cli/account-captured SSE route.
    let credentialsWatcher: CredentialsWatcher | undefined;
    try {
      await accountStore.list();
      credentialsWatcher = new CredentialsWatcher({
        accountStore,
        notify: notice => api.reportAccountCaptured(notice),
        profileFetch: fetchOauthProfile,
        jobRegistry: daemonJobRegistry,
        jobNode: daemonJobNode,
      });
      credentialsWatcher.start();
      logger.debug(
        "[DAEMON RUN] Credentials watcher started (account auto-capture)"
      );
    } catch (error) {
      logger.debug(
        "[DAEMON RUN] Failed to start credentials watcher (continuing)",
        error
      );
      logger.reportCaught(error, {
        category: "daemon-credentials-watcher-start",
        severity: "warn",
      });
    }
    // Issue #2268 (Sub-B of #2267): seed the account store from the service-env
    // CLAUDE_CODE_OAUTH_TOKEN so a user VM (the #1004 onboarding paste path,
    // which writes the token as a service-env credential) gets a first-class
    // account-store entry — the create-page picker lists it and spawned sessions
    // carry `metadata.claudeAccount`. `writeVmEnvFile` triggers
    // DAEMON_RELOAD_RESTART after every credential install, so this startup hook
    // fires exactly when a fresh token lands (no gateway change needed). It runs
    // AFTER `accountStore.list()` above (which completed the lazy initial-population
    // migration), and is FIRE-AND-FORGET: the profile fetch has a 10s timeout and
    // must never delay daemon/session readiness. The module is fail-soft (never
    // throws — Fallback Preservation Rule) and idempotent (skips when a record for
    // the uuid already exists). Gated on the token being present so operator
    // machines (host `~/.claude` auth) skip it entirely.
    //
    // Issue #3731 (R0/R0b, ruling D2 A′ + D3): the token is the node's INSTANCE
    // credential. The daemon HOLDS it on `ctx.instanceOAuthToken` and delivers it
    // EXPLICITLY to strictly-unbound claude spawns only — the tmux arm through its
    // 0600 spawn env file, the direct arm through the child's spawn env
    // (`resolveUnboundInstanceToken`, sessionSpawnerHelpers.ts). The AMBIENT copy is
    // deleted from `process.env` once the seed reports the primary on disk
    // (`shouldReleaseEnvSeedToken`), so no tmux server or child inherits it — an
    // inherited env token silently overrides every OTHER bound account's isolated
    // `CLAUDE_CONFIG_DIR` credentials (the wrong-account billing bug). A store-less /
    // seed-failed VM keeps the ambient copy and warns; unbound sessions still work
    // either way because their credential arrives explicitly. The disposition
    // (absent / pending / released / retained) is recorded in daemon.state.json for
    // `hapi doctor` — see envSeedTokenDisposition.ts.
    // Issue #2554: decode the gateway-delivered per-account identity payload
    // BEFORE the seeds, and remove it from process.env at its SOURCE (same
    // hygiene as the HAPI_ONBOARDING_OAUTH_TOKENS delete below — identity is not a
    // token, but it is onboarding-transient and has no reason to reach a spawned
    // agent's env; AGENT_FORBIDDEN_ENV_VARS strips it defensively too). The decode
    // is fail-soft: a corrupt payload yields [] and every account degrades to the
    // profile-fetch fallback. The array is index-aligned with the gateway's
    // ordered account list — `deliveredIdentities[0]` describes the
    // CLAUDE_CODE_OAUTH_TOKEN account, `deliveredIdentities.slice(1)` the
    // HAPI_ONBOARDING_OAUTH_TOKENS accounts in order.
    const onboardingIdentityRaw = process.env.HAPI_ONBOARDING_ACCOUNT_IDENTITY;
    delete process.env.HAPI_ONBOARDING_ACCOUNT_IDENTITY;
    const deliveredIdentities = onboardingIdentityRaw
      ? decodeDeliveredIdentities(onboardingIdentityRaw)
      : [];

    // #3731 (R0b): the instance credential was held, and the initial state (pending
    // / absent) put in the boot write, by buildDaemonBootRecord (#4153 A3). This
    // compare-and-write re-records it and is the boot's first ownership check
    // (run.test RT4a); the seed callbacks below record the final state.
    const { envSeedToken } = boot;
    recordAmbientTokenState({
      fileState,
      state: boot.initialTokenState,
      // #4155 (R11): every post-boot state write is compare-and-write.
      write: state => ownStateWriter.persist(state),
      logger,
    });
    // Issue #2314 (Sub-D of #2310, multi-account onboarding): the ADDITIONAL
    // Anthropic accounts the wizard's "add another account" loop connected. The
    // gateway delivers accounts 2..N as a base64-JSON string-array in the
    // HAPI_ONBOARDING_OAUTH_TOKENS service-env var (account 1 stays the
    // CLAUDE_CODE_OAUTH_TOKEN env fallback above — never replaced, only
    // augmented). Account 1 (primary) and accounts 2..N (extras) are both seeded,
    // and one is marked active-if-unset, by seedAccountsAtBoot below.
    const extraOnboardingTokens = process.env.HAPI_ONBOARDING_OAUTH_TOKENS;
    // #2383 (W3 of epic #2385): remove the var at its SOURCE, synchronously, the
    // instant it has been read into the local above. This is the primary fix — it
    // is launcher-agnostic (no spawn path can leak what no longer exists) and
    // race-free (the value is already captured, so the fire-and-forget seed below
    // keeps working from the local while every later reader of process.env sees
    // nothing). The daemon creates the tmux server, so deleting here at daemon
    // startup means no pane spawned in it ever inherits the tokens.
    //
    // The launcher-side strips (AGENT_FORBIDDEN_ENV_VARS in buildLauncherEnv and
    // sdk/query.ts) remain necessary as defence in depth: KillMode=process
    // deliberately preserves the tmux server across daemon restarts, so a server
    // created by an OLDER daemon still carries the contaminated env — the same
    // cross-session contamination class as #1651.
    delete process.env.HAPI_ONBOARDING_OAUTH_TOKENS;
    // Issue #2555: seed the primary CLAUDE_CODE_OAUTH_TOKEN account AND the
    // additional HAPI_ONBOARDING_OAUTH_TOKENS accounts, then mark an account
    // active-if-unset with a DETERMINISTIC primary↔extras ordering. On a
    // SINGLE-account VM the primary fills the otherwise-unset active pointer so
    // that first session binds and shows identity (the #2314-asymmetry fix); on a
    // MULTI-account VM the extras' most-recently-connected default wins and the
    // primary is a no-op. `deliveredIdentities` (decoded above) is threaded whole:
    // seedAccountsAtBoot takes index 0 for the primary and slice(1) for the extras.
    // Gated on at least one token being present, so operator machines (host
    // ~/.claude auth, no CLAUDE_CODE_OAUTH_TOKEN) skip it entirely (R4). It stays
    // fire-and-forget + fail-soft: the profile fetch and the set-active writes
    // never delay daemon/session readiness and never throw.
    if (envSeedToken || extraOnboardingTokens) {
      // #4153 (B2): ONE dispose + record per seed outcome. The two handlers are
      // .then's two arguments, so a throw in the success handler (after a
      // release) never reaches the failure handler to record a false "retained".
      const settle = (summary: SeedBootResult | null): void =>
        settleEnvSeedToken({
          envSeedToken,
          summary,
          fileState,
          env: process.env,
          // #4155 (R11): the async seed can resolve after a successor took over.
          write: state => ownStateWriter.persist(state),
          logger,
        });
      void seedAccountsAtBoot({
        primaryToken: envSeedToken,
        extrasRaw: extraOnboardingTokens,
        deliveredIdentities,
      })
        .then(
          summary => {
            // #3731 (R0, ruling D2 A′): sever the AMBIENT onboarding token at source
            // once the store can serve the primary, and record the outcome for
            // `hapi doctor`. The held copy (ctx.instanceOAuthToken) still reaches
            // unbound claude spawns explicitly. Never logs the token value.
            settle(summary);
            if (summary.primaryResult?.seeded) {
              logger.info("[DAEMON RUN] Seeded account store from env token");
            } else if (summary.primaryResult) {
              // #2670: split by reason so a real skip is journal-visible, not buried
              // at `debug` (the "no seed-log entry in the daemon journal" field
              // symptom). `already-present` is the benign per-boot idempotent skip —
              // the env token persists in ~/.config/hapimatic/env so the seed re-runs
              // on every restart — and routes to `info`; every failure-class reason
              // routes to `warn`. accountUuid is included when known; the token value
              // is never logged.
              const { reason, accountUuid } = summary.primaryResult;
              const skipMsg =
                `[DAEMON RUN] Env-token account seed skipped: ${reason}` +
                (accountUuid ? ` (account ${accountUuid})` : "");
              if (seedSkipLogLevel(reason) === "info") {
                logger.info(skipMsg);
              } else {
                logger.warn(skipMsg);
              }
            }
            if (summary.extrasSummary) {
              logger.info(
                `[DAEMON RUN] Seeded ${summary.extrasSummary.seededCount} additional onboarding account(s) ` +
                  `(${summary.extrasSummary.skippedCount} skipped; active default ${summary.extrasSummary.activeAccountUuid ? "set" : "unchanged"})`
              );
            }
            if (summary.primaryMarkedActive) {
              logger.info(
                "[DAEMON RUN] Marked env-token account as active default (was unset)"
              );
            }
          },
          error => {
            logger.warn(
              `[DAEMON RUN] Unexpected error seeding account store at boot: ${error}`
            );
            logger.reportCaught(error, {
              category: "daemon-seed-accounts-boot-error",
              severity: "error",
            });
            // #3731: an errored seed keeps the ambient token — say so, and record it.
            settle(null);
          }
        )
        // seedAccountsAtBoot never rejects, but a handler above can throw: log only
        // (never dispose again), so nothing surfaces as an unhandledRejection.
        .catch(error => {
          logger.warn(
            `[DAEMON RUN] Unexpected error after the boot account seed settled: ${error}`
          );
        });
    }
    // Issue #1507: after a proactive/reactive token refresh succeeds, restart any
    // active sessions bound to that account so the running `claude` process picks
    // up the fresh token (its CLAUDE_CODE_OAUTH_TOKEN env is frozen at spawn).
    // R4 (no restart storms): per-account in-flight guard prevents concurrent
    // restart passes for the same account. Returns a RestartSummary (issue #1547)
    // so the force-refresh harness can assert step 3/4; the fire-and-forget
    // caller (`void restartBoundSessions(...)` below) ignores it.
    // Issue #4679: extracted to `boundSessionRestart.ts`. A session the server
    // defers (busy) is retried until it restarts, ends, or errors — never
    // abandoned after 90s — and is forced after `tokenRestartForceAfterMs`.
    const boundSessionRestarter = createBoundSessionRestarter({
      serverUrl: configuration.serverUrl,
      cliApiToken: configuration.cliApiToken,
      forceAfterMs: configuration.tokenRestartForceAfterMs,
      logger,
    });
    const restartBoundSessions = (
      accountUuid: string
    ): Promise<RestartSummary> =>
      boundSessionRestarter.restartBoundSessions(accountUuid);

    // Start the OAuth token-refresh service (issue #1448) — keeps every stored
    // account's access token fresh ahead of expiry, since Hapimatic's env-var
    // injection bypasses Claude Code's built-in auto-refresh. The
    // onSuccessfulRefresh callback (issue #1507) restarts bound sessions so they
    // pick up the fresh token. Fire-and-forget — never blocks the scheduler.
    // Issue #1806: the idle-refresh backstop's live-session-anywhere guard. It
    // collects the accounts that currently have an ACTIVE session bound, from
    // two sources whose reliable keys differ:
    //   - LOCAL: the local server's `/cli/sessions` list (this node's sessions),
    //     keyed by `metadata.accountUuid`.
    //   - FEDERATION: `/api/federation/all-sessions` (every node's sessions via
    //     the hub's NodeRegistry cache), keyed by `metadata.claudeAccount.email`
    //     (remote SessionSummaries don't reliably carry `accountUuid` yet).
    // Mint a JWT (cliApiToken → /api/auth) for the federation query — the
    // federation route is JWT-authed, not cliApiToken-authed. Fail-safe: any
    // failure degrades to whatever was collected (never throws); a federation
    // failure is logged so a blind cross-machine rotation can't happen silently.
    // Issue #1852: resolve the freshness window ONCE at closure construction
    // (env override HAPI_LIVE_FRESHNESS_WINDOW_MS, the fine-grained rollback
    // lever) — do NOT read process.env per pass.
    const liveFreshnessWindowMs = resolveLiveFreshnessWindowMs();
    const getLiveAccountKeys = async (): Promise<LiveAccountKeys> => {
      // One clock per pass so the local and federation branches judge freshness
      // against a single `now` (avoids intra-pass skew).
      const now = Date.now();
      const uuids = new Set<string>();
      const emails = new Set<string>();
      // Issue #3541: the subset of `uuids`/`emails` whose bound session is
      // mid-inference (`thinking === true`). `inferring ⊆ live` by construction
      // (only populated inside the `isSessionLiveForGuard` gate below). The
      // rotate-anyway backstop defers a LOCALLY-bound (`uuids`) inferring session
      // rather than restarting it mid-turn. Populated for BOTH key spaces for
      // symmetry with `live`; only `inferring.uuids` is consumed today.
      const inferringUuids = new Set<string>();
      const inferringEmails = new Set<string>();
      // #4679: why each local busy account is busy, for the backstop's log line.
      const inferringReasons = new Map<string, string>();
      // Issue #1834: track whether the FEDERATION query failed this pass. The
      // per-block try/catch structure stays intact — this flag is set only in
      // the federation `catch` below, so the success path leaves it false. The
      // consumer (`refreshIdleIsolatedAccounts`) fails safe when it is true.
      let federationDegraded = false;
      // Issue #3640: the local-axis mirror of `federationDegraded`. Set true in
      // BOTH local failure branches below — a non-OK response (incl. the
      // missing-`cliApiToken` 401) AND a throw — so the success path leaves it
      // false. When true, `uuids` is incomplete and LOCAL liveness is UNKNOWN
      // (not proven empty), so the consumer must fail SAFE (skip rotation)
      // rather than rotate an account whose only live session is local (the
      // #1645 P-REVOKE kill-vector, local-axis variant of #1834).
      let localDegraded = false;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (configuration.cliApiToken) {
        headers["Authorization"] = `Bearer ${configuration.cliApiToken}`;
      }
      // Local sessions (by accountUuid).
      try {
        const resp = await fetch(`${configuration.serverUrl}/cli/sessions`, {
          headers,
        });
        if (resp.ok) {
          // `/cli/sessions` returns full `Session` objects; this narrows to the
          // liveness (#1852 `activeAt`), busy (#3541 `thinking`, #4679
          // `backgroundAgents`) and binding fields the guards read.
          const { sessions } = (await resp.json()) as {
            sessions: LocalBindingInput[];
          };
          // #1852: gate on a fresh `activeAt` heartbeat, not the raw `active`
          // flag. Local sessions carry no `nodeStatus` (so the predicate's
          // offline handling is a no-op); the 120s window is >= this node's
          // local reaper tolerance (TMUX_PTY_INACTIVE_TOLERANCE_MS, 30s), so a
          // just-ended live tmux/pty session is never falsely NOT-live here.
          // #3541 + #4679: a live LOCAL session that is BUSY (thinking, or
          // background agents / shells still running) joins the `inferring`
          // set so the backstop defers it rather than rotating the token its
          // in-flight work is using.
          const local = collectLocalBindings(
            sessions,
            now,
            liveFreshnessWindowMs
          );
          for (const uuid of local.uuids) uuids.add(uuid);
          for (const uuid of local.busyUuids) inferringUuids.add(uuid);
          for (const [uuid, reason] of local.busyReasons) {
            inferringReasons.set(uuid, reason);
          }
        } else {
          // Issue #3640: local visibility degraded (non-OK response — incl. the
          // missing-`cliApiToken` 401). Signal the consumer to fail safe rather
          // than treat this pass's empty `uuids` as "no local session".
          localDegraded = true;
          logger.warn(
            `[IDLE_REFRESH] local session query failed: HTTP ${resp.status}`
          );
        }
      } catch (err) {
        // Issue #3640: the local query threw — local visibility is degraded, so
        // signal the consumer to fail safe (same as the non-OK branch above).
        localDegraded = true;
        logger.warn(
          `[IDLE_REFRESH] local session query error: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      // Federation sessions (by claudeAccount.email) — mint a JWT first.
      try {
        const authResp = await fetch(`${configuration.serverUrl}/api/auth`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accessToken: configuration.cliApiToken }),
        });
        if (!authResp.ok) {
          throw new Error(`auth HTTP ${authResp.status}`);
        }
        const { token } = (await authResp.json()) as { token?: string };
        if (!token) throw new Error("no JWT in /api/auth response");
        const fedResp = await fetch(
          `${configuration.serverUrl}/api/federation/all-sessions`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!fedResp.ok) {
          throw new Error(`all-sessions HTTP ${fedResp.status}`);
        }
        const { sessions } = (await fedResp.json()) as {
          sessions?: Array<{
            active?: boolean;
            // #1852: freshness signal + hub reachability — the previous cast
            // stripped both, so the gate would have seen `undefined`.
            activeAt?: number;
            nodeStatus?: string; // R24: diagnostic only — never the sole not-live trigger.
            // #3541: inference signal (the federation `SessionSummary` carries
            // `thinking`, mapped from `session.thinking`). Populates
            // `inferring.emails` for symmetry; the rotate-anyway path is
            // local-only, so this key-space is not consumed by the gate today.
            thinking?: boolean;
            // #4679: background-work counts (the summary's counts-only
            // projection carries `running` and `shells.running`).
            backgroundAgents?: SessionBusySignal["backgroundAgents"];
            metadata?: { claudeAccount?: { email?: string } };
          }>;
        };
        for (const s of sessions ?? []) {
          const email = s.metadata?.claudeAccount?.email;
          // #1852: an OFFLINE node's frozen `active:true` cache must NOT count as
          // a live binding — gate on a fresh `activeAt`, not the raw `active`
          // flag (the deadlock this fix removes). The `catch` below (a FAILED
          // federation query ⇒ unknown) stays #1834's conservative domain and is
          // left untouched.
          if (email && isSessionLiveForGuard(s, now, liveFreshnessWindowMs)) {
            emails.add(email);
            // #3541: a live REMOTE busy session (symmetry with the local leg;
            // #4679: the same shared busy predicate). Unused by the local-only
            // rotate-anyway gate today.
            if (isSessionBusyForRotation(s)) {
              inferringEmails.add(email);
            }
          }
        }
      } catch (err) {
        // Cross-machine visibility lost for this pass — degrade to local-only.
        // Do NOT silently rotate blind across machines; log the degradation.
        // Issue #1834: signal the degrade to the consumer so it fails SAFE
        // (skips rotation of remote-only accounts) instead of rotating blind
        // against a local-only-blind `emails` set.
        federationDegraded = true;
        logger.warn(
          `[IDLE_REFRESH] federation session query failed — cross-machine guard degraded to local-only this pass: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      // #3541: `inferringUuids` is populated by the LOCAL leg above, which runs
      // BEFORE the federation try/catch — so even on a federation-degraded pass
      // the local inference signal is intact and a mid-turn LOCAL session can
      // never read as "not inferring" (the rotate-anyway gate stays honest).
      // #3640: `localDegraded` is set true in the local-leg failure branches.
      return {
        uuids,
        emails,
        federationDegraded,
        localDegraded,
        inferring: {
          uuids: inferringUuids,
          emails: inferringEmails,
          reasons: inferringReasons,
        },
      };
    };

    // Issue #4679 (R4): the cheap pre-rotation re-read — local `/cli/sessions`
    // only (no federation JWT), same collector as the local leg above. `null`
    // on any failure so the backstop defers (fail safe).
    const getLocalBusyAccounts = async (): Promise<Set<string> | null> => {
      try {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (configuration.cliApiToken) {
          headers["Authorization"] = `Bearer ${configuration.cliApiToken}`;
        }
        const resp = await fetch(`${configuration.serverUrl}/cli/sessions`, {
          headers,
        });
        if (!resp.ok) return null;
        const { sessions } = (await resp.json()) as {
          sessions: LocalBindingInput[];
        };
        return collectLocalBindings(sessions, Date.now(), liveFreshnessWindowMs)
          .busyUuids;
      } catch {
        return null;
      }
    };

    // Issue #3784: cross-node chain-independence probe (fetcher in
    // remoteChainIndependence.ts; fails SAFE so the default-OFF gate can only
    // ever ADD a proven-safe rotation, never a blind one).
    const getRemoteChainFingerprints = makeRemoteChainFingerprintsFetcher({
      serverUrl: configuration.serverUrl,
      cliApiToken: configuration.cliApiToken,
      warn: msg => logger.warn(msg),
    });

    const tokenRefreshService = new TokenRefreshService({
      accountStore,
      onSuccessfulRefresh: refreshedAccountUuid => {
        void restartBoundSessions(refreshedAccountUuid);
      },
      // #4423 (R5): skip accounts bound by a SIBLING instance's live session.
      getSiblingBoundAccounts: async () =>
        scanSiblingBoundAccounts({
          ownHapiHome: configuration.happyHomeDir,
          accountConfigsDir: configuration.accountConfigsDir,
        }),
      // Issue #1644: gate proactive rotation on the cross-machine family lease,
      // acquired through the shared manager. Default-off feature gate ⇒ no-op true.
      acquireRotationLease: uuid => rotationLeaseManager.acquire(uuid),
      // Issue #5021: release the lease when each rotation finishes, and skip it
      // for a chain #3784 proved independent, so every node's backstop can
      // rotate its own copy. HAPI_ROTATION_LEASE_RELEASE_AFTER_ROTATION=off
      // restores the #1644 standing lease (no release, no bypass).
      releaseRotationLease: configuration.rotationLeaseReleaseAfterRotation
        ? uuid => rotationLeaseManager.release(uuid)
        : undefined,
      bypassLeaseWhenIndependent:
        configuration.rotationLeaseReleaseAfterRotation,
      // Issue #1806: the live-session-anywhere guard for the idle-refresh backstop.
      getLiveAccountKeys,
      // Issue #3544: probe an isolated account's machine-global token before the
      // backstop refuses a stale `unrefreshable` flag. Injected (not imported
      // into tokenRefreshService.ts) to avoid the isolatedSnapshotRecovery →
      // TokenRefreshService value-import cycle.
      probeToken: accessToken => probeAccessToken(accessToken),
      // Issue #3541: rotate-anyway sub-path gate (default ON via
      // configuration.idleRotateAnywayEnabled; HAPI_IDLE_ROTATE_ANYWAY=off is the
      // instant kill-switch). Lets the backstop rotate a near-expiry isolated
      // account with a LOCALLY-bound, non-inferring session (then restart it)
      // instead of decaying it to expiry behind the P-REVOKE guard.
      rotateBoundAtExpiry: configuration.idleRotateAnywayEnabled,
      // Issue #4679: rotate a locally-bound account at an idle moment inside
      // this lead (HAPI_BOUND_ROTATION_LEAD_MS; 0 ⇒ pre-#4679 buffer timing),
      // re-reading local busy state right before the rotation (R4).
      boundRotationLeadMs: configuration.boundRotationLeadMs,
      getLocalBusyAccounts,
      // Issue #3784: mixed (local+remote) rotate-when-independent gate (default
      // OFF; HAPI_IDLE_ROTATE_REMOTE_INDEPENDENT=1 enables post-validation). The
      // verdict composes this node's own fingerprint with the remote probe above.
      rotateWhenRemoteIndependent:
        configuration.idleRotateWhenRemoteIndependentEnabled,
      assessRemoteChainIndependence: uuid =>
        assessRemoteChainIndependence(
          uuid,
          defaultLocalChainFingerprint,
          getRemoteChainFingerprints
        ),
      // Issue #3023: per-tick utilization sampler for the un-pinned spawn veto. Reads
      // each account's access token from the store, fetches its utilization (read-only,
      // mirroring usageService), computes the shared pacing score, and caches it on the
      // account store; the veto in sessionSpawner reads that cache at spawn time. The
      // factory swallows its own errors so a sampler fault never breaks the refresh tick.
      sampleUtilization: createUtilizationSampler({
        readAccessToken: async uuid => {
          const res = await accountStore.get(uuid).catch(() => null);
          return res && res.ok ? res.account.accessToken : null;
        },
        writeSnapshot: (uuid, snapshot) =>
          accountStore.setUtilizationSnapshot(uuid, snapshot),
        readSnapshot: uuid => accountStore.getUtilizationSnapshot(uuid),
      }),
      // #1964 (Sub-D): register the token-refresh loop into the daemon job
      // registry (Approach 2 — the central watchdog below supplies its missing
      // stall detection since it keeps its own adaptive scheduler).
      jobRegistry: daemonJobRegistry,
      jobNode: daemonJobNode,
    });
    tokenRefreshService.start();

    // #1964 (Sub-D): central stall-watchdog for Approach-2 loops. token-refresh
    // keeps its own adaptive scheduler (it is NOT a SupervisedLoop), so this
    // watchdog supplies the missing silent-stop detection: if a watched loop is
    // "ok" but has not ticked within stallFactor x intervalMs, flip it to
    // "stalled" so the server's portal pull sees it red and alerts. The name
    // MUST match TokenRefreshService's TOKEN_REFRESH_JOB_NAME ("token-refresh").
    // SupervisedLoop-managed loops (maintenance, credentials) self-detect and
    // are not listed here.
    const centralWatchdogNames = new Set(["token-refresh"]);
    const centralWatchdogStallFactor = 3;
    const daemonJobWatchdog = new SupervisedLoop({
      name: "daemon-job-watchdog",
      node: daemonJobNode,
      intervalMs: 30_000,
      registry: daemonJobRegistry,
      // Issue #2079: optional test clock seams — undefined in production, so
      // SupervisedLoop falls back to the globals (its own `?? Date.now`).
      now: testSeams.now,
      setTimeoutFn: testSeams.setTimeoutFn,
      clearTimeoutFn: testSeams.clearTimeoutFn,
      tick: () => {
        const nowMs = Date.now();
        for (const job of daemonJobRegistry.list()) {
          if (!centralWatchdogNames.has(job.name)) continue;
          if (job.status !== "ok" || job.lastTickAt === null) continue;
          const thresholdMs = centralWatchdogStallFactor * job.intervalMs;
          const sinceMs = nowMs - job.lastTickAt;
          if (sinceMs > thresholdMs) {
            daemonJobRegistry.update(job.name, {
              status: "stalled",
              lastError: `no tick completed in ${sinceMs}ms (> ${thresholdMs}ms)`,
            });
          }
        }
      },
    });
    daemonJobWatchdog.start();
    // Issue #1806: surface the idle-refresh backstop gate so an operator can
    // confirm it from journalctl without inspecting the env.
    logger.info(
      `[IDLE_REFRESH] backstop ${configuration.idleRefreshEnabled ? "enabled" : "disabled"}`
    );
    // Issue #4423: the machine-rotator role, evaluated once (soak S1 reads it).
    const role = resolveMachineRotatorRole({
      selfIsWorktreeDaemonUnit: runningInsideWorktreeInstanceDaemon(),
      serverUrl: configuration.serverUrl,
      idleRefreshEnabled: configuration.idleRefreshEnabled,
    });
    ctx.machineRotator = role.rotator;
    logger.info(machineRotatorRoleLine(role, configuration.idleRefreshEnabled));

    // Issue #1734 (OmniBox Phase 0b): start ONE daemon-owned egress broker when
    // the sandbox kill-switch is ON. Loopback + ephemeral port; the resolved
    // port is published (setActiveEgressBrokerPort) so the spawn path injects it
    // as HTTPS_PROXY (tmuxSpawnAdapter.buildSandboxEnv). Fallback Preservation
    // (OR-3): a broker that fails to start must NOT block every session — log
    // loudly and leave the port unset so spawns proceed proxy-less (fail-open; a
    // broker that blocks all egress is the worse, RED-rated regression).
    let egressBrokerHandle: EgressBrokerHandle | null = null;
    if (configuration.omniboxSandboxEnabled) {
      try {
        egressBrokerHandle = await startEgressBroker({
          // Issue #3813: merge the jail-eligible harnesses' inference/auth hosts
          // (codex's OpenAI hosts at the pin) into the NODE-WIDE allowlist. Advisory
          // control — the jail has no --unshare-net, so only proxy-honouring clients
          // are bound; a non-cooperating in-jail process still reaches any host.
          allowlist: resolveEgressAllowlist(
            process.env.HAPI_EGRESS_ALLOW,
            undefined,
            harnessEgressHosts()
          ),
        });
        setActiveEgressBrokerPort(egressBrokerHandle.port);
        logger.info(
          `[OMNIBOX] egress broker on 127.0.0.1:${egressBrokerHandle.port} (sandbox ON)`
        );
      } catch (err) {
        setActiveEgressBrokerPort(null);
        logger.warn(
          `[OMNIBOX] egress broker FAILED to start — spawning proxy-less ` +
            `(fail-open, OR-3): ${err instanceof Error ? err.message : String(err)}`
        );
      }
    } else {
      logger.info("[OMNIBOX] sandbox OFF — no egress broker");
    }

    // Wire the force-refresh harness handler now that the service + restart
    // closure exist (issue #1547). The control server's `forceRefreshAccount`
    // wrapper (declared above startDaemonControlServer) dispatches here. Reuses
    // the LIVE tokenRefreshService instance so the harness shares its in-flight
    // dedup, and the daemon's restartBoundSessions closure so it can observe
    // steps 3/4.
    forceRefreshHandler = (accountUuid: string): Promise<ForceRefreshReport> =>
      runForceRefreshHarness(accountUuid, {
        accountStore,
        forceRefresh: uuid => tokenRefreshService.forceRefresh(uuid),
        restartBoundSessions,
      });

    // #2081: assign the late-created members the health scheduler reads onto
    // ctx, then build + start the daemon-maintenance loop via the extracted
    // scheduler. It returns the loop so onReady + cleanupAndShutdown can use it.
    ctx.api = api;
    ctx.tokenRefreshService = tokenRefreshService;
    ctx.controlToken = controlToken;
    ctx.daemonJobNode = daemonJobNode;
    ctx.daemonJobRegistry = daemonJobRegistry;
    ctx.controlPort = controlPort;
    ctx.startedWithCliMtimeMs = startedWithCliMtimeMs;
    ctx.fileState = fileState;
    ctx.requestShutdown = (source, errorMessage) =>
      requestShutdown(source, errorMessage);
    // Issue #4155: assigned BEFORE createHealthScheduler, which destructures ctx.
    ctx.isShutdownRequested = () => shutdownRequested;
    ctx.ownStateWriter = ownStateWriter;
    const { maintenanceLoop } = createHealthScheduler(ctx, testSeams);
    // #3451: build + start the daily 05:00 worktree-trash collector (ships dark;
    // inert unless HAPI_WORKTREE_COLLECTOR=1 on this daemon's unit). ctx.daemonJobNode
    // + ctx.daemonJobRegistry are already assigned above, so the ordering is safe.
    const { collectorLoop } = createWorktreeCollector(ctx, testSeams);
    // Setup signal handlers
    const cleanupAndShutdown = async (
      source: "hapi-app" | "hapi-cli" | "os-signal" | "exception",
      errorMessage?: string
    ) => {
      logger.debug(
        `[DAEMON RUN] Starting proper cleanup (source: ${source}, errorMessage: ${errorMessage})...`
      );

      // Stop the maintenance loop (#1964 Sub-D: now a SupervisedLoop).
      maintenanceLoop.stop();
      logger.debug("[DAEMON RUN] Maintenance loop stopped");

      // #3451: stop the daily worktree-trash collector loop.
      collectorLoop.stop();
      logger.debug("[DAEMON RUN] Worktree collector loop stopped");

      // Issue #1449: stop the credentials watcher — tears down the fs watch +
      // any pending debounce timer (R9) so the daemon shuts down cleanly.
      if (credentialsWatcher) {
        credentialsWatcher.stop();
        logger.debug("[DAEMON RUN] Credentials watcher stopped");
      }
      // Stop the OAuth token-refresh service (issue #1448) — clears its timer
      // and awaits any in-flight refresh within a bounded timeout so daemon
      // shutdown can't hang.
      await tokenRefreshService.stop();
      // Issue #4679: cancel scheduled post-rotation restart retries.
      boundSessionRestarter.stop();

      // Issue #1644: best-effort release of every held rotation lease so peers
      // can take over promptly (the hub TTL covers a hard crash that skips this).
      try {
        await rotationLeaseManager.releaseAll();
      } catch (err) {
        logger.warn(
          `[DAEMON RUN] rotation-lease release failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      // Update daemon state before shutting down
      await apiMachine.updateDaemonState((state: DaemonState | null) => ({
        ...state,
        status: "shutting-down",
        shutdownRequestedAt: Date.now(),
        shutdownSource: source,
      }));

      // Give time for metadata update to send
      await new Promise(resolve => setTimeout(resolve, 100));

      apiMachine.shutdown();
      await stopControlServer();
      // Issue #1734: stop the egress broker (if running) on shutdown.
      if (egressBrokerHandle) {
        await egressBrokerHandle.close();
        setActiveEgressBrokerPort(null);
        logger.debug("[OMNIBOX] egress broker closed");
      }
      await cleanupDaemonState();
      await releaseDaemonLock(daemonLockHandle);

      // Exit with non-zero code on exception/crash so systemd's Restart=on-failure
      // can detect it and restart the daemon. Intentional shutdowns (SIGTERM, CLI
      // request, hapi-app) exit cleanly with 0 to prevent unnecessary restarts.
      const exitCode = source === "exception" ? 1 : 0;
      logger.debug(
        `[DAEMON RUN] Cleanup completed, exiting process with code ${exitCode} (source: ${source})`
      );
      clearTimeout(shutdownFallbackTimer);
      process.exit(exitCode);
    };

    // Issue #2079: characterization-test seam. Invoke the optional onReady hook
    // once, after full setup and before the daemon blocks on the shutdown
    // promise, so a test can drive the lifecycle with faked I/O and then trigger
    // shutdown. `undefined` in production ⇒ the guard is false ⇒ never called ⇒
    // zero behavior change. `requestShutdown` is forwarded through an arrow (not
    // referenced bare) because it is `let`-assigned inside the shutdown-promise
    // executor — matching the existing `() => requestShutdown("hapi-cli")` idiom.
    if (testSeams.onReady) {
      await testSeams.onReady({
        spawnSession,
        stopSession,
        requestShutdown: (source, errorMessage) =>
          requestShutdown(source, errorMessage),
        getCurrentChildren,
        computeEffectiveCount,
        onHappySessionWebhook,
        maintenanceLoop,
        daemonJobWatchdog,
        collectorLoop,
      });
    }

    logger.debug(
      "[DAEMON RUN] Daemon started successfully, waiting for shutdown request"
    );

    // Wait for shutdown request
    const shutdownRequest = await resolvesWhenShutdownRequested;
    await cleanupAndShutdown(
      shutdownRequest.source,
      shutdownRequest.errorMessage
    );
  } catch (error) {
    logger.error(
      "[DAEMON RUN][FATAL] Failed somewhere unexpectedly - exiting with code 1",
      error
    );
    // R6 in-path bug fix: surface fatal daemon errors to error_logs / Sentry
    // BEFORE process.exit(1). The fetch dispatch happens synchronously and is
    // in-flight by the time exit() runs, so the report has a chance to land.
    logger.reportCaught(error, {
      category: "daemon-fatal",
      severity: "fatal",
    });
    clearTimeout(shutdownFallbackTimer);
    process.exit(1);
  }
}
