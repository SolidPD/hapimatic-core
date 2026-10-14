// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync } from "node:fs";
import { logger } from "@/ui/logger";
import { claudeCheckSession } from "./utils/claudeCheckSession";
import { getProjectPath } from "./utils/path";
import { appendMcpConfigArg } from "./utils/mcpConfig";
import { buildSystemPrompt } from "./utils/systemPrompt";
import { withBunRuntimeEnv } from "@/utils/bunRuntime";
import { getDefaultClaudeCodePath } from "./sdk/utils";
import { FORBIDDEN_CLAUDE_ARGS, buildLauncherEnv } from "./launcherShared";

export interface ClaudePtyOptions {
  path: string;
  sessionId: string | null;
  abort: AbortSignal;
  claudeEnvVars?: Record<string, string>;
  claudeArgs?: string[];
  mcpServers?: Record<string, unknown>;
  allowedTools?: string[];
  hookSettingsPath: string;
  initialCols?: number;
  initialRows?: number;
  onPtyOutput?: (data: string) => void;
  onExit: (code: number | null, signal: string | null) => void;
}

export interface ClaudePtyHandle {
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
  killed: () => boolean;
}

export async function claudePty(
  opts: ClaudePtyOptions
): Promise<ClaudePtyHandle> {
  if (typeof Bun === "undefined" || typeof Bun.spawn !== "function") {
    throw new Error(
      "claudePty requires the Bun runtime (Bun.spawn with terminal: option). " +
        "Run hapi under the Bun-compiled binary."
    );
  }

  const projectDir = getProjectPath(opts.path);
  mkdirSync(projectDir, { recursive: true });

  if (opts.claudeArgs) {
    const violations = opts.claudeArgs.filter(a =>
      FORBIDDEN_CLAUDE_ARGS.has(a)
    );
    if (violations.length > 0) {
      throw new Error(
        `claudePty refuses SDK-classifying flags: ${violations.join(", ")}. ` +
          "These flags set CLAUDE_CODE_ENTRYPOINT=sdk-cli (the Agent SDK entrypoint; its 2026-06-15 per-token billing change is currently paused)."
      );
    }
  }

  const args: string[] = [];

  const hasContinueFlag = opts.claudeArgs?.includes("--continue");
  const hasResumeFlag = opts.claudeArgs?.includes("--resume");
  const hasUserSessionControl = Boolean(hasContinueFlag || hasResumeFlag);
  let startFrom = opts.sessionId;
  if (opts.sessionId && !claudeCheckSession(opts.sessionId, opts.path)) {
    startFrom = null;
  }
  if (startFrom && !hasUserSessionControl) {
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

  if (opts.claudeArgs) {
    args.push(...opts.claudeArgs);
  }

  if (!safeMode) {
    args.push("--settings", opts.hookSettingsPath);
  }

  const baseEnv = buildLauncherEnv(opts.claudeEnvVars);
  const finalEnv = withBunRuntimeEnv(baseEnv, { allowBunBeBun: false });
  const claudePath = getDefaultClaudeCodePath();

  logger.debug(
    `[ClaudePty] spawning ${claudePath} args=${JSON.stringify(args)}`
  );

  let exited = false;
  const decoder = new TextDecoder();
  const onPtyOutput = opts.onPtyOutput;

  // Abort-listener leak fix (issue #1310 Task 3): declare detachAbortListener
  // BEFORE Bun.spawn so the onExit callback can reference it without hitting a
  // temporal-dead-zone error if the subprocess somehow exits during the spawn
  // call. The actual abortListener registration happens after the terminal-
  // null check below (kept adjacent to the existing pattern), but the detach
  // function and its idempotency guard are hoisted here.
  let abortListenerDetached = false;
  let registeredAbortListener: (() => void) | null = null;
  const detachAbortListener = () => {
    if (abortListenerDetached) return;
    abortListenerDetached = true;
    if (registeredAbortListener) {
      try {
        opts.abort.removeEventListener("abort", registeredAbortListener);
      } catch (error) {
        logger.debug("[ClaudePty] removeEventListener error", { error });
      }
    }
  };

  const proc = Bun.spawn([claudePath, ...args], {
    cwd: opts.path,
    env: finalEnv,
    terminal: {
      cols: opts.initialCols ?? 100,
      rows: opts.initialRows ?? 30,
      data: (_terminal, data) => {
        if (!onPtyOutput) return;
        const text = decoder.decode(data, { stream: true });
        if (text) {
          onPtyOutput(text);
        }
      },
      exit: (_terminal, exitCode) => {
        logger.debug(`[ClaudePty] terminal.exit code=${exitCode}`);
      },
    },
    onExit: (subprocess, exitCode) => {
      if (exited) return;
      exited = true;
      cleanupMcpConfig?.();
      detachAbortListener();
      const signal = subprocess.signalCode ?? null;
      logger.debug(`[ClaudePty] onExit code=${exitCode} signal=${signal}`);
      opts.onExit(exitCode ?? null, signal);
    },
  });

  const terminal = proc.terminal;
  if (!terminal) {
    cleanupMcpConfig?.();
    try {
      proc.kill();
    } catch {
      // ignore
    }
    throw new Error(
      "claudePty: Bun.spawn did not return a terminal handle. " +
        "Confirm the Bun runtime version supports the terminal: option."
    );
  }

  // Register the abort listener now that we have a live process handle.
  // Detach paths (onExit, kill()) are wired through `detachAbortListener`
  // declared above for temporal-safety. The leak this fixes: the listener
  // was previously never removed, retaining an EventTarget entry on the
  // long-lived AbortSignal until the signal itself was GC'd (issue #1310
  // Task 3).
  const abortListener = () => {
    if (exited) return;
    logger.debug("[ClaudePty] abort signal received, killing process");
    try {
      proc.kill();
    } catch (error) {
      logger.debug("[ClaudePty] kill error on abort", { error });
    }
  };
  registeredAbortListener = abortListener;
  opts.abort.addEventListener("abort", abortListener);

  return {
    write: (data: string) => {
      if (exited) {
        logger.debug("[ClaudePty] write after exit; dropping bytes");
        return;
      }
      try {
        terminal.write(data);
      } catch (error) {
        logger.debug("[ClaudePty] write error", { error });
      }
    },
    resize: (cols: number, rows: number) => {
      if (exited) return;
      try {
        terminal.resize(cols, rows);
      } catch (error) {
        logger.debug("[ClaudePty] resize error", { error });
      }
    },
    kill: () => {
      if (exited) {
        // Even if already exited, ensure the listener is detached. This
        // covers the path where the caller calls .kill() but onExit hasn't
        // fired yet (or hasn't been awaited).
        detachAbortListener();
        return;
      }
      try {
        proc.kill();
      } catch (error) {
        logger.debug("[ClaudePty] kill error", { error });
      }
      detachAbortListener();
    },
    killed: () => exited,
  };
}
