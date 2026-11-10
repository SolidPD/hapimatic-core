// SPDX-License-Identifier: MIT AND AGPL-3.0-only
/**
 * Dedicated HTTP server for receiving Claude session hooks.
 *
 * This server receives notifications from Claude when sessions change
 * (new session, resume, compact, fork, etc.) via the SessionStart hook.
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from "node:http";
import { randomBytes } from "node:crypto";
import { logger } from "@/ui/logger";

/**
 * Data received from Claude's SessionStart hook.
 */
export interface SessionHookData {
  session_id?: string;
  sessionId?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  source?: string;
  // Issue #1653: Notification hook payload fields. `notification_type`
  // discriminates the prompt class (verified live against Claude Code 2.1.170:
  // `permission_prompt` for permission asks, `idle_prompt` for idle waits);
  // `message` is the user-facing notification text (e.g. "Claude needs your
  // permission"). Both are surfaced to the blocked-on-TUI-prompt banner.
  notification_type?: string;
  message?: string;
  [key: string]: unknown;
}

/**
 * Issue #1653: classify a Notification hook payload as a genuinely TUI-blocking
 * prompt (the user MUST answer in the terminal) versus a non-blocking
 * notification (e.g. `idle_prompt` — Claude is merely waiting at an empty
 * prompt; the user can keep typing in the web chat). The v1 allowlist is the
 * single source of truth for the message-class filter (issue #1653 Key
 * Decision 5 / Risk 2 — kept in ONE tested function rather than scattered
 * substring checks).
 *
 * Verified live (coverage matrix, Claude Code 2.1.269):
 *   - `permission_prompt`  → blocking     → SHOW banner
 *   - `elicitation_dialog` → blocking     → SHOW banner
 *   - `idle_prompt`        → not blocking → suppress (R4: no false positives)
 *
 * `elicitation_dialog` is the MCP-elicitation notification type — message
 * "Claude Code needs your input" — fired by the in-TUI elicitation dialog
 * after a ~6s delay via the same `Jgq`→`A58`→`yr` Notification-hook path as
 * `permission_prompt` (issue #1821, re-verified against Claude Code 2.1.269).
 * Its completion/response siblings (`elicitation_complete`,
 * `elicitation_response`) and `auth_success` are deliberately EXCLUDED — they
 * are status signals, not input-blocking prompts. A conservative allowlist
 * yields zero false positives; add a new type here only once its live
 * `notification_type` is observed to be genuinely input-blocking.
 */
export const BLOCKING_NOTIFICATION_TYPES: ReadonlySet<string> = new Set([
  "permission_prompt",
  "elicitation_dialog",
]);

export function isBlockingPromptNotification(data: SessionHookData): boolean {
  return (
    typeof data.notification_type === "string" &&
    BLOCKING_NOTIFICATION_TYPES.has(data.notification_type)
  );
}

/** A Stop hook answer that keeps the turn going (#6455). */
export type StopHookDecision = { decision: "block"; reason: string };

/** How long the Stop branch waits for `onStopDecision` before it lets the turn end. */
export const STOP_DECISION_TIMEOUT_MS = 4000;

export interface HookServerOptions {
  /** Called when a session hook is received with a valid session ID. */
  onSessionHook: (sessionId: string, data: SessionHookData) => void;
  /**
   * Issue #1611: called when a Claude lifecycle hook signals a thinking-state
   * change — `true` on UserPromptSubmit (Claude began working), `false` on Stop
   * (Claude finished, awaiting the user). Lets terminal-attached launchers
   * (pty/tmux) drive the session status dot without an SDK message stream.
   */
  onThinkingChange?: (thinking: boolean) => void;
  /**
   * Issue #1653: called when Claude's TUI fires a Notification hook (e.g. a
   * permission prompt is waiting for a terminal answer). Under the tmux/pty
   * launchers these prompts render ONLY in the TUI — invisible to the web chat,
   * which otherwise shows perpetual "thinking" (the frozen-session signature).
   * The consumer (runClaude, non-sdk launchers only) filters the payload via
   * `isBlockingPromptNotification` and drives the blocked-on-TUI-prompt banner.
   * The full payload is passed so the consumer can read `notification_type`
   * and `message`.
   */
  onNotification?: (data: SessionHookData) => void;
  /**
   * Issue #1664 (epic #1662, Sub B): called when a turn opens — fired from the
   * `UserPromptSubmit` branch alongside `onThinkingChange(true)`. Unlike
   * `onThinkingChange` (a UI thinking-dot concern scoped to non-sdk launchers in
   * runClaude), turn boundaries fire for ALL launchers — the hook itself POSTs
   * for sdk too, so the turn reporter must NOT inherit that non-sdk scoping. The
   * full `SessionHookData` is passed so the reporter can read `session_id`
   * (cc_session_id), `transcript_path`, and `cwd` at open time.
   */
  onTurnOpen?: (data: SessionHookData) => void;
  /**
   * Issue #1664: called when a turn finalizes (clean completion) — fired from
   * the `Stop` branch alongside `onThinkingChange(false)`. `SubagentStop` is
   * intentionally NOT registered, so a sub-agent finishing rolls up into the
   * parent turn rather than finalizing it. The interrupt path (no Stop hook —
   * #1611 R4 / #1654) finalizes at the launcher interrupt sites instead.
   */
  onTurnFinalize?: (data: SessionHookData) => void;
  /**
   * Issue #6455: asked on every top-level Stop. A `block` answer goes back to
   * Claude Code as the hook's JSON decision, which keeps the turn going, so the
   * Stop does not clear thinking or finalize the turn; the next Stop does. Null,
   * a throw, or no answer within `stopDecisionTimeoutMs` lets the turn end. No
   * callback leaves the Stop branch exactly as before.
   */
  onStopDecision?: (data: SessionHookData) => Promise<StopHookDecision | null>;
  /** Overrides `STOP_DECISION_TIMEOUT_MS` (tests). */
  stopDecisionTimeoutMs?: number;
  /** Optional token to require for hook requests. */
  token?: string;
}

export interface HookServer {
  /** The port the server is listening on. */
  port: number;
  /** Token required for hook requests. */
  token: string;
  /** Stop the server. */
  stop: () => void;
}

function readHookToken(req: IncomingMessage): string | null {
  const header = req.headers["x-hapi-hook-token"];
  if (Array.isArray(header)) {
    return header[0] ?? null;
  }
  return header ?? null;
}

/** The Stop decision, or null when it fails, is malformed or comes too late. */
async function decideStop(
  decide: NonNullable<HookServerOptions["onStopDecision"]>,
  data: SessionHookData,
  timeoutMs: number
): Promise<StopHookDecision | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const late = new Promise<null>(resolve => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const answer = await Promise.race([decide(data), late]);
    if (
      answer?.decision === "block" &&
      typeof answer.reason === "string" &&
      answer.reason.length > 0
    ) {
      return { decision: "block", reason: answer.reason };
    }
    return null;
  } catch (error) {
    logger.debug("[hookServer] Stop decision failed:", error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Start a dedicated HTTP server for receiving Claude session hooks.
 */
export async function startHookServer(
  options: HookServerOptions
): Promise<HookServer> {
  const {
    onSessionHook,
    onThinkingChange,
    onNotification,
    onTurnOpen,
    onTurnFinalize,
    onStopDecision,
  } = options;
  const stopDecisionTimeoutMs =
    options.stopDecisionTimeoutMs ?? STOP_DECISION_TIMEOUT_MS;
  const hookToken = options.token || randomBytes(16).toString("hex");

  return new Promise((resolve, reject) => {
    const server: Server = createServer(
      async (req: IncomingMessage, res: ServerResponse) => {
        const requestPath = req.url?.split("?")[0];
        if (req.method === "POST" && requestPath === "/hook/session-start") {
          const providedToken = readHookToken(req);
          if (providedToken !== hookToken) {
            logger.debug("[hookServer] Unauthorized hook request");
            res
              .writeHead(401, { "Content-Type": "text/plain" })
              .end("unauthorized");
            req.resume();
            return;
          }

          let timedOut = false;
          const timeout = setTimeout(() => {
            timedOut = true;
            if (!res.headersSent) {
              logger.debug("[hookServer] Request timeout");
              res.writeHead(408).end("timeout");
            }
            req.destroy(new Error("Request timeout"));
          }, 5000);

          try {
            const chunks: Buffer[] = [];
            for await (const chunk of req) {
              chunks.push(chunk as Buffer);
            }
            clearTimeout(timeout);

            if (timedOut || res.headersSent || res.writableEnded) {
              return;
            }

            const body = Buffer.concat(chunks).toString("utf-8");
            logger.debug("[hookServer] Received session hook:", body);

            let data: SessionHookData = {};
            try {
              const parsed = JSON.parse(body);
              if (!parsed || typeof parsed !== "object") {
                logger.debug("[hookServer] Parsed hook data is not an object");
                res
                  .writeHead(400, { "Content-Type": "text/plain" })
                  .end("invalid json");
                return;
              }
              data = parsed as SessionHookData;
            } catch (parseError) {
              logger.debug(
                "[hookServer] Failed to parse hook data as JSON:",
                parseError
              );
              res
                .writeHead(400, { "Content-Type": "text/plain" })
                .end("invalid json");
              return;
            }

            // Issue #1611: dispatch Claude lifecycle thinking events. The hook
            // settings file is passed to every launcher, so these fire under
            // all of them; runClaude scopes the onThinkingChange callback to
            // non-sdk launchers. UserPromptSubmit/Stop payloads need not carry a
            // session_id, so they are answered 200 here, BEFORE the SessionStart
            // session-id requirement below. Only the top-level Stop clears
            // thinking — SubagentStop is intentionally not handled, so a
            // sub-agent finishing does not mark the whole session idle mid-turn.
            const eventName = data.hook_event_name;
            if (eventName === "UserPromptSubmit") {
              onThinkingChange?.(true);
              // Issue #1664: open a turn row. Fired alongside (not replacing)
              // onThinkingChange, before the early 200-return is preserved.
              onTurnOpen?.(data);
              res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
              return;
            }
            if (eventName === "Stop") {
              const decision = onStopDecision
                ? await decideStop(onStopDecision, data, stopDecisionTimeoutMs)
                : null;
              if (decision) {
                // Issue #6455 (DQ2 = A): the turn goes on, so it is neither
                // idle nor finalized; the next Stop, never blocked twice, is.
                if (!res.headersSent && !res.writableEnded) {
                  res
                    .writeHead(200, { "Content-Type": "application/json" })
                    .end(JSON.stringify(decision));
                }
                return;
              }
              onThinkingChange?.(false);
              // Issue #1664: finalize the open turn (clean completion). The
              // interrupt path has no Stop hook and finalizes at the launcher
              // interrupt sites instead.
              onTurnFinalize?.(data);
              if (!res.headersSent && !res.writableEnded) {
                res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
              }
              return;
            }
            // Issue #1653: Notification hook (a TUI prompt is waiting for the
            // user). 🔴 This branch MUST come BEFORE the `session_id`
            // fallthrough below — Notification payloads DO carry `session_id`,
            // so without this early answer they would mis-route into
            // `onSessionHook` (the SessionStart handler). Answered 200 here and
            // tolerant of missing/odd fields (R6: a garbage Notification never
            // breaks session-start handling or the hook server).
            if (eventName === "Notification") {
              onNotification?.(data);
              res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
              return;
            }

            const sessionId = data.session_id || data.sessionId;
            if (sessionId) {
              logger.debug(
                `[hookServer] Session hook received session ID: ${sessionId}`
              );
              onSessionHook(sessionId, data);
            } else {
              logger.debug(
                "[hookServer] Session hook received but no session_id found in data"
              );
              res
                .writeHead(422, { "Content-Type": "text/plain" })
                .end("missing session_id");
              return;
            }

            if (!res.headersSent && !res.writableEnded) {
              res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
            }
          } catch (error) {
            clearTimeout(timeout);
            if (timedOut) {
              return;
            }
            logger.debug("[hookServer] Error handling session hook:", error);
            if (!res.headersSent && !res.writableEnded) {
              res.writeHead(500).end("error");
            }
          }
          return;
        }

        res.writeHead(404).end("not found");
      }
    );

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to get server address"));
        return;
      }

      const port = address.port;
      logger.debug(`[hookServer] Started on port ${port}`);

      resolve({
        port,
        token: hookToken,
        stop: () => {
          server.close();
          logger.debug("[hookServer] Stopped");
        },
      });
    });

    server.on("error", err => {
      logger.debug("[hookServer] Server error:", err);
      reject(err);
    });
  });
}
