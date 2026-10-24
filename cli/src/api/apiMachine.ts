// SPDX-License-Identifier: MIT AND AGPL-3.0-only
/**
 * WebSocket client for machine/daemon communication with hapi-server
 */

import { io, type Socket } from "socket.io-client";
import { readdir, stat, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename, isAbsolute, resolve, sep } from "node:path";
import os from "node:os";
import { logger } from "@/ui/logger";
import { configuration } from "@/configuration";
import type {
  DaemonState,
  Machine,
  MachineMetadata,
  Update,
  UpdateMachineBody,
} from "./types";
import { DaemonStateSchema, MachineMetadataSchema } from "./types";
import { backoff } from "@/utils/time";
import { RpcHandlerManager } from "./rpc/RpcHandlerManager";
import { registerCommonHandlers } from "../modules/common/registerCommonHandlers";
import type {
  SpawnSessionOptions,
  SpawnSessionResult,
} from "../modules/common/rpcTypes";
import { applyVersionedAck } from "./versionedUpdate";
import {
  stopTmuxSession,
  renameTmuxWindow,
  reapRemoteLauncherWindows,
  setArchiveTag,
} from "../daemon/tmuxSpawnAdapter";
import {
  cleanupIdleWorktree,
  cleanupWorktreeAndBranch,
  isWithinWorktreeBase,
  listSoftDeletedWorktrees,
  recoverWorktree,
} from "../daemon/worktree";
import { resolveWorktreeHostBase } from "../daemon/worktreeHostBase";
import { createSessionStore } from "@/sessionPersistence";
import {
  isSafeMachinePath,
  validateCreateDirectoryTarget,
} from "../modules/common/pathSecurity";
import { getProjectPath } from "@/claude/utils/path";
import {
  PATH_EXISTS_META,
  MACHINE_LIST_DIRECTORY_META,
  MACHINE_CREATE_DIRECTORY_META,
  SPAWN_HAPPY_SESSION_META,
  STOP_SESSION_META,
  STOP_DAEMON_META,
  CLEANUP_TMUX_SESSION_META,
  REAP_REMOTE_WINDOW_META,
  RENAME_TMUX_WINDOW_META,
  SET_ARCHIVE_TAG_META,
  CLEANUP_WORKTREE_META,
  CLEANUP_IDLE_WORKTREE_META,
  cleanupIdleWorktreeInput,
  GET_SESSION_CLAUDE_ID_META,
  HAS_CLAUDE_CONVERSATION_META,
  RECOVER_WORKTREE_META,
  IS_SESSION_ALIVE_META,
  CAPACITY_PROBE_META,
} from "@/api/rpc/capabilityMeta";

interface ServerToDaemonEvents {
  update: (data: Update) => void;
  "rpc-request": (
    data: { method: string; params: string },
    callback: (response: string) => void
  ) => void;
  error: (data: { message: string }) => void;
}

interface DaemonToServerEvents {
  "machine-alive": (
    data: { machineId: string; time: number },
    cb?: (ack: { ok: boolean }) => void
  ) => void;
  "machine-update-metadata": (
    data: { machineId: string; metadata: unknown; expectedVersion: number },
    cb: (
      answer:
        | {
            result: "error";
          }
        | {
            result: "version-mismatch";
            version: number;
            metadata: unknown | null;
          }
        | {
            result: "success";
            version: number;
            metadata: unknown | null;
          }
    ) => void
  ) => void;
  "machine-update-state": (
    data: {
      machineId: string;
      daemonState: unknown | null;
      expectedVersion: number;
    },
    cb: (
      answer:
        | {
            result: "error";
          }
        | {
            result: "version-mismatch";
            version: number;
            daemonState: unknown | null;
          }
        | {
            result: "success";
            version: number;
            daemonState: unknown | null;
          }
    ) => void
  ) => void;
  "rpc-register": (data: { method: string }) => void;
  "rpc-unregister": (data: { method: string }) => void;
}

type MachineRpcHandlers = {
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  stopSession: (sessionId: string) => boolean;
  requestShutdown: () => void;
  /**
   * Issue #1661: report whether a tmux-launcher session's wrapper + pane are
   * alive. Unlike `get-session-claude-id` / `has-claude-conversation` (stateless
   * store/filesystem reads registered directly in the ApiMachineClient
   * constructor), this needs the daemon's LIVE `pidToTrackedSession` state, so it
   * is provided by run.ts as a closure here. Returns `true` (tracked + pane not
   * dead), `false` (untracked/dead), or `null` (uncertain — caller respawns).
   */
  isSessionAlive: (sessionTag: string) => Promise<boolean | null>;
  /**
   * Issue #2299 (Task 3): read-only capacity probe. Like `isSessionAlive`, it
   * needs the daemon's LIVE count (the credited `computeEffectiveCount`), so run.ts
   * provides it as a closure here. Returns `{ effectiveCount, maxConcurrent,
   * wouldAdmit }` for a would-be reused-window respawn of `creditHapiSessionId`
   * WITHOUT spawning. `creditHapiSessionId` undefined = uncredited capacity.
   */
  capacityProbe: (creditHapiSessionId?: string) => Promise<{
    effectiveCount: number;
    maxConcurrent: number;
    wouldAdmit: boolean;
  }>;
};

interface PathExistsRequest {
  paths: string[];
}

interface PathExistsResponse {
  exists: Record<string, boolean>;
}

interface ListDirectoryRequest {
  path: string;
}

interface DirectoryEntry {
  name: string;
  type: "file" | "directory" | "other";
  size?: number;
  modified?: number;
}

interface ListDirectoryResponse {
  success: boolean;
  entries?: DirectoryEntry[];
  error?: string;
}

interface CreateDirectoryRequest {
  path: string;
  recursive: boolean;
}

interface CreateDirectoryResponse {
  success: boolean;
  entry?: DirectoryEntry;
  error?: string;
}

interface SpawnHappySessionParams extends SpawnSessionOptions {
  hapiSessionId?: string;
}

interface StopSessionParams {
  sessionId?: string;
}

interface CleanupTmuxSessionParams {
  sessionId?: string;
  /** #1628: server session UUID (embedded in the remote window NAME) — enables the daemon's direct exact-name reap path. Optional for version-skew safety. */
  serverSessionId?: string;
}

interface ReapRemoteWindowParams {
  sessionId?: string;
  /** #1628: server session UUID (embedded in the remote window NAME) — enables the daemon's direct exact-name reap path. Optional for version-skew safety. */
  serverSessionId?: string;
}

interface RenameTmuxWindowParams {
  sessionId?: string;
  newName?: string;
}

interface CleanupWorktreeParams {
  basePath?: string;
  worktreePath?: string;
  branch?: string;
  sessionId?: string;
}

export class ApiMachineClient {
  private socket!: Socket<ServerToDaemonEvents, DaemonToServerEvents>;
  private keepAliveInterval: NodeJS.Timeout | null = null;
  private watchdogInterval: NodeJS.Timeout | null = null;
  private isShuttingDown = false;
  private consecutiveDisconnectedChecks = 0;
  private consecutiveUnackedHeartbeats = 0;
  private rpcHandlerManager: RpcHandlerManager;

  constructor(
    private readonly token: string,
    private readonly machine: Machine
  ) {
    this.rpcHandlerManager = new RpcHandlerManager({
      scopePrefix: this.machine.id,
      logger: (msg, data) => logger.debug(msg, data),
    });

    registerCommonHandlers(this.rpcHandlerManager, process.cwd());

    this.rpcHandlerManager.registerHandler<
      PathExistsRequest,
      PathExistsResponse
    >(
      "path-exists",
      async params => {
        const rawPaths = Array.isArray(params?.paths) ? params.paths : [];
        const uniquePaths = Array.from(
          new Set(
            rawPaths.filter((path): path is string => typeof path === "string")
          )
        );
        const exists: Record<string, boolean> = {};

        // Helper to expand tilde to home directory
        const expandTilde = (p: string): string => {
          if (p.startsWith("~/")) return p.replace(/^~\//, `${os.homedir()}/`);
          if (p === "~") return os.homedir();
          return p;
        };

        await Promise.all(
          uniquePaths.map(async path => {
            const trimmed = path.trim();
            if (!trimmed) return;
            const expandedPath = expandTilde(trimmed);
            if (!isSafeMachinePath(expandedPath)) {
              exists[trimmed] = false;
              return;
            }
            try {
              const stats = await stat(expandedPath);
              // Return result keyed by original path, not expanded path
              exists[trimmed] = stats.isDirectory();
            } catch {
              exists[trimmed] = false;
            }
          })
        );

        return { exists };
      },
      PATH_EXISTS_META
    );

    // Directory listing for machine-level operations (e.g., New Session form browse)
    // This allows browsing any directory on the filesystem, unlike the session-scoped listDirectory
    this.rpcHandlerManager.registerHandler<
      ListDirectoryRequest,
      ListDirectoryResponse
    >(
      "list-directory",
      async params => {
        const rawPath =
          typeof params?.path === "string" ? params.path.trim() : "";
        if (!rawPath) {
          return { success: false, error: "Path is required" };
        }

        // Expand tilde to home directory
        let expandedPath = rawPath;
        if (expandedPath.startsWith("~/")) {
          expandedPath = expandedPath.replace(/^~\//, `${os.homedir()}/`);
        } else if (expandedPath === "~") {
          expandedPath = os.homedir();
        }

        if (!isSafeMachinePath(expandedPath)) {
          return { success: false, error: "Access denied to this path" };
        }

        try {
          const entries = await readdir(expandedPath, { withFileTypes: true });
          const directoryEntries: DirectoryEntry[] = await Promise.all(
            entries.map(async entry => {
              const fullPath = join(expandedPath, entry.name);
              let type: "file" | "directory" | "other" = "other";
              let size: number | undefined;
              let modified: number | undefined;

              if (entry.isDirectory()) {
                type = "directory";
              } else if (entry.isFile()) {
                type = "file";
              }

              try {
                const stats = await stat(fullPath);
                size = stats.size;
                modified = stats.mtime.getTime();
              } catch {
                // Ignore stat errors (permission denied, etc.)
              }

              return { name: entry.name, type, size, modified };
            })
          );

          // Sort: directories first, then alphabetically
          directoryEntries.sort((a, b) => {
            if (a.type === "directory" && b.type !== "directory") return -1;
            if (a.type !== "directory" && b.type === "directory") return 1;
            return a.name.localeCompare(b.name);
          });

          return { success: true, entries: directoryEntries };
        } catch (error) {
          return {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : "Failed to list directory",
          };
        }
      },
      MACHINE_LIST_DIRECTORY_META
    );

    // Directory creation for machine-level operations (the New Session form's
    // "New folder", issue #3498). Mirrors the list-directory handler above, but
    // runs the create-target UNION guard first (NUL-reject → tilde-expand →
    // realpath the deepest existing ancestor → union deny-list on the REAL path
    // → tail-segment validation; see validateCreateDirectoryTarget). mkdir runs
    // as the DAEMON's uid. `recursive:false` (the inline row) surfaces EEXIST
    // kernel-atomically on an existing folder; `recursive:true` (the typed-path
    // "Create & select") is mkdir -p.
    this.rpcHandlerManager.registerHandler<
      CreateDirectoryRequest,
      CreateDirectoryResponse
    >(
      "create-directory",
      async params => {
        const recursive = params?.recursive === true;
        const validation = validateCreateDirectoryTarget(params?.path);
        if (!validation.ok || !validation.target) {
          return {
            success: false,
            error: validation.error ?? "Access denied to this path",
          };
        }
        const target = validation.target;

        try {
          await mkdir(target, { recursive });
          // Best-effort metadata for the created DirectoryEntry (mirrors the
          // list entries shape); a stat failure never fails the create.
          let size: number | undefined;
          let modified: number | undefined;
          try {
            const stats = await stat(target);
            size = stats.size;
            modified = stats.mtime.getTime();
          } catch {
            // Ignore stat errors (permission denied, etc.) — mkdir succeeded.
          }
          return {
            success: true,
            entry: {
              name: basename(target),
              type: "directory",
              size,
              modified,
            },
          };
        } catch (error) {
          // Return the raw message (carries EEXIST/EACCES/ENOSPC/EROFS codes):
          // the server route maps EEXIST → 409, and the web client's
          // humanizeFsError translates the rest for the user (issue #3498 R5).
          return {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : "Failed to create directory",
          };
        }
      },
      MACHINE_CREATE_DIRECTORY_META
    );
  }

  setRPCHandlers({
    spawnSession,
    stopSession,
    requestShutdown,
    isSessionAlive,
    capacityProbe,
  }: MachineRpcHandlers): void {
    this.rpcHandlerManager.registerHandler(
      "spawn-happy-session",
      async (params: SpawnHappySessionParams) => {
        const {
          directory,
          sessionId,
          machineId,
          approvedNewDirectoryCreation,
          agent,
          yolo,
          claimPort,
          token,
          sessionType,
          worktreeName,
          // hapimatic-private#4481: existing-branch worktree (#1262 trap — an
          // un-listed field is silently dropped on this field-by-field hop).
          existingBranch,
          // hapimatic-private#4370: explicit worktree base branch (#1262 trap).
          sourceBranch,
          resumeSessionId,
          hapiSessionId,
          name,
          forkSession,
          parentSessionId,
          parentRelationship,
          originatingNodeId,
          scheduleId,
          accountUuid,
          // Issue #4568: destructure the API-key binding + its spawn-time mask
          // (#1262 trap — un-listed here, the session spawns on the node default).
          apiKeyId,
          apiKeyMasked,
          awaitWebhook,
          safeMode,
          launcher,
          modelMode,
          // Issue #2456: forward reasoning-effort + pinned raw model through
          // this second field-by-field RPC hop (rpcGateway → daemon). Same #1262
          // trap — omit and the daemon never appends --hapi-effort/--hapi-raw-model.
          effort,
          rawModel,
          model,
          // Issue #3349 (D4(a)): destructure the native-vs-OpenRouter routing
          // discriminator from the wire payload (#1262 trap — un-listed here, a
          // native opencode spawn strips the routing and misroutes to OpenRouter).
          modelRouting,
          cloneRepo,
          sessionRole,
          outputStyle,
          // Issue #3348: destructure the bundled non-claude native model
          // selection from the wire payload (#1262 trap — un-listed here, the
          // daemon never sets GEMINI_MODEL / bakes the codex config.toml model).
          nativeModelSelection,
          killLivePane,
          // Issue #3632: destructure the server-stamped message-hook stage flag
          // from the wire payload (the #1262 trap — an un-listed field is
          // silently dropped here, leaving the daemon to OMIT the marker).
          messageHooksEnabled,
          // Issue #3611: destructure the resolved optimal-account opt-in from the
          // wire payload (#1262 trap — un-listed here, the daemon reads undefined
          // and never runs the un-pinned optimal-pick, so R1 fails silently).
          autoSelectOptimalAccount,
        } = params || {};

        if (!directory) {
          throw new Error("Directory is required");
        }

        const result = await spawnSession({
          directory,
          sessionId,
          machineId,
          approvedNewDirectoryCreation,
          agent,
          yolo,
          claimPort,
          token,
          sessionType,
          worktreeName,
          // hapimatic-private#4481: existing-branch worktree (#1262 trap — an
          // un-listed field is silently dropped on this field-by-field hop).
          existingBranch,
          // hapimatic-private#4370: explicit worktree base branch (#1262 trap).
          sourceBranch,
          resumeSessionId,
          hapiSessionId,
          name,
          forkSession,
          parentSessionId,
          parentRelationship,
          originatingNodeId,
          scheduleId,
          // #1455: forward the bound account through this second field-by-field
          // RPC hop (the rpcGateway → daemon handoff). Like the #1262 claimPort
          // trap, an un-enumerated field is silently dropped here, leaving
          // HAPI_ACCOUNT_UUID unset and the session unbound.
          accountUuid,
          // Issue #4568: forward the API-key binding through this second hop
          // (#1262 trap — omit it and the session silently bills the node default).
          apiKeyId,
          apiKeyMasked,
          // Issue #1555: forward the await-webhook gate through this second
          // field-by-field RPC hop (rpcGateway → daemon). Same #1262 trap —
          // omit it and the daemon never sees the false value.
          awaitWebhook,
          // Issue #1633: forward Safe Mode + explicit model mode through this
          // second field-by-field RPC hop — same #1262 trap as above.
          safeMode,
          // Issue #1660: forward the per-session launcher through this hop too.
          launcher,
          modelMode,
          // Issue #2456: forward reasoning-effort + pinned raw model to the
          // daemon spawnSession (#1262 trap — omit and the daemon never appends
          // --hapi-effort / --hapi-raw-model, so the spawn ignores the selection).
          effort,
          rawModel,
          // Issue #1733: forward the OpenRouter model through this hop too
          // (#1262 trap — omit it and the daemon never sees the model).
          model,
          // Issue #3349 (D4(a)): forward the native-vs-OpenRouter routing
          // discriminator to the daemon spawnSession (#1262 trap — omit it and a
          // native opencode spawn misroutes to OpenRouter).
          modelRouting,
          // Issue #1953 (A6): forward the clone-on-spawn repo to the daemon
          // spawnSession (#1262 trap — omit it and the daemon never clones).
          cloneRepo,
          // Issue #2155: forward the role-scoped profile to the daemon
          // spawnSession (#1262 trap — omit it and the daemon never scopes the
          // stack, so the session silently loads the full stack).
          sessionRole,
          // Issue #2626 (D): forward the per-session output style to the daemon
          // spawnSession (#1262 trap — omit it and the daemon never appends
          // --hapi-output-style, so the style never reaches the --settings file
          // and R1 fails silently). Guarded by apiMachine.spawnOutputStyle.test.ts.
          outputStyle,
          // Issue #3348: forward the bundled non-claude native model selection to
          // the daemon spawnSession (#1262 trap — omit it and the daemon never
          // sets GEMINI_MODEL / bakes the codex config.toml model + effort).
          nativeModelSelection,
          // Issue #1661: forward the reconnect kill-vs-reattach intent through
          // this second field-by-field RPC hop (rpcGateway → daemon). Same #1262
          // trap — omit it and the daemon never sees the `false` value, so the
          // reused-window path always respawn-kills (the bug).
          killLivePane,
          // Issue #3632: forward the server-stamped message-hook stage flag to
          // the daemon spawnSession (#1262 trap — omit it and the daemon never
          // exports HAPI_MESSAGE_HOOKS, so the rp1-home mint fallback stays
          // dormant). `undefined` is preserved as OMIT. Guarded by
          // apiMachine.spawnMessageHooks.test.ts.
          messageHooksEnabled,
          // Issue #3611: forward the resolved optimal-account opt-in to the daemon
          // spawnSession (#1262 trap — omit it and the daemon never runs the
          // un-pinned optimal-pick). `undefined`/`false` ⇒ NO pick (#3023 unchanged).
          autoSelectOptimalAccount,
        });

        switch (result.type) {
          case "success":
            return {
              type: "success",
              sessionId: result.sessionId,
              ...(result.resolvedName
                ? { resolvedName: result.resolvedName }
                : {}),
              // Issue #5202 (U2): forward the downgrade reason (#1262 trap).
              ...(result.sessionTypeDowngrade
                ? { sessionTypeDowngrade: result.sessionTypeDowngrade }
                : {}),
            };
          case "requestToApproveDirectoryCreation":
            return {
              type: "requestToApproveDirectoryCreation",
              directory: result.directory,
            };
          case "error":
            // Issue #1772: forward the error `code` across this field-by-field
            // rebuild (the #1262 trap — an un-enumerated field dies at this hop).
            return {
              type: "error",
              errorMessage: result.errorMessage,
              ...(result.code ? { code: result.code } : {}),
            };
        }
      },
      SPAWN_HAPPY_SESSION_META
    );

    this.rpcHandlerManager.registerHandler(
      "stop-session",
      (params: StopSessionParams) => {
        const { sessionId } = params || {};
        if (!sessionId) {
          throw new Error("Session ID is required");
        }

        const success = stopSession(sessionId);
        if (!success) {
          throw new Error("Session not found or failed to stop");
        }

        return { message: "Session stopped" };
      },
      STOP_SESSION_META
    );

    this.rpcHandlerManager.registerHandler(
      "stop-daemon",
      () => {
        setTimeout(() => requestShutdown(), 100);
        return { message: "Daemon stop request acknowledged" };
      },
      STOP_DAEMON_META
    );

    // Handler for cleaning up tmux window when a session is deleted from the webapp
    this.rpcHandlerManager.registerHandler(
      "cleanup-tmux-session",
      async (params: CleanupTmuxSessionParams) => {
        const { sessionId, serverSessionId } = params || {};
        if (!sessionId) {
          throw new Error("Session ID is required");
        }

        logger.debug(
          `[API MACHINE] cleanup-tmux-session called for session: ${sessionId}`
        );
        const success = await stopTmuxSession(sessionId, serverSessionId);

        return {
          success,
          message: success
            ? "Tmux session cleaned up"
            : "Session not found in tmux store (may already be cleaned up)",
        };
      },
      CLEANUP_TMUX_SESSION_META
    );

    // #1603: Reap ONLY the launcher's hapimatic-remote window(s) for a session
    // tag. Distinct from cleanup-tmux-session (which also tears down the
    // window-A daemon window): archiveSession calls this on TERMINAL archives
    // to reap window B's live claude WITHOUT destroying the resume window.
    // Reuses #1600's reapRemoteLauncherWindows (tag-keyed via the pane's
    // HAPI_SESSION_ID, best-effort, no-ops for non-tmux launchers since the
    // hapimatic-remote tmux session won't exist).
    this.rpcHandlerManager.registerHandler(
      "reap-remote-window",
      async (params: ReapRemoteWindowParams) => {
        const { sessionId, serverSessionId } = params || {};
        if (!sessionId) {
          throw new Error("Session ID is required");
        }
        logger.debug(
          `[API MACHINE] reap-remote-window called for session: ${sessionId}`
        );
        const reaped = await reapRemoteLauncherWindows(
          sessionId,
          serverSessionId
        );
        return {
          success: true,
          reaped,
          message: `Reaped ${reaped} remote-launcher window(s)`,
        };
      },
      REAP_REMOTE_WINDOW_META
    );

    // Handler for renaming tmux window when session is renamed in webapp
    this.rpcHandlerManager.registerHandler(
      "rename-tmux-window",
      async (params: RenameTmuxWindowParams) => {
        const { sessionId, newName } = params || {};
        if (!sessionId) {
          throw new Error("Session ID is required");
        }
        if (!newName) {
          throw new Error("New name is required");
        }

        logger.debug(
          `[API MACHINE] rename-tmux-window called for session: ${sessionId} -> ${newName}`
        );
        const result = await renameTmuxWindow(sessionId, newName);

        return result;
      },
      RENAME_TMUX_WINDOW_META
    );

    // Issue #2683: tag a session's window as a deliberate archive-for-reconnect
    // (`@hapi_archive`) so the daemon's orphan reconciliation reaper preserves it.
    this.rpcHandlerManager.registerHandler(
      "set-archive-tag",
      async (params: { sessionId?: string }) => {
        const { sessionId } = params || {};
        if (!sessionId) {
          throw new Error("Session ID is required");
        }
        logger.debug(
          `[API MACHINE] set-archive-tag called for session: ${sessionId}`
        );
        return await setArchiveTag(sessionId);
      },
      SET_ARCHIVE_TAG_META
    );

    // Handler for cleaning up worktree + branch when a session is deleted from the webapp
    this.rpcHandlerManager.registerHandler(
      "cleanup-worktree",
      async (params: CleanupWorktreeParams) => {
        const { basePath, worktreePath, branch, sessionId } = params || {};
        if (!basePath) {
          throw new Error("basePath is required");
        }
        if (!branch) {
          throw new Error("branch is required");
        }

        // Issue #1382: reject malicious/malformed worktreePath BEFORE any
        // git/bash/rm side effects fire. Defense-in-depth — the function
        // body also re-validates for the three internal daemon callers in
        // cli/src/daemon/run.ts that bypass this RPC trust boundary.
        if (worktreePath !== undefined) {
          // Issue #1558: validate against the resolved worktree host base so a
          // relocated (NVMe) worktree path passes containment; the `..`-rejection
          // and out-of-base checks are unchanged. Default-off → basePath.
          const validation = isWithinWorktreeBase(
            resolveWorktreeHostBase(basePath),
            worktreePath
          );
          if (!validation.valid) {
            throw new Error(`Invalid worktreePath: ${validation.error}`);
          }
        }

        logger.debug(
          `[API MACHINE] cleanup-worktree called: branch=${branch} worktreePath=${worktreePath ?? "N/A"} sessionId=${sessionId ?? "N/A"}`
        );
        const result = await cleanupWorktreeAndBranch({
          basePath,
          worktreePath,
          branch,
          sessionId,
        });

        return {
          success: result.ok,
          message: result.ok
            ? "Worktree and branch cleaned up"
            : `Cleanup failed: ${(result as { error: string }).error}`,
        };
      },
      CLEANUP_WORKTREE_META
    );

    // #4450: the guarded removal behind the operator `remove_worktree` tool. Its
    // own method (not a flag on cleanup-worktree), so an older daemon never
    // registers it: the server's call fails as `daemon_unavailable` rather than
    // running the unguarded cleanup. The server derives every field from its
    // own session records.
    this.rpcHandlerManager.registerHandler(
      "cleanup-idle-worktree",
      async (params: unknown) => {
        const parsed = cleanupIdleWorktreeInput.safeParse(params ?? {});
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          return {
            success: false,
            message: `invalid_request: ${issue?.path.join(".") || "params"} ${issue?.message ?? "is invalid"}`,
          };
        }
        const result = await cleanupIdleWorktree(parsed.data);
        logger.debug(
          `[API MACHINE] cleanup-idle-worktree ${parsed.data.worktreePath}: ${result.ok ? "moved" : result.code}`
        );
        return result.ok
          ? {
              success: true,
              message: `Worktree moved to ${result.holdingPath}`,
              holdingPath: result.holdingPath,
              keptBranch: result.keptBranch,
            }
          : { success: false, message: `${result.code}: ${result.error}` };
      },
      CLEANUP_IDLE_WORKTREE_META
    );

    // Handler for looking up claudeSessionId from the daemon's persisted session store
    // Used by the server's reconnectSession() to recover missing claudeSessionId
    this.rpcHandlerManager.registerHandler(
      "get-session-claude-id",
      async (params: { hapiSessionId?: string }) => {
        const { hapiSessionId } = params || {};
        if (!hapiSessionId) {
          throw new Error("hapiSessionId is required");
        }

        const store = createSessionStore(configuration.happyHomeDir);
        const persisted = await store.get(hapiSessionId);

        return {
          claudeSessionId: persisted?.claudeSessionId ?? null,
        };
      },
      GET_SESSION_CLAUDE_ID_META
    );

    // Issue #1396: stale-claudeSessionId guard. Validates that Claude Code's
    // conversation store contains a JSONL file for the given session ID at the
    // given cwd before the server invokes `--resume <id>`. Returns `{ exists }`.
    // If absent, the server's reconnectSession clears claudeSessionId so the
    // existing spawn-fresh fall-through fires (see syncEngine.ts CRITICAL block).
    //
    // Path encoding is delegated to `getProjectPath` (canonical implementation
    // at `@/claude/utils/path`) which uses Claude Code's actual encoding rule:
    // `resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-")`. This replaces ALL
    // non-alphanumeric characters (including `.`, `_`, `-`) with `-`, not just
    // `/`. Critical for worktree cwds like `.../.worktrees/hapi-...` where the
    // dot in `.worktrees` must also be encoded.
    this.rpcHandlerManager.registerHandler(
      "has-claude-conversation",
      async (params: { cwd?: string; claudeSessionId?: string }) => {
        const { cwd, claudeSessionId } = params || {};
        if (!cwd || typeof cwd !== "string") {
          throw new Error("cwd is required");
        }
        if (!claudeSessionId || typeof claudeSessionId !== "string") {
          throw new Error("claudeSessionId is required");
        }

        const projectDir = getProjectPath(cwd);
        const conversationPath = join(projectDir, `${claudeSessionId}.jsonl`);

        return { exists: existsSync(conversationPath) };
      },
      HAS_CLAUDE_CONVERSATION_META
    );

    // Issue #3839 (D28): restore a soft-deleted worktree to its ORIGINAL path so
    // an orphaned transcript can be resumed where it ran. The caller names only
    // the path; the trash entry, repo root and branch all come from the entry's
    // own recorded metadata (see recoverWorktreeForOriginalPath).
    this.rpcHandlerManager.registerHandler(
      "recover-worktree",
      async (params: { originalPath?: unknown }) =>
        recoverWorktreeForOriginalPath(params?.originalPath),
      RECOVER_WORKTREE_META
    );

    // Issue #1661: liveness probe for the reconnect re-attach gate
    // (syncEngine.reconnectSession) and the 5-min force-kill watchdog
    // (syncEngine onForceKill). Unlike the two handlers above (stateless
    // store/fs reads), this needs the daemon's LIVE pidToTrackedSession map, so
    // it delegates to the `isSessionAlive` closure run.ts wires in via
    // setRPCHandlers. The closure is fault-tolerant (returns null on any
    // internal fault); a thrown error here is also caught by the RpcGateway,
    // which maps it to null — both paths satisfy the null-tolerant contract.
    this.rpcHandlerManager.registerHandler(
      "is-session-alive",
      async (params: { sessionTag?: string }) => {
        const { sessionTag } = params || {};
        if (!sessionTag) {
          throw new Error("sessionTag is required");
        }
        const alive = await isSessionAlive(sessionTag);
        return { alive };
      },
      IS_SESSION_ALIVE_META
    );

    // Issue #2299 (Task 3): capacity-probe machine RPC. Delegates to the run.ts
    // closure, which reads the daemon's LIVE credited count. Read-only — never
    // spawns or kills. Consumed by RpcGateway.probeCapacity for switchAccount's
    // pre-kill capacity pre-check.
    this.rpcHandlerManager.registerHandler(
      "capacity-probe",
      async (params: { creditHapiSessionId?: string }) => {
        const { creditHapiSessionId } = params || {};
        return await capacityProbe(creditHapiSessionId);
      },
      CAPACITY_PROBE_META
    );
  }

  async updateMachineMetadata(
    handler: (metadata: MachineMetadata | null) => MachineMetadata
  ): Promise<void> {
    await backoff(async () => {
      const updated = handler(this.machine.metadata);

      const answer = (await this.socket.emitWithAck("machine-update-metadata", {
        machineId: this.machine.id,
        metadata: updated,
        expectedVersion: this.machine.metadataVersion,
      })) as unknown;

      applyVersionedAck(answer, {
        valueKey: "metadata",
        parseValue: value => {
          const parsed = MachineMetadataSchema.safeParse(value);
          return parsed.success ? parsed.data : null;
        },
        applyValue: value => {
          this.machine.metadata = value;
        },
        applyVersion: version => {
          this.machine.metadataVersion = version;
        },
        logInvalidValue: (context, version) => {
          const suffix = context === "success" ? "ack" : "version-mismatch ack";
          logger.debug(
            `[API MACHINE] Ignoring invalid metadata value from ${suffix}`,
            { version }
          );
        },
        invalidResponseMessage: "Invalid machine-update-metadata response",
        errorMessage: "Machine metadata update failed",
        versionMismatchMessage: "Metadata version mismatch",
      });
    });
  }

  async updateDaemonState(
    handler: (state: DaemonState | null) => DaemonState
  ): Promise<void> {
    await backoff(async () => {
      const updated = handler(this.machine.daemonState);

      const answer = (await this.socket.emitWithAck("machine-update-state", {
        machineId: this.machine.id,
        daemonState: updated,
        expectedVersion: this.machine.daemonStateVersion,
      })) as unknown;

      applyVersionedAck(answer, {
        valueKey: "daemonState",
        parseValue: value => {
          const parsed = DaemonStateSchema.safeParse(value);
          return parsed.success ? parsed.data : null;
        },
        applyValue: value => {
          this.machine.daemonState = value;
        },
        applyVersion: version => {
          this.machine.daemonStateVersion = version;
        },
        logInvalidValue: (context, version) => {
          const suffix = context === "success" ? "ack" : "version-mismatch ack";
          logger.debug(
            `[API MACHINE] Ignoring invalid daemonState value from ${suffix}`,
            { version }
          );
        },
        invalidResponseMessage: "Invalid machine-update-state response",
        errorMessage: "Machine state update failed",
        versionMismatchMessage: "Daemon state version mismatch",
      });
    });
  }

  connect(): void {
    this.socket = io(`${configuration.serverUrl}/cli`, {
      transports: ["websocket"],
      auth: {
        token: this.token,
        clientType: "machine-scoped" as const,
        machineId: this.machine.id,
      },
      path: "/socket.io/",
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: Infinity,
    });

    this.socket.on("connect", () => {
      logger.debug("[API MACHINE] Connected to bot");
      this.rpcHandlerManager.onSocketConnect(this.socket);
      this.updateDaemonState(state => ({
        ...(state ?? {}),
        status: "running",
        pid: process.pid,
        httpPort: this.machine.daemonState?.httpPort,
        startedAt: Date.now(),
      })).catch(error => {
        logger.debug(
          "[API MACHINE] Failed to update daemon state on connect",
          error
        );
      });
      this.startKeepAlive();
      // Send immediate alive signal to prevent server-side expiry during reconnection gap
      this.socket
        .emitWithAck("machine-alive", {
          machineId: this.machine.id,
          time: Date.now(),
        })
        .then(() => {
          this.consecutiveUnackedHeartbeats = 0;
        })
        .catch(() => {
          logger.debug("[API MACHINE] Immediate alive ack failed on connect");
        });
      this.consecutiveDisconnectedChecks = 0;
      this.startWatchdog();
    });

    this.socket.on("disconnect", reason => {
      logger.debug(`[API MACHINE] Disconnected from bot, reason: ${reason}`);
      this.rpcHandlerManager.onSocketDisconnect();
      this.stopKeepAlive();
    });

    this.socket.on(
      "rpc-request",
      async (
        data: { method: string; params: string },
        callback: (response: string) => void
      ) => {
        callback(await this.rpcHandlerManager.handleRequest(data));
      }
    );

    this.socket.on("update", (data: Update) => {
      if (data.body.t !== "update-machine") {
        return;
      }

      const update = data.body as UpdateMachineBody;
      if (update.machineId !== this.machine.id) {
        return;
      }

      if (update.metadata) {
        const parsed = MachineMetadataSchema.safeParse(update.metadata.value);
        if (parsed.success) {
          this.machine.metadata = parsed.data;
        } else {
          logger.debug("[API MACHINE] Ignoring invalid metadata update", {
            version: update.metadata.version,
          });
        }
        this.machine.metadataVersion = update.metadata.version;
      }

      if (update.daemonState) {
        const next = update.daemonState.value;
        if (next == null) {
          this.machine.daemonState = null;
        } else {
          const parsed = DaemonStateSchema.safeParse(next);
          if (parsed.success) {
            this.machine.daemonState = parsed.data;
          } else {
            logger.debug("[API MACHINE] Ignoring invalid daemonState update", {
              version: update.daemonState.version,
            });
          }
        }
        this.machine.daemonStateVersion = update.daemonState.version;
      }
    });

    this.socket.on("connect_error", error => {
      logger.debug(`[API MACHINE] Connection error: ${error.message}`);
    });

    this.socket.on("error", payload => {
      logger.debug("[API MACHINE] Socket error:", payload);
    });

    // Reconnection lifecycle events (on socket.io Manager)
    this.socket.io.on("reconnect_attempt", attempt => {
      logger.debug(`[API MACHINE] Reconnection attempt #${attempt}`);
    });

    this.socket.io.on("reconnect_error", error => {
      logger.debug(`[API MACHINE] Reconnection error: ${error.message}`);
    });

    this.socket.io.on("reconnect", attempt => {
      logger.debug(`[API MACHINE] Reconnected after ${attempt} attempt(s)`);
    });
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    this.consecutiveUnackedHeartbeats = 0;
    let keepAliveCount = 0;
    this.keepAliveInterval = setInterval(() => {
      keepAliveCount++;
      this.consecutiveUnackedHeartbeats++;

      // Log every 3rd keep-alive (every 60s) to confirm interval is running
      if (keepAliveCount % 3 === 0) {
        logger.debug(
          `[API MACHINE] keep-alive #${keepAliveCount} connected=${this.socket.connected} unacked=${this.consecutiveUnackedHeartbeats}`
        );
      }

      // Use emitWithAck to get server confirmation
      this.socket
        .emitWithAck("machine-alive", {
          machineId: this.machine.id,
          time: Date.now(),
        })
        .then(() => {
          this.consecutiveUnackedHeartbeats = 0;
        })
        .catch(() => {
          // Ack failed — server may not support ack yet, or connection is dead
          logger.debug(
            `[API MACHINE] keep-alive ack failed (unacked=${this.consecutiveUnackedHeartbeats})`
          );
        });

      // If 3+ consecutive heartbeats go unacknowledged (60s+), force reconnect
      if (this.consecutiveUnackedHeartbeats >= 3 && !this.isShuttingDown) {
        logger.debug(
          `[API MACHINE] keep-alive: ${this.consecutiveUnackedHeartbeats} unacked heartbeats, forcing reconnect`
        );
        this.consecutiveUnackedHeartbeats = 0;
        try {
          this.socket.disconnect();
        } catch {
          // Ignore disconnect errors
        }
        this.socket.connect();
      }
    }, 20_000);
  }

  private stopKeepAlive(): void {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    this.consecutiveDisconnectedChecks = 0;
    this.watchdogInterval = setInterval(() => {
      if (this.isShuttingDown) return;

      if (!this.socket.connected) {
        this.consecutiveDisconnectedChecks++;
        logger.debug(
          `[API MACHINE] Watchdog: socket disconnected (check #${this.consecutiveDisconnectedChecks})`
        );

        // After 3 consecutive checks (90s), force reconnection
        if (this.consecutiveDisconnectedChecks >= 3) {
          logger.debug(
            "[API MACHINE] Watchdog: forcing socket reconnection after prolonged disconnect"
          );
          this.consecutiveDisconnectedChecks = 0;
          try {
            this.socket.disconnect();
          } catch {
            // Ignore disconnect errors during forced reconnect
          }
          this.socket.connect();
        }
      } else {
        this.consecutiveDisconnectedChecks = 0;
      }
    }, 30_000);
  }

  private stopWatchdog(): void {
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
      this.watchdogInterval = null;
    }
  }

  shutdown(): void {
    this.isShuttingDown = true;
    this.stopKeepAlive();
    this.stopWatchdog();
    if (this.socket) {
      this.socket.close();
    }
  }
}

export type RecoverWorktreeForPathResult =
  | { ok: true; worktreePath: string; branch: string }
  | {
      ok: false;
      code:
        | "invalid_path"
        | "not_a_worktree_path"
        | "destination_exists"
        | "not_in_trash"
        | "recover_failed";
      error: string;
    };

async function pathExistsOnDisk(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Issue #3839 (D28): recover the soft-deleted worktree whose RECORDED original
 * path is `originalPath`. Safety contract (the RPC trust boundary):
 *  - the caller supplies only an absolute `<hostBase>/.worktrees/<name>` path;
 *    it is containment-checked (`isWithinWorktreeBase`) before any disk access;
 *  - the trash entry is selected by exact match on its recorded `originalPath`
 *    — a caller can never name a holding dir, and the repo root passed to
 *    `recoverWorktree` is the entry's own recorded `basePath` (verified to
 *    resolve to the same host base, so the move never crosses trash dirs);
 *  - an existing destination is refused up front (and `recoverWorktree`
 *    re-checks); nothing is deleted or overwritten — `git worktree move` from
 *    the trash is the only mutation, plus removal of that entry's own
 *    `.meta.json`; no branch is created, renamed or deleted.
 */
export async function recoverWorktreeForOriginalPath(
  originalPath: unknown
): Promise<RecoverWorktreeForPathResult> {
  if (
    typeof originalPath !== "string" ||
    !isAbsolute(originalPath) ||
    originalPath.includes("\0")
  ) {
    return {
      ok: false,
      code: "invalid_path",
      error: "originalPath must be an absolute path",
    };
  }
  const target = resolve(originalPath);
  const marker = `${sep}.worktrees${sep}`;
  const at = target.lastIndexOf(marker);
  if (at <= 0) {
    return {
      ok: false,
      code: "not_a_worktree_path",
      error: `Not a worktree path: ${target}`,
    };
  }
  const hostBase = target.slice(0, at);
  const contained = isWithinWorktreeBase(hostBase, target);
  if (!contained.valid) {
    return {
      ok: false,
      code: "invalid_path",
      error: `Invalid worktree path: ${contained.error}`,
    };
  }
  if (await pathExistsOnDisk(target)) {
    return {
      ok: false,
      code: "destination_exists",
      error: `Refusing to recover: ${target} already exists`,
    };
  }

  const entries = (await listSoftDeletedWorktrees(hostBase))
    .filter(e => typeof e.originalPath === "string")
    .filter(e => resolve(e.originalPath) === target)
    .filter(e => resolveWorktreeHostBase(e.basePath) === hostBase)
    .sort((a, b) => Date.parse(b.deletedAt) - Date.parse(a.deletedAt));
  const entry = entries[0];
  if (!entry) {
    return {
      ok: false,
      code: "not_in_trash",
      error: `No soft-deleted worktree recorded for ${target}`,
    };
  }

  const result = await recoverWorktree({
    basePath: entry.basePath,
    holdingName: entry.holdingName,
  });
  if (!result.ok) {
    const occupied = result.error.startsWith("Original path is occupied");
    return {
      ok: false,
      code: occupied ? "destination_exists" : "recover_failed",
      error: result.error,
    };
  }
  return {
    ok: true,
    worktreePath: result.info.worktreePath,
    branch: result.info.branch,
  };
}
