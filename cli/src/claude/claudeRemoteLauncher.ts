// SPDX-License-Identifier: MIT AND AGPL-3.0-only
import React from "react";
import { Session } from "./session";
import { RemoteModeDisplay } from "@/ui/ink/RemoteModeDisplay";
import { claudeRemote } from "./claudeRemote";
import { PermissionHandler } from "./utils/permissionHandler";
import { Future } from "@/utils/future";
import {
  ChildExitError,
  SDKAssistantMessage,
  SDKMessage,
  SDKUserMessage,
  SignalExitError,
  type Query,
} from "./sdk";
import {
  createCleanupHandler,
  createRuntimeRemoteHandler,
} from "./services/mcpToggleService";
import { createRuntimeRemoteHandler as createSetPermissionModeRuntimeHandler } from "./services/setPermissionModeService";
import {
  createGetContextUsageHandler,
  createMcpStatusHandler,
} from "./services/capabilityHandlers";
import {
  ABORT_META,
  SWITCH_META,
  MCP_TOGGLE_META,
  SET_PERMISSION_MODE_META,
  GET_CONTEXT_USAGE_META,
  MCP_STATUS_META,
} from "@/api/rpc/capabilityMeta";
import { delay } from "@/utils/time";
import { formatClaudeMessageForInk } from "@/ui/messageFormatterInk";
import { logger } from "@/ui/logger";
import { SDKToLogConverter } from "./utils/sdkToLogConverter";
import { ToolErrorDetector } from "./utils/toolErrorDetector";
import { ApiErrorDetector } from "./utils/apiErrorDetector";
import { UserPromptBlockDetector } from "./utils/userPromptBlockDetector";
import type { RawJSONLines } from "./types";
import { CronUsageDetector } from "./utils/cronUsageDetector";
import {
  SurrogateErrorDetector,
  SURROGATE_LOOP_USER_MESSAGE,
} from "./utils/surrogateErrorDetector";
import {
  RefusalDetector,
  buildRefusalUserMessage,
} from "./utils/refusalDetector";
import { RateLimitDetector } from "./utils/rateLimitDetector";
import {
  logExitDiagnostics,
  captureProcessTree,
  buildSessionExitReport,
  createExitDiagnosticEntry,
} from "./utils/exitDiagnostics";
import { PLAN_FAKE_REJECT } from "./sdk/prompts";
import { EnhancedMode } from "./loop";
import { OutgoingMessageQueue } from "./utils/OutgoingMessageQueue";
import {
  resolveAccountTokenForSession,
  resolveAccountConfigDirForSession,
  verifyApiKeyForSession,
  readBoundApiKeyId,
  withAccountToken,
  withAccountConfigDir,
} from "./accountTokenInjection";
import type { ClaudePermissionMode } from "@hapi/protocol/types";
import {
  RemoteLauncherBase,
  type RemoteLauncherDisplayContext,
  type RemoteLauncherExitReason,
} from "@/modules/common/remote/RemoteLauncherBase";
import { NO_META_TEARDOWN } from "@/api/rpc/types";
import { CLI_VERSION } from "@/version";

interface PermissionsField {
  date: number;
  result: "approved" | "denied";
  mode?: ClaudePermissionMode;
  allowedTools?: string[];
}

const SIGNAL_NAMES: Record<number, string> = {
  1: "SIGHUP",
  2: "SIGINT",
  6: "SIGABRT",
  9: "SIGKILL",
  11: "SIGSEGV",
  15: "SIGTERM",
};

/** Enrich an error message with signal name when exit code indicates a signal kill. */
function enrichWithSignalContext(detail: string): string {
  const match = detail.match(/exited with code (\d+)/);
  if (!match) return detail;
  const code = parseInt(match[1]);
  if (code < 128) return detail;
  const sigNum = code - 128;
  const sigName = SIGNAL_NAMES[sigNum] ?? `signal ${sigNum}`;
  return `${detail} (killed by ${sigName})`;
}

class ClaudeRemoteLauncher extends RemoteLauncherBase {
  private readonly session: Session;
  private abortController: AbortController | null = null;
  private abortFuture: Future<void> | null = null;
  private permissionHandler: PermissionHandler | null = null;
  private handleSessionFound: ((sessionId: string) => void) | null = null;
  /**
   * Active SDK Query instance for the current claudeRemote() run. Used by the
   * mcp-toggle RPC handler (issue #1077) to dispatch out-of-band control
   * requests to Claude Code's headless handler without restarting the process.
   */
  private currentQuery: Query | null = null;

  constructor(session: Session) {
    super(process.env.DEBUG ? session.logPath : undefined);
    this.session = session;
  }

  protected createDisplay(
    context: RemoteLauncherDisplayContext
  ): React.ReactElement {
    return React.createElement(RemoteModeDisplay, context);
  }

  private async abort(): Promise<void> {
    if (this.abortController && !this.abortController.signal.aborted) {
      this.abortController.abort();
    }
    await this.abortFuture?.promise;
  }

  private async handleAbortRequest(): Promise<void> {
    logger.debug("[remote]: doAbort");
    // Issue #1664 (Sub B): the abort RPC is the user "stop" (web-stop /
    // interrupt) on the SDK launcher. An aborted query fires no Stop hook, so
    // finalize the open turn as interrupted here. Switch/exit teardown
    // (handleSwitchRequest / handleExitFromUi → abort()) deliberately does NOT
    // finalize — a turn left open by teardown is orphaned via the server sweep
    // (Key Decision 4). The reporter's idempotency guard makes this safe if a
    // Stop hook also raced in.
    this.session.turnReporter?.finalize("interrupted");
    await this.abort();
  }

  private async handleSwitchRequest(): Promise<void> {
    logger.debug("[remote]: doSwitch");
    await this.requestExit("switch", async () => {
      await this.abort();
    });
  }

  private async handleExitFromUi(): Promise<void> {
    logger.debug("[remote]: Exiting client via Ctrl-C");
    await this.requestExit("exit", async () => {
      await this.abort();
    });
  }

  private async handleSwitchFromUi(): Promise<void> {
    logger.debug("[remote]: Switching to local mode via double space");
    await this.handleSwitchRequest();
  }

  public async launch(): Promise<RemoteLauncherExitReason> {
    return this.start({
      onExit: () => this.handleExitFromUi(),
      onSwitchToLocal: () => this.handleSwitchFromUi(),
    });
  }

  protected async runMainLoop(): Promise<void> {
    logger.debug("[claudeRemoteLauncher] Starting remote launcher");
    logger.debug(`[claudeRemoteLauncher] TTY available: ${this.hasTTY}`);

    const session = this.session;
    const messageBuffer = this.messageBuffer;

    this.setupAbortHandlers(
      session.client.rpcHandlerManager,
      {
        onAbort: () => this.handleAbortRequest(),
        onSwitch: () => this.handleSwitchRequest(),
      },
      // Issue #2421: complete the remote-launcher registry migration — #2417
      // annotated the LOCAL launcher's abort with ABORT_META; this backfills the
      // REMOTE launcher so abort enumerates with meta alongside the new caps.
      ABORT_META,
      // Issue #3745: annotate the sdk-active `switch` too (SWITCH_META).
      SWITCH_META
    );

    // Register mcp-toggle RPC handler (issue #1077). Delegates to the
    // shared service (#1101) so both launchers' runtime + cleanup paths
    // emit identical response shapes for identical inputs. The service
    // owns transport/policy/persistence; the launcher only owns the
    // ephemeral `currentQuery` reference, which the service reads via
    // callback so it observes the latest value at every invocation.
    session.client.rpcHandlerManager.registerHandler(
      "mcp-toggle",
      createRuntimeRemoteHandler({
        sessionPath: session.path,
        sessionId: session.sessionId,
        getQuery: () => this.currentQuery,
      }),
      // Issue #2421: backfill the remote-launcher mcp-toggle meta (#2417
      // annotated only the local launcher). The cleanup stub re-registers
      // mcp-toggle meta-less on teardown, which clears this via the
      // set-or-delete symmetry — matching the local launcher's lifecycle.
      MCP_TOGGLE_META
    );

    // Issue #2256: publish the live-query accessor onto the Session so
    // runClaude's "set-model" RPC handler can reach the live Query out-of-band
    // for the set_model lever. Mirrors the `getQuery` closure the mcp-toggle /
    // get-context-usage handlers use — reads `this.currentQuery` FRESH at each
    // invocation (null at registration, set at launch :743, cleared at :978).
    // Only the SDK remote launcher publishes it; non-sdk launchers never do, so
    // the handler degrades to method:"config" on those sessions.
    this.session.setLiveQueryAccessor(() => this.currentQuery);

    // Issue #2346: register the "set-permission-mode" RPC handler beside
    // mcp-toggle (the launcher-registered control pattern — required for the 501
    // local_mode_not_supported taxonomy the AC mandates). The runtime handler
    // reaches runClaude's shared in-place applier via the Session-carried bridge
    // (published in onSessionReady); `getQuery` is only the no_active_query
    // sentinel, read FRESH each invocation. Non-sdk launchers instead register the
    // local-mode rejection in their own setup, yielding local_mode_not_supported.
    session.client.rpcHandlerManager.registerHandler(
      "set-permission-mode",
      createSetPermissionModeRuntimeHandler({
        getQuery: () => this.currentQuery,
        applyInPlace: async mode => {
          const apply = this.session.getPermissionModeApplier();
          // Not yet published (pre-onSessionReady) or cleared → treat as no live
          // query; the service maps method:"config" to no_active_query.
          if (!apply) return { method: "config" as const };
          return apply(mode);
        },
      }),
      SET_PERMISSION_MODE_META
    );

    // Issue #2421 (epic #2416, Sub-Issue E): migrate two readonly control
    // capabilities through the registry. Handler logic lives in the testable
    // `capabilityHandlers` factories (mirrors mcpToggleService, #1101); the
    // `getQuery` callback reads `this.currentQuery` FRESH at each invocation —
    // never closing over a stale binding (`currentQuery` is null at registration
    // time, set at :699, cleared at :934). `get-context-usage` wraps the
    // already-built `Query.getContextUsage()` (issue #1469); idle → a CLI-shaped
    // `no_active_query` the #2419 invoke gate forwards verbatim inside `data`
    // (capabilityPolicy 1B-14). `mcp-status` reads the existing live source
    // (`pollMcpStatus` → `claude mcp list`), NOT a new Query bridge (ruling
    // 1B-28 — no `mcp_status` subtype exists in `sdk/types.ts`).
    session.client.rpcHandlerManager.registerHandler(
      "get-context-usage",
      createGetContextUsageHandler({ getQuery: () => this.currentQuery }),
      GET_CONTEXT_USAGE_META
    );
    session.client.rpcHandlerManager.registerHandler(
      "mcp-status",
      createMcpStatusHandler({ sessionPath: session.path }),
      MCP_STATUS_META
    );

    const permissionHandler = new PermissionHandler(session);
    this.permissionHandler = permissionHandler;

    const toolErrorDetector = new ToolErrorDetector();
    // Issue #1232: detect Anthropic API errors (exhausted/retrying) → error_logs
    const apiErrorDetector = new ApiErrorDetector();
    // Issue #1348: detect UserPromptSubmit hook blocks for real-time toast surface
    const userPromptBlockDetector = new UserPromptBlockDetector();
    // Issue #1460: warn (non-silently) when a session uses in-session cron,
    // which is idle-gated and unreliable in long-lived sessions.
    const cronUsageDetector = new CronUsageDetector();
    // Issue #1604: detect the UTF-16 surrogate-truncation 400 death-loop and
    // break it. The poison is persisted in the conversation history, so a restart
    // would re-send it — the only safe action is a clean terminal exit + loud
    // notification so the user can --resume/branch deliberately. This callback
    // wires the detector's launcher-agnostic trigger to this launcher's terminate
    // (requestExit + interrupt/abort current query) and notify (sendSessionEvent)
    // primitives.
    // Issue #1633: surface model content-policy refusals (stop_reason: refusal)
    // visibly in the chat thread — notify-only, never terminate (a refusal is
    // per-turn and recoverable, unlike the surrogate loop's persisted poison).
    const refusalDetector = new RefusalDetector((sessionId, model) => {
      logger.warn(
        `[remote]: model refusal detected for session ${sessionId} (model: ${model ?? "unknown"}) — notifying chat (issue #1633)`
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
          `[remote]: surrogate-400 compaction death-loop detected for session ${sessionId} — terminating (issue #1604). Error: ${errorText.slice(0, 200)}`
        );
        try {
          session.client.sendSessionEvent({
            type: "message",
            message: SURROGATE_LOOP_USER_MESSAGE,
          });
        } catch {
          // best-effort notify — never let a notify throw skip the terminate below
        }
        void this.requestExit("exit", () => {
          try {
            this.currentQuery?.interrupt();
          } catch {
            // interrupt may reject if the query already exited — best-effort
          }
          if (this.abortController && !this.abortController.signal.aborted) {
            this.abortController.abort();
          }
        });
      }
    );

    // Issue #1647: detect the 429 session-limit on the SDK path too. The SDK
    // launcher is immune to the eternal-thinking bug (its thinking is stream-
    // derived with a per-query reset), so here the detector's value is surfacing
    // the rate-limited chip — the thinking-clear in setRateLimited is harmless/
    // redundant. The 429 reaches this converted stream as either the synthetic
    // assistant shape or a system/api_error record (the detector handles both).
    const rateLimitDetector = new RateLimitDetector(
      (sessionId, info) => {
        session.setRateLimited({
          resetText: info.resetText,
          resetAt: info.resetAt,
          since: Date.now(),
        });
      },
      // Issue #3235: clear the chip on the FALLING edge (genuine forward
      // progress) — onThinkingChange no longer clears `rateLimited`. Teardown
      // clears it separately in the launch `finally` below.
      () => session.setRateLimited(null)
    );

    const messageQueue = new OutgoingMessageQueue(logMessage => {
      session.client.sendClaudeSessionMessage(logMessage);
      toolErrorDetector.processMessage(logMessage, session.sessionId);
      // Detect and report Anthropic API errors to the error log system (#1232)
      apiErrorDetector.processMessage(logMessage, session.sessionId);
      // Detect and report UserPromptSubmit hook blocks (#1348). NOTE (#1258): in
      // remote mode this call is a no-op for the `system`/`informational` block
      // carrier — OMQ drops it before this send callback runs. The remote-effective
      // detection is the onMessage-head call above; this line stays harmless (same
      // detector instance, uuid/content-deduped).
      userPromptBlockDetector.processMessage(logMessage, session.sessionId);
      // Detect in-session cron usage and surface a reliability warning (#1460)
      cronUsageDetector.processMessage(logMessage, session.sessionId);
      // Detect the surrogate-truncation 400 death-loop (#1604)
      surrogateErrorDetector.processMessage(logMessage, session.sessionId);
      // Surface model content-policy refusals in the chat thread (#1633)
      refusalDetector.processMessage(logMessage, session.sessionId);
      // Surface the 429 session-limit rate-limited state (#1647)
      rateLimitDetector.processMessage(logMessage, session.sessionId);
    });

    permissionHandler.setOnPermissionRequest((toolCallId: string) => {
      messageQueue.releaseToolCall(toolCallId);
    });

    const sdkToLogConverter = new SDKToLogConverter(
      {
        sessionId: session.sessionId || "unknown",
        cwd: session.path,
        version: CLI_VERSION,
      },
      permissionHandler.getResponses()
    );

    const handleSessionFound = (sessionId: string) => {
      sdkToLogConverter.updateSessionId(sessionId);
    };
    this.handleSessionFound = handleSessionFound;
    session.addSessionFoundCallback(handleSessionFound);

    let planModeToolCalls = new Set<string>();
    let ongoingToolCalls = new Map<
      string,
      { parentToolCallId: string | null }
    >();
    function onMessage(message: SDKMessage) {
      formatClaudeMessageForInk(message, messageBuffer);
      permissionHandler.onMessage(message);

      // Issue #1258: surface UserPromptSubmit hook BLOCKS in remote mode. #1348's
      // UserPromptBlockDetector is also wired into the OutgoingMessageQueue send
      // callback below, but OMQ drops every system.* message whose subtype !== "result"
      // BEFORE that callback runs — so the `system`/`informational` block carrier never
      // reaches it in remote mode (#1348 fired only in local mode's JSONL path). The raw
      // pre-filter SDK stream here is the only wrapper-side place that sees the block.
      // The detector's own uuid + content debounce makes the OMQ-callback call a no-op
      // for this message type. Also fixes #1348's remote-mode defect.
      userPromptBlockDetector.processMessage(
        message as unknown as RawJSONLines,
        session.sessionId
      );

      // Issue #4383: feed the background-Agent tracker the RAW SDK stream here at
      // the onMessage head — NOT the OutgoingMessageQueue send callback, which
      // relays only system/result and drops task_started / task_notification
      // before that callback runs [ER 4383-2].
      session.backgroundAgentTracker.onSdkMessage(message);

      if (message.type === "assistant") {
        let umessage = message as SDKAssistantMessage;
        if (
          umessage.message.content &&
          Array.isArray(umessage.message.content)
        ) {
          for (let c of umessage.message.content) {
            if (
              c.type === "tool_use" &&
              (c.name === "exit_plan_mode" || c.name === "ExitPlanMode")
            ) {
              logger.debug("[remote]: detected plan mode tool call " + c.id!);
              planModeToolCalls.add(c.id! as string);
            }
          }
        }
      }

      if (message.type === "assistant") {
        let umessage = message as SDKAssistantMessage;
        if (
          umessage.message.content &&
          Array.isArray(umessage.message.content)
        ) {
          for (let c of umessage.message.content) {
            if (c.type === "tool_use") {
              logger.debug(
                "[remote]: detected tool use " +
                  c.id! +
                  " parent: " +
                  umessage.parent_tool_use_id
              );
              ongoingToolCalls.set(c.id!, {
                parentToolCallId: umessage.parent_tool_use_id ?? null,
              });
            }
          }
        }
      }
      if (message.type === "user") {
        let umessage = message as SDKUserMessage;
        if (
          umessage.message.content &&
          Array.isArray(umessage.message.content)
        ) {
          for (let c of umessage.message.content) {
            if (c.type === "tool_result" && c.tool_use_id) {
              ongoingToolCalls.delete(c.tool_use_id);
              messageQueue.releaseToolCall(c.tool_use_id);
            }
          }
        }
      }

      let msg = message;

      if (message.type === "user") {
        let umessage = message as SDKUserMessage;
        if (
          umessage.message.content &&
          Array.isArray(umessage.message.content)
        ) {
          msg = {
            ...umessage,
            message: {
              ...umessage.message,
              content: umessage.message.content.map(c => {
                if (
                  c.type === "tool_result" &&
                  c.tool_use_id &&
                  planModeToolCalls.has(c.tool_use_id!)
                ) {
                  if (c.content === PLAN_FAKE_REJECT) {
                    logger.debug("[remote]: hack plan mode exit");
                    logger.debugLargeJson("[remote]: hack plan mode exit", c);
                    return {
                      ...c,
                      is_error: false,
                      content: "Plan approved",
                      mode: c.mode,
                    };
                  } else {
                    return c;
                  }
                }
                return c;
              }),
            },
          };
        }
      }

      const logMessage = sdkToLogConverter.convert(msg);
      if (logMessage) {
        if (logMessage.isSidechain) {
          logger.debug(
            `[remote] sidechain msg: type=${logMessage.type} uuid=${logMessage.uuid} parentUuid=${logMessage.parentUuid} isSidechain=true`
          );
        }
        if (logMessage.type === "user" && logMessage.message?.content) {
          const content = Array.isArray(logMessage.message.content)
            ? logMessage.message.content
            : [];

          for (let i = 0; i < content.length; i++) {
            const c = content[i];
            if (c.type === "tool_result" && c.tool_use_id) {
              const responses = permissionHandler.getResponses();
              const response = responses.get(c.tool_use_id);

              if (response) {
                const permissions: PermissionsField = {
                  date: response.receivedAt || Date.now(),
                  result: response.approved ? "approved" : "denied",
                };

                if (response.mode) {
                  permissions.mode = response.mode;
                }

                if (response.allowTools && response.allowTools.length > 0) {
                  permissions.allowedTools = response.allowTools;
                }

                content[i] = {
                  ...c,
                  permissions,
                };
              }
            }
          }
        }

        if (logMessage.type === "assistant" && message.type === "assistant") {
          const assistantMsg = message as SDKAssistantMessage;
          const toolCallIds: string[] = [];

          if (
            assistantMsg.message.content &&
            Array.isArray(assistantMsg.message.content)
          ) {
            for (const block of assistantMsg.message.content) {
              if (block.type === "tool_use" && block.id) {
                toolCallIds.push(block.id);
              }
            }
          }

          if (toolCallIds.length > 0) {
            const isSidechain = assistantMsg.parent_tool_use_id !== undefined;

            if (!isSidechain) {
              messageQueue.enqueue(logMessage, {
                delay: 250,
                toolCallIds,
              });
              return;
            }
          }
        }

        messageQueue.enqueue(logMessage);
      }

      if (message.type === "assistant") {
        let umessage = message as SDKAssistantMessage;
        if (
          umessage.message.content &&
          Array.isArray(umessage.message.content)
        ) {
          for (let c of umessage.message.content) {
            if (
              c.type === "tool_use" &&
              c.name === "Task" &&
              c.input &&
              typeof c.input === "object" &&
              "prompt" in c.input &&
              typeof (c.input as Record<string, unknown>).prompt === "string"
            ) {
              const logMessage2 = sdkToLogConverter.convertSidechainUserMessage(
                c.id!,
                (c.input as Record<string, unknown>).prompt as string
              );
              if (logMessage2) {
                logger.debug(
                  `[remote] sidechain root created: toolUseId=${c.id} uuid=${logMessage2.uuid} parentUuid=${logMessage2.parentUuid}`
                );
                messageQueue.enqueue(logMessage2);
              }
            }
          }
        }
      }
    }

    try {
      let pending: {
        message: string;
        mode: EnhancedMode;
      } | null = null;

      // Spawn-time --yolo sets session.permissionMode to "bypassPermissions",
      // but the web client's first message arrives with "default" because it
      // doesn't know about the spawn flag.  We apply the override on the first
      // message only so the SDK, permission handler, keepAlive, and UI all
      // reflect the correct mode.  Subsequent user changes from the UI are
      // respected normally.
      const spawnBypass = session.claudeArgs?.includes(
        "--dangerously-skip-permissions"
      );
      let spawnModeApplied = false;

      // Consecutive launch failure detection (Issue #638):
      // When Claude's child process dies, claudeRemote() throws and the outer
      // loop retries. Without user interaction the retry just blocks on
      // waitForSingleMessage() forever — the wrapper appears "stuck."
      // After MAX_CONSECUTIVE_LAUNCH_FAILURES without a successful user
      // interaction, we exit the loop so the wrapper process terminates
      // and the tmux window becomes reclaimable.
      const MAX_CONSECUTIVE_LAUNCH_FAILURES = 3;
      let consecutiveLaunchFailures = 0;
      let consecutiveSignalFailures = 0;
      // Minimum duration (ms) for a claudeRemote() run to be considered
      // "successful."  If it returns in under this threshold — whether by
      // throwing or by completing normally — it counts as a launch failure.
      // Normal interactive sessions spend minutes/hours inside claudeRemote(),
      // so a sub-5-second return is a strong signal the process died
      // immediately.
      const MIN_HEALTHY_DURATION_MS = 5_000;

      // Signal-aware retry: external signals (SIGTERM, SIGKILL) are often
      // transient — the process can recover with a clean restart + resume.
      // Use a separate, higher retry budget and add a cooldown to let the
      // system stabilize before retrying.
      const MAX_SIGNAL_RETRIES = 5;
      const SIGNAL_RETRY_COOLDOWN_MS = 3_000;

      let previousSessionId: string | null = null;
      while (!this.exitReason) {
        logger.debug("[remote]: launch");
        messageBuffer.addMessage("═".repeat(40), "status");

        const isNewSession = session.sessionId !== previousSessionId;
        if (isNewSession) {
          messageBuffer.addMessage("Starting new Claude session...", "status");
          permissionHandler.reset();
          sdkToLogConverter.resetParentChain();
          logger.debug(
            `[remote]: New session detected (previous: ${previousSessionId}, current: ${session.sessionId})`
          );
        } else {
          messageBuffer.addMessage("Continuing Claude session...", "status");
          logger.debug(
            `[remote]: Continuing existing session: ${session.sessionId}`
          );
        }

        previousSessionId = session.sessionId;
        const controller = new AbortController();
        this.abortController = controller;
        this.abortFuture = new Future<void>();
        let modeHash: string | null = null;
        let mode: EnhancedMode | null = null;
        const launchStartTime = Date.now();
        // Multi-account (epic #1446, Sub-Issue D): resolve the bound account's
        // token at each (re)launch (R7). Throws on unknown/unrefreshable (R3) —
        // surfaced via launch-error handling, never a silent host-credential fallback.
        // Issue #1551: prefer per-account CLAUDE_CONFIG_DIR isolation for a bound
        // non-host account (native owns refresh). null falls through to the
        // env-token path, which AUGMENTS — never replaces — isolation (Fallback
        // Preservation Rule) and carries the unknown/unrefreshable throws (R3/R4).
        // Issue #4568 (R4): an API-key session checks its vault binding BY ID at
        // every (re)launch; its ONLY credential is the settings-file
        // `apiKeyHelper` — no isolated config dir, no OAuth token, and no key in
        // any env (F1). A missing id or a changed key fails CLOSED (never a
        // fallback to an account or the host login); the reason is posted to the
        // session first so the user sees which key failed. A safe-mode key
        // session keeps its helper through a helper-only settings file
        // (claudeRemote).
        const apiKeyBound = readBoundApiKeyId() !== null;
        if (apiKeyBound) {
          try {
            await verifyApiKeyForSession();
          } catch (error) {
            session.client.sendSessionEvent({
              type: "message",
              message: `Session cannot start: ${error instanceof Error ? error.message : String(error)}`,
            });
            throw error;
          }
        }
        const accountConfigDir = apiKeyBound
          ? null
          : await resolveAccountConfigDirForSession(session);
        // Issue #4383: hand the background-Agent tracker the reconcile context —
        // the same account-isolated config dir the SDK child writes under (#1573).
        // The cc session id arrives later via onSessionFound (SessionBase
        // recomputes the subagents/ path then).
        session.setBackgroundAgentContext({
          configDir: accountConfigDir ?? undefined,
          workingDirectory: session.path,
        });
        const accountToken =
          apiKeyBound || accountConfigDir
            ? null
            : await resolveAccountTokenForSession(session);
        try {
          await claudeRemote({
            sessionId: session.sessionId,
            path: session.path,
            allowedTools: session.allowedTools ?? [],
            mcpServers: session.mcpServers,
            hookSettingsPath: session.hookSettingsPath,
            canCallTool: permissionHandler.handleToolCall,
            isAborted: (toolCallId: string) => {
              return permissionHandler.isAborted(toolCallId);
            },
            nextMessage: async () => {
              if (pending) {
                let p = pending;
                pending = null;
                // Apply spawn-time bypass on first message
                const effectivePerm =
                  spawnBypass && !spawnModeApplied
                    ? "bypassPermissions"
                    : p.mode.permissionMode;
                if (spawnBypass && !spawnModeApplied) {
                  spawnModeApplied = true;
                  p = {
                    ...p,
                    mode: { ...p.mode, permissionMode: effectivePerm },
                  };
                }
                permissionHandler.handleModeChange(effectivePerm);
                return p;
              }

              let msg = await session.queue.waitForSingleMessage(
                controller.signal,
                () => {
                  // Queue is empty and we're about to block — safe to signal ready
                  if (!pending) {
                    session.client.sendSessionEvent({ type: "ready" });
                  }
                }
              );

              if (msg) {
                if ((modeHash && msg.hash !== modeHash) || msg.isolate) {
                  logger.debug("[remote]: mode has changed, pending message");
                  pending = msg;
                  return null;
                }
                modeHash = msg.hash;
                mode = msg.mode;
                // Apply spawn-time bypass on first message
                const effectivePerm =
                  spawnBypass && !spawnModeApplied
                    ? "bypassPermissions"
                    : mode.permissionMode;
                if (spawnBypass && !spawnModeApplied) {
                  spawnModeApplied = true;
                  mode = { ...mode, permissionMode: effectivePerm };
                }
                permissionHandler.handleModeChange(effectivePerm);
                return {
                  message: msg.message,
                  mode,
                };
              }

              return null;
            },
            onSessionFound: sessionId => {
              session.onSessionFound(sessionId);
            },
            onThinkingChange: session.onThinkingChange,
            onContextUsage: session.onContextUsage,
            onMissingAttachments: (missingPaths: string[]) => {
              // Issue #1442: surface the silent multi-image data loss to the
              // sender via the proven #1078 tool-error toast path. Use the SAME
              // sessionId source ToolErrorDetector uses (`session.sessionId`,
              // which the server's resolveSessionForNamespace resolves) — NOT
              // the claudeRemote `sessionId` opt (the Claude resume id, null for
              // fresh sessions). The toast renders as "Attached files: <msg>".
              const names = missingPaths
                .map(p => p.split("/").pop() ?? p)
                .join(", ");
              logger.reportError({
                message: `${missingPaths.length} attached file(s) missing from disk at parse time`,
                category: "tool-error",
                severity: "warn",
                sessionId: session.sessionId,
                context: JSON.stringify({
                  toolName: "Attached files",
                  errorContent:
                    `${missingPaths.length} of the attached files were not found on disk and ` +
                    `could not be sent as images: ${names}. They were uploaded but their bytes ` +
                    `never reached disk — please re-attach and resend.`,
                }),
              });
            },
            // Issue #4568: a key session's explicit set carries NO credential —
            // the key comes from its `apiKeyHelper`, and `apiKeyHelperSession`
            // strips every env credential that outranks the helper. Every other
            // session keeps its account binding.
            apiKeyHelperSession: apiKeyBound,
            claudeEnvVars: apiKeyBound
              ? session.claudeEnvVars
              : withAccountConfigDir(
                  withAccountToken(session.claudeEnvVars, accountToken),
                  accountConfigDir
                ),
            claudeArgs: session.claudeArgs,
            onMessage,
            onCompletionEvent: (message: string) => {
              logger.debug(`[remote]: Completion event: ${message}`);
              session.client.sendSessionEvent({ type: "message", message });
            },
            onSessionReset: () => {
              logger.debug("[remote]: Session reset");
              session.clearSessionId();
            },
            onReady: () => {
              // Ready is now emitted via the onWaitStarted callback in
              // waitForSingleMessage(), which fires at the exact moment the
              // queue is empty and the consumer starts blocking.  This
              // eliminates the TOCTOU race where the old check fired before
              // nextMessage() had set up its waiter.
              //
              // The callback handles the "queue was empty" case.  When
              // nextMessage returns a queued item immediately (queue was
              // non-empty), ready is intentionally NOT sent — the next result
              // cycle will trigger it.
            },
            onQueryCreated: (q: Query) => {
              this.currentQuery = q;
            },
            signal: controller.signal,
          });

          // claudeRemote() returned normally.  If it ran for a healthy
          // duration (user interaction occurred), reset the failure counter.
          // A very fast return (< MIN_HEALTHY_DURATION_MS) means Claude's
          // process died immediately — count it as a launch failure just
          // like the throw path.
          const launchDurationMs = Date.now() - launchStartTime;
          if (launchDurationMs >= MIN_HEALTHY_DURATION_MS) {
            consecutiveLaunchFailures = 0;
            consecutiveSignalFailures = 0;
          } else {
            consecutiveLaunchFailures++;
            logger.warn(
              `[remote]: claudeRemote() returned in ${launchDurationMs}ms ` +
                `(< ${MIN_HEALTHY_DURATION_MS}ms threshold) — counting as ` +
                `launch failure (${consecutiveLaunchFailures}/${MAX_CONSECUTIVE_LAUNCH_FAILURES})`
            );

            // Issue #795: Log rapid-exit diagnostic
            // PR D (#1239): stderr_tail intentionally null for rapid-exit —
            // claudeRemote() returned cleanly, so the child's stderr is
            // uninteresting (no error preamble to capture). The crash-branch
            // path below populates stderr_tail when the close handler raised.
            const rapidExitEntry = createExitDiagnosticEntry({
              exitType: "rapid-exit" as const,
              exitCode: null,
              signal: null,
              hapiSessionId: session.client.sessionId,
              claudeSessionId: session.sessionId,
              duration_ms: launchDurationMs,
              workingDirectory: session.path,
              ongoingToolCalls: ongoingToolCalls.size,
              procStatus: null,
              processTree: null,
              stderr_tail: null,
              errorDetail: `Rapid exit in ${launchDurationMs}ms`,
            });
            logExitDiagnostics(rapidExitEntry);
            // Issue #1239: also persist to error_logs SQLite for admin visibility.
            logger.reportError(
              buildSessionExitReport(rapidExitEntry, {
                consecutiveLaunchFailures,
                consecutiveSignalFailures,
              })
            );

            if (consecutiveLaunchFailures >= MAX_CONSECUTIVE_LAUNCH_FAILURES) {
              logger.warn(
                `[remote]: ${consecutiveLaunchFailures} consecutive rapid exits — ` +
                  `Claude process is not recoverable. Exiting wrapper.`
              );
              session.client.sendSessionEvent({
                type: "message",
                message:
                  `Session terminated: Claude process exited ${consecutiveLaunchFailures} ` +
                  `consecutive times without successful interaction. ` +
                  `This typically means the Claude process crashed or the API is unreachable.`,
              });
              break;
            }
          }

          session.consumeOneTimeFlags();

          if (!this.exitReason && controller.signal.aborted) {
            session.client.sendSessionEvent({
              type: "message",
              message: "Aborted by user",
            });
          }
        } catch (e) {
          const isSignalExit = e instanceof SignalExitError;
          const errorDetail = isSignalExit
            ? e.message
            : enrichWithSignalContext(
                e instanceof Error ? e.message : String(e)
              );
          const launchDurationMs = Date.now() - launchStartTime;

          logger.warn("[remote]: launch error", e);
          logger.warn(
            `[remote]: Claude process exited unexpectedly — ` +
              `type=${isSignalExit ? "signal" : "crash"}, ` +
              `duration=${launchDurationMs}ms, ` +
              `ongoingToolCalls=${ongoingToolCalls.size}, ` +
              `error=${errorDetail}`
          );

          // Issue #795 + #1239: Log structured exit diagnostics to JSONL.
          // Both SignalExitError (signal kill) and ChildExitError (non-signal
          // crash, code 1-127) carry structured exitCode/procStatus/childPid.
          // Pre-#1239 the non-signal branch was wrapped in a generic Error
          // and these fields were null in JSONL.
          {
            const isChildExit = e instanceof ChildExitError;
            const isTypedExit = isSignalExit || isChildExit;
            const typedErr = isTypedExit
              ? (e as SignalExitError | ChildExitError)
              : null;
            const procStatus = typedErr?.procStatus ?? null;
            const childPid = typedErr?.childPid;
            const exitCode = typedErr?.exitCode ?? null;
            const signal = isSignalExit
              ? (e as SignalExitError).signalName
              : null;
            // PR D (#1239): pull the stderr ring tail off the typed error.
            // For signal/crash exits the child wrote stderr (Node/Bun
            // runtime errors, parseStderrApiError-discarded lines, etc.)
            // that PR A's procStatus could not capture — /proc is reaped
            // before the close handler runs but stderr was buffered in
            // the parent. Empty/whitespace-only stderr → null so the
            // SQLite context omits a no-op "".
            const stderrTail = typedErr?.stderrTail ?? null;

            const exitEntry = createExitDiagnosticEntry({
              exitType: isSignalExit ? ("signal" as const) : ("crash" as const),
              exitCode,
              signal,
              hapiSessionId: session.client.sessionId,
              claudeSessionId: session.sessionId,
              duration_ms: launchDurationMs,
              workingDirectory: session.path,
              ongoingToolCalls: ongoingToolCalls.size,
              procStatus,
              processTree: childPid ? captureProcessTree(childPid) : null,
              stderr_tail: stderrTail,
              errorDetail,
            });
            logExitDiagnostics(exitEntry);

            // Send structured event to web UI
            session.client.sendSessionEvent({
              type: "exit-diagnostics",
              exitType: exitEntry.exitType,
              exitCode,
              signal,
              duration_ms: launchDurationMs,
              ongoingToolCalls: ongoingToolCalls.size,
              errorDetail,
            });

            // Issue #1239: also persist to error_logs SQLite so the crash is
            // visible in /admin/error-logs alongside other server errors.
            // Mirrors the #1078 (tool-error) and #1107 (mcp-toggle) wire-up.
            logger.reportError(
              buildSessionExitReport(exitEntry, {
                consecutiveLaunchFailures,
                consecutiveSignalFailures,
              })
            );
          }

          if (!this.exitReason) {
            if (isSignalExit) {
              // Signal-based exit (Issue #793): higher retry budget + cooldown
              consecutiveSignalFailures++;
              logger.warn(
                `[remote]: Signal exit (${e.signalName}) — ` +
                  `retry ${consecutiveSignalFailures}/${MAX_SIGNAL_RETRIES}, ` +
                  `cooldown ${SIGNAL_RETRY_COOLDOWN_MS}ms`
              );

              if (consecutiveSignalFailures >= MAX_SIGNAL_RETRIES) {
                logger.warn(
                  `[remote]: ${consecutiveSignalFailures} consecutive signal exits — ` +
                    `Claude process is not recoverable. Exiting wrapper.`
                );
                session.client.sendSessionEvent({
                  type: "message",
                  message:
                    `Session terminated: Claude process was killed by ${e.signalName} ` +
                    `${consecutiveSignalFailures} consecutive times. ` +
                    `Session ran for ${Math.round(launchDurationMs / 1000)}s before last exit. ` +
                    `The session can be resumed manually with --resume.`,
                });
                break;
              }

              session.client.sendSessionEvent({
                type: "message",
                message:
                  `Process killed by ${e.signalName} — retrying in ` +
                  `${SIGNAL_RETRY_COOLDOWN_MS / 1000}s ` +
                  `(attempt ${consecutiveSignalFailures}/${MAX_SIGNAL_RETRIES})...`,
              });

              await delay(SIGNAL_RETRY_COOLDOWN_MS);
              continue;
            } else {
              // Non-signal crash: existing behavior (rapid retry, lower budget)
              consecutiveLaunchFailures++;
              logger.warn(
                `[remote]: Claude process crashed ` +
                  `(${consecutiveLaunchFailures}/${MAX_CONSECUTIVE_LAUNCH_FAILURES}): ` +
                  errorDetail
              );

              if (
                consecutiveLaunchFailures >= MAX_CONSECUTIVE_LAUNCH_FAILURES
              ) {
                logger.warn(
                  `[remote]: ${consecutiveLaunchFailures} consecutive launch failures — ` +
                    `Claude process is not recoverable. Exiting wrapper.`
                );
                session.client.sendSessionEvent({
                  type: "message",
                  message:
                    `Session terminated: Claude process exited ${consecutiveLaunchFailures} ` +
                    `consecutive times without successful interaction. ` +
                    `This typically means the Claude process crashed or the API is unreachable. ` +
                    `Last error: ${errorDetail}`,
                });
                break;
              }

              session.client.sendSessionEvent({
                type: "message",
                message: `Process exited unexpectedly: ${errorDetail}`,
              });
              continue;
            }
          }
        } finally {
          logger.debug("[remote]: launch finally");

          // Clear the active Query reference so a late-arriving mcp-toggle RPC
          // returns no_active_query instead of dispatching to a dead pipe.
          this.currentQuery = null;

          for (let [toolCallId, { parentToolCallId }] of ongoingToolCalls) {
            const converted = sdkToLogConverter.generateInterruptedToolResult(
              toolCallId,
              parentToolCallId
            );
            if (converted) {
              logger.debug(
                "[remote]: terminating tool call " +
                  toolCallId +
                  " parent: " +
                  parentToolCallId
              );
              session.client.sendClaudeSessionMessage(converted);
            }
          }
          ongoingToolCalls.clear();

          logger.debug("[remote]: flushing message queue");
          messageQueue.flush();
          messageQueue.destroy();
          logger.debug("[remote]: message queue flushed");

          this.abortController = null;
          this.abortFuture?.resolve(undefined);
          this.abortFuture = null;
          logger.debug("[remote]: launch done");
          permissionHandler.reset();
          // Issue #1078: clear the detector's tool_use_id maps between
          // crash-restart cycles so orphaned IDs from a previous run don't
          // surface as "unknown"-tool errors when the SDK recycles them.
          toolErrorDetector.reset();
          // Issue #1232: clear the api-error retry rate-limit map between
          // crash-restart cycles so a recycled session's first retry report
          // after restart isn't silently swallowed by a stale window.
          apiErrorDetector.reset();
          // Issue #1348: same rationale for the UserPromptSubmit-block detector
          // — clear uuid + content-debounce state between crash-restart cycles
          // so stale entries don't suppress legitimate new blocks.
          userPromptBlockDetector.reset();
          // Issue #1460: same rationale for the in-session-cron usage detector
          // — clear warned tool_use_ids between crash-restart cycles so a stale
          // id doesn't suppress a legitimate new cron warning.
          cronUsageDetector.reset();
          // Issue #1604: clear the surrogate-loop counter + fire-latch between
          // crash-restart cycles so a stale streak doesn't carry across attempts.
          surrogateErrorDetector.reset();
          // Issue #1633: clear the refusal dedup set between cycles too.
          refusalDetector.reset();
          // Issue #1647: clear the rate-limit latch between crash-restart cycles
          // so a stale latch doesn't suppress a legitimate new 429 chip.
          rateLimitDetector.reset();
          modeHash = null;
          mode = null;
        }
      }
    } finally {
      // Issue #3235: the SDK launcher wires onCleared (falling-edge clear) but has
      // no per-turn onThinkingChange(false) teardown, so clear the chip here on
      // launch exit — a dead session must not show a stale rate-limited chip.
      session.setRateLimited(null);
      if (this.permissionHandler) {
        this.permissionHandler.reset();
      }
    }
  }

  protected async cleanup(): Promise<void> {
    this.clearAbortHandlers(this.session.client.rpcHandlerManager);

    // Replace the mcp-toggle handler with a config-write stub so RPCs
    // arriving after teardown (e.g. during a mode switch) still apply the
    // toggle durably to ~/.claude.json. The local launcher will register
    // its own stub when it takes over. Service extracted in #1101 — both
    // launchers now share the same closure factory for cleanup behavior.
    this.session.client.rpcHandlerManager.registerHandler(
      "mcp-toggle",
      createCleanupHandler({ sessionPath: this.session.path }),
      NO_META_TEARDOWN
    );

    // Issue #2256: clear the live-query accessor so a set-model RPC arriving
    // after teardown (e.g. during a mode switch) degrades to method:"config"
    // (the durable pin) instead of reaching a stale/cleared Query.
    this.session.setLiveQueryAccessor(null);

    if (this.handleSessionFound) {
      this.session.removeSessionFoundCallback(this.handleSessionFound);
      this.handleSessionFound = null;
    }

    if (this.permissionHandler) {
      this.permissionHandler.reset();
    }

    if (this.abortFuture) {
      this.abortFuture.resolve(undefined);
    }
  }
}

export async function claudeRemoteLauncher(
  session: Session
): Promise<"switch" | "exit"> {
  const launcher = new ClaudeRemoteLauncher(session);
  return launcher.launch();
}
