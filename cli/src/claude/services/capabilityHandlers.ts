// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Testable factories for the readonly control capabilities migrated through the
 * capability registry in issue #2421 (epic #2416, Sub-Issue E).
 *
 * Mirrors the `mcpToggleService` factory pattern (#1101): the launcher
 * registration stays a thin `registerHandler(name, factory(...), META)` call
 * while the handler logic — especially `get-context-usage`'s idle
 * `no_active_query` branch (expert-review ruling 1B-27) — is unit-testable in
 * isolation. `getQuery` and `poll` are injected so a test drives the idle /
 * active / unavailable paths without instantiating the launcher or a socket.
 */
import type { Query } from "../sdk";
import type { ContextUsagePayload } from "../sdk/types";
import { pollMcpStatus } from "@/daemon/mcpStatusPoller";
import type { McpStatusUpdate } from "@hapi/protocol";

/**
 * Response shape for `get-context-usage`. A discriminated union so a consumer
 * branches on `ok`. On idle/failure the `code` is a CLI-side response code that
 * the #2419 invoke gate forwards verbatim inside `data` (capabilityPolicy
 * 1B-14) — it is NOT a transport error.
 */
export type GetContextUsageResponse =
  | { ok: true; usage: ContextUsagePayload }
  | {
      ok: false;
      code: "no_active_query" | "context_usage_error";
      error: string;
    };

export interface GetContextUsageHandlerOptions {
  /**
   * Callback (not a value) so the handler reads the LATEST `Query` at each
   * invocation. `currentQuery` is null at registration time, set when a query
   * starts and cleared when it ends — closing over a value would capture the
   * null. Same rationale as mcpToggleService's `getQuery`.
   */
  getQuery: () => Query | null;
}

/**
 * `get-context-usage` (readonly) — the session's live context-window usage.
 * Wraps the already-built `Query.getContextUsage()` (issue #1469). Idle (no
 * active query) → CLI-shaped `no_active_query`; a throw from the SDK call →
 * `context_usage_error` carrying the underlying message.
 */
export function createGetContextUsageHandler(
  opts: GetContextUsageHandlerOptions
): () => Promise<GetContextUsageResponse> {
  return async (): Promise<GetContextUsageResponse> => {
    const query = opts.getQuery();
    if (!query) {
      return {
        ok: false,
        code: "no_active_query",
        error:
          "No active Claude query — context usage is unavailable while the session is idle.",
      };
    }
    try {
      const usage = await query.getContextUsage();
      return { ok: true, usage };
    } catch (err) {
      return {
        ok: false,
        code: "context_usage_error",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };
}

/**
 * Response shape for `mcp-status`.
 */
export type McpStatusResponse =
  | { ok: true; status: McpStatusUpdate }
  | { ok: false; code: "mcp_status_unavailable"; error: string };

export interface McpStatusHandlerOptions {
  /** The session's working directory — the cwd `claude mcp list` runs in. */
  sessionPath: string;
  /** Injectable for tests; defaults to the real `pollMcpStatus`. */
  poll?: (cwd?: string) => Promise<McpStatusUpdate | null>;
}

/**
 * `mcp-status` (readonly) — the session's live MCP server status, read from the
 * EXISTING live source (`pollMcpStatus` → `claude mcp list` in the session
 * cwd). No Query control_request bridge: no `mcp_status` subtype exists in
 * `sdk/types.ts` (expert-review ruling 1B-28).
 */
export function createMcpStatusHandler(
  opts: McpStatusHandlerOptions
): () => Promise<McpStatusResponse> {
  const poll = opts.poll ?? pollMcpStatus;
  return async (): Promise<McpStatusResponse> => {
    const status = await poll(opts.sessionPath);
    if (!status) {
      return {
        ok: false,
        code: "mcp_status_unavailable",
        error: "MCP status could not be read for this session.",
      };
    }
    return { ok: true, status };
  };
}
