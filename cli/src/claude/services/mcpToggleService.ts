// SPDX-License-Identifier: AGPL-3.0-only
/**
 * MCP toggle service — extracted from launchers (issue #1101).
 *
 * Owns three concerns the launcher layer used to inline:
 *
 * 1. **Transport**: payload validation against {@link McpToggleRequestSchema}.
 * 2. **Policy**: try the active SDK Query, fall back to durable
 *    `~/.claude.json` write, and decide which response shape to emit.
 * 3. **Persistence**: delegating to {@link applyDisabledServerToggle}
 *    and mapping its error classes to {@link McpToggleErrorCode} values.
 *
 * The service is stateless. Three factory functions produce closure-based
 * RPC handlers that match the four launcher call sites:
 *
 * - {@link createRuntimeRemoteHandler} — remote-mode runtime (full path)
 * - {@link createCleanupHandler}       — both launchers' cleanup paths
 * - {@link createLocalModeRejectionHandler} — local-mode runtime
 *
 * `getQuery` is a callback (not a value) because the launcher mutates
 * `currentQuery` between turns; the service must read it on every
 * invocation, not at handler-creation.
 */

import { McpToggleRequestSchema } from "@hapi/protocol/schemas";
import type {
  McpToggleErrorCode,
  McpToggleResponse,
} from "@hapi/protocol/types";
import {
  applyDisabledServerToggle,
  ConfigCorruptError,
  ConfigLockTimeoutError,
  UnsafePathError,
} from "../utils/projectMcpConfig";
import { findCanonicalGitRoot } from "../utils/canonicalGitRoot";
import { isolatedConfigPath } from "@/accounts/accountConfigDir";
import { SdkRequestError, type Query } from "../sdk";
import { logger } from "@/ui/logger";

const INVALID_PAYLOAD: McpToggleResponse = {
  ok: false,
  error: "Invalid mcp-toggle payload",
  code: "invalid_request",
};

const LOCAL_MODE_NOT_SUPPORTED: McpToggleResponse = {
  ok: false,
  error: "MCP toggle is currently supported only for remote-mode sessions",
  code: "local_mode_not_supported",
};

/**
 * Map an error thrown by {@link applyDisabledServerToggle} to its canonical
 * {@link McpToggleErrorCode}. Centralized so all launcher call sites emit
 * identical error codes for identical thrown classes.
 */
function configWriteErrorToCode(err: Error): McpToggleErrorCode {
  if (err instanceof ConfigLockTimeoutError) return "config_lock_timeout";
  if (err instanceof ConfigCorruptError) return "config_corrupt";
  if (err instanceof UnsafePathError) return "unsafe_path";
  return "transport_failed";
}

/**
 * Finding 6 (hp#2142) — durable MCP-disabled write to EVERY config Claude Code
 * might read for this session:
 *  - keyed by the CANONICAL GIT ROOT (what CC + the #1347/#2364 spawn scrub use),
 *    NOT the raw session cwd — a worktree cwd has no `disabledMcpServers` key of
 *    its own, so a cwd-keyed write is one CC never reads; and
 *  - to BOTH the home `~/.claude.json` AND, for an account-bound session
 *    (`HAPI_ACCOUNT_UUID`), the ISOLATED `<accountConfigsDir>/<uuid>/.claude.json`
 *    that `claude` actually reads under `CLAUDE_CONFIG_DIR`. A home-only write
 *    silently no-ops for account-bound sessions — the pre-fix "toggle does
 *    nothing" bug. The home write keeps the (unbound) status pollers in sync.
 *
 * Mirrors {@link scrubHapiFromDisabledMcps}. The home write's error is RETURNED
 * (callers map it to an {@link McpToggleErrorCode}); the isolated write is
 * best-effort — a missing isolated config is benign (host-default session), any
 * other failure is reported at WARN (it is the file CC reads).
 */
async function applyDurableDisabledToggle(
  sessionPath: string,
  serverName: string,
  enabled: boolean,
  sessionId?: string | null
): Promise<{ homeError: Error | null }> {
  const canonicalRoot = findCanonicalGitRoot(sessionPath) ?? sessionPath;

  let homeError: Error | null = null;
  try {
    await applyDisabledServerToggle(canonicalRoot, serverName, enabled);
  } catch (err) {
    homeError = err instanceof Error ? err : new Error(String(err));
  }

  // Account-bound isolated write (#2364) — the file CC actually reads. Skip when
  // the home write already failed the shared path validation (same path).
  const accountUuid = process.env.HAPI_ACCOUNT_UUID;
  if (accountUuid && !(homeError instanceof UnsafePathError)) {
    try {
      await applyDisabledServerToggle(
        canonicalRoot,
        serverName,
        enabled,
        isolatedConfigPath(accountUuid)
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/not found/i.test(message)) {
        logger.debug(
          `[mcp-toggle] no isolated config for ${canonicalRoot} (${message}); home write authoritative`
        );
      } else {
        logger.reportError({
          message: `MCP toggle isolated-config write failed: ${message}`,
          category: "mcp-toggle-isolated-config-write",
          severity: "warn",
          sessionId: sessionId ?? null,
          context: JSON.stringify({
            projectDir: canonicalRoot,
            serverName,
            enabled,
            consequence:
              "account-bound session may not see the toggle until re-toggled",
          }),
        });
      }
    }
  }

  return { homeError };
}

export interface RuntimeRemoteHandlerOptions {
  /** Project directory passed verbatim to {@link applyDisabledServerToggle}. */
  sessionPath: string;
  /**
   * Session ID for `logger.reportError` context. Nullable because
   * `Session.sessionId` is `string | null` (a session can exist before
   * Claude Code has minted its UUID).
   */
  sessionId: string | null;
  /**
   * Read the active SDK Query at handler-invocation time. The launcher
   * mutates `currentQuery` as the session moves between turns; reading
   * via callback ensures we never dispatch to a stale Query reference.
   */
  getQuery: () => Query | null;
}

export interface CleanupHandlerOptions {
  /** Project directory passed verbatim to {@link applyDisabledServerToggle}. */
  sessionPath: string;
}

/**
 * Build the runtime mcp-toggle handler for a remote-mode session.
 *
 * Always writes the durable layer (`~/.claude.json`) first so the toggle
 * survives SDK process restarts — Claude Code re-reads its config on every
 * spawn. Bails before the SDK call on {@link UnsafePathError} (issue #1098).
 * On SDK success with a stale config-write error, surfaces the swallowed
 * write failure via `logger.reportError` so the user can see why a toggle
 * didn't stick across the next spawn.
 */
export function createRuntimeRemoteHandler(
  opts: RuntimeRemoteHandlerOptions
): (payload: unknown) => Promise<McpToggleResponse> {
  return async (payload: unknown): Promise<McpToggleResponse> => {
    const parsed = McpToggleRequestSchema.safeParse(payload);
    if (!parsed.success) return INVALID_PAYLOAD;

    const { homeError: configWriteError } = await applyDurableDisabledToggle(
      opts.sessionPath,
      parsed.data.serverName,
      parsed.data.enabled,
      opts.sessionId
    );

    if (configWriteError instanceof UnsafePathError) {
      return {
        ok: false,
        error: configWriteError.message,
        code: "unsafe_path",
      };
    }

    const query = opts.getQuery();
    if (query) {
      try {
        await query.mcpToggle(parsed.data.serverName, parsed.data.enabled);
        if (configWriteError) {
          const corrupt = configWriteError instanceof ConfigCorruptError;
          const lockTimeout =
            configWriteError instanceof ConfigLockTimeoutError;
          logger.reportError({
            message: `MCP toggle config write failed: ${configWriteError.message}`,
            category: lockTimeout
              ? "mcp-toggle-config-lock-timeout"
              : corrupt
                ? "mcp-toggle-config-corrupt"
                : "mcp-toggle-config-write",
            severity: "warn",
            sessionId: opts.sessionId,
            context: JSON.stringify({
              projectDir: opts.sessionPath,
              serverName: parsed.data.serverName,
              enabled: parsed.data.enabled,
              consequence:
                "SDK in-memory toggle applied; reverts on next spawn",
              configCorrupt: corrupt,
              configLockTimeout: lockTimeout,
            }),
          });
        }
        return { ok: true, method: "sdk" };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Prefer the structured `code` carried by SdkRequestError when
        // present (issue #1104). The /not found/i regex remains for
        // upstream Claude Code error responses that don't carry a code yet.
        const code: McpToggleErrorCode =
          err instanceof SdkRequestError && err.code === "claude_exited"
            ? "claude_exited"
            : /not found/i.test(message)
              ? "server_not_found"
              : "transport_failed";
        return { ok: false, error: message, code };
      }
    }

    // No active SDK Query — config write is the durable record.
    if (configWriteError) {
      return {
        ok: false,
        error: configWriteError.message,
        code: configWriteErrorToCode(configWriteError),
      };
    }
    return { ok: true, method: "config" };
  };
}

/**
 * Build the cleanup-time mcp-toggle handler.
 *
 * Used by both launchers' cleanup paths so a toggle RPC arriving during
 * teardown still applies durably to `~/.claude.json` instead of being
 * silently dropped (#1105 — local-launcher symmetry was the predecessor).
 * No SDK Query is reachable during cleanup, so the SDK path is omitted.
 */
export function createCleanupHandler(
  opts: CleanupHandlerOptions
): (payload: unknown) => Promise<McpToggleResponse> {
  return async (payload: unknown): Promise<McpToggleResponse> => {
    const parsed = McpToggleRequestSchema.safeParse(payload);
    if (!parsed.success) return INVALID_PAYLOAD;

    const { homeError } = await applyDurableDisabledToggle(
      opts.sessionPath,
      parsed.data.serverName,
      parsed.data.enabled
    );
    if (homeError) {
      return {
        ok: false,
        error: homeError.message,
        code: configWriteErrorToCode(homeError),
      };
    }
    return { ok: true, method: "config" };
  };
}

/**
 * Build the runtime mcp-toggle handler for a local-mode session.
 *
 * Local mode runs Claude's interactive Ink TUI on the inherited PTY —
 * there is no SDK control_request channel to dispatch to. Toggle requests
 * during local mode return `local_mode_not_supported` so callers can fall
 * back to typing `/mcp enable/disable` directly in the session UI. See
 * issue #1077 (mode-aware control protocol).
 *
 * Stateless and takes no parameters because the rejection is constant.
 */
export function createLocalModeRejectionHandler(): () => Promise<McpToggleResponse> {
  return async (): Promise<McpToggleResponse> => LOCAL_MODE_NOT_SUPPORTED;
}
