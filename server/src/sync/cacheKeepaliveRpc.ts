// SPDX-License-Identifier: AGPL-3.0-only
import {
  CacheKeepaliveResponseSchema,
  type CacheKeepaliveResponse,
} from "@hapi/protocol";

/**
 * Issue #6169: one `cache-keepalive` call to a session's CLI, never throwing.
 * `call` sends the params over the session RPC path. The CLI's own shaped reply
 * passes through. Nothing reached the model when the method is not registered,
 * the socket has gone, or the CLI answers "Method not found" (a pty/tmux/local
 * session, or a process that exited): `no_active_query`. A handler error reply
 * (`{type:"error", errorMessage}`), a transport error, a timeout or an
 * unparseable reply answers `side_question_failed` with the reason.
 */

const NOT_SENT = [
  "RPC handler not registered",
  "RPC socket disconnected",
  "Method not found",
];

function notSent(message: string): boolean {
  return NOT_SENT.some(m => message.includes(m));
}
export async function cacheKeepaliveRpc(
  call: (params: { deadlineAt: number }) => Promise<unknown>,
  request: { deadlineAt: number }
): Promise<CacheKeepaliveResponse> {
  try {
    const result = await call({ deadlineAt: request.deadlineAt });
    const parsed = CacheKeepaliveResponseSchema.safeParse(result);
    if (parsed.success) return parsed.data;
    const reply = result as { type?: unknown; errorMessage?: unknown } | null;
    if (reply && typeof reply === "object" && reply.type === "error") {
      const message =
        typeof reply.errorMessage === "string"
          ? reply.errorMessage
          : "RPC error reply";
      return {
        ok: false,
        code: notSent(message) ? "no_active_query" : "side_question_failed",
        error: message,
      };
    }
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      code: "side_question_failed",
      error: `malformed RPC response${
        issue ? ` (${issue.path.join(".") || "root"}: ${issue.message})` : ""
      }`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      code: notSent(message) ? "no_active_query" : "side_question_failed",
      error: message,
    };
  }
}
