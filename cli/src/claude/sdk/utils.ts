// SPDX-License-Identifier: MIT
/**
 * Utility functions for Claude Code SDK integration
 * Provides helper functions for path resolution and logging
 */

import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { logger } from "@/ui/logger";

/**
 * Try to find globally installed Claude CLI.
 * Returns an absolute path on Unix (via `which`), bare "claude" only on Windows.
 * Runs from home directory to avoid local cwd side effects.
 *
 * Uses execSync with hardcoded command strings (not user input) — shell
 * injection is not a concern here.
 */
function findGlobalClaudePath(): string | null {
  const homeDir = homedir();

  // PRIMARY for Unix: use `which` to get the absolute path directly.
  // This avoids returning bare "claude" which requires PATH resolution
  // at spawn time — a source of ENOENT failures (#862).
  if (process.platform !== "win32") {
    try {
      const whichCmd = "which claude";
      const result = execSync(whichCmd, {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        cwd: homeDir,
      }).trim();
      if (result && existsSync(result)) {
        logger.debug(
          `[Claude SDK] Found global claude path via which: ${result}`
        );
        return result;
      }
    } catch {
      // which didn't find it
    }
  }

  // FALLBACK: Windows — bare "claude" is acceptable because
  // spawn() uses shell: true on Windows (query.ts:499)
  if (process.platform === "win32") {
    try {
      const versionCmd = "claude --version";
      execSync(versionCmd, {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        cwd: homeDir,
      });
      logger.debug("[Claude SDK] Global claude command available (Windows)");
      return "claude";
    } catch {
      // claude command not available
    }
  }

  return null;
}

/**
 * Get default path to Claude Code executable.
 *
 * Environment variables:
 * - HAPI_CLAUDE_PATH: Force a specific path to claude executable
 */
export function getDefaultClaudeCodePath(): string {
  // Allow explicit override via env var — but validate it first (#862)
  if (process.env.HAPI_CLAUDE_PATH) {
    const envPath = process.env.HAPI_CLAUDE_PATH;

    // Absolute path — validate it exists before trusting it
    if (envPath.startsWith("/") || envPath.includes("\\")) {
      if (existsSync(envPath)) {
        logger.debug(`[Claude SDK] Using HAPI_CLAUDE_PATH: ${envPath}`);
        return envPath;
      }
      logger.warn(
        `[Claude SDK] HAPI_CLAUDE_PATH set to ${envPath} but file not found, falling through`
      );
    } else {
      // Bare command (e.g., "claude") — resolve to absolute path instead
      // of using bare name, which can fail with ENOENT when spawn() runs
      // without a shell and PATH doesn't include the binary's directory
      logger.debug(
        `[Claude SDK] HAPI_CLAUDE_PATH is bare command "${envPath}", resolving to absolute path`
      );
    }
    // Fall through to normal resolution
  }

  // Find global claude via PATH
  const globalPath = findGlobalClaudePath();
  if (globalPath) {
    return globalPath;
  }

  // Fallback: check well-known install locations.
  // systemd daemons inherit a minimal PATH that excludes ~/.local/bin,
  // ~/.nvm paths, etc., so the above lookup may fail even when claude
  // is installed.  Check common locations before giving up.
  const home = homedir();
  const wellKnownPaths = [
    `${home}/.local/bin/claude`,
    `${home}/.npm-global/bin/claude`,
    "/usr/local/bin/claude",
  ];
  for (const candidate of wellKnownPaths) {
    if (existsSync(candidate)) {
      logger.debug(
        `[Claude SDK] Found claude at well-known path: ${candidate}`
      );
      return candidate;
    }
  }

  throw new Error(
    "Claude Code CLI not found on PATH. Install Claude Code or set HAPI_CLAUDE_PATH."
  );
}

/**
 * Log debug message
 */
export function logDebug(message: string): void {
  if (process.env.DEBUG) {
    logger.debug(message);
    console.log(message);
  }
}

/**
 * Stream async messages to stdin with error handling and backpressure
 */
export async function streamToStdin(
  stream: AsyncIterable<unknown>,
  stdin: NodeJS.WritableStream,
  abort?: AbortSignal
): Promise<void> {
  const handleError = (err: Error) => {
    logger.debug(`[streamToStdin] stdin error: ${err.message}`);
  };
  stdin.on("error", handleError);
  try {
    for await (const message of stream) {
      if (abort?.aborted) break;
      const ok = stdin.write(JSON.stringify(message) + "\n");
      if (!ok) {
        await new Promise<void>(resolve => stdin.once("drain", resolve));
      }
    }
    stdin.end();
  } finally {
    stdin.removeListener("error", handleError);
  }
}
