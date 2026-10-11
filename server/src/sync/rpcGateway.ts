// SPDX-License-Identifier: AGPL-3.0-only
import type {
  McpToggleResponse,
  SetModelResponse,
  SetPermissionModeResponse,
  EffortLevel,
  ModelMode,
  PermissionMode,
} from "@hapi/protocol/types";
import type { Server } from "socket.io";
import type { RpcRegistry } from "../socket/rpcRegistry";
import type { CapabilityMeta } from "../socket/handlers/cli/rpcHandlers";
import type { SpawnSessionOptions } from "./syncEngine";
import type { ErrorLogger } from "../logging/errorLogger";
// Issue #3632: value import (not `import type`) — this predicate is CALLED at
// spawn time to stamp the owning server's message-hook stage into the RPC.
import { messageHooksEnabled } from "./messageHooks";

/** Default ack timeout for daemon RPC calls (cleanup, list-directory, etc.). */
const DEFAULT_RPC_TIMEOUT_MS = 30_000;
/**
 * Spawn-specific ack timeout. The daemon blocks its spawn-RPC ack on the new
 * session's "I'm alive" webhook, which has a 60s budget (run.ts) because a cold
 * Claude session on a Pi 5 can take >30s to boot. Give the spawn RPC headroom
 * above that 60s budget (+ the daemon's child-detect window) so the server
 * never pre-empts a slow-but-valid spawn with "operation has timed out".
 */
const SPAWN_RPC_TIMEOUT_MS = 75_000;

/**
 * Issue #2301 (Task 2): bounded-retry tuning for {@link spawnWithRetry}. The
 * transient-RPC regime mirrors updateSessionAccount's fixed-attempt loop shape
 * (sessionCache.ts, MAX_ATTEMPTS=5); the capacity poll interval mirrors #2299's
 * waitForCapacityBeforeKill (~2.5-4s + jitter) so N waiters at saturation never
 * hammer the daemon capacity probe / spawn gate at sub-second backoff.
 */
const SPAWN_TRANSIENT_MAX_ATTEMPTS = 5;
const SPAWN_TRANSIENT_BASE_BACKOFF_MS = 500;
const SPAWN_TRANSIENT_MAX_BACKOFF_MS = 8_000;
const CAPACITY_POLL_MIN_MS = 2_500;
const CAPACITY_POLL_JITTER_MS = 1_500;
/**
 * Issue #2301 (Task 3 / KD-3): the SHORT post-kill capacity tail for switchAccount.
 * The PRIMARY capacity wait is #2299's PRE-kill waitForCapacityBeforeKill (session
 * still RUNNING). switchAccount's post-kill respawn only needs to absorb the residual
 * slot-steal race, so its capacity budget is a couple of polls — NOT the full 30-60s
 * deadline, because a long post-kill wait would widen the disconnected window (R6).
 */
export const CAPACITY_TAIL_DEADLINE_MS = 10_000;

export type RpcCommandResponse = {
  success: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  error?: string;
};

export type RpcReadFileResponse = {
  success: boolean;
  content?: string;
  hash?: string;
  size?: number;
  tooLarge?: boolean;
  error?: string;
};

export type RpcWriteFileResponse = {
  success: boolean;
  hash?: string;
  conflict?: boolean;
  error?: string;
};

// issue #2715: the V2 mutating file ops (create-folder / rename / delete) all
// return a plain success/error envelope from the CLI handler.
export type RpcMutationResponse = {
  success: boolean;
  error?: string;
};

export type RpcPathExistsResponse = {
  exists: Record<string, boolean>;
};

export type DirectoryEntry = {
  name: string;
  type: "file" | "directory" | "other";
  size?: number;
  modified?: number;
};

export type ListDirectoryResponse = {
  success: boolean;
  entries?: DirectoryEntry[];
  error?: string;
};

// issue #3498: machine-level create-directory response (the daemon returns the
// created entry, or `success:false` + a raw error message the machine route maps
// to 403/409).
export type CreateDirectoryResponse = {
  success: boolean;
  entry?: DirectoryEntry;
  error?: string;
};

/**
 * Typed return for `cleanupTmuxSession` (issue #1349).
 *
 * The previous return shape `{success, message?}` lost the distinction between
 * "daemon definitely offline" and "RPC reached daemon but failed". Callers in
 * `syncEngine.deleteSession` and `deleteSessions` now branch on `success` and
 * use `errorKind` to log the failure mode loudly enough that orphan
 * accumulation is detectable in production logs. `originalError` preserves the
 * raw exception message for diagnostic context.
 *
 * Backward-compatible: every new field is optional and additive. Tests that
 * mock `cleanupTmuxSession` returning `{message: "spy"}` continue to pass.
 */
export type CleanupTmuxResponse = {
  success: boolean;
  message?: string;
  errorKind?: "daemon_offline" | "rpc_failed";
  originalError?: string;
};

/**
 * Typed return for `reapRemoteWindow` (issue #1603). Mirrors CleanupTmuxResponse
 * but adds `reaped` — the count of `hapimatic-remote` launcher windows reaped by
 * the daemon's `reapRemoteLauncherWindows` (#1600). Consumed by archiveSession's
 * terminal-archive reap path.
 */
export type ReapRemoteWindowResponse = {
  success: boolean;
  reaped?: number;
  message?: string;
  errorKind?: "daemon_offline" | "rpc_failed";
  originalError?: string;
};

export class RpcGateway {
  constructor(
    private readonly io: Server,
    private readonly rpcRegistry: RpcRegistry,
    private readonly errorLogger?: ErrorLogger | null
  ) {}

  async approvePermission(
    sessionId: string,
    requestId: string,
    mode?: PermissionMode,
    allowTools?: string[],
    decision?: "approved" | "approved_for_session" | "denied" | "abort",
    answers?: Record<string, string[]>
  ): Promise<void> {
    await this.sessionRpc(sessionId, "permission", {
      id: requestId,
      approved: true,
      mode,
      allowTools,
      decision,
      answers,
    });
  }

  async denyPermission(
    sessionId: string,
    requestId: string,
    decision?: "approved" | "approved_for_session" | "denied" | "abort"
  ): Promise<void> {
    await this.sessionRpc(sessionId, "permission", {
      id: requestId,
      approved: false,
      decision,
    });
  }

  async abortSession(sessionId: string): Promise<void> {
    await this.sessionRpc(sessionId, "abort", {
      reason: "User aborted",
    });
  }

  async switchSession(
    sessionId: string,
    to: "remote" | "local"
  ): Promise<void> {
    await this.sessionRpc(sessionId, "switch", { to });
  }

  async mcpToggle(
    sessionId: string,
    serverName: string,
    enabled: boolean
  ): Promise<McpToggleResponse> {
    return (await this.sessionRpc(sessionId, "mcp-toggle", {
      serverName,
      enabled,
    })) as McpToggleResponse;
  }

  // Issue #2256: set the session model via the landed #2421 runClaude
  // "set-model" RPC handler. The payload field is `modelMode` (enumerated
  // explicitly, never spread — the #1262 trap) — a `{model}` payload would hit
  // the handler's "set-model requires a modelMode" throw.
  async setModel(
    sessionId: string,
    modelMode: string
  ): Promise<SetModelResponse> {
    return (await this.sessionRpc(sessionId, "set-model", {
      modelMode,
    })) as SetModelResponse;
  }

  // Issue #2346: set the session permission mode via the launcher-registered
  // "set-permission-mode" RPC. Mirrors mcpToggle (NOT set-model): it keeps the
  // local_mode_not_supported / no_active_query taxonomy because the handler is
  // launcher-registered per-flavor. Payload field is `mode` (enumerated, never
  // spread — the #1262 trap).
  async setPermissionMode(
    sessionId: string,
    mode: string
  ): Promise<SetPermissionModeResponse> {
    return (await this.sessionRpc(sessionId, "set-permission-mode", {
      mode,
    })) as SetPermissionModeResponse;
  }

  async requestSessionConfig(
    sessionId: string,
    config: {
      permissionMode?: PermissionMode;
      modelMode?: ModelMode;
      effort?: EffortLevel;
      rawModel?: string;
    }
  ): Promise<unknown> {
    return await this.sessionRpc(sessionId, "set-session-config", config);
  }

  async killSession(sessionId: string): Promise<void> {
    await this.sessionRpc(sessionId, "killSession", {});
  }

  async spawnSession(opts: SpawnSessionOptions): Promise<
    | { type: "success"; sessionId: string }
    // Issue #1772: carry the daemon's error `code` (e.g. "at_capacity") back to
    // syncEngine.spawnSession, whose return type already declares `code?`.
    | { type: "error"; message: string; code?: string }
  > {
    try {
      const result = await this.machineRpc(
        opts.machineId,
        "spawn-happy-session",
        {
          type: "spawn-in-directory",
          directory: opts.directory,
          agent: opts.agent ?? "claude",
          yolo: opts.yolo,
          // Issue #1262: forward `claimPort` through the RPC payload. This
          // payload is constructed field-by-field (not via spread), so any
          // field NOT enumerated here is silently dropped on the wire —
          // which is exactly how the original 1262 worker rollout shipped a
          // broken propagation chain. Tester verified the regression by
          // observing `claimed_port: null` on a `claimPort: true` spawn.
          claimPort: opts.claimPort,
          sessionType: opts.sessionType,
          worktreeName: opts.worktreeName,
          // hapimatic-private#4481: existing-branch worktree (#1262 trap).
          existingBranch: opts.existingBranch,
          resumeSessionId: opts.resumeSessionId,
          hapiSessionId: opts.hapiSessionId,
          name: opts.name,
          forkSession: opts.forkSession,
          parentSessionId: opts.parentSessionId,
          parentRelationship: opts.parentRelationship,
          originatingNodeId: opts.originatingNodeId,
          // Issue #1456: account binding — field-by-field enumeration (#1262
          // trap) so it is NOT silently dropped on the wire to the daemon.
          accountUuid: opts.accountUuid,
          // Issue #4568: the API-key binding + its spawn-time mask — field-by-field
          // (#1262 trap): an un-listed field is dropped on the wire, and the daemon
          // would spawn the session on the node-default subscription instead.
          apiKeyId: opts.apiKeyId,
          apiKeyMasked: opts.apiKeyMasked,
          scheduleId: opts.scheduleId,
          claudePath: opts.claudePath,
          // Issue #1633: field-by-field enumeration (#1262 trap) — un-listed
          // fields are silently dropped on the wire to the daemon.
          safeMode: opts.safeMode,
          // Issue #1660: field-by-field enumeration (#1262 trap) — forward the
          // per-session launcher so the daemon can inject HAPI_CLAUDE_LAUNCHER.
          launcher: opts.launcher,
          modelMode: opts.modelMode,
          // Issue #2456: forward the reasoning-effort level + specific pinned raw
          // model (#1262 trap — un-listed fields are silently dropped on the wire,
          // so the daemon never appends --hapi-effort / --hapi-raw-model). Guarded
          // by syncEngine.spawnEffort.test.ts.
          effort: opts.effort,
          rawModel: opts.rawModel,
          // Issue #1733: forward the OpenRouter model (#1262 trap — un-listed
          // fields are silently dropped on the wire to the daemon).
          model: opts.model,
          // Issue #3349 (D4(a)): forward the native-vs-OpenRouter routing
          // discriminator (#1262 trap — un-listed here, the daemon never sees a
          // native opencode selection and misroutes it to the OpenRouter branch).
          modelRouting: opts.modelRouting,
          // Issue #1953 (A6): forward the clone-on-spawn repo (#1262 trap — an
          // un-listed field is silently dropped, so the daemon never clones).
          cloneRepo: opts.cloneRepo,
          // Issue #2155: forward the role-scoped profile (#1262 trap — an
          // un-listed field is silently dropped, so the daemon never scopes the
          // stack and the session loads the full stack). Guarded by
          // syncEngine.spawnRole.test.ts.
          sessionRole: opts.sessionRole,
          // Issue #2626: forward the per-session output style (#1262 trap — an
          // un-listed field is silently dropped, so the daemon never appends
          // --hapi-output-style and the style never reaches the --settings file).
          // Guarded by syncEngine.spawnOutputStyle.test.ts.
          outputStyle: opts.outputStyle,
          // Issue #3348: forward the bundled non-claude native model selection
          // (#1262 trap — an un-listed field is silently dropped, so the daemon
          // would never set GEMINI_MODEL / bake the codex config.toml model).
          nativeModelSelection: opts.nativeModelSelection,
          // Issue #3632: stamp the OWNING SERVER's message-hook stage flag into
          // the spawn RPC. Read FRESH here via messageHooksEnabled() — NOT from
          // `opts` — because the daemon runs as a separate systemd unit whose env
          // lacks HAPI_MESSAGE_HOOKS (a daemon-side read would be false on prod
          // while the server gate is ON). The daemon converts this boolean to the
          // literal child-env marker HAPI_MESSAGE_HOOKS=1|0; when this field is
          // absent on the wire (daemon-local spawn, or an old server) the daemon
          // OMITS the marker → the rp1-home client DEFERS (fail-closed, safe).
          // Guarded by syncEngine.spawnMessageHooks.test.ts (the #1262 trap).
          messageHooksEnabled: messageHooksEnabled(),
          // Issue #1555: forward the await-webhook gate through this first
          // field-by-field RPC hop (the #1262 trap — un-enumerated fields are
          // silently dropped on the wire). false → daemon returns once the
          // respawn child starts, not after the full cold-MCP boot.
          awaitWebhook: opts.awaitWebhook,
          // Issue #1661: forward the reconnect kill-vs-reattach intent through
          // this first field-by-field RPC hop (the #1262 trap). Omitting it would
          // silently drop the false value → the daemon's reused-window path would
          // always respawn-kill, defeating the re-attach guard.
          killLivePane: opts.killLivePane,
          // Issue #3611: forward the resolved optimal-account opt-in (set on `opts`
          // by syncEngine.spawnSession from the server preference mirror) through
          // this first field-by-field RPC hop (the #1262 trap — un-enumerated
          // fields are silently dropped, so the daemon would never run the
          // un-pinned optimal-pick). undefined/false ⇒ NO pick (#3023 unchanged, R3).
          autoSelectOptimalAccount: opts.autoSelectOptimalAccount,
        },
        SPAWN_RPC_TIMEOUT_MS
      );
      if (result && typeof result === "object") {
        const obj = result as Record<string, unknown>;
        if (obj.type === "success" && typeof obj.sessionId === "string") {
          return {
            type: "success",
            sessionId: obj.sessionId,
            ...(typeof obj.resolvedName === "string"
              ? { resolvedName: obj.resolvedName }
              : {}),
          };
        }
        if (obj.type === "error" && typeof obj.errorMessage === "string") {
          // Issue #1772: propagate the daemon's error `code` (e.g. "at_capacity")
          // so syncEngine + the route can classify without string-matching.
          return {
            type: "error",
            message: obj.errorMessage,
            ...(typeof obj.code === "string" ? { code: obj.code } : {}),
          };
        }
        // Handle legacy/framework error shape: { error: "..." } without type field
        if (typeof obj.error === "string") {
          return { type: "error", message: obj.error };
        }
        // Handle directory creation approval request (not applicable for heartbeat,
        // but prevents silent failure for other callers)
        if (obj.type === "requestToApproveDirectoryCreation") {
          return {
            type: "error",
            message: `Directory creation requires approval: ${obj.directory ?? "unknown"}`,
          };
        }
      }
      // Include actual response for diagnostics
      return {
        type: "error",
        message: `Unexpected spawn result: ${JSON.stringify(result)}`,
      };
    } catch (error) {
      this.errorLogger?.warn("[RpcGateway] spawnSession failed", {
        category: "rpc-spawn-session",
        stack: error instanceof Error ? error.stack : null,
      });
      return {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Query the daemon's persisted session store for a session's claudeSessionId.
   * Used by reconnectSession() to recover missing claudeSessionId from the
   * daemon's sessions-state.json when the server metadata doesn't have it.
   */
  async getSessionClaudeId(
    machineId: string,
    hapiSessionId: string
  ): Promise<string | null> {
    try {
      const result = await this.machineRpc(machineId, "get-session-claude-id", {
        hapiSessionId,
      });
      if (result && typeof result === "object") {
        const obj = result as Record<string, unknown>;
        if (typeof obj.claudeSessionId === "string") {
          return obj.claudeSessionId;
        }
      }
      return null;
    } catch (error) {
      if (this.errorLogger) {
        this.errorLogger.warn(
          "[RpcGateway] Failed to query daemon for claudeSessionId",
          {
            category: "rpc-claude-session-id",
            stack: error instanceof Error ? error.stack : null,
          }
        );
      } else {
        console.log(
          `[RpcGateway] Failed to query daemon for claudeSessionId: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      return null;
    }
  }

  /**
   * Issue #1396: Validate that Claude Code's conversation store contains a
   * JSONL file for the given session ID at the given cwd. Used by
   * reconnectSession() to pre-check `claudeSessionId` before invoking
   * `--resume <id>` — preventing the "No conversation found with session ID"
   * crash class when the stored ID is stale-but-present.
   *
   * Return semantics (THREE values — mirrors null-tolerance from #494):
   *   - `true`  : conversation file exists; caller proceeds with --resume unchanged
   *   - `false` : conversation file is absent; caller MUST clear claudeSessionId
   *               so the existing spawn-fresh fall-through fires
   *   - `null`  : validation is UNCERTAIN (RPC error, daemon offline, malformed
   *               response). Caller MUST NOT block recovery — proceed with
   *               --resume unchanged, same as today. This matches the #370/#494
   *               principle: when state is uncertain, prefer "try to resume"
   *               over "fail hard".
   */
  async hasClaudeConversation(
    machineId: string,
    cwd: string,
    claudeSessionId: string
  ): Promise<boolean | null> {
    try {
      const result = await this.machineRpc(
        machineId,
        "has-claude-conversation",
        { cwd, claudeSessionId }
      );
      if (result && typeof result === "object") {
        const obj = result as Record<string, unknown>;
        if (typeof obj.exists === "boolean") {
          return obj.exists;
        }
      }
      return null;
    } catch (error) {
      if (this.errorLogger) {
        this.errorLogger.warn(
          "[RpcGateway] Failed to query daemon for hasClaudeConversation",
          {
            category: "rpc-has-claude-conversation",
            stack: error instanceof Error ? error.stack : null,
          }
        );
      } else {
        console.log(
          `[RpcGateway] Failed to query daemon for hasClaudeConversation: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      return null;
    }
  }

  /**
   * Issue #3839 (D28): ask the daemon to restore a soft-deleted worktree from
   * `.worktrees/.trash/` to its ORIGINAL recorded path, so an orphaned
   * transcript can be resumed where it ran. The daemon selects the trash entry
   * by its recorded `originalPath` and refuses an existing destination
   * (`recoverWorktreeForOriginalPath`, cli/src/api/apiMachine.ts). An RPC
   * failure (daemon offline, old binary without the handler) returns
   * `rpc_failed` so the caller can fall through to the directory picker.
   */
  async recoverWorktree(
    machineId: string,
    originalPath: string
  ): Promise<RecoverWorktreeRpcResult> {
    try {
      const result = await this.machineRpc(machineId, "recover-worktree", {
        originalPath,
      });
      if (result && typeof result === "object") {
        const obj = result as Record<string, unknown>;
        if (obj.ok === true && typeof obj.worktreePath === "string") {
          return {
            ok: true,
            worktreePath: obj.worktreePath,
            branch: typeof obj.branch === "string" ? obj.branch : "",
          };
        }
        if (obj.ok === false) {
          return {
            ok: false,
            code: typeof obj.code === "string" ? obj.code : "recover_failed",
            error: typeof obj.error === "string" ? obj.error : "recover failed",
          };
        }
      }
      return { ok: false, code: "rpc_failed", error: "malformed RPC response" };
    } catch (error) {
      return {
        ok: false,
        code: "rpc_failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Issue #1661: ask the daemon whether a tmux-launcher session's launcher
   * wrapper AND tmux pane are actually alive. Used by reconnectSession's
   * re-attach gate and the 5-min force-kill watchdog to avoid respawn-killing
   * (SIGTERM 143) a live, busy Claude that was only falsely flagged inactive by
   * the server's 10s `expireInactive` trip-wire. The daemon holds the
   * authoritative signal (`pidToTrackedSession` + `tmux.isPaneDead`); the
   * server's `active` flag is exactly the unreliable signal that caused the bug.
   *
   * Three-valued (mirrors hasClaudeConversation's #1396 null-tolerance):
   *   - `true`  — wrapper tracked AND pane not dead → re-attach; do NOT respawn.
   *   - `false` — untracked OR pane dead → caller may respawn (the bash-occupied
   *               pane must be forcibly respawned, since `; exec bash` keeps the
   *               pane non-dead after Claude exits).
   *   - `null`  — UNCERTAIN (RPC error, daemon offline, malformed/absent
   *               response). Caller MUST NOT block recovery; it falls through to
   *               respawn with a fresh daemon-local re-check (Fallback
   *               Preservation Rule — same #370/#494/#1396 reasoning).
   */
  async isSessionAlive(
    machineId: string,
    sessionTag: string
  ): Promise<boolean | null> {
    try {
      const result = await this.machineRpc(machineId, "is-session-alive", {
        sessionTag,
      });
      if (result && typeof result === "object") {
        const obj = result as Record<string, unknown>;
        if (typeof obj.alive === "boolean") {
          return obj.alive;
        }
        // Explicit null from the daemon (uncertain) — preserve as null.
      }
      return null;
    } catch (error) {
      if (this.errorLogger) {
        this.errorLogger.warn(
          "[RpcGateway] Failed to query daemon for isSessionAlive",
          {
            category: "rpc-is-session-alive",
            stack: error instanceof Error ? error.stack : null,
          }
        );
      } else {
        console.log(
          `[RpcGateway] Failed to query daemon for isSessionAlive: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      return null;
    }
  }

  /**
   * Issue #2299 (Task 3): read-only capacity probe for switchAccount's pre-kill
   * pre-check. Asks the owning daemon whether a reused-window respawn of
   * `creditHapiSessionId` would be admitted RIGHT NOW, WITHOUT spawning or
   * killing. Uses the same credited `computeEffectiveCount` the spawn gate uses,
   * so the pre-check and the eventual respawn gate agree.
   *
   * Return semantics (null-tolerant — Fallback Preservation Rule, mirrors
   * isSessionAlive): a shaped `{ effectiveCount, maxConcurrent, wouldAdmit }` on
   * success, or `null` on ANY fault (RPC error, daemon offline, malformed
   * response). The caller MUST treat `null` as "uncertain — do NOT block the
   * switch", so an unreachable daemon never strands a live session behind an
   * unverifiable `at_capacity`; it falls through to the existing kill+respawn
   * (which itself now benefits from the daemon-side own-slot credit).
   */
  async probeCapacity(
    machineId: string,
    creditHapiSessionId?: string
  ): Promise<{
    effectiveCount: number;
    maxConcurrent: number;
    wouldAdmit: boolean;
  } | null> {
    try {
      const result = await this.machineRpc(machineId, "capacity-probe", {
        creditHapiSessionId,
      });
      if (result && typeof result === "object") {
        const obj = result as Record<string, unknown>;
        if (
          typeof obj.effectiveCount === "number" &&
          typeof obj.maxConcurrent === "number" &&
          typeof obj.wouldAdmit === "boolean"
        ) {
          return {
            effectiveCount: obj.effectiveCount,
            maxConcurrent: obj.maxConcurrent,
            wouldAdmit: obj.wouldAdmit,
          };
        }
      }
      return null;
    } catch (error) {
      if (this.errorLogger) {
        this.errorLogger.warn(
          "[RpcGateway] Failed to query daemon for capacity probe",
          {
            category: "rpc-capacity-probe",
            stack: error instanceof Error ? error.stack : null,
          }
        );
      } else {
        console.log(
          `[RpcGateway] Failed to query daemon for capacity probe: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      return null;
    }
  }

  async checkPathsExist(
    machineId: string,
    paths: string[]
  ): Promise<Record<string, boolean>> {
    const result = (await this.machineRpc(machineId, "path-exists", {
      paths,
    })) as RpcPathExistsResponse | unknown;
    if (!result || typeof result !== "object") {
      throw new Error("Unexpected path-exists result");
    }

    const existsValue = (result as RpcPathExistsResponse).exists;
    if (!existsValue || typeof existsValue !== "object") {
      throw new Error("Unexpected path-exists result");
    }

    const exists: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(existsValue)) {
      exists[key] = value === true;
    }
    return exists;
  }

  async listDirectory(
    machineId: string,
    path: string
  ): Promise<DirectoryEntry[]> {
    // Uses the unrestricted 'list-directory' handler registered in ApiMachineClient
    // This allows browsing any directory on the filesystem (not limited to session working directory)
    const result = (await this.machineRpc(machineId, "list-directory", {
      path,
    })) as ListDirectoryResponse | unknown;
    if (!result || typeof result !== "object") {
      throw new Error("Unexpected list-directory result");
    }

    const response = result as ListDirectoryResponse;
    if (!response.success) {
      throw new Error(response.error ?? "Failed to list directory");
    }

    return response.entries ?? [];
  }

  // issue #3498: create a directory on the machine via the machine-scoped
  // 'create-directory' handler in ApiMachineClient. Mirrors listDirectory above
  // (the daemon runs the authoritative create-target UNION guard + realpath).
  async createDirectory(
    machineId: string,
    path: string,
    recursive: boolean
  ): Promise<DirectoryEntry> {
    const result = (await this.machineRpc(machineId, "create-directory", {
      path,
      recursive,
    })) as CreateDirectoryResponse | unknown;
    if (!result || typeof result !== "object") {
      throw new Error("Unexpected create-directory result");
    }

    const response = result as CreateDirectoryResponse;
    if (!response.success || !response.entry) {
      throw new Error(response.error ?? "Failed to create directory");
    }

    return response.entry;
  }

  async getGitStatus(
    sessionId: string,
    cwd?: string
  ): Promise<RpcCommandResponse> {
    return (await this.sessionRpc(sessionId, "git-status", {
      cwd,
    })) as RpcCommandResponse;
  }

  async getGitDiffNumstat(
    sessionId: string,
    options: { cwd?: string; staged?: boolean }
  ): Promise<RpcCommandResponse> {
    return (await this.sessionRpc(
      sessionId,
      "git-diff-numstat",
      options
    )) as RpcCommandResponse;
  }

  async getGitDiffFile(
    sessionId: string,
    options: { cwd?: string; filePath: string; staged?: boolean }
  ): Promise<RpcCommandResponse> {
    return (await this.sessionRpc(
      sessionId,
      "git-diff-file",
      options
    )) as RpcCommandResponse;
  }

  async getGitRemoteUrl(
    sessionId: string,
    cwd?: string
  ): Promise<RpcCommandResponse> {
    return (await this.sessionRpc(sessionId, "git-remote-url", {
      cwd,
    })) as RpcCommandResponse;
  }

  async readSessionFile(
    sessionId: string,
    path: string
  ): Promise<RpcReadFileResponse> {
    return (await this.sessionRpc(sessionId, "readFile", {
      path,
    })) as RpcReadFileResponse;
  }

  async writeSessionFile(
    sessionId: string,
    options: { path: string; content: string; expectedHash?: string | null }
  ): Promise<RpcWriteFileResponse> {
    return (await this.sessionRpc(sessionId, "writeFile", {
      path: options.path,
      content: options.content,
      expectedHash: options.expectedHash ?? null,
    })) as RpcWriteFileResponse;
  }

  // issue #2518: session-scoped directory listing (the git-rpc file browser),
  // distinct from the machine-scoped `listDirectory` above which browses the
  // whole filesystem. Routes through the session-cwd-guarded `listDirectory`
  // RPC handler (cli/src/modules/common/handlers/directories.ts).
  async listSessionDirectory(
    sessionId: string,
    path: string
  ): Promise<ListDirectoryResponse> {
    return (await this.sessionRpc(sessionId, "listDirectory", {
      path,
    })) as ListDirectoryResponse;
  }

  // issue #2715: create a folder in the session working directory. The CLI
  // handler runs the authoritative validatePath + isSafeMachinePath + R5 guard.
  async createSessionDirectory(
    sessionId: string,
    path: string
  ): Promise<RpcMutationResponse> {
    return (await this.sessionRpc(sessionId, "createDirectory", {
      path,
    })) as RpcMutationResponse;
  }

  // issue #2715: rename a file/folder. The CLI handler guards BOTH legs
  // (source deny-list + destination containment).
  async renameSessionPath(
    sessionId: string,
    options: { path: string; newPath: string }
  ): Promise<RpcMutationResponse> {
    return (await this.sessionRpc(sessionId, "renamePath", {
      path: options.path,
      newPath: options.newPath,
    })) as RpcMutationResponse;
  }

  // issue #2715: delete a file/folder. Non-recursive unless the caller sets the
  // explicit, separately-confirmed `recursive` flag (sweep finding 2715-5).
  async deleteSessionPath(
    sessionId: string,
    options: { path: string; recursive?: boolean }
  ): Promise<RpcMutationResponse> {
    return (await this.sessionRpc(sessionId, "deletePath", {
      path: options.path,
      recursive: options.recursive ?? false,
    })) as RpcMutationResponse;
  }

  async runRipgrep(
    sessionId: string,
    args: string[],
    cwd?: string
  ): Promise<RpcCommandResponse> {
    return (await this.sessionRpc(sessionId, "ripgrep", {
      args,
      cwd,
    })) as RpcCommandResponse;
  }

  async listSlashCommands(
    sessionId: string,
    agent: string
  ): Promise<{
    success: boolean;
    commands?: Array<{
      name: string;
      description?: string;
      source: "builtin" | "user";
    }>;
    error?: string;
  }> {
    return (await this.sessionRpc(sessionId, "listSlashCommands", {
      agent,
    })) as {
      success: boolean;
      commands?: Array<{
        name: string;
        description?: string;
        source: "builtin" | "user";
      }>;
      error?: string;
    };
  }

  /**
   * Clean up a tmux window associated with a session.
   * Called when a disconnected session is deleted from the webapp.
   * This is a best-effort operation - if the daemon isn't running or
   * the session wasn't tmux-backed, it will silently succeed.
   */
  async cleanupTmuxSession(
    machineId: string,
    sessionId: string,
    serverSessionId?: string
  ): Promise<CleanupTmuxResponse> {
    try {
      const result = (await this.machineRpc(machineId, "cleanup-tmux-session", {
        sessionId,
        serverSessionId,
      })) as { success: boolean; message?: string };
      return result;
    } catch (error) {
      // #1349: distinguish daemon-offline (RPC handler not registered, socket
      // disconnected) from genuine RPC failure so callers can log the failure
      // mode loudly enough that orphan accumulation is detectable.
      const originalError =
        error instanceof Error ? error.message : String(error);
      const errorKind: "daemon_offline" | "rpc_failed" =
        originalError.includes("RPC handler not registered") ||
        originalError.includes("RPC socket disconnected")
          ? "daemon_offline"
          : "rpc_failed";
      if (this.errorLogger) {
        this.errorLogger.warn(
          `[RPC Gateway] cleanup-tmux-session failed: ${errorKind}`,
          {
            category: "rpc-cleanup",
            context: { machineId, sessionId, errorKind, originalError },
          }
        );
      } else {
        console.warn(
          `[RPC Gateway] cleanup-tmux-session failed (${errorKind}): ${originalError}`
        );
      }
      return {
        success: false,
        message:
          errorKind === "daemon_offline"
            ? "Daemon not available"
            : "RPC failed",
        errorKind,
        originalError,
      };
    }
  }

  /**
   * Reap the launcher's `hapimatic-remote` window(s) for a session tag (#1603).
   *
   * Calls the daemon's `reap-remote-window` RPC, which runs
   * `reapRemoteLauncherWindows(sessionTag)` (#1600). Used by archiveSession on
   * TERMINAL archives so window B's live claude does not orphan when a session
   * is archived but never deleted. `sessionId` here carries the session TAG
   * (the daemon matches windows by the pane's HAPI_SESSION_ID), mirroring
   * `cleanupTmuxSession`. The optional `serverSessionId` (#1628) carries the
   * server UUID embedded in the window NAME, enabling the daemon's direct
   * exact-name kill path on tmux-3.4 nodes where list-windows enumeration is
   * blind; when absent the daemon stays enumeration-only (pre-#1628 behavior).
   * Best-effort + #1349-style errorKind so a reap failure
   * is logged loudly (orphan accumulation stays detectable) but never throws.
   */
  async reapRemoteWindow(
    machineId: string,
    sessionId: string,
    serverSessionId?: string
  ): Promise<ReapRemoteWindowResponse> {
    try {
      const result = (await this.machineRpc(machineId, "reap-remote-window", {
        sessionId,
        serverSessionId,
      })) as { success: boolean; reaped?: number; message?: string };
      return result;
    } catch (error) {
      const originalError =
        error instanceof Error ? error.message : String(error);
      const errorKind: "daemon_offline" | "rpc_failed" =
        originalError.includes("RPC handler not registered") ||
        originalError.includes("RPC socket disconnected")
          ? "daemon_offline"
          : "rpc_failed";
      if (this.errorLogger) {
        this.errorLogger.warn(
          `[RPC Gateway] reap-remote-window failed: ${errorKind}`,
          {
            category: "rpc-cleanup",
            context: { machineId, sessionId, errorKind, originalError },
          }
        );
      } else {
        console.warn(
          `[RPC Gateway] reap-remote-window failed (${errorKind}): ${originalError}`
        );
      }
      return {
        success: false,
        message:
          errorKind === "daemon_offline"
            ? "Daemon not available"
            : "RPC failed",
        errorKind,
        originalError,
      };
    }
  }

  /**
   * Clean up a worktree directory and its branch when a session is deleted.
   * Called when a worktree-backed session is permanently deleted from the webapp.
   * Best-effort: if daemon is offline or worktree is already gone, returns gracefully.
   */
  async cleanupWorktree(
    machineId: string,
    worktreeInfo: {
      basePath: string;
      worktreePath?: string;
      branch: string;
      sessionId?: string;
    }
  ): Promise<{ success: boolean; message?: string }> {
    try {
      const result = (await this.machineRpc(machineId, "cleanup-worktree", {
        basePath: worktreeInfo.basePath,
        worktreePath: worktreeInfo.worktreePath,
        branch: worktreeInfo.branch,
        sessionId: worktreeInfo.sessionId,
      })) as { success: boolean; message?: string };
      return result;
    } catch (error) {
      // #1349: structured logging — match cleanupTmuxSession's pattern.
      // Note: callers don't yet branch on cleanupWorktree.errorKind, so the
      // return shape stays the prior `{success, message?}` for backward compat.
      const originalError =
        error instanceof Error ? error.message : String(error);
      if (this.errorLogger) {
        this.errorLogger.warn(`[RPC Gateway] cleanup-worktree failed`, {
          category: "rpc-cleanup",
          context: {
            machineId,
            worktreeBranch: worktreeInfo.branch,
            sessionId: worktreeInfo.sessionId,
            originalError,
          },
        });
      } else {
        console.warn(`[RPC Gateway] cleanup-worktree failed: ${originalError}`);
      }
      return { success: false, message: "Daemon not available" };
    }
  }

  /**
   * Rename a tmux window associated with a session.
   * Called when a session is renamed in the webapp (Phase 1.3: Hapimatic → Tmux sync).
   * This is a best-effort operation - if the daemon isn't running or
   * the session wasn't tmux-backed, it will silently succeed.
   */
  async renameTmuxWindow(
    machineId: string,
    sessionId: string,
    newName: string
  ): Promise<{ success: boolean; message?: string }> {
    try {
      const result = (await this.machineRpc(machineId, "rename-tmux-window", {
        sessionId,
        newName,
      })) as { success: boolean; message?: string };
      return result;
    } catch (error) {
      // If daemon isn't connected, that's OK - the rename still succeeds in Hapimatic
      console.log(
        `[RPC Gateway] rename-tmux-window failed (expected if daemon offline): ${error instanceof Error ? error.message : String(error)}`
      );
      return { success: false, message: "Daemon not available" };
    }
  }

  /**
   * Issue #2683: tag a session's tmux window as a deliberate archive-for-reconnect
   * (`@hapi_archive` window user-option) so the daemon's orphan reconciliation
   * reaper preserves it. Best-effort — if the daemon is offline or the session
   * was not tmux-backed, it silently returns `success:false` (the archive still
   * proceeds). Mirrors renameTmuxWindow.
   */
  async setArchiveTag(
    machineId: string,
    sessionId: string
  ): Promise<{ success: boolean; message?: string }> {
    try {
      const result = (await this.machineRpc(machineId, "set-archive-tag", {
        sessionId,
      })) as { success: boolean; message?: string };
      return result;
    } catch (error) {
      console.log(
        `[RPC Gateway] set-archive-tag failed (expected if daemon offline): ${error instanceof Error ? error.message : String(error)}`
      );
      return { success: false, message: "Daemon not available" };
    }
  }

  /**
   * The single derivation of a session+method registry/wire key (issue #2419,
   * [1B-16]). BOTH the capability-invoke gate's meta lookup (`getCapabilityMeta`)
   * and the dispatch (`sessionRpc` → `invokeCapability`) route through this, so
   * the gate can never check one key while dispatch sends another.
   */
  private sessionMethodKey(sessionId: string, method: string): string {
    return `${sessionId}:${method}`;
  }

  private async sessionRpc(
    sessionId: string,
    method: string,
    params: unknown
  ): Promise<unknown> {
    return await this.rpcCall(this.sessionMethodKey(sessionId, method), params);
  }

  /**
   * Read the registered CapabilityMeta for a session+method (issue #2419 gate
   * lookup). Uses the SAME wire key as dispatch ([1B-16]). Returns `null` for a
   * name-only registration or a registry miss — both of which the fail-closed
   * gate (`capabilityPolicy.isInvocable`) treats as NOT invocable.
   */
  getCapabilityMeta(sessionId: string, method: string): CapabilityMeta | null {
    return this.rpcRegistry.getMeta(this.sessionMethodKey(sessionId, method));
  }

  /**
   * Dispatch a capability over the session RPC path (issue #2419, R1). A thin
   * wrapper over `sessionRpc` returning the raw handler result for the route to
   * envelope. It does NOT enforce policy — that is the route's job via
   * `capabilityPolicy.runCapabilityInvoke`, and this MUST only be reached after
   * the fail-closed gate passes.
   */
  async invokeCapability(
    sessionId: string,
    method: string,
    params: unknown
  ): Promise<unknown> {
    return await this.sessionRpc(sessionId, method, params);
  }

  private async machineRpc(
    machineId: string,
    method: string,
    params: unknown,
    timeoutMs: number = DEFAULT_RPC_TIMEOUT_MS
  ): Promise<unknown> {
    return await this.rpcCall(`${machineId}:${method}`, params, timeoutMs);
  }

  /**
   * Enumerate a session's live RPC capabilities for the #2418 read path.
   * Resolves the session's `/cli` socket via socket.io ROOM membership (room
   * `session:${sessionId}`, joined at connect in socket/handlers/cli/index.ts)
   * — NOT a registry-prefix scan, which cannot represent a live-but-method-less
   * socket (issue #2418, expert-review 1B-7). The room→socket idiom mirrors
   * `pickCliSocketId` in socket/handlers/claudePty.ts.
   *
   * Returns:
   *   - `{ name, meta? }[]` (possibly empty) when a live `/cli` socket exists —
   *     `meta` omitted (never `undefined`) for name-only / pre-A registrations.
   *   - `null` when the session has no live `/cli` socket (route maps → 404).
   */
  getSessionCapabilities(
    sessionId: string
  ): { name: string; meta?: CapabilityMeta }[] | null {
    const cliNamespace = this.io.of("/cli");
    const room = cliNamespace.adapter.rooms.get(`session:${sessionId}`);
    if (!room || room.size === 0) {
      return null;
    }
    // A session has exactly one live `/cli` socket; take the first that resolves.
    let socketId: string | null = null;
    for (const id of room) {
      if (cliNamespace.sockets.get(id)) {
        socketId = id;
        break;
      }
    }
    if (socketId === null) {
      return null;
    }
    return this.rpcRegistry
      .getMethodsForSocket(socketId)
      .map(({ method, meta }) =>
        meta ? { name: method, meta } : { name: method }
      );
  }

  private async rpcCall(
    method: string,
    params: unknown,
    timeoutMs: number = DEFAULT_RPC_TIMEOUT_MS
  ): Promise<unknown> {
    const socketId = this.rpcRegistry.getSocketIdForMethod(method);
    if (!socketId) {
      throw new Error(`RPC handler not registered: ${method}`);
    }

    const socket = this.io.of("/cli").sockets.get(socketId);
    if (!socket) {
      throw new Error(`RPC socket disconnected: ${method}`);
    }

    const response = (await socket
      .timeout(timeoutMs)
      .emitWithAck("rpc-request", {
        method,
        params: JSON.stringify(params),
      })) as unknown;

    if (typeof response !== "string") {
      return response;
    }

    try {
      return JSON.parse(response) as unknown;
    } catch {
      return response;
    }
  }
}

// ---------------------------------------------------------------------------
// Issue #2301: bounded retry / wait-for-slot around spawn (reconnect + switch)
// ---------------------------------------------------------------------------

/** Issue #2301 (Task 1): how a failed spawn should be treated by the retry loop. */
export type SpawnFailureKind = "capacity" | "transient-rpc" | "deterministic";

/**
 * Issue #2301 (Task 1, R2): classify a failed spawn result so switchAccount +
 * reconnectSession (and any future call site, e.g. #3618) share ONE source of
 * truth for "is this retriable" — avoiding two skills disagreeing about what
 * "transient" means. Promoted from the #1349 daemon-offline include-idiom (used
 * by cleanupTmuxSession / reapRemoteWindow above).
 *
 * Prefers the daemon's structured error `code` when present (D1): the daemon mints
 * `code:"at_capacity"` for the concurrency-cap rejection (#1772) and it is preserved
 * through the spawn-result chain (#2299 switch-path pre-check re-tag + #2300 Task 2
 * reconnect-failure preservation). Falls back to a message substring test otherwise.
 * Everything not matched is `deterministic` (account_not_found, account_unrefreshable,
 * cwd_missing, unsupported-agent, …) → fail fast, zero retries.
 */
export function isRetriableSpawnFailure(result: {
  message?: string;
  code?: string;
}): { retriable: boolean; kind: SpawnFailureKind } {
  // Prefer the structured code (D1).
  if (result.code === "at_capacity") {
    return { retriable: true, kind: "capacity" };
  }
  const msg = result.message ?? "";
  // Substring fallback for capacity: the daemon's cap message. Some paths carry
  // only the message (e.g. pendingSpawns.markSpawnFailed) with no code.
  if (msg.includes("Too many concurrent sessions")) {
    return { retriable: true, kind: "capacity" };
  }
  // Transient RPC faults — the #1349 include-idiom. rpcCall throws these when the
  // daemon socket drops under CPU starvation; they are retriable once it recovers.
  if (
    msg.includes("RPC handler not registered") ||
    msg.includes("RPC socket disconnected")
  ) {
    return { retriable: true, kind: "transient-rpc" };
  }
  return { retriable: false, kind: "deterministic" };
}

/** Issue #2301 (Task 2): the capacity-retry regime, chosen per call site. */
export type CapacityRetryMode =
  // Poll until `capacityDeadlineMs` (reconnect — the session is already
  // disconnected, so the full 30-60s poll-until-slot is safe).
  | "full"
  // A SHORT residual-slot-steal-race tail (switchAccount post-kill respawn —
  // the primary wait is #2299's PRE-kill loop; a long post-kill wait widens the
  // disconnected window, R6). Uses CAPACITY_TAIL_DEADLINE_MS.
  | "tail"
  // Transient-RPC only; a capacity failure fails fast (the R4 rollback — a
  // rollback must never wait for a slot).
  | "none";

export interface SpawnWithRetryOptions {
  /** Regime for capacity failures. Default "full". */
  capacityMode?: CapacityRetryMode;
  /**
   * Total budget for a `capacityMode:"full"` poll. Callers pass the shared
   * ACCOUNT_SWITCH_SLOT_WAIT_DEADLINE_MS (exported from accountRestart.ts) so the
   * pre-kill wait, the post-kill tail, and the reconnect poll all agree on ONE
   * deadline (D1 / OR-2). Ignored for "tail" (uses CAPACITY_TAIL_DEADLINE_MS) and
   * "none". Defaults to CAPACITY_TAIL_DEADLINE_MS as a floor.
   */
  capacityDeadlineMs?: number;
  /** Fixed attempt cap for transient-RPC retries. Default SPAWN_TRANSIENT_MAX_ATTEMPTS. */
  maxTransientAttempts?: number;
  /**
   * Invoked once, when a capacity wait actually begins, so the caller can surface a
   * live "waiting for a slot…" status (R4). Emitted once (not per poll) to avoid
   * toast spam — the #2299 pre-kill loop's "announce once" precedent.
   */
  onWaitingForSlot?: (info: { elapsedMs: number; deadlineMs: number }) => void;
  /** Route abort signal (`c.req.raw.signal`) — a client disconnect cancels the wait. */
  signal?: AbortSignal;
  /** Injectable for tests (default real timers). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injectable for tests (default Date.now). */
  now?: () => number;
}

/** Minimal shape spawnWithRetry needs; the caller's concrete result type flows through. */
type SpawnResultLike =
  | ({ type: "success" } & Record<string, unknown>)
  | { type: "error"; message: string; code?: string };

function spawnRetrySleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>(resolve => {
    if (ms <= 0) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Race a settling promise against a deadline / abort. On timeout or abort, resolves
 * `{timedOut:true}` and the abandoned promise is left to settle harmlessly (its
 * rejection is swallowed). Under `awaitWebhook:false` a valid spawn acks on
 * child-START (fast), so a race-timeout implies a stuck RPC transport with NO child
 * started — returning failure here does not orphan a spawn.
 */
async function raceSpawnDeadline<T>(
  p: Promise<T>,
  ms: number,
  signal?: AbortSignal
): Promise<{ timedOut: true } | { timedOut: false; value: T }> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (r: { timedOut: true } | { timedOut: false; value: T }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(r);
    };
    const onAbort = () => finish({ timedOut: true });
    const timer = setTimeout(() => finish({ timedOut: true }), Math.max(0, ms));
    signal?.addEventListener("abort", onAbort, { once: true });
    p.then(
      value => finish({ timedOut: false, value }),
      () => finish({ timedOut: true })
    );
  });
}

/**
 * Issue #2301 (Task 2, R1/R3): a bounded retry-with-backoff wrapper around a single
 * `spawnSession` call, gated to transient/capacity failures via
 * {@link isRetriableSpawnFailure}. Deterministic failures return immediately (0
 * retries — R2). The final spawn result is returned UNCHANGED so a caller's
 * downstream logic (incl. the R4 rollback) is untouched (Fallback Preservation Rule).
 *
 * Regimes:
 *  - transient-rpc → exponential backoff (500ms→8s cap) up to maxTransientAttempts,
 *    mirroring the updateSessionAccount fixed-attempt loop shape (sessionCache.ts).
 *  - capacity → poll until the deadline (full) / a short tail (tail) / never (none),
 *    emitting onWaitingForSlot when the wait begins.
 *
 * The deadline wraps IN-FLIGHT attempts (not just the gaps): SPAWN_RPC_TIMEOUT_MS
 * (75s) exceeds the 30-60s deadline, so during a capacity wait each attempt is raced
 * against the remaining budget and a stuck attempt returns failure rather than
 * hanging. `none` mode (rollback) keeps the natural SPAWN_RPC_TIMEOUT_MS bound.
 */
export async function spawnWithRetry<T extends SpawnResultLike>(
  spawnFn: () => Promise<T>,
  opts: SpawnWithRetryOptions = {}
): Promise<T> {
  const capacityMode = opts.capacityMode ?? "full";
  const maxTransientAttempts =
    opts.maxTransientAttempts ?? SPAWN_TRANSIENT_MAX_ATTEMPTS;
  const sleep = opts.sleep ?? spawnRetrySleep;
  const now = opts.now ?? Date.now;
  const capacityDeadlineMs =
    capacityMode === "tail"
      ? CAPACITY_TAIL_DEADLINE_MS
      : capacityMode === "full"
        ? (opts.capacityDeadlineMs ?? CAPACITY_TAIL_DEADLINE_MS)
        : 0;

  const start = now();
  const deadline = start + capacityDeadlineMs;
  let transientAttempts = 0;
  let announced = false;
  let lastError: T | undefined;

  const abortedResult = (): T =>
    lastError ??
    ({
      type: "error",
      message: "Spawn aborted (client disconnected).",
      code: "aborted",
    } as unknown as T);
  const deadlineResult = (): T =>
    lastError ??
    ({
      type: "error",
      message: "Timed out waiting for a free session slot.",
      code: "at_capacity",
    } as unknown as T);

  for (;;) {
    if (opts.signal?.aborted) return abortedResult();

    let result: T;
    if (capacityMode === "none") {
      // Transient-only (rollback): no capacity wait, keep the natural RPC timeout.
      result = await spawnFn();
    } else {
      const remaining = deadline - now();
      if (remaining <= 0) return deadlineResult();
      // Race the attempt against the remaining budget (see raceSpawnDeadline).
      const raced = await raceSpawnDeadline(spawnFn(), remaining, opts.signal);
      if (raced.timedOut) return deadlineResult();
      result = raced.value;
    }

    if (result.type === "success") return result;
    lastError = result;

    const { retriable, kind } = isRetriableSpawnFailure(result);
    if (!retriable) return result; // deterministic → fail fast (R2)

    if (kind === "transient-rpc") {
      transientAttempts += 1;
      if (transientAttempts >= maxTransientAttempts) return result;
      const backoff = Math.min(
        SPAWN_TRANSIENT_BASE_BACKOFF_MS * 2 ** (transientAttempts - 1),
        SPAWN_TRANSIENT_MAX_BACKOFF_MS
      );
      if (capacityMode === "none") {
        await sleep(backoff, opts.signal);
      } else {
        const remaining = deadline - now();
        if (remaining <= 0) return result;
        await sleep(Math.min(backoff, remaining), opts.signal);
      }
      continue;
    }

    // kind === "capacity"
    if (capacityMode === "none") return result; // rollback: never wait for a slot
    if (now() >= deadline) return result; // deadline expiry → report failure (no hang)
    if (!announced) {
      announced = true;
      opts.onWaitingForSlot?.({
        elapsedMs: now() - start,
        deadlineMs: capacityDeadlineMs,
      });
    }
    const remaining = deadline - now();
    const waitMs = Math.max(
      0,
      Math.min(
        CAPACITY_POLL_MIN_MS +
          Math.floor(Math.random() * CAPACITY_POLL_JITTER_MS),
        remaining
      )
    );
    await sleep(waitMs, opts.signal);
  }
}

/** Result of the `recover-worktree` machine RPC (issue #3839, D28). */
export type RecoverWorktreeRpcResult =
  | { ok: true; worktreePath: string; branch: string }
  | { ok: false; code: string; error: string };
