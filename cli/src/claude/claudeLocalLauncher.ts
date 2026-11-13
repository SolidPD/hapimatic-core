// SPDX-License-Identifier: MIT AND AGPL-3.0-only
import { logger } from "@/ui/logger";
import { claudeLocal } from "./claudeLocal";
import { Session } from "./session";
import { Future } from "@/utils/future";
import { createSessionScanner } from "./utils/sessionScanner";
import { resumeSessionIdFromArgs } from "./utils/resumeArgs";
import { createTranscriptForwarder } from "./services/transcriptForwarder";
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
import { createSessionRateLimitDetector } from "./services/sessionRateLimitDetector";
import { getLocalLaunchExitReason } from "@/agent/localLaunchPolicy";
import {
  appendEffortArg,
  resolveAccountTokenForSession,
  resolveAccountConfigDirForSession,
  readBoundApiKeyId,
  withAccountToken,
  withAccountConfigDir,
} from "./accountTokenInjection";
import {
  localLaunchPermissionArgs,
  permissionNarrowingHolds,
  relaunchPermissionArgs,
  settleLaunchPermissionMode,
} from "./spawnPermissionSeed";
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

/**
 * Issue #5348 F2 (board-26 PM ruling, 2026-11-12): the session leaves local mode with the
 * prompt after -- still undelivered (no Claude was started with it). Show it once in the
 * chat and drop it: a stale prompt arriving on its own at a later local start is worse
 * than a visible miss.
 */
function reportUndeliveredPrompt(
  session: Session,
  exitReason: "switch" | "exit" | null
): void {
  const prompt = session.takeUndeliveredPrompt();
  if (prompt === undefined) return;
  const why =
    exitReason === "switch"
      ? "the session switched to remote before Claude started"
      : "Claude did not start";
  try {
    session.client.sendSessionEvent({
      type: "message",
      message: `The text after -- was not delivered because ${why}: ${prompt}`,
    });
  } catch (e) {
    logger.warn("[local]: could not report the undelivered prompt", e);
  }
}

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
  // Issue #6065: report a usage-window cap the way the pty and tmux launchers
  // do (the shared factory). The chip and the server's rate-limit edges read
  // `session.rateLimited`, and setting it also clears `thinking`, whatever the
  // mode.
  const rateLimitDetector = createSessionRateLimitDetector(session);

  // Issue #6088 (SINK-4, #1573 parity with pty/tmux): resolve the account
  // config dir once, up front (it never throws — null for host/non-isolated
  // sessions), so the scanner watches the projects tree the account-bound
  // claude child writes to under isolation. Reused for the launch below.
  const accountConfigDir = await resolveAccountConfigDirForSession(session);

  // Issue #6088 (SINK-6): what reaches the chat — every record except Claude
  // Code's "No response requested." placeholder; the detectors below still
  // see every record.
  const forwardToChat = createTranscriptForwarder(session.client);

  // Create scanner
  const scanner = await createSessionScanner({
    sessionId: session.sessionId,
    // Issue #6088 (SINK-1): a fresh `--resume` process seeds the scanner from
    // the resumed transcript, so its history reaches neither the chat nor the
    // detectors below.
    resumeSessionId: resumeSessionIdFromArgs(session.claudeArgs) ?? undefined,
    workingDirectory: session.path,
    configDir: accountConfigDir ?? undefined,
    onMessage: message => {
      forwardToChat(message);
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
      // Surface the 429 usage-window rate-limited state (#1647, #6065)
      rateLimitDetector.processMessage(message, session.sessionId);
    },
    // Issue #4383: feed the background-Agent tracker every raw transcript line
    // (including the queue-operation <task-notification> enqueue/remove that
    // onMessage drops) — the local launcher's ONLY path to agent completions.
    onRawLine: raw => session.backgroundAgentTracker.onTranscriptLine(raw),
  });

  // Issue #4383: hand the tracker this session's reconcile context (the same
  // account-config dir the scanner watches, #1573 / #6088).
  session.setBackgroundAgentContext({
    configDir: accountConfigDir ?? undefined,
    workingDirectory: session.path,
  });

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
      // The config dir was resolved up front (above createSessionScanner, #6088).
      const accountToken = accountConfigDir
        ? null
        : await resolveAccountTokenForSession(session);
      // Issue #5348 F2: set by claudeLocal just before it spawns Claude.
      let started = false;
      try {
        await claudeLocal({
          path: session.path,
          sessionId: session.sessionId,
          abort: processAbortController.signal,
          claudeEnvVars: withAccountConfigDir(
            withAccountToken(session.claudeEnvVars, accountToken),
            accountConfigDir
          ),
          // Issue #6166: a session taken over in a terminal keeps its effort —
          // before, only the pty/tmux launchers appended it, so a local launch
          // ran the binary default (medium on Opus 5.5). A user's own --effort
          // passthrough wins. A new array: consumeOneTimeFlags below still
          // edits session.claudeArgs itself.
          // Issue #6400 P1: a session started with a terminal
          // --permission-mode no longer forwards it, so its live mode is
          // passed instead (a plain session is unchanged).
          // Issue #6617 (Matt 43a / 43-local a / D1-1 / D3-1): with the switch
          // on, the live mode decides the child's permission flags. A start in
          // bypass narrowed in the UI drops the bypass token; the mode is named
          // for a terminal --permission-mode start, a daemon-started session, a
          // bypass start, and a session whose mode was set from the UI or a card
          // (D3-1); an untouched plain terminal session keeps the user's own
          // default. An unreadable mode is written back as `default` (R7 ii).
          claudeArgs: permissionNarrowingHolds()
            ? relaunchPermissionArgs(
                appendEffortArg(session.claudeArgs ?? [], session.getEffort()),
                settleLaunchPermissionMode(session, message =>
                  logger.warn(`[local]: ${message}`)
                ),
                {
                  appendMode:
                    session.permissionModeFromFlag ||
                    session.startedBy === "daemon" ||
                    (session.claudeArgs ?? []).includes(
                      "--dangerously-skip-permissions"
                    ) ||
                    session.permissionModeSetHere,
                }
              )
            : localLaunchPermissionArgs(
                appendEffortArg(session.claudeArgs ?? [], session.getEffort()),
                session.permissionModeFromFlag
                  ? session.getPermissionMode()
                  : undefined,
                session.permissionModeFromFlag
              ),
          // Issue #5348: the marker prompt, first spawn only (consumed below).
          claudeTrailingArgs: session.claudeTrailingArgs,
          onSpawn: () => {
            started = true;
          },
          mcpServers: session.mcpServers,
          allowedTools: session.allowedTools,
          hookSettingsPath: session.hookSettingsPath,
        });

        // Consume one-time Claude flags after spawn
        // For example we don't want to pass --resume flag after first spawn
        // Issue #5348 F2: the prompt after -- only when Claude was started with it.
        session.consumeOneTimeFlags({ promptDelivered: started });

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

    // Issue #5348 F2: leaving local mode with the prompt after -- undelivered.
    reportUndeliveredPrompt(session, exitReason);

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

    // Issue #3235 / #6065: a dead or switched-away session must not show a
    // stale chip. The remote launcher's fresh detector starts unlatched, so it
    // could never fire the falling edge for a cap seen here.
    session.setRateLimited(null);

    // Cleanup
    session.removeSessionFoundCallback(handleSessionFound);
    await scanner.cleanup();
    // #6065: a scan in flight during cleanup can still deliver a 429 after the
    // clear above (runScan does not re-check `stopped` once it has read the
    // file), so clear once more now that no scan can run.
    session.setRateLimited(null);
  }

  // Return
  return exitReason || "exit";
}
