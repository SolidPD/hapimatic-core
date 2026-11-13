// SPDX-License-Identifier: MIT AND AGPL-3.0-only
import { ApiClient, ApiSessionClient } from "@/lib";
import { MessageQueue2 } from "@/utils/MessageQueue2";
import { logger } from "@/ui/logger";
import { AgentSessionBase } from "@/agent/sessionBase";
import type { TurnReporter } from "@/claude/utils/turnReporter";
import type { SessionModelMode } from "@/api/types";
import type { EnhancedMode } from "./loop";
import type { PermissionMode } from "./loop";
import type { LocalLaunchExitReason } from "@/agent/localLaunchPolicy";
// Issue #2256: type-only import for the live-query accessor (Task 5). query.ts
// does NOT import session.ts, and `import type` is erased at compile time, so
// this introduces no runtime cycle.
import type { Query } from "./sdk/query";
import { isResumeValue, stripOneTimeFlags } from "./utils/resumeArgs";

/**
 * What the in-place permission-mode applier reports (#2346). Issue #6617
 * (D4 g2-1) adds `permissionSwitch`: on the SDK launcher, whether the live
 * switch reached the running query within the wait (`applied`) or is still
 * waiting, for example behind an open permission card (`pending`). `ended`
 * (Matt 93a): it reached the query within the wait while the screen showed
 * another mode, so that query was ended.
 */
export type PermissionModeApplyResult = {
  method: "sdk" | "config";
  permissionSwitch?: "applied" | "pending" | "ended";
};

type LocalLaunchFailure = {
  message: string;
  exitReason: LocalLaunchExitReason;
};

export class Session extends AgentSessionBase<EnhancedMode> {
  readonly claudeEnvVars?: Record<string, string>;
  claudeArgs?: string[];
  /**
   * Issue #5348: the end-of-options marker and the ONE prompt argument after it
   * (`["--", "<prompt>"]`). Kept out of {@link claudeArgs}, which the launchers search
   * for a mode, a model, an effort and their own flags, so no prompt text sets a
   * posture. Only the local launcher delivers it, LAST, after every flag it adds, and
   * only at the first spawn: {@link consumeOneTimeFlags} clears it, so a same-process
   * relaunch does not send the prompt again. F2: a pass that returned before spawning
   * keeps it, and leaving local mode with it undelivered shows it once and drops it
   * ({@link takeUndeliveredPrompt}).
   */
  claudeTrailingArgs?: string[];
  // Issue #1608: the runClaude-resolved spawn model (e.g. "opus[1m]" for an
  // entitled-default session; "sonnet"/"opus"/undefined for user selections).
  // Read ONLY by the PTY/tmux launcher arg-derivation (resolveSpawnClaudeArgs)
  // as the entitled-pin discriminator — it survives the #1506 modelMode display
  // overload that syncSessionModes applies, which getModelMode() does not.
  model?: string;
  readonly mcpServers: Record<string, any>;
  readonly allowedTools?: string[];
  readonly hookSettingsPath: string;
  readonly startedBy: "daemon" | "terminal";
  readonly startingMode: "local" | "remote";
  /**
   * Issue #6400 P1: the session's starting mode came from a
   * terminal `--permission-mode`, which is no longer forwarded in `claudeArgs`,
   * so the local launcher passes the live mode to its claude child.
   */
  readonly permissionModeFromFlag: boolean;
  localLaunchFailure: LocalLaunchFailure | null = null;
  /**
   * Issue #1664 (epic #1662, Sub B): the per-turn telemetry reporter for this
   * session. Attached once by `runClaude`'s `onSessionReady`, then shared by the
   * hook-server turn callbacks (open/finalize) and the launcher interrupt sites
   * (interrupt-finalize) — both reach the SAME Session instance. Optional so the
   * codex/gemini sessions (which don't drive Claude turn hooks) leave it unset.
   */
  turnReporter?: TurnReporter;

  constructor(opts: {
    api: ApiClient;
    client: ApiSessionClient;
    path: string;
    logPath: string;
    sessionId: string | null;
    claudeEnvVars?: Record<string, string>;
    claudeArgs?: string[];
    claudeTrailingArgs?: string[];
    mcpServers: Record<string, any>;
    messageQueue: MessageQueue2<EnhancedMode>;
    onModeChange: (mode: "local" | "remote") => void;
    allowedTools?: string[];
    mode?: "local" | "remote";
    startedBy: "daemon" | "terminal";
    startingMode: "local" | "remote";
    hookSettingsPath: string;
    permissionMode?: PermissionMode;
    /** Issue #6400 P1: see {@link Session.permissionModeFromFlag}. */
    permissionModeFromFlag: boolean;
    modelMode?: SessionModelMode;
    model?: string;
    effort?: string;
  }) {
    super({
      api: opts.api,
      client: opts.client,
      path: opts.path,
      logPath: opts.logPath,
      sessionId: opts.sessionId,
      messageQueue: opts.messageQueue,
      onModeChange: opts.onModeChange,
      mode: opts.mode,
      sessionLabel: "Session",
      sessionIdLabel: "Claude Code",
      applySessionIdToMetadata: (metadata, sessionId) => ({
        ...metadata,
        claudeSessionId: sessionId,
      }),
      permissionMode: opts.permissionMode,
      modelMode: opts.modelMode,
      // Issue #2456: effort lives on AgentSessionBase (mirrors modelMode) so it
      // rides the keepAlive runtime; the subclass just forwards the ctor opt.
      effort: opts.effort,
    });

    this.claudeEnvVars = opts.claudeEnvVars;
    this.claudeArgs = opts.claudeArgs;
    this.claudeTrailingArgs = opts.claudeTrailingArgs;
    this.model = opts.model;
    this.mcpServers = opts.mcpServers;
    this.allowedTools = opts.allowedTools;
    this.hookSettingsPath = opts.hookSettingsPath;
    this.startedBy = opts.startedBy;
    this.startingMode = opts.startingMode;
    this.permissionMode = opts.permissionMode;
    this.permissionModeFromFlag = opts.permissionModeFromFlag;
    this.modelMode = opts.modelMode;
  }

  setPermissionMode = (mode: PermissionMode): void => {
    this.permissionMode = mode;
  };

  setModelMode = (mode: SessionModelMode): void => {
    this.modelMode = mode;
  };

  // Issue #1608: setter/getter for the runClaude-resolved spawn model. Kept in
  // sync by syncSessionModes() (startup + every set-session-config) so the
  // launcher's entitled-pin discriminator reflects the CURRENT effective model.
  setModel = (model: string | undefined): void => {
    this.model = model;
  };

  getModel(): string | undefined {
    return this.model;
  }

  // Issue #2256: the SDK remote launcher publishes an accessor to its live
  // Query here (on launch; cleared in cleanup) so runClaude's "set-model" RPC
  // handler can reach the live query out-of-band for the set_model lever.
  // Non-sdk launchers / pre-launch / post-teardown never publish → the handler
  // reads null and degrades to method:"config". Session-carried callback idiom
  // (cf. onModeChange). Distinct from Session.setModel (the display-state
  // setter above): this carries a getter for the SDK Query, not a model string.
  private liveQueryAccessor: (() => Query | null) | null = null;

  setLiveQueryAccessor = (fn: (() => Query | null) | null): void => {
    this.liveQueryAccessor = fn;
  };

  getLiveQuery = (): Query | null => {
    return this.liveQueryAccessor ? this.liveQueryAccessor() : null;
  };

  // Issue #6617 (D4 g2-1): the SDK launcher publishes a way to end the query
  // the permission-mode applier stops (a failed live switch; a switch that
  // landed on a moved screen, Matt 93a; a recorded mode under a wider child,
  // round 4), beside the accessor above and cleared in its cleanup. Ending it
  // stops the running turn without ending the launcher, so the next message
  // starts a new query in the live mode.
  private liveQueryTerminator: ((query: Query) => void) | null = null;

  setLiveQueryTerminator = (fn: ((query: Query) => void) | null): void => {
    this.liveQueryTerminator = fn;
  };

  endLiveQuery = (query: Query): void => {
    this.liveQueryTerminator?.(query);
  };

  // Issue #6617 round 4 (the board-26 PM's option 2): the mode each live
  // query's child is in, noted by the SDK launcher at the query's start and by
  // the applier when a live switch lands. A write that switches nothing (a
  // card answer's mode) compares it with the shown mode. Keyed by query, so a
  // late landing on an old query never stands for a newer one.
  private liveChildModes = new WeakMap<Query, PermissionMode>();

  noteLiveChildMode = (query: Query, mode: PermissionMode): void => {
    this.liveChildModes.set(query, mode);
  };

  getLiveChildMode = (query: Query): PermissionMode | undefined => {
    return this.liveChildModes.get(query);
  };

  // Issue #2346: runClaude publishes its in-place permission-mode applier here
  // (on launch) so the launcher-registered "set-permission-mode" RPC handler can
  // reach it without threading a callback through the loop→launcher plumbing. The
  // applier does the full R3 resync (currentPermissionMode + durable pin +
  // syncSessionModes) AND fires Query.setPermissionMode on the live query via the
  // live-query accessor above, returning the method actually used. This is the
  // MIRROR of setLiveQueryAccessor (#2256), opposite direction: the launcher
  // publishes the query getter; runClaude publishes the applier. Both callers of
  // the applier — this bridge (new RPC) and the set-session-config permissionMode
  // branch — share ONE closure (issue #2346 ruling D2, Task 5).
  private permissionModeApplier:
    | ((mode: PermissionMode) => Promise<PermissionModeApplyResult>)
    | null = null;

  setPermissionModeApplier = (
    fn: ((mode: PermissionMode) => Promise<PermissionModeApplyResult>) | null
  ): void => {
    this.permissionModeApplier = fn;
  };

  getPermissionModeApplier = ():
    | ((mode: PermissionMode) => Promise<PermissionModeApplyResult>)
    | null => {
    return this.permissionModeApplier;
  };

  // Issue #6617 (D4 g3-1): runClaude also publishes a RECORD-ONLY function: it
  // records a mode chosen on a permission card or a plan approval where every
  // later decision reads it (runClaude's own copy, the saved
  // `metadata.permissionMode`, this session) and sends nothing to the live
  // child. A card answer must never call the full applier above: the SDK reader
  // handles a permission request inline, so a live switch sent from inside the
  // answer would wait for a reply it cannot read until the answer returns.
  private permissionModeRecorder: ((mode: PermissionMode) => void) | null =
    null;

  setPermissionModeRecorder = (
    fn: ((mode: PermissionMode) => void) | null
  ): void => {
    this.permissionModeRecorder = fn;
  };

  getPermissionModeRecorder = (): ((mode: PermissionMode) => void) | null => {
    return this.permissionModeRecorder;
  };

  // Issue #6617 (D3-1, refined): true once the mode has been set from the UI or
  // an approval card (the recorder sets it). The local launcher then hands a
  // terminal session's child the shown mode, `default` included; an untouched
  // session keeps the user's own `permissions.defaultMode`.
  permissionModeSetHere = false;

  markPermissionModeSetHere = (): void => {
    this.permissionModeSetHere = true;
  };

  recordLocalLaunchFailure = (
    message: string,
    exitReason: LocalLaunchExitReason
  ): void => {
    this.localLaunchFailure = { message, exitReason };
  };

  /**
   * Multi-account (epic #1446, Sub-Issue D): the account this session is bound
   * to, read from the per-process HAPI_ACCOUNT_UUID env var (KD-3). `undefined`
   * selects the host-credential fallback (R2/R6).
   */
  get accountUuid(): string | undefined {
    return process.env.HAPI_ACCOUNT_UUID || undefined;
  }

  /**
   * Clear the current session ID (used by /clear command)
   */
  clearSessionId = (): void => {
    this.sessionId = null;
    logger.debug("[Session] Session ID cleared");
  };

  /**
   * Consume one-time Claude flags from claudeArgs after Claude spawn:
   * `--resume [<id>]` and, since #6088, `--fork-session` (a retained
   * `--fork-session` made each same-process relaunch of a branched session fork
   * again).
   */
  consumeOneTimeFlags = (opts: { promptDelivered?: boolean } = {}): void => {
    // Issue #5348: BEFORE the guard below. `hapi -- "review"` starts with no
    // claudeArgs at all, so a clear placed after it would never run and every
    // relaunch would send the prompt again. F2: the local launcher passes
    // `promptDelivered: false` when it returned before spawning Claude (the abort
    // was already set), so the text is kept for the next start or for
    // takeUndeliveredPrompt.
    if (this.claudeTrailingArgs && opts.promptDelivered !== false) {
      logger.debug("[Session] Consumed the prompt after the -- marker");
      this.claudeTrailingArgs = undefined;
    }
    if (!this.claudeArgs) return;

    const before = this.claudeArgs;
    const resumeAt = before.indexOf("--resume");
    if (resumeAt >= 0) {
      const value = before[resumeAt + 1];
      logger.debug(
        isResumeValue(value)
          ? `[Session] Consumed --resume flag with session ID: ${value}`
          : "[Session] Consumed --resume flag (no session ID)"
      );
    }
    if (before.includes("--fork-session")) {
      logger.debug("[Session] Consumed --fork-session flag (issue #6088)");
    }

    this.claudeArgs = stripOneTimeFlags(before);
    logger.debug(
      `[Session] Consumed one-time flags, remaining args:`,
      this.claudeArgs
    );
  };

  /**
   * Issue #5348 F2: the prompt after the -- marker that no Claude was started with,
   * removed so it is never replayed at a later local start; undefined when none is left.
   */
  takeUndeliveredPrompt = (): string | undefined => {
    const trailing = this.claudeTrailingArgs;
    this.claudeTrailingArgs = undefined;
    return trailing?.[trailing.length - 1];
  };
}
