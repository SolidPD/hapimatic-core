// SPDX-License-Identifier: MIT AND AGPL-3.0-only
import { mkdirSync } from "node:fs";
import { logger } from "@/ui/logger";
import { restoreTerminalState } from "@/ui/terminalState";
import { claudeCheckSession } from "./utils/claudeCheckSession";
import { getProjectPath } from "./utils/path";
import { appendMcpConfigArg } from "./utils/mcpConfig";
import { buildSystemPrompt } from "./utils/systemPrompt";
import { withBunRuntimeEnv } from "@/utils/bunRuntime";
import { spawnWithAbort } from "@/utils/spawnWithAbort";
import { getDefaultClaudeCodePath } from "./sdk/utils";
import { buildSdkSpawnEnv } from "./launcherShared";

export async function claudeLocal(opts: {
  abort: AbortSignal;
  sessionId: string | null;
  mcpServers?: Record<string, any>;
  path: string;
  claudeEnvVars?: Record<string, string>;
  claudeArgs?: string[];
  allowedTools?: string[];
  hookSettingsPath: string;
}) {
  // Ensure project directory exists
  const projectDir = getProjectPath(opts.path);
  mkdirSync(projectDir, { recursive: true });

  // Check if user passed explicit session control flags.
  const hasContinueFlag = opts.claudeArgs?.includes("--continue");
  const hasResumeFlag = opts.claudeArgs?.includes("--resume");
  const hasUserSessionControl = Boolean(hasContinueFlag || hasResumeFlag);

  // Determine session strategy:
  // - If resuming an existing session: use --resume (unless user already supplied session control)
  // - If starting fresh: let Claude create a new session ID (reported via SessionStart hook)
  let startFrom = opts.sessionId;
  if (opts.sessionId && !claudeCheckSession(opts.sessionId, opts.path)) {
    startFrom = null;
  }

  if (opts.abort.aborted) {
    logger.debug(
      "[ClaudeLocal] Abort already signaled before spawn; skipping launch"
    );
    return startFrom ?? null;
  }

  // Build args for Claude CLI
  const args: string[] = [];

  if (startFrom && !hasUserSessionControl) {
    // Resume existing session
    args.push("--resume", startFrom);
  }

  // Issue #1633: a --safe-mode spawn suppresses Hapimatic's own injections.
  // Empirically (v2.1.170) --safe-mode disables CLI-arg --mcp-config servers
  // and --settings hooks anyway, while --append-system-prompt SURVIVES — so
  // without suppression every safe-mode session starts with a system prompt
  // instructing calls to hapi MCP tools that do not exist. Omitting all four
  // injections keeps the preamble minimal (the feature's purpose). Expected
  // degradations: no change_title/image_fetch, no hook-driven thinking-state.
  const safeMode = opts.claudeArgs?.includes("--safe-mode") ?? false;
  if (!safeMode) {
    args.push("--append-system-prompt", buildSystemPrompt(opts.path));
  }

  const cleanupMcpConfig = safeMode
    ? null
    : appendMcpConfigArg(args, opts.mcpServers, {
        baseDir: projectDir,
      });

  if (!safeMode && opts.allowedTools && opts.allowedTools.length > 0) {
    args.push("--allowedTools", opts.allowedTools.join(","));
  }

  // Add custom Claude arguments
  if (opts.claudeArgs) {
    args.push(...opts.claudeArgs);
  }

  // Add hook settings for session tracking
  if (!safeMode) {
    args.push("--settings", opts.hookSettingsPath);
  }
  logger.debug(`[ClaudeLocal] Using hook settings: ${opts.hookSettingsPath}`);

  // Prepare environment variables
  // Note: Local mode uses global Claude installation
  // Issue #3731 (R1): the account binding comes ONLY from the explicit
  // `claudeEnvVars` — ambient BINDING_ENV_VARS (a stray CLAUDE_CODE_OAUTH_TOKEN /
  // CLAUDE_CONFIG_DIR / HAPI_ACCOUNT_UUID) never reach the child. Same precedence as
  // before: DISABLE_AUTOUPDATER sits in the base, the explicit set layers last.
  const env = buildSdkSpawnEnv(
    { ...process.env, DISABLE_AUTOUPDATER: "1" },
    opts.claudeEnvVars
  );

  logger.debug(
    `[ClaudeLocal] Spawning claude with args: ${JSON.stringify(args)}`
  );

  // Spawn the process
  try {
    process.stdin.pause();
    const claudePath = getDefaultClaudeCodePath();
    await spawnWithAbort({
      command: claudePath,
      args,
      cwd: opts.path,
      env: withBunRuntimeEnv(env, { allowBunBeBun: false }),
      signal: opts.abort,
      logLabel: "ClaudeLocal",
      spawnName: claudePath,
      installHint: "Claude CLI",
      includeCause: true,
      logExit: true,
      shell: process.platform === "win32",
    });
  } finally {
    cleanupMcpConfig?.();
    process.stdin.resume();
    restoreTerminalState();
  }

  return startFrom ?? null;
}
