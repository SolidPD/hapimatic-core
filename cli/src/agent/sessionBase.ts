// SPDX-License-Identifier: AGPL-3.0-only
import { ApiClient, ApiSessionClient } from "@/lib";
import { MessageQueue2 } from "@/utils/MessageQueue2";
import type {
  Metadata,
  SessionModelMode,
  SessionPermissionMode,
} from "@/api/types";
import { logger } from "@/ui/logger";
import { readClaudeAccountInfo } from "@/utils/claudeCredentials";
import type {
  BackgroundAgentsSnapshot,
  ClaudeAccountInfo,
} from "@hapi/protocol/schemas";
import {
  FALLBACK_CLAUDE_MODELS,
  HAPI_MCP_SERVER_NAME,
  clampEffortToModel,
  isEffortLevel,
  mcpServerContextTokens,
  normalizeMcpServerName,
  resolveModelEffortLevels,
  type EffortLevel,
  type McpServerUsage,
  type PromptCacheState,
} from "@hapi/protocol";
import { BackgroundAgentTracker } from "@/claude/utils/backgroundAgentTracker";
import { getProjectPath } from "@/claude/utils/path";
import { join } from "node:path";
// Imported from the leaf `@/ext/lifecycle`, NOT `@/ext/host`: the host pulls in
// `@/commands/registry` (all 16 command modules), and this file is core session
// code imported by most of the CLI.
import { fireSessionStart } from "@/ext/lifecycle";

export type AgentSessionBaseOptions<Mode> = {
  api: ApiClient;
  client: ApiSessionClient;
  path: string;
  logPath: string;
  sessionId: string | null;
  messageQueue: MessageQueue2<Mode>;
  onModeChange: (mode: "local" | "remote") => void;
  mode?: "local" | "remote";
  sessionLabel: string;
  sessionIdLabel: string;
  applySessionIdToMetadata: (metadata: Metadata, sessionId: string) => Metadata;
  permissionMode?: SessionPermissionMode;
  modelMode?: SessionModelMode;
  /** Issue #2456: reasoning-effort level (`--effort <level>`). */
  effort?: string;
};

export class AgentSessionBase<Mode> {
  readonly path: string;
  readonly logPath: string;
  readonly api: ApiClient;
  readonly client: ApiSessionClient;
  readonly queue: MessageQueue2<Mode>;
  protected readonly _onModeChange: (mode: "local" | "remote") => void;

  sessionId: string | null;
  mode: "local" | "remote" = "local";
  thinking: boolean = false;
  // Issue #1653: under the tmux/pty launchers a permission (or other blocking)
  // prompt renders ONLY in the TUI — invisible to the web chat. This holds the
  // "Claude is waiting on a terminal prompt" state so the web can surface a
  // banner distinct from the #1611 thinking dot. `null` = no pending prompt;
  // `{ message, since }` = blocked (since = epoch-ms when the Notification hook
  // fired, used by the scanner-activity since-guard to skip backlog deliveries).
  // Held here (not one-shot) so it rides the 2s keepAlive tick and self-heals
  // across dropped emits — mirrors `thinking`.
  blockedOnTuiPrompt: { message: string; since: number } | null = null;
  // Issue #1647: a session-limit 429 (HTTP rate limit) aborts the turn but under
  // the tmux/pty launchers fires NO Stop hook, so the #1611 thinking latch never
  // clears and the web shows "thinking" forever. This holds the rate-limited
  // state so the web can surface a "rate-limited — resets {time}" chip distinct
  // from the thinking dot. `null` = not rate-limited; `{ resetText, resetAt,
  // since }` = rate-limited (resetText is the display string; resetAt is a
  // best-effort epoch ms or null; since = when the 429 fired). Held (not
  // one-shot) so it rides the 2s keepAlive tick and self-heals across dropped
  // emits — mirrors `thinking` / `blockedOnTuiPrompt`.
  rateLimited: {
    resetText: string;
    resetAt: number | null;
    since: number;
  } | null = null;

  private sessionFoundCallbacks: ((sessionId: string) => void)[] = [];
  private readonly applySessionIdToMetadata: (
    metadata: Metadata,
    sessionId: string
  ) => Metadata;
  private readonly sessionLabel: string;
  private readonly sessionIdLabel: string;
  private keepAliveInterval: NodeJS.Timeout | null = null;
  private credentialRefreshInterval: NodeJS.Timeout | null = null;
  // Issue #4383: the background-Agent tracker. Owned by SessionBase (the only
  // process-local component that sees both launchers' starts AND ends). Fed by
  // the launchers (onSdkMessage / onTranscriptLine via the scanner tap), cleared
  // at turn end by onThinkingChange(false), and read into the keepAlive runtime.
  readonly backgroundAgentTracker = new BackgroundAgentTracker();
  private bgReconcileInterval: NodeJS.Timeout | null = null;
  private bgConfigDir: string | undefined;
  private bgWorkingDir: string | undefined;
  private lastKnownAccountInfo: ClaudeAccountInfo | undefined;
  protected permissionMode?: SessionPermissionMode;
  protected modelMode?: SessionModelMode;
  // Issue #2456: reasoning-effort level, reported via the keepAlive runtime so
  // the web renders the live effort tag next to the model name.
  protected effort?: string;
  // Composer-chip pin integrity (successor to #2456/#2768): the specific pinned
  // raw model id, mutually exclusive with modelMode. Reported via the keepAlive
  // runtime so the server's EPHEMERAL record self-heals after a rebuild
  // (sessionCache.refreshSession) the same way `effort` already does — before
  // this, no keepAlive tick carried it, so one store write dropped it for good.
  protected rawModel?: string;
  protected resolvedModel?: string;
  // Issue #6166: the effort the Claude process APPLIES, read back via the SDK
  // get_settings request (after env overrides and model remaps): a level,
  // `null` (it sends none) or undefined (not measured). `appliedModel` is the
  // model that read-back reported, and `appliedForEffort` the effort the
  // measured query was LAUNCHED with (`null` = none), so a reader can tell a
  // pending effort change (the next message relaunches the query) from a
  // mismatch. Live only — reported on the keepAlive and never written to
  // metadata, which feeds respawns and outlives the process.
  protected appliedEffort?: EffortLevel | null;
  protected appliedModel?: string;
  protected appliedForEffort?: EffortLevel | null;
  // Issue #6166: one mismatch warning per distinct launch/applied/model triple.
  private readonly warnedEffortMismatches = new Set<string>();
  // Issue #6169: the prompt-cache keep-alive state, published by the SDK remote
  // launcher (the only one with a control channel); null elsewhere.
  private promptCacheReporter: (() => PromptCacheState | null) | null = null;
  // Issue #1469: first-order context window + live usage, pushed per turn from
  // get_context_usage (see onContextUsage). Propagated via keepAlive runtime.
  protected contextWindowTokens?: number;
  protected contextUsedTokens?: number;
  protected contextPercentage?: number;

  constructor(opts: AgentSessionBaseOptions<Mode>) {
    this.path = opts.path;
    this.api = opts.api;
    this.client = opts.client;
    this.logPath = opts.logPath;
    this.sessionId = opts.sessionId;
    this.queue = opts.messageQueue;
    this._onModeChange = opts.onModeChange;
    this.applySessionIdToMetadata = opts.applySessionIdToMetadata;
    this.sessionLabel = opts.sessionLabel;
    this.sessionIdLabel = opts.sessionIdLabel;
    this.mode = opts.mode ?? "local";
    this.permissionMode = opts.permissionMode;
    this.modelMode = opts.modelMode;
    this.effort = opts.effort;

    this.client.keepAlive(this.thinking, this.mode, this.getKeepAliveRuntime());
    this.keepAliveInterval = setInterval(() => {
      this.client.keepAlive(
        this.thinking,
        this.mode,
        this.getKeepAliveRuntime()
      );
    }, 2000);

    // Seed initial account info for change detection (completes in ms,
    // well before the first 30s refresh tick).
    void readClaudeAccountInfo().then(info => {
      this.lastKnownAccountInfo = info;
    });

    // Periodic credential refresh: re-read Claude account info from disk
    // every 30s and push metadata update if the account changed (e.g., user
    // switched Claude Code accounts mid-session).
    this.credentialRefreshInterval = setInterval(() => {
      void this.refreshCredentialsIfChanged();
    }, 30_000);

    // Issue #4383: reconcile the background-Agent tracker against the session's
    // subagents/ dir every 30 s WHILE it is tracking something (total > 0) — picks
    // up an agent whose start was missed and drift-completes a silent agent. A
    // reconcile also runs at each turn end (onThinkingChange(false)).
    this.bgReconcileInterval = setInterval(() => {
      const snap = this.backgroundAgentTracker.snapshot();
      if (snap && snap.total > 0) this.backgroundAgentTracker.reconcile();
    }, 30_000);

    // Issue #1268: extension lifecycle — session start.
    //
    // Documented AC deviation: the AC frames this as firing "before any session
    // work begins", but the keep-alive interval above has already started
    // ticking by the time we get here. Constructor-end is nonetheless the
    // correct site — it is the EARLIEST point at which a complete `Session` is
    // available to hand a handler, and it is unconditional, so short-lived
    // sessions cannot slip past it the way a later seam would let them.
    //
    // Guarded because the extension system is OPTIONAL infrastructure that must
    // never prevent a session from being constructed. Handler faults are already
    // contained inside the emitter; this covers the snapshot + emit path itself.
    try {
      fireSessionStart(this.client.getSessionSnapshot());
    } catch (error) {
      logger.warn("[ext.lifecycle] failed to emit session start:", error);
    }
  }

  onThinkingChange = (thinking: boolean) => {
    this.thinking = thinking;
    // Issue #4383: a turn END is the T1 "results consumed" clock. Reconcile first
    // (a drift-detected completion may land here), then clear any consumed agents.
    // This is launcher-agnostic — the Stop hook for tmux/pty, updateThinking for
    // SDK, and the #1742 TurnEndDetector for bare turn-ends all route here.
    if (!thinking) {
      this.backgroundAgentTracker.reconcile();
      const beforeClear = this.backgroundAgentTracker.snapshot();
      this.backgroundAgentTracker.onTurnEnd();
      // Issue #4385 fix round 1: the T1 clear can drop an agent that finished
      // since the last tick (a drift-done from the reconcile above, or a
      // completion consumed inside one keepAlive interval). Report the finished
      // snapshot once before the cleared keepAlive below, so the hub sees the
      // completion and records the agent's full usage.
      if (beforeClear && this.backgroundAgentTracker.snapshot() === null) {
        this.client.keepAlive(thinking, this.mode, {
          ...this.getKeepAliveRuntime(),
          backgroundAgents: beforeClear,
        });
      }
    }
    // Issue #1653 clear-site (i): UserPromptSubmit (thinking=true, the user
    // moved on) and Stop (thinking=false, the turn ended) both make any pending
    // TUI prompt moot. This also covers the launcher teardown clear, which
    // routes through onThinkingChange(false).
    this.blockedOnTuiPrompt = null;
    // Issue #3235: `rateLimited` is NO LONGER cleared here — on EITHER edge. A
    // bare turn-end (#1742 TurnEndDetector → onThinkingChange(false)) fires on
    // the SAME refusal turn that just set the 429 chip, so clearing here
    // clobbered it instantly (the incident: monitors always read null). The chip
    // now clears ONLY on genuine forward progress (RateLimitDetector.onCleared →
    // session.setRateLimited(null), the FALLING edge) or on process teardown
    // (each launcher's `finally` calls setRateLimited(null)). R3.
    this.client.keepAlive(thinking, this.mode, this.getKeepAliveRuntime());
  };

  // Issue #1647: enter/clear the rate-limited state. Entering (non-null) also
  // clears `thinking` and `blockedOnTuiPrompt` — a rate-limited session is
  // neither working nor waiting on a TUI prompt, and on the tmux/pty launchers
  // NO Stop hook fires to clear `thinking` (that missing hook IS the #1647 bug),
  // so we MUST clear it here at the turn boundary. Mirrors setBlockedOnTuiPrompt:
  // mutate held state + immediate keepAlive (the 2s tick re-sends for self-heal).
  setRateLimited = (
    state: { resetText: string; resetAt: number | null; since: number } | null
  ) => {
    this.rateLimited = state;
    if (state !== null) {
      this.thinking = false;
      this.blockedOnTuiPrompt = null;
    }
    this.client.keepAlive(this.thinking, this.mode, this.getKeepAliveRuntime());
  };

  // Issue #1653: set/clear the blocked-on-TUI-prompt state. Mirrors
  // onThinkingChange — mutate the held state + immediate keepAlive (the 2s tick
  // re-sends it for self-heal). The message-class filter lives upstream
  // (isBlockingPromptNotification, called from runClaude); only genuinely
  // blocking prompts arrive here as a non-null value.
  setBlockedOnTuiPrompt = (
    blocked: { message: string; since: number } | null
  ) => {
    this.blockedOnTuiPrompt = blocked;
    this.client.keepAlive(this.thinking, this.mode, this.getKeepAliveRuntime());
  };

  // Issue #1653 clear-site (ii): transcript-scanner activity means Claude has
  // progressed past the prompt (answered in the TUI or the web terminal, or
  // dismissed via the #1654 web-Stop/Escape path that fires no Stop hook). The
  // since-guard skips backlog deliveries older than the moment the prompt fired
  // (the prompt-triggering tool-call entry can be delivered AFTER the
  // Notification — clearing on it would prematurely hide a still-pending
  // banner). A no-op when nothing is blocked, so it adds no keepAlive churn to
  // normal message flow. `activityEpochMs` undefined (untyped/unparseable
  // transcript timestamp, per fable-review [1653-4]) → unconditional clear.
  clearTuiPromptOnActivity = (activityEpochMs?: number) => {
    if (this.blockedOnTuiPrompt === null) {
      return;
    }
    if (
      activityEpochMs !== undefined &&
      activityEpochMs < this.blockedOnTuiPrompt.since
    ) {
      return;
    }
    this.blockedOnTuiPrompt = null;
    this.client.keepAlive(this.thinking, this.mode, this.getKeepAliveRuntime());
  };

  onModeChange = (mode: "local" | "remote") => {
    this.mode = mode;
    this.client.keepAlive(this.thinking, mode, this.getKeepAliveRuntime());
    const permissionLabel = this.permissionMode ?? "unset";
    const modelLabel = this.modelMode ?? "unset";
    logger.debug(
      `[${this.sessionLabel}] Mode switched to ${mode} (permissionMode=${permissionLabel}, modelMode=${modelLabel})`
    );
    this._onModeChange(mode);
  };

  onSessionFound = (sessionId: string) => {
    this.sessionId = sessionId;
    // Issue #4383: the cc session id is the final piece of the subagents/ path —
    // recompute it now that it is known (and on every resume, which fires again).
    this.recomputeBackgroundAgentsSubagentsDir();
    this.client.updateMetadata(metadata =>
      this.applySessionIdToMetadata(metadata, sessionId)
    );
    logger.debug(
      `[${this.sessionLabel}] ${this.sessionIdLabel} session ID ${sessionId} added to metadata`
    );

    for (const callback of this.sessionFoundCallbacks) {
      callback(sessionId);
    }
  };

  /**
   * Issue #4383: hand the background-Agent tracker the reconcile context each
   * launcher resolves — `configDir` (the account-isolated CLAUDE_CONFIG_DIR, the
   * same root the scanner watches — NOT a hardcoded ~/.claude) and the session's
   * `workingDirectory`. The cc session id arrives separately via onSessionFound;
   * the subagents/ dir is (re)computed once all three are known.
   */
  setBackgroundAgentContext = (opts: {
    configDir?: string;
    workingDirectory: string;
  }): void => {
    this.bgConfigDir = opts.configDir;
    this.bgWorkingDir = opts.workingDirectory;
    this.recomputeBackgroundAgentsSubagentsDir();
  };

  private recomputeBackgroundAgentsSubagentsDir(): void {
    if (!this.bgWorkingDir || !this.sessionId) return;
    const projectDir = getProjectPath(this.bgWorkingDir, this.bgConfigDir);
    this.backgroundAgentTracker.setSubagentsDir(
      join(projectDir, this.sessionId, "subagents")
    );
  }

  addSessionFoundCallback = (callback: (sessionId: string) => void): void => {
    this.sessionFoundCallbacks.push(callback);
  };

  removeSessionFoundCallback = (
    callback: (sessionId: string) => void
  ): void => {
    const index = this.sessionFoundCallbacks.indexOf(callback);
    if (index !== -1) {
      this.sessionFoundCallbacks.splice(index, 1);
    }
  };

  private async refreshCredentialsIfChanged(): Promise<void> {
    // Multi-account (epic #1446, Sub-Issue D): a session bound to an account
    // (HAPI_ACCOUNT_UUID set) injects its token via env var, bypassing host disk.
    // The bound account's identity is fixed for the process lifetime (per-process
    // binding, KD-3), so this host-disk refresh loop must NOT overwrite
    // metadata.claudeAccount with the host default (R4). Non-bound sessions keep
    // the loop intact (the legitimate "user switched host account mid-session" case).
    if (process.env.HAPI_ACCOUNT_UUID) {
      return;
    }
    // Issue #4568: an API-key session binds no account at all — the host's
    // on-disk login is not its credential, so a host-account change must never
    // stamp `claudeAccount` onto it (that would name the wrong credential).
    if (process.env.HAPI_API_KEY_ID) {
      return;
    }
    try {
      const fresh = await readClaudeAccountInfo();

      // Compare with last known values — only push update if something changed
      if (
        fresh?.email === this.lastKnownAccountInfo?.email &&
        fresh?.planLabel === this.lastKnownAccountInfo?.planLabel &&
        fresh?.subscriptionType ===
          this.lastKnownAccountInfo?.subscriptionType &&
        fresh?.rateLimitTier === this.lastKnownAccountInfo?.rateLimitTier
      ) {
        return;
      }

      logger.debug(
        `[CREDENTIAL_REFRESH] Account info changed: ${this.lastKnownAccountInfo?.email ?? "none"} → ${fresh?.email ?? "none"}`
      );

      this.lastKnownAccountInfo = fresh;
      this.client.updateMetadata(metadata => ({
        ...metadata,
        claudeAccount: fresh,
      }));
    } catch (error) {
      logger.debug(
        "[CREDENTIAL_REFRESH] Failed to refresh credentials:",
        error
      );
    }
  }

  stopKeepAlive = (): void => {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
    if (this.credentialRefreshInterval) {
      clearInterval(this.credentialRefreshInterval);
      this.credentialRefreshInterval = null;
    }
    if (this.bgReconcileInterval) {
      clearInterval(this.bgReconcileInterval);
      this.bgReconcileInterval = null;
    }
  };

  protected getKeepAliveRuntime(): {
    permissionMode?: SessionPermissionMode;
    modelMode?: SessionModelMode;
    effort?: string;
    // Issue #6166: the applied effort read back from Claude (`null` = none), the
    // model it reported and the effort the measured query was launched with.
    // Present only while measured; the server always-assigns them (like
    // blockedOnTuiPrompt), so a tick without them clears its copy.
    appliedEffort?: EffortLevel | null;
    appliedModel?: string;
    appliedForEffort?: EffortLevel | null;
    // Composer-chip pin integrity: always present — `null` when no raw model is
    // pinned (a family-mode pick clears the pin), so the server drops a stale
    // id instead of keeping it (same always-assign contract as
    // blockedOnTuiPrompt). An old CLI omits the field → the server leaves the
    // record untouched.
    rawModel: string | null;
    resolvedModel?: string;
    contextWindowTokens?: number;
    contextUsedTokens?: number;
    contextPercentage?: number;
    // Issue #1653: always present (null when no pending prompt). Unlike the
    // sticky fields above, this is NOT gated behind the all-undefined early
    // return — the server always-assigns it (mirroring `thinking`), so it must
    // ride EVERY keepAlive tick. Gating it would strand a clear emitted before
    // any sticky field is populated (e.g. a permission prompt on the first tool
    // call). `undefined` sticky fields are dropped by JSON serialization, so
    // an otherwise-empty runtime travels as just `{ blockedOnTuiPrompt: null }`.
    blockedOnTuiPrompt: { message: string; since: number } | null;
    // Issue #1647: always-present (null when not rate-limited), same always-
    // assign contract as `blockedOnTuiPrompt` — the server mirrors it on every
    // tick so a clear reliably lands and a dropped emit self-heals next tick.
    rateLimited: {
      resetText: string;
      resetAt: number | null;
      since: number;
    } | null;
    // Issue #4383: always-present (null when no background agents), the same
    // always-assign contract as rateLimited — the server normalises null to
    // absent (K11) so a clear lands and a dropped tick self-heals next tick.
    backgroundAgents: BackgroundAgentsSnapshot | null;
    // Issue #6169: always present (null when no launcher reports it), the same
    // always-assign contract — the keep-alive scheduler must never read a cache
    // clock left behind by an ended query.
    promptCache: PromptCacheState | null;
  } {
    return {
      permissionMode: this.permissionMode,
      modelMode: this.modelMode,
      effort: this.effort,
      ...(this.appliedEffort !== undefined
        ? {
            appliedEffort: this.appliedEffort,
            appliedModel: this.appliedModel,
            appliedForEffort: this.appliedForEffort,
          }
        : {}),
      rawModel: this.rawModel ?? null,
      resolvedModel: this.resolvedModel,
      contextWindowTokens: this.contextWindowTokens,
      contextUsedTokens: this.contextUsedTokens,
      contextPercentage: this.contextPercentage,
      blockedOnTuiPrompt: this.blockedOnTuiPrompt,
      rateLimited: this.rateLimited,
      backgroundAgents: this.backgroundAgentTracker.snapshot(),
      promptCache: this.promptCacheReporter?.() ?? null,
    };
  }

  /** Issue #6169: the SDK remote launcher publishes (and on teardown clears) its tracker. */
  setPromptCacheReporter(fn: (() => PromptCacheState | null) | null): void {
    this.promptCacheReporter = fn;
  }

  getPermissionMode(): SessionPermissionMode | undefined {
    return this.permissionMode;
  }

  getModelMode(): SessionModelMode | undefined {
    return this.modelMode;
  }

  // Issue #2456: effort accessor/mutator (mirrors modelMode). Kept current by
  // syncSessionModes so getKeepAliveRuntime reports the live effort each tick.
  getEffort(): string | undefined {
    return this.effort;
  }

  setEffort(effort: string | undefined): void {
    this.effort = effort;
  }

  // Composer-chip pin integrity: raw-model accessor/mutator (mirrors effort).
  // Kept current by runClaude's syncSessionModes so every keepAlive tick
  // re-asserts the pin (or its absence) on the server's ephemeral record.
  getRawModel(): string | undefined {
    return this.rawModel;
  }

  setRawModel(rawModel: string | undefined): void {
    this.rawModel = rawModel;
  }

  // Issue #6166: an SDK query (one Claude process) is starting with this effort
  // on its argv. An earlier measurement described the previous process, so it
  // is dropped; this query's read-back reports against this launch effort.
  onQueryStart = (launch: { effort?: string }) => {
    const hadMeasurement = this.appliedEffort !== undefined;
    this.appliedEffort = undefined;
    this.appliedModel = undefined;
    this.appliedForEffort = isEffortLevel(launch.effort) ? launch.effort : null;
    if (hadMeasurement) {
      this.client.keepAlive(
        this.thinking,
        this.mode,
        this.getKeepAliveRuntime()
      );
    }
  };

  // Issue #6166: the SDK query ended, so its Claude process is gone and the
  // measurement no longer describes a running process.
  onQueryEnd = () => {
    const hadMeasurement = this.appliedEffort !== undefined;
    this.appliedEffort = undefined;
    this.appliedModel = undefined;
    this.appliedForEffort = undefined;
    if (hadMeasurement) {
      this.client.keepAlive(
        this.thinking,
        this.mode,
        this.getKeepAliveRuntime()
      );
    }
  };

  // Issue #6166: the effort the Claude process applies, read back via get_settings
  // (once per query start, and after a live model switch). Pushed on the
  // keepAlive so the web chip and the session summary show what the process
  // runs. Only a running query is measured: a read-back that arrives before its
  // query start or after its end describes no live process, so it is dropped.
  onAppliedEffort = (applied: {
    effort: EffortLevel | null;
    model?: string;
  }) => {
    if (this.appliedForEffort === undefined) return;
    if (
      applied.effort === this.appliedEffort &&
      applied.model === this.appliedModel
    ) {
      return;
    }
    this.appliedEffort = applied.effort;
    this.appliedModel = applied.model;
    this.client.keepAlive(this.thinking, this.mode, this.getKeepAliveRuntime());
    this.warnOnEffortMismatch();
  };

  // Issue #6166 (R7): compare like with like — what the LAUNCH effort becomes on
  // the applied model (a model without a level remaps it, e.g. xhigh → high on
  // Opus 4.6) against what Claude applies. The launch effort, not the current
  // request: a pick made since then reaches the process only on the next
  // message, so it is pending, not a mismatch. No launch effort, no warning.
  private warnOnEffortMismatch(): void {
    const launched = this.appliedForEffort;
    if (!isEffortLevel(launched) || this.appliedEffort === undefined) return;
    const expected = clampEffortToModel(
      launched,
      resolveModelEffortLevels(FALLBACK_CLAUDE_MODELS, "fallback", {
        rawModel: this.appliedModel,
      })
    );
    if (this.appliedEffort === expected) return;
    const key = `${launched}|${this.appliedEffort}|${this.appliedModel ?? ""}`;
    if (this.warnedEffortMismatches.has(key)) return;
    this.warnedEffortMismatches.add(key);
    logger.warn(
      `[effort] Claude runs ${this.appliedEffort ?? "no effort"} on ${
        this.appliedModel ?? "an unreported model"
      } but it was launched with --effort ${launched}: a CLAUDE_CODE_EFFORT_LEVEL value (process env or a settings.json env block) or the model's supported levels`
    );
  }

  /** Issue #6171: the server-name list last reported, so a session reports once. */
  private lastMcpCostsSignature: string | null = null;

  /**
   * Issue #6171: each MCP server's context cost, from the per-turn
   * get_context_usage reply, for the New Session picker. Reported once per
   * session, and again only when the server list changes (a toggle, a
   * relaunch). Fire-and-forget: a failed report only leaves the numbers older.
   * `hapi` is left out; every session has it.
   *
   * #6409 item 3: a row that covers more than one server (raw names sharing
   * the tool prefix before `__`) is left out too, because its cost is their
   * combined cost and belongs to neither; the catalog shows "—" for them. The
   * signature is built from raw names, so a server joining or leaving a key
   * re-reports, and it is stored before the empty check, so a list that skips
   * every row still counts as a change.
   */
  onMcpContextCosts = (servers: McpServerUsage[]): void => {
    const skipped = servers.filter(server => server.names.length > 1);
    const rows = servers
      .filter(server => server.names.length <= 1)
      .filter(
        server => normalizeMcpServerName(server.name) !== HAPI_MCP_SERVER_NAME
      );
    const signature = [
      rows
        .map(server => server.name)
        .sort()
        .join("\n"),
      skipped
        .flatMap(server => server.names)
        .sort()
        .join("\n"),
    ].join("\n--\n");
    if (signature === this.lastMcpCostsSignature) return;
    this.lastMcpCostsSignature = signature;
    if (rows.length === 0) return;
    const sampledAt = new Date().toISOString();
    void this.api
      .updateMcpCosts({
        context: rows.map(server => ({
          name: server.name,
          inContextTokens: mcpServerContextTokens(server),
          deferredTokens: server.deferredTokens,
          toolCount: server.loadedTools + server.deferredTools,
          sampledAt,
        })),
      })
      .catch(error => {
        // Report again next turn rather than lose the sample.
        this.lastMcpCostsSignature = null;
        logger.debug(
          `[${this.sessionLabel}] MCP context cost report failed:`,
          error
        );
      });
  };

  // Issue #1469: replaces onModelResolved. Receives the first-order per-turn
  // model name (bare) + context window + live usage from get_context_usage,
  // stores them, and pushes via keepAlive. No system.init snapshot involved.
  onContextUsage = (usage: {
    resolvedModel: string;
    contextWindowTokens: number;
    contextUsedTokens: number;
    contextPercentage: number;
  }) => {
    this.resolvedModel = usage.resolvedModel;
    this.contextWindowTokens = usage.contextWindowTokens;
    this.contextUsedTokens = usage.contextUsedTokens;
    this.contextPercentage = usage.contextPercentage;
    this.client.keepAlive(this.thinking, this.mode, this.getKeepAliveRuntime());
    logger.debug(
      "[" +
        this.sessionLabel +
        "] Issue #1469 context usage: model=" +
        usage.resolvedModel +
        " window=" +
        usage.contextWindowTokens +
        " used=" +
        usage.contextUsedTokens +
        " pct=" +
        usage.contextPercentage
    );
  };
}
