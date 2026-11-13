// SPDX-License-Identifier: AGPL-3.0-only
import chalk from "chalk";
import { execFileSync } from "node:child_process";
import { configuration } from "@/configuration";
import { readDaemonBuildSkew } from "@/daemon/controlClient";
import { authAndSetupMachineIfNeeded } from "@/ui/auth";
import { logger } from "@/ui/logger";
import { initializeToken } from "@/ui/tokenInit";
import { spawnHappyCLI } from "@/utils/spawnHappyCLI";
import { maybeAutoStartServer } from "@/utils/autoStartServer";
import { withBunRuntimeEnv } from "@/utils/bunRuntime";
import { formatDaemonBuildSkew } from "@/version";
import { parseClaudeCommandArgs } from "./claudeCommandArgs";
import { buildRootHelpText } from "./helpText";
import type { CommandDefinition } from "./types";

function extractErrorInfo(error: unknown): {
  message: string;
  messageLower: string;
  axiosCode?: string;
  httpStatus?: number;
  responseErrorText: string;
} {
  const message = error instanceof Error ? error.message : "Unknown error";
  const messageLower = message.toLowerCase();

  if (typeof error !== "object" || error === null) {
    return { message, messageLower, responseErrorText: "" };
  }

  const record = error as Record<string, unknown>;
  const axiosCode = typeof record.code === "string" ? record.code : undefined;
  const response =
    typeof record.response === "object" && record.response !== null
      ? (record.response as Record<string, unknown>)
      : undefined;
  const httpStatus =
    typeof response?.status === "number" ? response.status : undefined;
  const responseData = response?.data;
  const responseError =
    typeof responseData === "object" && responseData !== null
      ? (responseData as Record<string, unknown>).error
      : undefined;
  const responseErrorText =
    typeof responseError === "string" ? responseError : "";

  return {
    message,
    messageLower,
    axiosCode,
    httpStatus,
    responseErrorText,
  };
}

export const claudeCommand: CommandDefinition = {
  name: "default",
  requiresRuntimeAssets: true,
  // Issue #5348: `hapi [options] -- "<prompt>"`; parseClaudeCommandArgs stops at the
  // marker and takes exactly one prompt argument after it.
  acceptsEndOfOptions: true,
  run: async ({ commandArgs }) => {
    // Issue #6400: the argv parser lives in claudeCommandArgs.ts (testable).
    const parsed = parseClaudeCommandArgs(commandArgs);
    if ("error" in parsed) {
      console.error(chalk.red(parsed.error));
      process.exit(1);
    }
    const { options, showHelp } = parsed;

    if (showHelp) {
      console.log(buildRootHelpText());

      try {
        const claudeHelp = execFileSync("claude", ["--help"], {
          encoding: "utf8",
          env: withBunRuntimeEnv(),
          shell: process.platform === "win32",
        });
        console.log(claudeHelp);
      } catch {
        console.log(
          chalk.yellow(
            "Could not retrieve claude help. Make sure claude is installed."
          )
        );
      }

      process.exit(0);
    }

    await initializeToken();
    await maybeAutoStartServer();
    await authAndSetupMachineIfNeeded();

    logger.debug("Ensuring hapi background service is running...");

    // Issue #4594 (D-4594-1 A): start a daemon only when none is live. A live
    // daemon of another build is left alone — that includes the daemon that
    // spawned this very session (`--started-by daemon`) after a binary swap.
    // #5103: its build skew is reported, as `daemon start` reports it.
    const daemon = await readDaemonBuildSkew();
    const skewLine = formatDaemonBuildSkew(daemon);
    if (skewLine) {
      logger.debug(`[CLAUDE] ${skewLine}`);
      // A daemon-spawned session's console is a tmux pane nobody reads.
      if (options.startedBy !== "daemon") {
        console.log(chalk.yellow(skewLine));
      }
    }
    if (!daemon.running) {
      logger.debug("Starting hapi background service...");

      const daemonProcess = spawnHappyCLI(["daemon", "start-sync"], {
        detached: true,
        stdio: "ignore",
        env: process.env,
      });
      daemonProcess.unref();

      await new Promise(resolve => setTimeout(resolve, 200));
    }

    try {
      const { runClaude } = await import("@/claude/runClaude");
      await runClaude(options);
    } catch (error) {
      const {
        message,
        messageLower,
        axiosCode,
        httpStatus,
        responseErrorText,
      } = extractErrorInfo(error);

      if (
        axiosCode === "ECONNREFUSED" ||
        axiosCode === "ETIMEDOUT" ||
        axiosCode === "ENOTFOUND" ||
        messageLower.includes("econnrefused") ||
        messageLower.includes("etimedout") ||
        messageLower.includes("enotfound") ||
        messageLower.includes("network error")
      ) {
        console.error(chalk.yellow("Unable to connect to HAPI server"));
        console.error(chalk.gray(`  Server URL: ${configuration.serverUrl}`));
        console.error(
          chalk.gray("  Please check your network connection or server status")
        );
      } else if (
        httpStatus === 403 &&
        responseErrorText === "Machine access denied"
      ) {
        console.error(chalk.red("Machine access denied."));
        console.error(
          chalk.gray(
            "  This machineId is already registered under a different namespace."
          )
        );
        console.error(
          chalk.gray(
            "  Fix: run `hapi auth logout`, or set a separate HAPI_HOME per namespace."
          )
        );
      } else if (
        httpStatus === 403 &&
        responseErrorText === "Session access denied"
      ) {
        console.error(chalk.red("Session access denied."));
        console.error(
          chalk.gray("  This session belongs to a different namespace.")
        );
        console.error(
          chalk.gray("  Use the matching CLI_API_TOKEN or switch namespaces.")
        );
      } else if (
        httpStatus === 401 ||
        httpStatus === 403 ||
        messageLower.includes("unauthorized") ||
        messageLower.includes("forbidden")
      ) {
        console.error(chalk.red("Authentication error:"), message);
        console.error(chalk.gray("  Run: hapi auth login"));
      } else {
        console.error(chalk.red("Error:"), message);
      }

      if (process.env.DEBUG) {
        console.error(error);
      }
      process.exit(1);
    }
  },
};
