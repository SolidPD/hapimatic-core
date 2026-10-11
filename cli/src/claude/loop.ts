// SPDX-License-Identifier: MIT
import { ApiSessionClient } from "@/api/apiSession";
import { MessageQueue2 } from "@/utils/MessageQueue2";
import { logger } from "@/ui/logger";
import { runLocalRemoteSession } from "@/agent/loopBase";
import { Session } from "./session";
import { claudeLocalLauncher } from "./claudeLocalLauncher";
import { selectClaudeRemoteLauncher } from "./launcherDispatch";
import { ApiClient } from "@/lib";
import type { SessionModelMode } from "@/api/types";
import type { ClaudePermissionMode } from "@hapi/protocol/types";
import { deriveModelModeFromRaw } from "@hapi/protocol";

export type PermissionMode = ClaudePermissionMode;

export interface EnhancedMode {
  permissionMode: PermissionMode;
  model?: string;
  fallbackModel?: string;
  /** Issue #2456: reasoning-effort level (`--effort`). Hashed by the message
   *  queue (runClaude) so a mid-session effort change re-spawns the SDK query. */
  effort?: string;
  customSystemPrompt?: string;
  appendSystemPrompt?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
}

interface LoopOptions {
  path: string;
  model?: string;
  /** Issue #2456: reasoning-effort level, seeded from runClaude's currentEffort. */
  effort?: string;
  permissionMode?: PermissionMode;
  startingMode?: "local" | "remote";
  startedBy?: "daemon" | "terminal";
  onModeChange: (mode: "local" | "remote") => void;
  mcpServers: Record<string, any>;
  session: ApiSessionClient;
  api: ApiClient;
  claudeEnvVars?: Record<string, string>;
  claudeArgs?: string[];
  messageQueue: MessageQueue2<EnhancedMode>;
  allowedTools?: string[];
  onSessionReady?: (session: Session) => void;
  hookSettingsPath: string;
}

export async function loop(opts: LoopOptions) {
  // Get log path for debug display
  const logPath = logger.logFilePath;
  const startedBy = opts.startedBy ?? "terminal";
  const startingMode = opts.startingMode ?? "local";
  // Issue #1633: raw-value → display-mode derivation lives in the shared
  // helper (see its doc comment for the fable/#1506 clobber rationale).
  const modelMode: SessionModelMode = deriveModelModeFromRaw(opts.model);
  const session = new Session({
    api: opts.api,
    client: opts.session,
    path: opts.path,
    sessionId: null,
    claudeEnvVars: opts.claudeEnvVars,
    claudeArgs: opts.claudeArgs,
    mcpServers: opts.mcpServers,
    logPath: logPath,
    messageQueue: opts.messageQueue,
    allowedTools: opts.allowedTools,
    onModeChange: opts.onModeChange,
    mode: startingMode,
    startedBy,
    startingMode,
    hookSettingsPath: opts.hookSettingsPath,
    permissionMode: opts.permissionMode ?? "default",
    modelMode,
    // Issue #1608: seed the launcher's entitled-pin discriminator. `opts.model`
    // is runClaude's `currentModel` ("opus[1m]" for an entitled-default session,
    // set by the #1506 block BEFORE loop() is called). syncSessionModes keeps it
    // current thereafter.
    model: opts.model,
    // Issue #2456: seed the session's effort carrier so the keepAlive tick
    // reports the live effort and set-session-config can restart with it.
    effort: opts.effort,
  });

  await runLocalRemoteSession({
    session,
    startingMode: opts.startingMode,
    logTag: "loop",
    runLocal: claudeLocalLauncher,
    runRemote: selectClaudeRemoteLauncher(),
    onSessionReady: opts.onSessionReady,
  });
}
