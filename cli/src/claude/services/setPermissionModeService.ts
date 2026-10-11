// SPDX-License-Identifier: MIT
/**
 * set-permission-mode service (issue #2346) — the CLI-side RPC handler factories
 * for the `set-permission-mode` control route.
 *
 * Mirrors {@link mcpToggleService} structurally (launcher-registered, stateless
 * factories, a `getQuery` callback read fresh per invocation), but is simpler:
 * there is NO durable config-write path here. The durable permission-mode pin is
 * owned by runClaude's set-session-config branch / the shared applier (ruling
 * D2), NOT this route — so this service only routes to the live query.
 *
 * Two factories match the launcher call sites:
 * - {@link createRuntimeRemoteHandler} — SDK remote-mode runtime (delegates to
 *   runClaude's applier via the session-carried bridge, published by the launcher
 *   as `applyInPlace`). Rejects `no_active_query` when no live Query is present.
 * - {@link createLocalModeRejectionHandler} — tmux/pty/local launchers, which
 *   have no SDK control channel → `local_mode_not_supported` (→ HTTP 501).
 *
 * `getQuery` is a callback (not a value) because the launcher mutates its
 * `currentQuery` between turns; the service must read it on every invocation.
 * It is used ONLY as the no_active_query sentinel — the actual live-query call is
 * performed inside `applyInPlace` (which shares the accessor with the set-session-
 * config path), so the mode is delivered to the live query exactly once.
 */

import { SetPermissionModeRequestSchema } from "@hapi/protocol/schemas";
import type {
  ClaudePermissionMode,
  SetPermissionModeErrorCode,
  SetPermissionModeResponse,
} from "@hapi/protocol/types";
import { SdkRequestError, type Query } from "../sdk";

const INVALID_PAYLOAD: SetPermissionModeResponse = {
  ok: false,
  error: "Invalid set-permission-mode payload",
  code: "invalid_request",
};

const NO_ACTIVE_QUERY: SetPermissionModeResponse = {
  ok: false,
  error: "No active Claude query to apply the permission mode to",
  code: "no_active_query",
};

const LOCAL_MODE_NOT_SUPPORTED: SetPermissionModeResponse = {
  ok: false,
  error:
    "set-permission-mode is currently supported only for remote-mode (SDK) sessions",
  code: "local_mode_not_supported",
};

export interface RuntimeRemoteHandlerOptions {
  /**
   * Read the active SDK Query at handler-invocation time. The launcher mutates
   * `currentQuery` as the session moves between turns; reading via callback
   * ensures we never dispatch to a stale Query. Used here ONLY as the
   * no_active_query sentinel — the live-query call is inside `applyInPlace`.
   */
  getQuery: () => Query | null;
  /**
   * runClaude's shared in-place applier (issue #2346 ruling D2, Task 5),
   * published onto the Session by the launcher via
   * `session.getPermissionModeApplier()`. Does the full R3 resync
   * (currentPermissionMode + durable pin + syncSessionModes) AND fires
   * Query.setPermissionMode on the live query via the accessor, returning the
   * method actually used. Throws {@link SdkRequestError} on a live-query failure.
   */
  applyInPlace: (
    mode: ClaudePermissionMode
  ) => Promise<{ method: "sdk" | "config" }>;
}

/**
 * Build the runtime set-permission-mode handler for a remote-mode session.
 * Validates the payload, rejects with `no_active_query` when no live Query is
 * present, otherwise delegates to runClaude's shared applier (which resyncs the
 * durable/display state AND fires the live control_request). Maps a thrown
 * SdkRequestError to `claude_exited` / `transport_failed` exactly like
 * mcpToggleService.
 */
export function createRuntimeRemoteHandler(
  opts: RuntimeRemoteHandlerOptions
): (payload: unknown) => Promise<SetPermissionModeResponse> {
  return async (payload: unknown): Promise<SetPermissionModeResponse> => {
    const parsed = SetPermissionModeRequestSchema.safeParse(payload);
    if (!parsed.success) return INVALID_PAYLOAD;

    if (!opts.getQuery()) return NO_ACTIVE_QUERY;

    try {
      const { method } = await opts.applyInPlace(parsed.data.mode);
      // The applier reads the live-query accessor (same source as getQuery). If
      // it degraded to "config", the query vanished between the sentinel check
      // and the apply — surface that as no_active_query rather than claiming sdk.
      if (method === "config") return NO_ACTIVE_QUERY;
      return { ok: true, method: "sdk" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code: SetPermissionModeErrorCode =
        err instanceof SdkRequestError && err.code === "claude_exited"
          ? "claude_exited"
          : "transport_failed";
      return { ok: false, error: message, code };
    }
  };
}

/**
 * Build the runtime set-permission-mode handler for a local / tmux / pty session.
 * Those launchers run Claude without an SDK control_request channel, so there is
 * no live query to mutate — return `local_mode_not_supported` (→ HTTP 501),
 * exactly as mcpToggleService does. Stateless; the rejection is constant.
 */
export function createLocalModeRejectionHandler(): () => Promise<SetPermissionModeResponse> {
  return async (): Promise<SetPermissionModeResponse> =>
    LOCAL_MODE_NOT_SUPPORTED;
}
