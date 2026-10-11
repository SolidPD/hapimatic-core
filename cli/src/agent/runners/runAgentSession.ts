// SPDX-License-Identifier: AGPL-3.0-only
import type { AgentState } from "@/api/types";
import { logger } from "@/ui/logger";
import { MessageQueue2 } from "@/utils/MessageQueue2";
import { hashObject } from "@/utils/deterministicJson";
import { AgentRegistry } from "@/agent/AgentRegistry";
import { convertAgentMessage } from "@/agent/messageConverter";
import { AgentTurnReporter } from "@/agent/utils/agentTurnReporter";
import { PermissionAdapter } from "@/agent/permissionAdapter";
import type {
  AgentBackend,
  McpServerStdio,
  PromptContent,
} from "@/agent/types";
import {
  mergeAcpMcpServers,
  readProjectedAcpMcpServers,
} from "@/agent/projection/mcp";
import { startHappyServer } from "@/claude/utils/startHappyServer";
import { configuration } from "@/configuration";
import { renderTier0, capabilityCatalogIndex } from "@hapi/protocol";
import { getHappyCliCommand } from "@/utils/spawnHappyCLI";
import { registerKillSessionHandler } from "@/claude/registerKillSessionHandler";
import { bootstrapSession } from "@/agent/sessionFactory";
// Imported from the leaf `@/ext/lifecycle`, NOT `@/ext/host` — see the note at
// the matching imports in `@/agent/sessionBase` and `@/agent/runnerLifecycle`.
import { fireSessionEnd, fireSessionStart } from "@/ext/lifecycle";
import { reportScorecardRun } from "@/agent/scorecardRunReporter";
import { NO_META_TEARDOWN } from "@/api/rpc/types";

function emitReadyIfIdle(props: {
  queueSize: () => number;
  shouldExit: boolean;
  thinking: boolean;
  sendReady: () => void;
}): void {
  if (props.shouldExit) return;
  if (props.thinking) return;
  if (props.queueSize() > 0) return;
  props.sendReady();
}

/**
 * Build the ACP prompt content for one turn, prepending the Tier-0 capability
 * block on the FIRST turn only (issue #3748, Sub H, R6). Gemini/opencode (ACP)
 * have no system-prompt carrier, so Tier-0 rides a leading USER-turn text block;
 * it lands in transcript history and does NOT survive a transcript trim. Gated
 * by the HAPI_CAPABILITY_TIER0 kill-switch (R8). Pure + exported for unit testing.
 */
export function buildAgentPromptContent(
  message: string,
  tier0AlreadySent: boolean
): { content: PromptContent[]; tier0Sent: boolean } {
  const content: PromptContent[] = [];
  if (!tier0AlreadySent && configuration.capabilityTier0Enabled) {
    content.push({ type: "text", text: renderTier0(capabilityCatalogIndex) });
  }
  content.push({ type: "text", text: message });
  return { content, tier0Sent: true };
}

/**
 * Resolve `{ modelProvider, modelId }` for an ACP flavor's turn rows (issue
 * #3352, R8). The provider MUST be non-null so #3353's provider-keyed rate cards
 * resolve (a NULL provider defaults to `anthropic` and misprices a non-claude
 * row). `modelId` seeds from `metadata.nativeModel` (#3348); gemini's per-turn
 * emission refines it. opencode's model id may be provider-prefixed
 * ("provider/model") — split it so the provider is accurate.
 */
export function resolveAcpProvider(
  flavor: string,
  nativeModel: string | undefined
): { provider: string; modelId?: string } {
  if (flavor === "gemini") return { provider: "google", modelId: nativeModel };
  if (nativeModel && nativeModel.includes("/")) {
    const slash = nativeModel.indexOf("/");
    return {
      provider: nativeModel.slice(0, slash),
      modelId: nativeModel.slice(slash + 1),
    };
  }
  return { provider: flavor, modelId: nativeModel };
}

export async function runAgentSession(opts: {
  agentType: string;
  startedBy?: "daemon" | "terminal";
}): Promise<void> {
  const initialState: AgentState = {
    controlledByUser: false,
  };
  const { session } = await bootstrapSession({
    flavor: opts.agentType,
    startedBy: opts.startedBy ?? "terminal",
    workingDirectory: process.cwd(),
    agentState: initialState,
  });

  session.updateAgentState(currentState => ({
    ...currentState,
    controlledByUser: false,
  }));

  // Extension session-start (issue #1273). ACP-style agents (Gemini, OpenCode)
  // run through this generic runner rather than `AgentSessionBase`, so without
  // this seam they emitted no lifecycle events at all — the gap sub-issue D
  // (#1268) explicitly deferred to this issue. Guarded because the extension
  // system is OPTIONAL infrastructure that must never break a session; handler
  // faults are already contained inside the emitter.
  try {
    fireSessionStart(session.getSessionSnapshot());
  } catch (error) {
    logger.warn("[ext.lifecycle] failed to emit session start:", error);
  }

  const messageQueue = new MessageQueue2<Record<string, never>>(() =>
    hashObject({})
  );

  session.onUserMessage(message => {
    messageQueue.push(message.content.text, {});
  });

  const backend: AgentBackend = AgentRegistry.create(opts.agentType);

  // #3347: start the keepAlive heartbeat IMMEDIATELY — before backend boot —
  // matching claude's construction-time start (`sessionBase.ts` constructor).
  // Session records are created `active=0`; the ONLY durable path to `active=true`
  // is this heartbeat. The pre-#3347 code started it only AFTER
  // `backend.initialize()`/`startHappyServer()`/`newSession()`, so an ACP backend's
  // slow boot (auth, model load, ACP handshake) left the session showing
  // "disconnected / needs manual Connect" for the whole boot window — and FOREVER
  // if boot threw (the heartbeat was never reached). The boot-failure guard below
  // stops it so a failed boot goes honestly inactive with a visible error rather
  // than a silent, permanently-disconnected phantom.
  let thinking = false;
  let shouldExit = false;
  let waitAbortController: AbortController | null = null;

  // Issue #3352: agent-side per-turn telemetry. Without this, non-claude runners
  // (gemini/opencode) produce ZERO `turns` rows — the TokenUsageWidget and the
  // server token-stats stay empty for them. The reporter emits through the SAME
  // `sendTurnEvent` seam as claude; the server side is flavor-agnostic.
  const turnReporter = new AgentTurnReporter({
    emit: payload => session.sendTurnEvent(payload),
    launcher: opts.agentType,
  });
  const attribution = resolveAcpProvider(
    opts.agentType,
    session.getMetadata()?.nativeModel ?? undefined
  );
  // Latest context-window snapshot (from a `usage_update`) — held so it rides
  // every 2s keepAlive tick and self-heals across dropped emits (R6), mirroring
  // how AgentSessionBase persists `contextWindowTokens`.
  let latestContext:
    | {
        contextWindowTokens: number;
        contextUsedTokens: number;
        contextPercentage: number;
      }
    | undefined;
  let resolvedModel: string | undefined = attribution.modelId;
  let promptAborted = false;
  const contextRuntime = () => {
    if (latestContext) {
      return {
        resolvedModel,
        contextWindowTokens: latestContext.contextWindowTokens,
        contextUsedTokens: latestContext.contextUsedTokens,
        contextPercentage: latestContext.contextPercentage,
      };
    }
    return resolvedModel ? { resolvedModel } : undefined;
  };

  session.keepAlive(thinking, "remote", contextRuntime());
  const keepAliveInterval = setInterval(() => {
    session.keepAlive(thinking, "remote", contextRuntime());
  }, 2000);

  // Durability note (#3347, Task 5): the ACP flavors reached here (gemini /
  // opencode) are `tmuxSafe:false` — direct-spawn, no tmux persistence (see
  // cli/CLAUDE.md). This fix makes them land `active` on spawn like claude, but a
  // daemon RESTART still does NOT re-attach them: they require a fresh respawn
  // (unlike claude/codex, which survive via the tmux path). Restart durability for
  // these flavors is out of scope for #3347 and tracked as a separate follow-up.

  // #3347: surface an ACP backend-boot failure as a visible spawn error instead
  // of a silent inactive record. Assigned inside the try (definite-assignment `!`
  // is sound because the catch always re-throws — code past the try/catch runs
  // only on a fully-successful boot).
  let permissionAdapter!: PermissionAdapter;
  let happyServer!: Awaited<ReturnType<typeof startHappyServer>>;
  let agentSessionId!: string;
  try {
    await backend.initialize();

    permissionAdapter = new PermissionAdapter(session, backend);

    happyServer = await startHappyServer(session);
    const bridgeCommand = getHappyCliCommand(["mcp", "--url", happyServer.url]);
    const hapiEntry: McpServerStdio = {
      name: "happy",
      command: bridgeCommand.command,
      args: bridgeCommand.args,
      env: [],
    };
    // #3125 (KD1a): merge HAL-projected ACP MCP servers (written 0600 by the MCP
    // projection stage in the daemon) with the built-in hapi bridge, deduped by
    // name so the hapi server is never double-registered (R4). Fail-open — no
    // handoff artifact yields just the hapi entry, byte-identical to pre-#3125.
    const mcpServers = mergeAcpMcpServers(
      [hapiEntry],
      readProjectedAcpMcpServers()
    );

    agentSessionId = await backend.newSession({
      cwd: process.cwd(),
      mcpServers,
    });

    // #3811: persist the ACP session id into metadata.acpSessionId — the ONE
    // native id not otherwise written (claude's is claudeSessionId, codex's
    // threadId is already codexSessionId). This generic runner is the sole write
    // site for gemini, opencode, and any ACP-driven tier-2 CLI. Read by the
    // harness-neutral SessionIdDisplay via the flavor's nativeSessionId descriptor.
    session.updateMetadata(m => ({ ...m, acpSessionId: agentSessionId }));
  } catch (error) {
    // Boot failed — stop heartbeating (the session honestly goes inactive rather
    // than heartbeating a corpse), surface the reason to the operator, fire
    // session death, then re-throw so the spawn is reported as failed instead of
    // leaving a permanently-disconnected phantom. Wrapped so a fault in the
    // surfacing cannot mask the boot error we are unwinding from.
    clearInterval(keepAliveInterval);
    logger.warn(
      "[ACP] Backend boot failed — surfacing as a visible spawn error (#3347)",
      error
    );
    try {
      session.sendSessionEvent({
        type: "message",
        message: `Agent failed to start: ${error instanceof Error ? error.message : String(error)}. Check logs for details.`,
      });
      session.sendSessionDeath();
      await session.flush();
    } catch (surfaceError) {
      logger.debug("[ACP] Failed to surface backend-boot error", surfaceError);
    }
    session.close();
    await backend.disconnect().catch(() => {});
    throw error;
  }

  const sendReady = () => {
    session.sendSessionEvent({ type: "ready" });
  };

  const handleAbort = async () => {
    logger.debug("[ACP] Abort requested");
    // Issue #3352: mark the turn interrupted so its finalize outcome is
    // `interrupted` (reset at each turn-open). An abort during the idle wait
    // opens no turn, so the flag is harmless until the next open resets it.
    promptAborted = true;
    await backend.cancelPrompt(agentSessionId);
    await permissionAdapter.cancelAll("User aborted");
    thinking = false;
    session.keepAlive(thinking, "remote");
    sendReady();
    if (waitAbortController) {
      waitAbortController.abort();
    }
  };

  session.rpcHandlerManager.registerHandler(
    "abort",
    async () => {
      await handleAbort();
    },
    NO_META_TEARDOWN
  );

  const handleKillSession = async () => {
    if (shouldExit) return;
    shouldExit = true;
    // Stop heartbeats immediately so the server doesn't re-activate
    // this session after the archive (issue #678).
    clearInterval(keepAliveInterval);
    await permissionAdapter.cancelAll("Session killed");
    if (waitAbortController) {
      waitAbortController.abort();
    }
  };

  registerKillSessionHandler(session.rpcHandlerManager, handleKillSession);

  // #3748 (Sub H, R6): Gemini/opencode (ACP) have no system-prompt carrier, so
  // Tier-0 is delivered as a leading text block on the FIRST agent turn only.
  let tier0Sent = false;

  try {
    while (!shouldExit) {
      waitAbortController = new AbortController();
      const batch = await messageQueue.waitForMessagesAndGetAsString(
        waitAbortController.signal
      );
      waitAbortController = null;
      if (!batch) {
        if (shouldExit) {
          break;
        }
        continue;
      }

      // #3748 (Sub H, R6): prepend Tier-0 on the FIRST turn only (see helper).
      const { content: promptContent, tier0Sent: nextTier0Sent } =
        buildAgentPromptContent(batch.message, tier0Sent);
      tier0Sent = nextTier0Sent;

      thinking = true;
      // Issue #3352: open the turn boundary at the prompt-cycle start. Record a
      // base attribution (R8) so even a zero-token turn's row carries a
      // provider; gemini's per-turn emission adds model_id + tokens below.
      promptAborted = false;
      turnReporter.open();
      turnReporter.recordUsage({
        modelId: resolvedModel,
        modelProvider: attribution.provider,
      });
      session.keepAlive(thinking, "remote", contextRuntime());

      let promptErrored = false;
      try {
        await backend.prompt(agentSessionId, promptContent, message => {
          // Issue #3352: intercept the usage side-channels (surfaced by the ACP
          // backend + message handler) BEFORE conversion — they are not chat
          // messages. `context_usage` (session/update usage_update) feeds the
          // context snapshot (R6); `usage` (prompt-response _meta.quota) feeds
          // the per-turn token stats (R5/R8).
          if (message.type === "context_usage") {
            const w = message.contextWindowTokens;
            const u = message.contextUsedTokens;
            latestContext = {
              contextWindowTokens: w,
              contextUsedTokens: u,
              contextPercentage:
                w > 0 ? Math.min(100, Math.round((u / w) * 100)) : 0,
            };
            // Push the context to keepAlive immediately (self-heals on the tick).
            session.keepAlive(thinking, "remote", contextRuntime());
            turnReporter.recordUsage({
              contextWindowTokens: w,
              contextUsedTokens: u,
              modelId: resolvedModel,
              modelProvider: attribution.provider,
            });
            return;
          }
          if (message.type === "usage") {
            if (message.modelId) resolvedModel = message.modelId;
            turnReporter.recordUsage({
              tokIn: message.tokIn,
              tokOut: message.tokOut,
              tokCacheRead: message.tokCacheRead,
              tokCacheWrite: message.tokCacheWrite,
              modelId: message.modelId ?? resolvedModel,
              modelProvider: attribution.provider,
            });
            return;
          }
          const converted = convertAgentMessage(message);
          if (converted) {
            session.sendCodexMessage(converted);
          }
        });
      } catch (error) {
        promptErrored = true;
        logger.warn("[ACP] Prompt failed", error);
        session.sendSessionEvent({
          type: "message",
          message: "Agent prompt failed. Check logs for details.",
        });
      } finally {
        // Issue #3352: finalize the turn boundary — `interrupted` on a user
        // abort (handleAbort), else `errored` on a prompt throw, else
        // `completed`. The accumulated usage rides `turn:finalize`.
        turnReporter.finalize(
          promptAborted
            ? "interrupted"
            : promptErrored
              ? "errored"
              : "completed"
        );
        thinking = false;
        session.keepAlive(thinking, "remote", contextRuntime());
        await permissionAdapter.cancelAll("Prompt finished");
        emitReadyIfIdle({
          queueSize: () => messageQueue.size(),
          shouldExit,
          thinking,
          sendReady,
        });
      }
    }
  } finally {
    // Emitted FIRST so a fault in the teardown below cannot suppress it, and
    // wrapped so a fault here cannot mask the error we may be unwinding from
    // (issue #1273 — mirrors `@/agent/runnerLifecycle`).
    try {
      fireSessionEnd(session.getSessionSnapshot());
    } catch (error) {
      logger.warn("[ext.lifecycle] failed to emit session end:", error);
    }
    // #3128 (Task 5): fire-and-forget scorecard run report. Fully guarded
    // internally + intentionally NOT awaited — teardown latency is unchanged.
    void reportScorecardRun(session.getSessionSnapshot());
    clearInterval(keepAliveInterval);
    await permissionAdapter.cancelAll("Session ended");
    session.sendSessionDeath();
    await session.flush();
    session.close();
    await backend.disconnect();
    happyServer.stop();
  }
}
