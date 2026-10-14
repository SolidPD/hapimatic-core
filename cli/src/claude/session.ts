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

type LocalLaunchFailure = {
  message: string;
  exitReason: LocalLaunchExitReason;
};

export class Session extends AgentSessionBase<EnhancedMode> {
  readonly claudeEnvVars?: Record<string, string>;
  claudeArgs?: string[];
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
    mcpServers: Record<string, any>;
    messageQueue: MessageQueue2<EnhancedMode>;
    onModeChange: (mode: "local" | "remote") => void;
    allowedTools?: string[];
    mode?: "local" | "remote";
    startedBy: "daemon" | "terminal";
    startingMode: "local" | "remote";
    hookSettingsPath: string;
    permissionMode?: PermissionMode;
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
    this.model = opts.model;
    this.mcpServers = opts.mcpServers;
    this.allowedTools = opts.allowedTools;
    this.hookSettingsPath = opts.hookSettingsPath;
    this.startedBy = opts.startedBy;
    this.startingMode = opts.startingMode;
    this.permissionMode = opts.permissionMode;
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
    | ((mode: PermissionMode) => Promise<{ method: "sdk" | "config" }>)
    | null = null;

  setPermissionModeApplier = (
    fn: ((mode: PermissionMode) => Promise<{ method: "sdk" | "config" }>) | null
  ): void => {
    this.permissionModeApplier = fn;
  };

  getPermissionModeApplier = ():
    | ((mode: PermissionMode) => Promise<{ method: "sdk" | "config" }>)
    | null => {
    return this.permissionModeApplier;
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
   * Consume one-time Claude flags from claudeArgs after Claude spawn
   * Currently handles: --resume (with or without session ID)
   */
  consumeOneTimeFlags = (): void => {
    if (!this.claudeArgs) return;

    const filteredArgs: string[] = [];
    for (let i = 0; i < this.claudeArgs.length; i++) {
      if (this.claudeArgs[i] === "--resume") {
        // Check if next arg looks like a UUID (contains dashes and alphanumeric)
        if (i + 1 < this.claudeArgs.length) {
          const nextArg = this.claudeArgs[i + 1];
          // Simple UUID pattern check - contains dashes and is not another flag
          if (!nextArg.startsWith("-") && nextArg.includes("-")) {
            // Skip both --resume and the UUID
            i++; // Skip the UUID
            logger.debug(
              `[Session] Consumed --resume flag with session ID: ${nextArg}`
            );
          } else {
            // Just --resume without UUID
            logger.debug("[Session] Consumed --resume flag (no session ID)");
          }
        } else {
          // --resume at the end of args
          logger.debug("[Session] Consumed --resume flag (no session ID)");
        }
      } else {
        filteredArgs.push(this.claudeArgs[i]);
      }
    }

    this.claudeArgs = filteredArgs.length > 0 ? filteredArgs : undefined;
    logger.debug(
      `[Session] Consumed one-time flags, remaining args:`,
      this.claudeArgs
    );
  };
}
