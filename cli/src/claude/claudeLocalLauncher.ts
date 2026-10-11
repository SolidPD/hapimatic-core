// SPDX-License-Identifier: MIT
import { logger } from "@/ui/logger";
import { claudeLocal } from "./claudeLocal";
import { Session } from "./session";
import { Future } from "@/utils/future";
import { createSessionScanner } from "./utils/sessionScanner";
import { ToolErrorDetector } from "./utils/toolErrorDetector";
import { ApiErrorDetector } from "./utils/apiErrorDetector";
import { UserPromptBlockDetector } from "./utils/userPromptBlockDetector";
import {
  SurrogateErrorDetector,
  SURROGATE_LOOP_USER_MESSAGE,
} from "./utils/surrogateErrorDetector";
import {
  RefusalDetector,
  buildRefusalUserMessage,
} from "./utils/refusalDetector";
import { getLocalLaunchExitReason } from "@/agent/localLaunchPolicy";
import {
  resolveAccountTokenForSession,
  resolveAccountConfigDirForSession,
  readBoundApiKeyId,
  withAccountToken,
  withAccountConfigDir,
} from "./accountTokenInjection";
import {
  createCleanupHandler,
  createLocalModeRejectionHandler,
} from "./services/mcpToggleService";
import { createLocalModeRejectionHandler as createSetPermissionModeLocalRejection } from "./services/setPermissionModeService";
import {
  ABORT_META,
  SWITCH_META,
  MCP_TOGGLE_META,
  SET_PERMISSION_MODE_META,
} from "@/api/rpc/capabilityMeta";
import { NO_META_TEARDOWN } from "@/api/rpc/types";

export async function claudeLocalLauncher(
  session: Session
): Promise<"switch" | "exit"> {
  // Issue #4568 (R5): an API-key session never runs in local (interactive) mode —
  // the key binding is an SDK-launcher contract (D-4568-2 A), and the interactive
  // path was never verified for API billing. Refuse with a clear message and
  // hand the session straight back to remote mode, where the SDK launcher bills
  // the key; nothing is spawned here.
  if (readBoundApiKeyId()) {
    session.client.sendSessionEvent({
      type: "message",
      message:
        "Local mode is unavailable for an API-key session — it stays on the SDK launcher, which bills the key.",
    });
    return "switch";
  }
  // Create tool error detector to report tool failures to the error log
  const toolErrorDetector = new ToolErrorDetector();
  // Issue #1232: detect Anthropic API errors (exhausted/retrying) → error_logs
  const apiErrorDetector = new ApiErrorDetector();
  // Issue #1348: detect UserPromptSubmit hook blocks for real-time toast surface
  const userPromptBlockDetector = new UserPromptBlockDetector();
  // Issue #1604: detect the UTF-16 surrogate-truncation 400 death-loop. In local
  // (interactive terminal) mode a human is watching the claude TUI and can break
  // the loop directly, so this launcher surfaces detection + a loud notify
  // (reportError → server error_logs happens inside the detector; the callback
  // adds the session-chat message) rather than auto-terminating — local's doAbort
  // switches to remote mode, where the remote launcher's detector performs the
  // terminal exit on re-detection.
  // Issue #1633: surface model content-policy refusals (stop_reason: refusal)
  // visibly in the chat thread — notify-only, never terminate (a refusal is
  // per-turn and recoverable, unlike the surrogate loop's persisted poison).
  const refusalDetector = new RefusalDetector((sessionId, model) => {
    logger.warn(
      `[local]: model refusal detected for session ${sessionId} (model: ${model ?? "unknown"}) — notifying chat (issue #1633)`
    );
    try {
      session.client.sendSessionEvent({
        type: "message",
        message: buildRefusalUserMessage(model),
      });
    } catch {
      // best-effort notify
    }
  });
  const surrogateErrorDetector = new SurrogateErrorDetector(
    (sessionId, errorText) => {
      logger.warn(
        `[local]: surrogate-400 compaction death-loop detected for session ${sessionId} (issue #1604). Error: ${errorText.slice(0, 200)}`
      );
      try {
        session.client.sendSessionEvent({
          type: "message",
          message: SURROGATE_LOOP_USER_MESSAGE,
        });
      } catch {
        // best-effort notify
      }
    }
  );

  // Create scanner
  const scanner = await createSessionScanner({
    sessionId: session.sessionId,
    workingDirectory: session.path,
    onMessage: message => {
      session.client.sendClaudeSessionMessage(message);
      // Detect and report tool errors to the error log system
      toolErrorDetector.processMessage(message, session.sessionId);
      // Detect and report Anthropic API errors to the error log system (#1232)
      apiErrorDetector.processMessage(message, session.sessionId);
      // Detect and report UserPromptSubmit hook blocks (#1348)
      userPromptBlockDetector.processMessage(message, session.sessionId);
      // Detect the surrogate-truncation 400 death-loop (#1604)
      surrogateErrorDetector.processMessage(message, session.sessionId);
      // Surface model content-policy refusals in the chat thread (#1633)
      refusalDetector.processMessage(message, session.sessionId);
    },
    // Issue #4383: feed the background-Agent tracker every raw transcript line
    // (including the queue-operation <task-notification> enqueue/remove that
    // onMessage drops) — the local launcher's ONLY path to agent completions.
    onRawLine: raw => session.backgroundAgentTracker.onTranscriptLine(raw),
  });

  // Issue #4383: hand the tracker this session's reconcile context (the local
  // launcher watches the host projects tree — no account-config override).
  session.setBackgroundAgentContext({ workingDirectory: session.path });

  const handleSessionFound = (sessionId: string) => {
    scanner.onNewSession(sessionId);
  };
  session.addSessionFoundCallback(handleSessionFound);

  // Handle abort
  let exitReason: "switch" | "exit" | null = null;
  const processAbortController = new AbortController();
  const exitFuture = new Future<void>();
  try {
    async function abort() {
      // Send abort signal
      if (!processAbortController.signal.aborted) {
        processAbortController.abort();
      }

      // Await full exit
      await exitFuture.promise;
    }

    async function doAbort() {
      logger.debug("[local]: doAbort");

      // Switching to remote mode
      if (!exitReason) {
        exitReason = "switch";
      }

      // Reset sent messages
      session.queue.reset();

      // Abort
      await abort();
    }

    async function doSwitch() {
      logger.debug("[local]: doSwitch");

      // Switching to remote mode
      if (!exitReason) {
        exitReason = "switch";
      }

      // Abort
      await abort();
    }

    // When to abort
    session.client.rpcHandlerManager.registerHandler(
      "abort",
      doAbort,
      ABORT_META
    ); // Abort current process, clean queue and switch to remote mode
    session.client.rpcHandlerManager.registerHandler(
      "switch",
      doSwitch,
      SWITCH_META
    ); // When user wants to switch to remote mode

    // Local-mode MCP toggle is deferred to a follow-up of issue #1077 —
    // Claude runs the interactive TUI here with keyboard-injection via tmux
    // send-keys, a fire-and-forget mechanism that cannot mirror remote
    // mode's structured control_response contract. Reject explicitly so
    // callers fall back to `/mcp enable/disable` in the session UI.
    // (Service extracted in #1101.)
    session.client.rpcHandlerManager.registerHandler(
      "mcp-toggle",
      createLocalModeRejectionHandler(),
      MCP_TOGGLE_META
    );
    // Issue #2346: local launcher runs Claude's interactive TUI, no SDK control
    // channel → local_mode_not_supported (no capability meta — the bespoke route
    // consumes this, not the #2419 registry).
    session.client.rpcHandlerManager.registerHandler(
      "set-permission-mode",
      createSetPermissionModeLocalRejection(),
      SET_PERMISSION_MODE_META
    );
    session.queue.setOnMessage((message: string, mode) => {
      // Switch to remote mode when message received
      doSwitch();
    }); // When any message is received, abort current process, clean queue and switch to remote mode

    // Exit if there are messages in the queue
    if (session.queue.size() > 0) {
      return "switch";
    }

    // Run local mode
    while (true) {
      // If we already have an exit reason, return it
      if (exitReason) {
        return exitReason;
      }

      // Launch
      logger.debug("[local]: launch");
      // Multi-account (epic #1446, Sub-Issue D): resolve the bound account's
      // token at each launcher (re)entry (R7). Throws on unknown/unrefreshable (R3).
      // Without this, a session in local (terminal) mode would silently use host
      // credentials instead of the bound account.
      // Issue #1551: prefer per-account CLAUDE_CONFIG_DIR isolation for a bound
      // non-host account (native owns refresh). null falls through to the
      // env-token path, which AUGMENTS — never replaces — isolation (Fallback
      // Preservation Rule) and carries the unknown/unrefreshable throws (R3/R4).
      const accountConfigDir = await resolveAccountConfigDirForSession(session);
      const accountToken = accountConfigDir
        ? null
        : await resolveAccountTokenForSession(session);
      try {
        await claudeLocal({
          path: session.path,
          sessionId: session.sessionId,
          abort: processAbortController.signal,
          claudeEnvVars: withAccountConfigDir(
            withAccountToken(session.claudeEnvVars, accountToken),
            accountConfigDir
          ),
          claudeArgs: session.claudeArgs,
          mcpServers: session.mcpServers,
          allowedTools: session.allowedTools,
          hookSettingsPath: session.hookSettingsPath,
        });

        // Consume one-time Claude flags after spawn
        // For example we don't want to pass --resume flag after first spawn
        session.consumeOneTimeFlags();

        // Normal exit
        if (!exitReason) {
          exitReason = "exit";
          break;
        }
      } catch (e) {
        logger.debug("[local]: launch error", e);
        const message = e instanceof Error ? e.message : String(e);
        session.client.sendSessionEvent({
          type: "message",
          message: `Local Claude process failed: ${message}`,
        });
        const failureExitReason =
          exitReason ??
          getLocalLaunchExitReason({
            startedBy: session.startedBy,
            startingMode: session.startingMode,
          });
        session.recordLocalLaunchFailure(message, failureExitReason);
        if (!exitReason) {
          exitReason = failureExitReason;
        }
        if (failureExitReason === "exit") {
          logger.warn(`[local]: Local Claude process failed: ${message}`);
        }
        break;
      }
      logger.debug("[local]: launch done");
    }
  } finally {
    // Resolve future
    exitFuture.resolve(undefined);

    // Set handlers to no-op
    session.client.rpcHandlerManager.registerHandler(
      "abort",
      async () => {},
      NO_META_TEARDOWN
    );
    session.client.rpcHandlerManager.registerHandler(
      "switch",
      async () => {},
      NO_META_TEARDOWN
    );
    // Replace the mcp-toggle handler with a config-write stub so RPCs
    // arriving after teardown still apply the toggle durably to
    // ~/.claude.json — mirrors the remote launcher's cleanup-time stub
    // (see issues #1105 and #1101: shared service since the latter).
    session.client.rpcHandlerManager.registerHandler(
      "mcp-toggle",
      createCleanupHandler({ sessionPath: session.path }),
      NO_META_TEARDOWN
    );
    session.queue.setOnMessage(null);

    // Cleanup
    session.removeSessionFoundCallback(handleSessionFound);
    await scanner.cleanup();
  }

  // Return
  return exitReason || "exit";
}
