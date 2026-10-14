// SPDX-License-Identifier: MIT AND AGPL-3.0-only
import { logger } from "@/ui/logger";
import { loop } from "@/claude/loop";
import { AgentState, SessionModelMode } from "@/api/types";
import { EnhancedMode, PermissionMode } from "./loop";
import { MessageQueue2 } from "@/utils/MessageQueue2";
import { hashObject } from "@/utils/deterministicJson";
import { extractSDKMetadataAsync } from "@/claude/sdk/metadataExtractor";
import { applyModelInPlace } from "@/claude/applyModelInPlace";
import { parseSpecialCommand } from "@/parsers/specialCommands";
import { getEnvironmentInfo } from "@/ui/doctor";
import { startHappyServer } from "@/claude/utils/startHappyServer";
import {
  startHookServer,
  isBlockingPromptNotification,
  type SessionHookData,
} from "@/claude/utils/startHookServer";
import { TurnReporter } from "@/claude/utils/turnReporter";
import { makeGitProbe } from "@/claude/utils/gitProbe";
import { resolveActiveLauncher } from "@/claude/launcherDispatch";
import {
  generateHookSettingsFile,
  cleanupHookSettingsFile,
} from "@/claude/utils/generateHookSettings";
import { resolveProfileExcludes } from "@/daemon/roleProfiles";
import type { SessionRole } from "@hapi/protocol";
import {
  HAPI_MCP_SERVER_NAME,
  scrubHapiFromDisabledMcps,
} from "@/claude/utils/scrubHapiOnSpawn";
import { registerKillSessionHandler } from "./registerKillSessionHandler";
import type { Session } from "./session";
import {
  readBoundApiKeyBinding,
  resolveEntitledModelForBoundAccount,
} from "@/claude/accountTokenInjection";
import { resolveSpawnModelState } from "@/claude/spawnModelState";
import { bootstrapSession } from "@/agent/sessionFactory";
import {
  SET_MODEL_META,
  SET_SESSION_CONFIG_META,
} from "@/api/rpc/capabilityMeta";
import {
  createModeChangeHandler,
  createRunnerLifecycle,
  setControlledByUser,
} from "@/agent/runnerLifecycle";
import {
  deriveModelModeFromRaw,
  isModelModeAllowedForFlavor,
  isPermissionModeAllowedForFlavor,
  resolveRawModelForMode,
} from "@hapi/protocol";
import type { ModelMode } from "@hapi/protocol/modes";
import type { EffortLevel } from "@hapi/protocol/effort";
import {
  EffortLevelSchema,
  ModelModeSchema,
  PermissionModeSchema,
} from "@hapi/protocol/schemas";

export interface StartOptions {
  model?: string;
  permissionMode?: PermissionMode;
  startingMode?: "local" | "remote";
  shouldStartDaemon?: boolean;
  claudeEnvVars?: Record<string, string>;
  claudeArgs?: string[];
  startedBy?: "daemon" | "terminal";
  /** Issue #1633: session launched with --safe-mode (scaffolding disabled).
   *  Stamped into session metadata so server-side respawns preserve it. */
  safeMode?: boolean;
  /** Issue #1633: explicit model mode from --hapi-model-mode ("sonnet" |
   *  "opus" | "fable") — seeds the model state at startup. */
  modelMode?: string;
  /** Issue #2456: reasoning-effort level from --hapi-effort ("low" | "medium" |
   *  "high" | "xhigh" | "max") — seeds the effort state at startup and is
   *  stamped into metadata so a respawn preserves it. */
  effort?: string;
  /** Issue #2456: a specific pinned raw Claude model id from --hapi-raw-model
   *  ("claude-opus-4-6") — takes precedence over modelMode in the currentModel
   *  resolution below (it is already a resolved id, no mode→model mapping). */
  rawModel?: string;
  /** Issue #2155: role-scoped `@`-include profile from --hapi-session-role
   *  ("pm" | "worker" | "researcher" | "closer" | "interactive"). Resolves to
   *  the profile's `claudeMdExcludes` (merged into the hook-settings file) and
   *  is stamped into session metadata so a respawn preserves the role. Always
   *  a validated SessionRole (commands/claude.ts parses via SessionRoleSchema
   *  and drops invalid values before setting this). */
  sessionRole?: SessionRole;
  /** Issue #2626: per-session output-style name from --hapi-output-style
   *  (built-in "default" | "Explanatory" | "Learning", or a custom style).
   *  Injected into the generated --settings file (generateHookSettingsFile —
   *  the single choke point every launcher delivers) and stamped into session
   *  metadata so a respawn preserves it. A --settings scalar `outputStyle` wins
   *  over ~/.claude/settings.local.json (Task 1 spike, Claude Code 2.1.x). */
  outputStyle?: string;
}

export async function runClaude(options: StartOptions = {}): Promise<void> {
  const workingDirectory = process.cwd();
  const startedBy = options.startedBy ?? "terminal";

  // Log environment info at startup
  logger.debugLargeJson("[START] HAPI process started", getEnvironmentInfo());
  logger.debug(
    `[START] Options: startedBy=${startedBy}, startingMode=${options.startingMode}`
  );

  // Validate daemon spawn requirements
  if (startedBy === "daemon" && options.startingMode === "local") {
    logger.debug(
      "Daemon spawn requested with local mode - forcing remote mode"
    );
    options.startingMode = "remote";
    // TODO: Eventually we should error here instead of silently switching
    // throw new Error('Daemon-spawned sessions cannot use local/interactive mode');
  }

  // #1347: Remove HAPI_MCP_SERVER_NAME from this project's disabledMcpServers
  // in ~/.claude.json so Claude Code's project-config disable filter does NOT
  // silently drop the --mcp-config injection built below. Non-fatal: spawn
  // proceeds even if the scrub fails (logged at WARN).
  await scrubHapiFromDisabledMcps(workingDirectory);

  const initialState: AgentState = {};
  const { api, session, sessionInfo } = await bootstrapSession({
    flavor: "claude",
    startedBy,
    workingDirectory,
    agentState: initialState,
    safeMode: options.safeMode === true,
    sessionRole: options.sessionRole,
  });
  logger.debug(`Session created: ${sessionInfo.id}`);

  // Extract SDK metadata in background and update session when ready
  extractSDKMetadataAsync(async sdkMetadata => {
    logger.debug(
      "[start] SDK metadata extracted, updating session:",
      sdkMetadata
    );
    try {
      // Update session metadata with tools and slash commands
      session.updateMetadata(currentMetadata => ({
        ...currentMetadata,
        tools: sdkMetadata.tools,
        slashCommands: sdkMetadata.slashCommands,
      }));
      logger.debug("[start] Session metadata updated with SDK capabilities");
    } catch (error) {
      logger.debug("[start] Failed to update session metadata:", error);
      logger.reportCaught(error, {
        category: "claude-metadata-update",
        severity: "warn",
      });
    }
  });

  // Start HAPI MCP server
  const happyServer = await startHappyServer(session);
  logger.debug(`[START] HAPI MCP server started at ${happyServer.url}`);

  // Variable to track current session instance (updated via onSessionReady callback)
  const currentSessionRef: { current: Session | null } = { current: null };

  const formatFailureReason = (message: string): string => {
    const maxLength = 200;
    if (message.length <= maxLength) {
      return message;
    }
    return `${message.slice(0, maxLength)}...`;
  };

  // Issue #1611: terminal-attached launchers (pty/tmux) have no SDK message
  // stream to derive Claude's thinking state from, so the web session status dot
  // stays stuck. Derive `thinking` from UserPromptSubmit/Stop lifecycle hooks
  // instead. Scoped to non-sdk launchers so the sdk launcher's existing
  // stream-driven thinking is NOT double-driven (R5). Resolved from the same
  // priority chain (env > settings > default) that selectClaudeRemoteLauncher
  // uses, so the kind here matches the launcher the loop actually selects.
  const activeLauncherKind = resolveActiveLauncher().kind;

  // #1613: Record the launcher kind resolved for THIS spawn onto session
  // metadata, FROZEN for the session's lifetime. Later `hapi launcher set`
  // changes to the global default do NOT retroactively alter a running
  // session's launcher, so the web UI shows the viewed session's actual
  // launcher rather than the global default the footer badge reflects.
  // Reuses #1611's already-resolved `activeLauncherKind` (same value).
  // Issue #2434: stamp the DURABLE model pin in the SAME metadata write as
  // launcherKind — deliberately atomic with it.
  //
  // 🔴 This MUST be written CLI-side, not server-side. `updateMetadata` builds
  // the new blob from the CLI's LOCALLY CACHED `this.metadata` (apiSession.ts),
  // so a server-side write racing this one is silently clobbered: the launcherKind
  // stamp spreads a cached base that predates it. A server-side spawn-time write
  // was tried first and lost this race every time — `metadata.modelMode` came back
  // null while `metadata.launcherKind` landed. Folding the pin into THIS call makes
  // the two fields one atomic write, which is exactly why safeMode / launcherKind /
  // sessionRole are all stamped here too.
  //
  // `"default"` is never stored — it is the ABSENCE of a pin, and storing it would
  // make respawn paths thread `--hapi-model-mode default`, shadowing the #1506
  // entitled-model resolution.
  //
  // 🔴 Issue #2456: this durable write is DEFERRED to just after the spawn-pin
  // computation below (see the write site tagged "durable launcher + model pin
  // stamp"). `updateMetadata` runs its mutator inside an `AsyncLock` — even when
  // uncontended, `await lock()` yields a microtask, so the mutator does NOT run
  // here; it runs at the NEXT `await` (the `startHookServer` call just below),
  // which is BEFORE `spawnModelModePin` / `spawnEffortPin` / `spawnRawModelPin`
  // are assigned (~line 380). Stamping here wrote `launcherKind` but silently
  // dropped all three pins (they were still `undefined`) — the durable respawn
  // metadata came back with no model/effort pin.

  // Start Hook server for receiving Claude session notifications
  const hookServer = await startHookServer({
    onSessionHook: (sessionId, data) => {
      logger.debug(`[START] Session hook received: ${sessionId}`, data);

      const currentSession = currentSessionRef.current;
      if (currentSession) {
        const previousSessionId = currentSession.sessionId;
        if (previousSessionId !== sessionId) {
          logger.debug(
            `[START] Claude session ID changed: ${previousSessionId} -> ${sessionId}`
          );
          currentSession.onSessionFound(sessionId);
        }
      }
    },
    onThinkingChange:
      activeLauncherKind === "sdk"
        ? undefined
        : (thinking: boolean) => {
            currentSessionRef.current?.onThinkingChange(thinking);
          },
    // Issue #1653: a TUI prompt (permission ask, etc.) is invisible to the web
    // chat under the tmux/pty launchers. Scoped to non-sdk launchers exactly
    // like onThinkingChange (the sdk launcher surfaces prompts through its own
    // can_use_tool channel). The message-class filter
    // (isBlockingPromptNotification) is the single source of truth: only a
    // genuinely TUI-blocking prompt sets the banner; everything else (e.g.
    // idle_prompt) clears it (R4 — no false positives).
    onNotification:
      activeLauncherKind === "sdk"
        ? undefined
        : (data: SessionHookData) => {
            const currentSession = currentSessionRef.current;
            if (!currentSession) {
              return;
            }
            if (isBlockingPromptNotification(data)) {
              const message =
                typeof data.message === "string" && data.message.length > 0
                  ? data.message
                  : "Claude is waiting for input in the terminal";
              currentSession.setBlockedOnTuiPrompt({
                message,
                since: Date.now(),
              });
            } else {
              currentSession.setBlockedOnTuiPrompt(null);
            }
          },
    // Issue #1664 (epic #1662, Sub B): open/finalize a turn row on the shared
    // hook boundary. CRITICAL — unlike onThinkingChange/onNotification above,
    // these are NOT scoped to non-sdk: the hook settings file is passed to ALL
    // launchers and the UserPromptSubmit/Stop hooks fire for the sdk launcher
    // too, so turns must be recorded uniformly. The reporter (attached to the
    // session in onSessionReady) owns idempotency + the monotonic clock.
    onTurnOpen: (data: SessionHookData) => {
      currentSessionRef.current?.turnReporter?.open({
        ccSessionId: data.session_id ?? data.sessionId,
        cwd: data.cwd,
        transcriptPath: data.transcript_path,
      });
    },
    onTurnFinalize: (data: SessionHookData) => {
      currentSessionRef.current?.turnReporter?.finalize("completed", {
        ccSessionId: data.session_id ?? data.sessionId,
        transcriptPath: data.transcript_path,
      });
    },
  });
  logger.debug(`[START] Hook server started on port ${hookServer.port}`);

  // Issue #2155: merge the role profile's `claudeMdExcludes` into the single
  // hook-settings `--settings` file (ruling D3). Skip the merge under safe-mode
  // — the launchers already drop this settings file entirely for safe-mode
  // sessions (claudeRemote.ts settingsPath:undefined; the terminal launchers
  // gate the `--settings` push on `!safeMode`), so V4 (safeMode + role →
  // --safe-mode present, no excludes) holds for free. A null/unknown role or a
  // missing profile file yields [] → no key → the full stack (fail-open, R3).
  const profileExcludes =
    options.safeMode === true
      ? []
      : resolveProfileExcludes(options.sessionRole);
  // Issue #2626: inject the per-session output style into the SAME --settings
  // file (fail-open — generateHookSettingsFile omits the key when outputStyle
  // is undefined, so R2 byte-identical holds). options.outputStyle arrives via
  // the --hapi-output-style argv hop (commands/claude.ts → StartOptions).
  // Issue #4568 (F1): an API-key session's settings file names its
  // `apiKeyHelper` (vault id + mask, never the key); the launcher verifies the
  // binding before the first turn.
  const hookSettingsPath = generateHookSettingsFile(
    hookServer.port,
    hookServer.token,
    profileExcludes,
    options.outputStyle,
    readBoundApiKeyBinding() ?? undefined
  );
  logger.debug(
    `[START] Generated hook settings file: ${hookSettingsPath}` +
      (profileExcludes.length > 0
        ? ` (role "${options.sessionRole}" → ${profileExcludes.length} claudeMdExcludes)`
        : "")
  );

  // Print log file path
  const logPath = logger.logFilePath;
  logger.infoDeveloper(`Session: ${sessionInfo.id}`);
  logger.infoDeveloper(`Logs: ${logPath}`);

  const lifecycle = createRunnerLifecycle({
    session,
    logTag: "claude",
    stopKeepAlive: () => currentSessionRef.current?.stopKeepAlive(),
    onAfterClose: () => {
      happyServer.stop();
      hookServer.stop();
      cleanupHookSettingsFile(hookSettingsPath);
    },
  });

  lifecycle.registerProcessHandlers();
  registerKillSessionHandler(
    session.rpcHandlerManager,
    lifecycle.cleanupAndExit
  );

  // Set initial agent state
  const startingMode =
    options.startingMode ?? (startedBy === "daemon" ? "remote" : "local");
  setControlledByUser(session, startingMode);

  // Import MessageQueue2 and create message queue
  const messageQueue = new MessageQueue2<EnhancedMode>(mode =>
    // Issue #2346: `isPlan` is intentionally NOT hashed (was here pre-#2346). A
    // permission-mode-only change is now delivered to the live query IN-PLACE via
    // the set_permission_mode control_request (applyPermissionModeInPlace + the
    // set-session-config wiring), so it must NOT force a query relaunch — that
    // eliminated relaunch is this issue's perf win. The ExitPlanMode approval
    // flow keeps its relaunch via an explicit `isolate` trigger on
    // PLAN_FAKE_RESTART (permissionHandler), NOT via this hash. The remaining 7
    // fields still legitimately relaunch: model/fallbackModel/effort change the
    // spawn argv; the prompt/tool fields change request assembly.
    hashObject({
      model: mode.model,
      fallbackModel: mode.fallbackModel,
      // Issue #2456: include effort so a mid-session effort switch changes the
      // mode hash → MessageQueue2 re-spawns the SDK query with the new --effort.
      effort: mode.effort,
      customSystemPrompt: mode.customSystemPrompt,
      appendSystemPrompt: mode.appendSystemPrompt,
      allowedTools: mode.allowedTools,
      disallowedTools: mode.disallowedTools,
    })
  );

  // Round 11 (epic #3285): a saved permission posture (metadata.permissionMode
  // — stamped by set-session-config on a live change, or staged by the
  // disconnected Session Configuration save) seeds the initial mode of a
  // respawn, so "save Plan while disconnected → reconnect" comes back IN plan
  // mode from the first message. A spawn-time --yolo (options.permissionMode =
  // bypassPermissions) still takes precedence; an invalid/foreign pin is ignored.
  const pinnedPermissionParse = PermissionModeSchema.safeParse(
    session.getMetadata()?.permissionMode
  );
  const pinnedPermissionMode: PermissionMode | undefined =
    pinnedPermissionParse.success &&
    isPermissionModeAllowedForFlavor(pinnedPermissionParse.data, "claude")
      ? (pinnedPermissionParse.data as PermissionMode)
      : undefined;
  const initialPermissionMode: PermissionMode | undefined =
    options.permissionMode ?? pinnedPermissionMode;
  // Forward messages to the queue
  let currentPermissionMode: PermissionMode =
    initialPermissionMode ?? "default";
  // Issue #3616: resolve the entitled-account pin FIRST, then seed the model
  // state via the pure `resolveSpawnModelState` helper (Shape B extraction of
  // the former inline seeding + #1506 block). Hoisting the resolve ABOVE the
  // seeding — before ANY RPC handler is registered, and with no top-level await
  // between here and the loop() call — folds the #1506 entitled decision into
  // the helper's `!currentModel` test and closes the deferred-clobber race the
  // old in-line #1506 block (formerly below the RPC handlers, keyed on the
  // display mode) carried. The helper is unit-tested in spawnModelState.test.ts
  // (runClaude has no test seam of its own).
  const entitledModel = await resolveEntitledModelForBoundAccount();
  const seededModel = resolveSpawnModelState(
    {
      model: options.model,
      rawModel: options.rawModel,
      modelMode: options.modelMode,
    },
    entitledModel
  );
  let currentModel = seededModel.currentModel; // Track current model state
  // Issue #2456: the specific pinned raw Claude model id (--hapi-raw-model),
  // captured for the durable stamp. It ALWAYS stays the BARE catalog id.
  const spawnRawModelPin = seededModel.spawnRawModelPin;
  // Issue #2456: track the current specific raw-model pin (mutated below by
  // set-session-config's "More models" branch), seeded from the spawn pin.
  let currentRawModel: string | undefined = seededModel.currentRawModel;
  // Issue #2434: the VALIDATED spawn-time model-mode pin for the durable stamp.
  // (Issue #2438: the assignment just below MUST remain textually BEFORE the
  // durable updateMetadata stamp reads the pin into metadata.modelMode — the
  // #2438 source-order guard asserts that byte order. This comment deliberately
  // avoids the two exact guarded tokens so the guard's indexOf lands on the real
  // code, not on this comment.)
  const spawnModelModePin = seededModel.spawnModelModePin;
  // Issue #1633: display model-mode; the entitled branch (inside the helper)
  // sets it to "opus" for display only.
  let currentModelMode: SessionModelMode = seededModel.currentModelMode;
  // Issue #3616/#1506: debug trace when the entitled pin was applied — i.e. no
  // explicit pick was supplied (no rawModel pin, no model-mode pin) and the
  // helper folded in the entitled default. Moved here from the removed in-line
  // #1506 block below.
  if (
    entitledModel &&
    currentModel === entitledModel &&
    !spawnRawModelPin &&
    !spawnModelModePin
  ) {
    logger.debug(
      `[START] Issue #1506: pinned entitled model for bound account -> ${entitledModel}`
    );
  }
  // Issue #2456: track the reasoning-effort level. Seeded from --hapi-effort;
  // updated by set-session-config. `spawnEffortPin` is the validated value for
  // the durable metadata stamp (undefined when absent/invalid). Orthogonal to
  // model resolution, so it stays here (not in the model-state helper).
  let currentEffort: EffortLevel | undefined;
  let spawnEffortPin: EffortLevel | undefined;
  if (options.effort) {
    const parsedEffort = EffortLevelSchema.safeParse(options.effort);
    if (parsedEffort.success) {
      currentEffort = parsedEffort.data;
      spawnEffortPin = parsedEffort.data;
    }
  }

  // 🔴 Durable launcher + model pin stamp (moved here from above — issue #2456).
  // Stamps launcherKind (#1613) + the spawn model/effort/rawModel pins (#2434/
  // #2456) in ONE atomic CLI-side `updateMetadata` write, so server-side respawn
  // paths (model switch, account switch, reconnect) re-thread the pin. It MUST
  // run AFTER `spawnModelModePin` / `spawnEffortPin` / `spawnRawModelPin` are
  // assigned (just above) — writing it before they exist dropped them silently
  // (the mutator runs deferred in an AsyncLock microtask; see the note above the
  // startHookServer call). It MUST be CLI-side, not server-side: `updateMetadata`
  // rebuilds the blob from the CLI's LOCALLY CACHED metadata, so a racing
  // server-side write is silently clobbered (measured: modelMode came back null
  // while launcherKind landed). `"default"` is never stored — absence = no pin.
  session.updateMetadata(currentMetadata => ({
    ...currentMetadata,
    launcherKind: activeLauncherKind,
    ...(spawnModelModePin && spawnModelModePin !== "default"
      ? { modelMode: spawnModelModePin }
      : {}),
    ...(spawnEffortPin ? { effort: spawnEffortPin } : {}),
    ...(spawnRawModelPin ? { rawModel: spawnRawModelPin } : {}),
    // Issue #2626: stamp the per-session output style CLI-side in the SAME
    // atomic write (same clobber-race rationale as the model pins) so the
    // server-side respawn paths (model/account switch, reconnect) re-source it
    // from metadata.outputStyle. Absence = no key = default (fail-open).
    ...(options.outputStyle ? { outputStyle: options.outputStyle } : {}),
  }));
  let currentFallbackModel: string | undefined = undefined; // Track current fallback model
  let currentCustomSystemPrompt: string | undefined = undefined; // Track current custom system prompt
  let currentAppendSystemPrompt: string | undefined = undefined; // Track current append system prompt
  let currentAllowedTools: string[] | undefined = undefined; // Track current allowed tools
  let currentDisallowedTools: string[] | undefined = undefined; // Track current disallowed tools

  const syncSessionModes = () => {
    const sessionInstance = currentSessionRef.current;
    if (!sessionInstance) {
      return;
    }
    sessionInstance.setPermissionMode(currentPermissionMode);
    sessionInstance.setModelMode(currentModelMode);
    // Issue #1608: keep the launcher's entitled-pin discriminator in sync with
    // the CURRENT effective spawn model. `currentModel` is "opus[1m]" at
    // entitled-default startup (set by the #1506 block) and becomes
    // "sonnet"/"opus"/undefined after a mid-session set-session-config switch.
    // Unlike currentModelMode (overloaded to "opus" for display above), this
    // preserves the "[1m]" alias the launcher keys off to distinguish an
    // entitled pin from an explicit user selection.
    sessionInstance.setModel(currentModel);
    // Issue #2456: keep the session's effort carrier current so the keepAlive
    // tick reports the live effort and the launcher's --effort derivation is fresh.
    sessionInstance.setEffort(currentEffort);
    // Composer-chip pin integrity: keep the raw-model pin on the keepAlive
    // carrier too, so the server's ephemeral `session.rawModel` self-heals
    // after a record rebuild (and a cleared pin propagates as `null`).
    sessionInstance.setRawModel(currentRawModel);
    logger.debug(
      `[loop] Synced session modes for keepalive: permissionMode=${currentPermissionMode}, modelMode=${currentModelMode}, model=${currentModel}, effort=${currentEffort ?? "none"}, rawModel=${currentRawModel ?? "none"}`
    );
  };

  // Issue #2346 (ruling D2, Task 5): ONE in-place permission-mode applier, shared
  // by BOTH callers — the EXISTING set-session-config permissionMode branch (the
  // product's only real mode path) and the new launcher-registered
  // "set-permission-mode" RPC (published onto the Session below so the launcher
  // reaches it without threading a callback through the loop). Mirrors #2256's
  // set-model live wiring: resync the durable + display state FIRST (so a respawn
  // and the keepalive see the new mode), THEN reach the LIVE query out-of-band via
  // set_permission_mode. Non-sdk launchers / pre-launch / post-teardown never
  // publish the live-query accessor → getLiveQuery() is null → method "config"
  // (the durable pin is the record; the mode takes effect on the next spawn).
  // Throws on a live-query failure — callers decide whether to swallow (the
  // set-session-config branch, whose other fields already applied) or shape it
  // (the new RPC, via the service's error mapping).
  const applyPermissionModeInPlace = async (
    mode: PermissionMode
  ): Promise<{ method: "sdk" | "config" }> => {
    currentPermissionMode = mode;
    // Round 11 (epic #3285) durable pin — same write the set-session-config
    // permissionMode branch did inline before #2346 folded it into this applier.
    session.updateMetadata(currentMetadata => ({
      ...currentMetadata,
      permissionMode: mode,
    }));
    syncSessionModes();
    const liveQuery = currentSessionRef.current?.getLiveQuery() ?? null;
    if (liveQuery) {
      await liveQuery.setPermissionMode(mode);
      return { method: "sdk" };
    }
    return { method: "config" };
  };
  session.onUserMessage(message => {
    const sessionPermissionMode =
      currentSessionRef.current?.getPermissionMode();
    if (
      sessionPermissionMode &&
      isPermissionModeAllowedForFlavor(sessionPermissionMode, "claude")
    ) {
      currentPermissionMode = sessionPermissionMode as PermissionMode;
    }
    const messagePermissionMode = currentPermissionMode;
    const messageModel = currentModel;
    // Issue #2456: effort is session-level (changed only via set-session-config,
    // never per-message like fallbackModel), so it is captured directly from the
    // current state without a message.meta override branch.
    const messageEffort = currentEffort;
    logger.debug(
      `[loop] User message received with permission mode: ${currentPermissionMode}, model: ${currentModelMode}`
    );

    // Resolve custom system prompt - use message.meta.customSystemPrompt if provided, otherwise use current
    let messageCustomSystemPrompt = currentCustomSystemPrompt;
    if (message.meta?.hasOwnProperty("customSystemPrompt")) {
      messageCustomSystemPrompt = message.meta.customSystemPrompt || undefined; // null becomes undefined
      currentCustomSystemPrompt = messageCustomSystemPrompt;
      logger.debug(
        `[loop] Custom system prompt updated from user message: ${messageCustomSystemPrompt ? "set" : "reset to none"}`
      );
    } else {
      logger.debug(
        `[loop] User message received with no custom system prompt override, using current: ${currentCustomSystemPrompt ? "set" : "none"}`
      );
    }

    // Resolve fallback model - use message.meta.fallbackModel if provided, otherwise use current fallback model
    let messageFallbackModel = currentFallbackModel;
    if (message.meta?.hasOwnProperty("fallbackModel")) {
      messageFallbackModel = message.meta.fallbackModel || undefined; // null becomes undefined
      currentFallbackModel = messageFallbackModel;
      logger.debug(
        `[loop] Fallback model updated from user message: ${messageFallbackModel || "reset to none"}`
      );
    } else {
      logger.debug(
        `[loop] User message received with no fallback model override, using current: ${currentFallbackModel || "none"}`
      );
    }

    // Resolve append system prompt - use message.meta.appendSystemPrompt if provided, otherwise use current
    let messageAppendSystemPrompt = currentAppendSystemPrompt;
    if (message.meta?.hasOwnProperty("appendSystemPrompt")) {
      messageAppendSystemPrompt = message.meta.appendSystemPrompt || undefined; // null becomes undefined
      currentAppendSystemPrompt = messageAppendSystemPrompt;
      logger.debug(
        `[loop] Append system prompt updated from user message: ${messageAppendSystemPrompt ? "set" : "reset to none"}`
      );
    } else {
      logger.debug(
        `[loop] User message received with no append system prompt override, using current: ${currentAppendSystemPrompt ? "set" : "none"}`
      );
    }

    // Resolve allowed tools - use message.meta.allowedTools if provided, otherwise use current
    let messageAllowedTools = currentAllowedTools;
    if (message.meta?.hasOwnProperty("allowedTools")) {
      messageAllowedTools = message.meta.allowedTools || undefined; // null becomes undefined
      currentAllowedTools = messageAllowedTools;
      logger.debug(
        `[loop] Allowed tools updated from user message: ${messageAllowedTools ? messageAllowedTools.join(", ") : "reset to none"}`
      );
    } else {
      logger.debug(
        `[loop] User message received with no allowed tools override, using current: ${currentAllowedTools ? currentAllowedTools.join(", ") : "none"}`
      );
    }

    // Resolve disallowed tools - use message.meta.disallowedTools if provided, otherwise use current
    let messageDisallowedTools = currentDisallowedTools;
    if (message.meta?.hasOwnProperty("disallowedTools")) {
      messageDisallowedTools = message.meta.disallowedTools || undefined; // null becomes undefined
      currentDisallowedTools = messageDisallowedTools;
      logger.debug(
        `[loop] Disallowed tools updated from user message: ${messageDisallowedTools ? messageDisallowedTools.join(", ") : "reset to none"}`
      );
    } else {
      logger.debug(
        `[loop] User message received with no disallowed tools override, using current: ${currentDisallowedTools ? currentDisallowedTools.join(", ") : "none"}`
      );
    }

    // Check for special commands before processing
    const specialCommand = parseSpecialCommand(message.content.text);

    if (specialCommand.type === "compact") {
      logger.debug("[start] Detected /compact command");
      const enhancedMode: EnhancedMode = {
        permissionMode: messagePermissionMode ?? "default",
        model: messageModel,
        fallbackModel: messageFallbackModel,
        effort: messageEffort,
        customSystemPrompt: messageCustomSystemPrompt,
        appendSystemPrompt: messageAppendSystemPrompt,
        allowedTools: messageAllowedTools,
        disallowedTools: messageDisallowedTools,
      };
      messageQueue.pushIsolateAndClear(
        specialCommand.originalMessage || message.content.text,
        enhancedMode
      );
      logger.debugLargeJson(
        "[start] /compact command pushed to queue:",
        message
      );
      return;
    }

    if (specialCommand.type === "clear") {
      logger.debug("[start] Detected /clear command");
      const enhancedMode: EnhancedMode = {
        permissionMode: messagePermissionMode ?? "default",
        model: messageModel,
        fallbackModel: messageFallbackModel,
        effort: messageEffort,
        customSystemPrompt: messageCustomSystemPrompt,
        appendSystemPrompt: messageAppendSystemPrompt,
        allowedTools: messageAllowedTools,
        disallowedTools: messageDisallowedTools,
      };
      messageQueue.pushIsolateAndClear(
        specialCommand.originalMessage || message.content.text,
        enhancedMode
      );
      logger.debugLargeJson(
        "[start] /compact command pushed to queue:",
        message
      );
      return;
    }

    // Push with resolved permission mode, model, system prompts, and tools
    const enhancedMode: EnhancedMode = {
      permissionMode: messagePermissionMode ?? "default",
      model: messageModel,
      fallbackModel: messageFallbackModel,
      effort: messageEffort,
      customSystemPrompt: messageCustomSystemPrompt,
      appendSystemPrompt: messageAppendSystemPrompt,
      allowedTools: messageAllowedTools,
      disallowedTools: messageDisallowedTools,
    };
    messageQueue.push(message.content.text, enhancedMode);
    logger.debugLargeJson("User message pushed to queue:", message);
  });

  const resolvePermissionMode = (value: unknown): PermissionMode => {
    const parsed = PermissionModeSchema.safeParse(value);
    if (
      !parsed.success ||
      !isPermissionModeAllowedForFlavor(parsed.data, "claude")
    ) {
      throw new Error("Invalid permission mode");
    }
    return parsed.data as PermissionMode;
  };

  const resolveModelMode = (value: unknown): SessionModelMode => {
    const parsed = ModelModeSchema.safeParse(value);
    if (
      !parsed.success ||
      !isModelModeAllowedForFlavor(parsed.data, "claude")
    ) {
      throw new Error("Invalid model mode");
    }
    return parsed.data;
  };

  session.rpcHandlerManager.registerHandler(
    "set-session-config",
    async (payload: unknown) => {
      if (!payload || typeof payload !== "object") {
        throw new Error("Invalid session config payload");
      }
      const config = payload as {
        permissionMode?: unknown;
        modelMode?: unknown;
        effort?: unknown;
        rawModel?: unknown;
      };

      // Issue #3769 (ruling D6): capture the model BEFORE any branch mutates it,
      // so the shared applyModelInPlace applier below fires the live SDK switch
      // at most once and only when the model actually changed (an effort-only /
      // permission-only / unchanged Apply reports method:"config").
      const modelBefore = currentModel;

      if (config.permissionMode !== undefined) {
        // Issue #2346 (ruling D2): this is the product's ONLY real permission-mode
        // path (web UI → POST /permission-mode → applySessionConfig → set-session-
        // config → here). Apply in-place via the shared applier — it does the state
        // resync + the Round-11 (#3285) durable pin (formerly inline here) AND fires
        // Query.setPermissionMode on the live query. Before #2346 this branch set
        // currentPermissionMode + the pin and relied on the isPlan mode-hash
        // relaunch to carry the change to the subprocess; Task 6 removes that
        // relaunch, so this live-query wiring is what delivers the mode in-place.
        // resolvePermissionMode still validates + throws on an invalid / foreign-
        // flavor mode BEFORE the applier runs.
        const resolvedPermissionMode = resolvePermissionMode(
          config.permissionMode
        );
        try {
          await applyPermissionModeInPlace(resolvedPermissionMode);
        } catch (err) {
          // The state resync + durable pin already applied inside the applier
          // before the live-query call threw; only the live switch failed. Surface
          // it (OR-3: never a silent, more-permissive divergence). Until Task 6
          // removes the isPlan relaunch, the relaunch reconciles on the next
          // message — which is exactly why Task 6 is HARD-GATED on this wiring
          // verifying live before the relaunch is removed.
          logger.warn(
            `[set-session-config] live permission switch to ${resolvedPermissionMode} failed: ${
              err instanceof Error ? err.message : String(err)
            } (durable pin applied)`
          );
        }
      }

      if (config.modelMode !== undefined) {
        const resolvedModelMode = resolveModelMode(config.modelMode);
        currentModelMode = resolvedModelMode;
        // Issue #1633: derive the raw --model value from the mode. For
        // sonnet/opus this is the bare alias (unchanged behavior); for fable
        // it is "fable[1m]" — the 1M-context alias the ModelMode enum cannot
        // carry (same reason #1506 threads opus[1m] as a raw string).
        currentModel = resolveRawModelForMode(resolvedModelMode);
        // Issue #2434: a mid-session model change becomes the NEW durable pin —
        // "last manual selection wins". It overwrites any spawn-time value in
        // the same `metadata.modelMode` the server-side respawn paths (model
        // switch, account switch, reconnect) re-source from, so the manual
        // choice survives a later restart exactly as a spawn-time pin does.
        //
        // Written here, CLI-side, for the same reason as the spawn stamp above:
        // this process owns the cached metadata base, so a server-side write
        // would be clobbered by the next CLI stamp.
        //
        // Reverting to "default" CLEARS the pin rather than storing it, so the
        // session falls back to normal default-mode resolution (#1506 entitled
        // pin) instead of being pinned to a literal "default".
        session.updateMetadata(currentMetadata => {
          const next = { ...currentMetadata };
          if (resolvedModelMode === "default") {
            delete next.modelMode;
          } else {
            next.modelMode = resolvedModelMode;
          }
          // Issue #2456: a family/mode selection supersedes a specific pinned
          // version — clear the rawModel pin so the two axes never both persist.
          delete next.rawModel;
          currentRawModel = undefined;
          return next;
        });
      }

      // Issue #2456: a specific pinned raw Claude model id ("More models"). It
      // becomes the new durable pin AND overrides currentModel directly (already
      // a resolved id — no mode→model mapping). Clears the modelMode pin (mutual
      // exclusion) and sets the display modelMode via deriveModelModeFromRaw
      // (a specific version usually derives "default", mirroring #1506's pinned
      // entitled model whose display mode is also a plain alias/default).
      if (config.rawModel !== undefined) {
        const raw =
          typeof config.rawModel === "string" && config.rawModel.length > 0
            ? config.rawModel
            : undefined;
        currentRawModel = raw;
        if (raw) {
          currentModel = raw;
          currentModelMode = deriveModelModeFromRaw(raw);
        }
        session.updateMetadata(currentMetadata => {
          const next = { ...currentMetadata };
          if (raw) {
            next.rawModel = raw;
            delete next.modelMode;
          } else {
            delete next.rawModel;
          }
          return next;
        });
      }

      // Issue #2456: reasoning-effort change. Validated against EffortLevelSchema;
      // an empty/invalid value CLEARS the effort pin (falls back to binary default).
      // Written CLI-side (same clobber-race reason as modelMode above).
      if (config.effort !== undefined) {
        const parsed = EffortLevelSchema.safeParse(config.effort);
        currentEffort = parsed.success ? parsed.data : undefined;
        session.updateMetadata(currentMetadata => {
          const next = { ...currentMetadata };
          if (currentEffort) {
            next.effort = currentEffort;
          } else {
            delete next.effort;
          }
          return next;
        });
      }

      syncSessionModes();

      // Issue #3769 (ruling D6): reach the LIVE SDK query for a model change so a
      // web pick applies IN-PLACE (no extra user message) instead of next-turn.
      // Called ONCE after all branches + syncSessionModes(); the change-gate
      // inside the applier suppresses the live switch for a permission-only /
      // effort-only / unchanged Apply. tmux/pty sessions have no live query →
      // method:"config" and the existing sessionConfigRestart respawn applies the
      // pick (byte-identical). A failed live switch is swallowed to
      // method:"config" (the durable pin above is the record).
      const { method } = await applyModelInPlace({
        getLiveQuery: () => currentSessionRef.current?.getLiveQuery() ?? null,
        currentModel,
        modelBefore,
        warn: msg => logger.warn(msg),
      });

      // Issue #3769 (R6): diagnostics — the path taken, the payload received, the
      // model before/after, and the method the fold used (an in-session "Default"
      // pick on a Max-bound account lands on Claude Code's own default, not the
      // entitled opus[1m] spawn pin, so currentModel before/after tells them apart).
      logger.info(
        `[set-session-config] applied={modelMode:${currentModelMode},effort:${
          currentEffort ?? "none"
        },rawModel:${
          currentRawModel ?? "none"
        }} currentModel: ${modelBefore ?? "none"} -> ${
          currentModel ?? "none"
        } method=${method}`
      );

      return {
        applied: {
          permissionMode: currentPermissionMode,
          modelMode: currentModelMode,
          effort: currentEffort,
          rawModel: currentRawModel,
        },
        // Issue #3769 (Task 1d): additive — surfaced through
        // sessionLifecycleOps.applySessionConfig → sessionService → the
        // /model,/effort,/raw-model routes as {ok:true, method}. Old clients
        // ignore it (the `applied` envelope is unchanged).
        method,
      };
    },
    SET_SESSION_CONFIG_META
  );

  // Issue #2421 (epic #2416, Sub-Issue E): `set-model` — the model-set control
  // exposed through the registry as a MUTATING capability. It reuses the same
  // closure model-change machinery as `set-session-config`'s modelMode branch
  // (currentModelMode/currentModel/currentRawModel + updateMetadata +
  // syncSessionModes), so it is a real, functional handler — NOT a stub. But
  // because it is `mutating`, the #2419 readonly-only invoke gate BLOCKS it with
  // `tier_not_invocable`: it is the epic's deliberate enumerable-but-not-
  // invocable demonstration (the registry's discovery value even where invoke
  // stays gated; promotion to generic invoke is a future reviewed change to
  // INVOCABLE_TIERS). Registered on the SAME ApiSessionClient rpcHandlerManager
  // (scopePrefix = sessionId) as the launcher's get-context-usage/mcp-status, so
  // all three enumerate together for the session. `mcp_reconnect` is NOT
  // registered — it has zero implementation repo-wide (ruling 1B-29).
  session.rpcHandlerManager.registerHandler(
    "set-model",
    async (payload: unknown) => {
      if (!payload || typeof payload !== "object") {
        throw new Error("Invalid set-model payload");
      }
      const { modelMode } = payload as { modelMode?: unknown };
      if (modelMode === undefined) {
        throw new Error("set-model requires a modelMode");
      }
      const resolvedModelMode = resolveModelMode(modelMode);
      // Issue #3769: capture before the durable resync mutates currentModel, so
      // the shared applier's change-gate fires the live switch only on an actual
      // change (re-selecting the same model → method:"config").
      const modelBefore = currentModel;
      currentModelMode = resolvedModelMode;
      currentModel = resolveRawModelForMode(resolvedModelMode);
      session.updateMetadata(currentMetadata => {
        const next = { ...currentMetadata };
        if (resolvedModelMode === "default") {
          delete next.modelMode;
        } else {
          next.modelMode = resolvedModelMode;
        }
        // A family/mode selection supersedes a specific pinned version (#2456).
        delete next.rawModel;
        currentRawModel = undefined;
        return next;
      });
      syncSessionModes();

      // Issue #2256 / #3769 (ruling D6): after the durable resync above, ALSO
      // reach the LIVE SDK query out-of-band via set_model — through the SAME
      // applyModelInPlace applier the set-session-config handler uses, so the two
      // model paths can never drift (the #2346 rationale for permission mode).
      // The applier reads the live-query accessor off the Session WRAPPER
      // (currentSessionRef.current, published at onSessionReady), not the
      // ApiSessionClient `session` this handler closes over. Non-sdk launchers /
      // pre-launch / post-teardown never publish → method:"config" (the durable
      // pin above is the record). `currentModel` is undefined for a "default"
      // pick → no live switch. A live-switch throw is swallowed to
      // method:"config" (the pin is applied; the next message reconciles via the
      // mode-hash relaunch) with the SdkRequestError classification logged.
      const { method } = await applyModelInPlace({
        getLiveQuery: () => currentSessionRef.current?.getLiveQuery() ?? null,
        currentModel,
        modelBefore,
        warn: msg => logger.warn(msg),
      });

      // Issue #3769 (R6): diagnostics for the set-model path.
      logger.info(
        `[set-model] currentModel: ${modelBefore ?? "none"} -> ${
          currentModel ?? "none"
        } method=${method}`
      );

      return {
        ok: true,
        method,
        applied: { modelMode: currentModelMode, rawModel: currentRawModel },
      };
    },
    SET_MODEL_META
  );

  // Issue #3616: the #1506 entitled-pin decision moved UP into
  // resolveSpawnModelState (called at the seeding site above), where it keys on
  // explicit-model ABSENCE (`!currentModel`) rather than the derived DISPLAY
  // mode. Keying on the display mode misfired here: deriveModelModeFromRaw maps
  // every concrete id to "default", so a concrete rawModel pick (e.g.
  // "claude-fable-5-1") on a Max-bound account was clobbered with opus[1m].
  // Resolving it at seed time — before any RPC handler is registered — also
  // removes the deferred-clobber race that would otherwise need a post-await
  // re-check here.

  let loopError: unknown = null;
  let loopFailed = false;
  try {
    await loop({
      path: workingDirectory,
      model: currentModel,
      effort: currentEffort,
      // Round 11: the pin-aware initial posture (see initialPermissionMode).
      permissionMode: initialPermissionMode,
      startingMode,
      messageQueue,
      api,
      allowedTools: happyServer.toolNames.map(
        toolName => `mcp__${HAPI_MCP_SERVER_NAME}__${toolName}`
      ),
      onModeChange: createModeChangeHandler(session),
      onSessionReady: sessionInstance => {
        currentSessionRef.current = sessionInstance;
        // Issue #2346 (ruling D2): publish the shared in-place applier onto the
        // Session so the launcher-registered "set-permission-mode" RPC handler can
        // reach it (mirror of #2256's setLiveQueryAccessor, opposite direction).
        sessionInstance.setPermissionModeApplier(applyPermissionModeInPlace);
        // Issue #1664: attach the per-turn reporter — one instance for the
        // session's whole lifetime (it survives local↔remote switches because
        // loop.ts holds a single Session). Emits are fire-and-forget over the
        // session's socket client; the reporter never awaits on the turn path.
        sessionInstance.turnReporter = new TurnReporter({
          emit: payload => sessionInstance.client.sendTurnEvent(payload),
          launcher: activeLauncherKind,
          // Sub D (#1666): local working-tree git probe (sha/branch/dirty),
          // fail-open and bounded; fires only at turn boundaries.
          gitProbe: makeGitProbe(),
        });
        syncSessionModes();
      },
      mcpServers: {
        [HAPI_MCP_SERVER_NAME]: {
          type: "http" as const,
          url: happyServer.url,
        },
      },
      session,
      claudeEnvVars: options.claudeEnvVars,
      claudeArgs: options.claudeArgs,
      startedBy,
      hookSettingsPath,
    });
  } catch (error) {
    loopError = error;
    loopFailed = true;
    lifecycle.markCrash(error);
  }

  const localFailure = currentSessionRef.current?.localLaunchFailure;
  if (localFailure?.exitReason === "exit") {
    lifecycle.setExitCode(1);
    lifecycle.setArchiveReason(
      `Local launch failed: ${formatFailureReason(localFailure.message)}`
    );
  }

  if (loopFailed) {
    await lifecycle.cleanup();
    throw loopError;
  }

  await lifecycle.cleanupAndExit();
}
