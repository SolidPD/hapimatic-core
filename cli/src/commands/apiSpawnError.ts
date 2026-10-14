// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Pure helpers for the `hapi api sessions spawn` client-side error path (#1559).
 *
 * Extracted so the spawn-timeout budget, the axios-timeout classifier, and the
 * actionable timeout message are unit-testable WITHOUT mocking the network — the
 * CLI test convention is "no mocking; test extracted pure functions" (see
 * cli/CLAUDE.md and the apiErrorLogs.ts precedent).
 *
 * Context: a slow-but-successful daemon spawn (cold Claude on a Pi 5, CIFS
 * worktree creation) can exceed the historical 30s client ceiling while the
 * daemon ultimately completes the spawn and the session attaches. The bare
 * "timeout of 30000ms exceeded" then reads as a hard failure even though the
 * session is fine. We raise the ceiling and clarify the message.
 */

/**
 * Spawn-specific client timeout (ms). Sits ABOVE the server's spawn-RPC ack
 * budget (`rpcGateway.ts` `SPAWN_RPC_TIMEOUT_MS = 75_000`) and matches the web
 * client's `SPAWN_TIMEOUT_MS = 90_000`, so the SERVER — not the CLI client — is
 * the binding constraint. The client therefore receives the server's structured
 * response/error rather than abandoning a slow-but-valid spawn. All OTHER CLI
 * timeouts (send/branch/abort 30s, list/messages 10s) stay unchanged — the raise
 * is spawn-scoped, not global.
 */
export const SPAWN_CLIENT_TIMEOUT_MS = 90_000;

/**
 * True when `error` is an axios client-side request-timeout abort — the
 * user-reported "timeout of Nms exceeded" class. Axios sets `code` to
 * `"ECONNABORTED"` on a request timeout; some environments surface
 * `"ETIMEDOUT"`. A server error response (`error.response`) or a connection
 * refusal (`"ECONNREFUSED"`) is NOT a client timeout and must fall through to
 * normal error surfacing (R2).
 */
export function isAxiosTimeout(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === "ECONNABORTED" || code === "ETIMEDOUT";
}

/**
 * Actionable message for a spawn that exceeded the client wait. Distinguishes
 * "the daemon may still be completing — check the session list" from a hard
 * failure (R3), so the user never sees a bare "timeout of 30000ms exceeded".
 */
export function spawnTimeoutMessage(timeoutMs: number): string {
  const seconds = Math.round(timeoutMs / 1000);
  return (
    `Spawn request exceeded the client wait (${seconds}s). ` +
    `The daemon may still be completing the spawn — run ` +
    "`hapi api sessions list` to check whether the session attached before retrying."
  );
}
