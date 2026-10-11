// SPDX-License-Identifier: MIT
import { logger } from "@/ui/logger";
import { loop, type EnhancedMode, type PermissionMode } from "./loop";
import { MessageQueue2 } from "@/utils/MessageQueue2";
import { hashObject } from "@/utils/deterministicJson";
import { registerKillSessionHandler } from "@/claude/registerKillSessionHandler";
import type { AgentState } from "@/api/types";
import type { CodexSession } from "./session";
import { parseCodexCliOverrides } from "./utils/codexCliOverrides";
import { bootstrapSession } from "@/agent/sessionFactory";
import {
  createModeChangeHandler,
  createRunnerLifecycle,
  setControlledByUser,
} from "@/agent/runnerLifecycle";
import { isPermissionModeAllowedForFlavor } from "@hapi/protocol";
import { PermissionModeSchema } from "@hapi/protocol/schemas";
import { NO_META_TEARDOWN } from "@/api/rpc/types";

export { emitReadyIfIdle } from "./utils/emitReadyIfIdle";

export async function runCodex(opts: {
  startedBy?: "daemon" | "terminal";
  codexArgs?: string[];
  permissionMode?: PermissionMode;
  /** Issue #1733: gateway model id ("provider/model") for OpenRouter-routed
   *  sessions; flows into EnhancedMode.model (codexStartConfig maps it to the
   *  --model / MCP arg). Provider routing comes from config.toml. */
  model?: string;
  /** Issue #1082: codex session id to resume, from the daemon's
   *  CODEX_TMUX_RESUME_FLAG on a recovery respawn. Seeds the CodexSession
   *  sessionId → remote-mode findCodexResumeFile. Undefined on a fresh spawn. */
  resumeCodexSessionId?: string;
}): Promise<void> {
  const workingDirectory = process.cwd();
  const startedBy = opts.startedBy ?? "terminal";

  logger.debug(`[codex] Starting with options: startedBy=${startedBy}`);

  let state: AgentState = {
    controlledByUser: false,
  };
  const { api, session } = await bootstrapSession({
    flavor: "codex",
    startedBy,
    workingDirectory,
    agentState: state,
  });

  const startingMode: "local" | "remote" =
    startedBy === "daemon" ? "remote" : "local";

  setControlledByUser(session, startingMode);

  const messageQueue = new MessageQueue2<EnhancedMode>(mode =>
    hashObject({
      permissionMode: mode.permissionMode,
      model: mode.model,
    })
  );

  const codexCliOverrides = parseCodexCliOverrides(opts.codexArgs);
  const sessionWrapperRef: { current: CodexSession | null } = { current: null };

  let currentPermissionMode: PermissionMode = opts.permissionMode ?? "default";

  const lifecycle = createRunnerLifecycle({
    session,
    logTag: "codex",
    stopKeepAlive: () => sessionWrapperRef.current?.stopKeepAlive(),
  });

  lifecycle.registerProcessHandlers();
  registerKillSessionHandler(
    session.rpcHandlerManager,
    lifecycle.cleanupAndExit
  );

  const syncSessionMode = () => {
    const sessionInstance = sessionWrapperRef.current;
    if (!sessionInstance) {
      return;
    }
    sessionInstance.setPermissionMode(currentPermissionMode);
    logger.debug(
      `[Codex] Synced session permission mode for keepalive: ${currentPermissionMode}`
    );
  };

  session.onUserMessage(message => {
    const messagePermissionMode = currentPermissionMode;
    logger.debug(
      `[Codex] User message received with permission mode: ${currentPermissionMode}`
    );

    const enhancedMode: EnhancedMode = {
      permissionMode: messagePermissionMode ?? "default",
    };
    // Issue #1733: carry the OpenRouter model into the codex session config
    // (codexStartConfig maps mode.model → the MCP/--model arg).
    if (opts.model) {
      enhancedMode.model = opts.model;
    }
    messageQueue.push(message.content.text, enhancedMode);
  });

  const formatFailureReason = (message: string): string => {
    const maxLength = 200;
    if (message.length <= maxLength) {
      return message;
    }
    return `${message.slice(0, maxLength)}...`;
  };

  const resolvePermissionMode = (value: unknown): PermissionMode => {
    const parsed = PermissionModeSchema.safeParse(value);
    if (
      !parsed.success ||
      !isPermissionModeAllowedForFlavor(parsed.data, "codex")
    ) {
      throw new Error("Invalid permission mode");
    }
    return parsed.data as PermissionMode;
  };

  session.rpcHandlerManager.registerHandler(
    "set-session-config",
    async (payload: unknown) => {
      if (!payload || typeof payload !== "object") {
        throw new Error("Invalid session config payload");
      }
      const config = payload as { permissionMode?: unknown };

      if (config.permissionMode !== undefined) {
        currentPermissionMode = resolvePermissionMode(config.permissionMode);
      }

      syncSessionMode();
      return { applied: { permissionMode: currentPermissionMode } };
    },
    NO_META_TEARDOWN
  );

  try {
    await loop({
      path: workingDirectory,
      startingMode,
      messageQueue,
      api,
      session,
      codexArgs: opts.codexArgs,
      codexCliOverrides,
      startedBy,
      // #1082: thread the resume id into the CodexSession sessionId.
      resumeCodexSessionId: opts.resumeCodexSessionId,
      permissionMode: currentPermissionMode,
      onModeChange: createModeChangeHandler(session),
      onSessionReady: instance => {
        sessionWrapperRef.current = instance;
        syncSessionMode();
      },
    });
  } catch (error) {
    lifecycle.markCrash(error);
    logger.debug("[codex] Loop error:", error);
  } finally {
    const localFailure = sessionWrapperRef.current?.localLaunchFailure;
    if (localFailure?.exitReason === "exit") {
      lifecycle.setExitCode(1);
      lifecycle.setArchiveReason(
        `Local launch failed: ${formatFailureReason(localFailure.message)}`
      );
    }
    await lifecycle.cleanupAndExit();
  }
}
