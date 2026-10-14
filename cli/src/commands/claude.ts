// SPDX-License-Identifier: AGPL-3.0-only
import chalk from "chalk";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { SessionRoleSchema } from "@hapi/protocol/schemas";
import type { StartOptions } from "@/claude/runClaude";
import { configuration } from "@/configuration";
import { readDaemonBuildSkew } from "@/daemon/controlClient";
import { authAndSetupMachineIfNeeded } from "@/ui/auth";
import { logger } from "@/ui/logger";
import { initializeToken } from "@/ui/tokenInit";
import { spawnHappyCLI } from "@/utils/spawnHappyCLI";
import { maybeAutoStartServer } from "@/utils/autoStartServer";
import { withBunRuntimeEnv } from "@/utils/bunRuntime";
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
  run: async ({ commandArgs }) => {
    const args = [...commandArgs];

    if (args.length > 0 && args[0] === "claude") {
      args.shift();
    }

    const options: StartOptions = {};
    let showHelp = false;
    const unknownArgs: string[] = [];

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];

      if (arg === "-h" || arg === "--help") {
        showHelp = true;
        unknownArgs.push(arg);
      } else if (arg === "--hapi-starting-mode") {
        options.startingMode = z.enum(["local", "remote"]).parse(args[++i]);
      } else if (arg === "--yolo") {
        options.permissionMode = "bypassPermissions";
        unknownArgs.push("--dangerously-skip-permissions");
      } else if (arg === "--dangerously-skip-permissions") {
        options.permissionMode = "bypassPermissions";
        unknownArgs.push(arg);
      } else if (arg === "--safe-mode") {
        // Issue #1633: explicit branch — the catch-all below would slurp a
        // following non-dash token as this boolean flag's value. The flag is
        // forwarded to the claude child via claudeArgs; the launchers key
        // their hapi-injection suppression off its presence there.
        options.safeMode = true;
        unknownArgs.push(arg);
      } else if (arg === "--hapi-model-mode") {
        // Issue #1633: Hapimatic-internal (NOT forwarded to the claude child)
        // — seeds runClaude's model state so an explicit model selection
        // survives a model-switch respawn / daemon recovery.
        options.modelMode = args[++i];
      } else if (arg === "--hapi-effort") {
        // Issue #2456: Hapimatic-internal (NOT forwarded as-is) — seeds
        // runClaude's effort state, which reaches the claude child as --effort
        // (via the launcher argv). Consumes the next token like --hapi-model-mode.
        options.effort = args[++i];
      } else if (arg === "--hapi-raw-model") {
        // Issue #2456: Hapimatic-internal — seeds runClaude's currentModel with a
        // specific pinned raw model id (precedence over --hapi-model-mode).
        options.rawModel = args[++i];
      } else if (arg === "--hapi-session-role") {
        // Issue #2155: Hapimatic-internal (NOT forwarded to the claude child) —
        // seeds runClaude's role so the role profile's claudeMdExcludes are
        // merged into the hook-settings file and a respawn preserves the role.
        // An unrecognized value is dropped → runClaude sees no role → the
        // session loads the FULL stack (fail-open, R3). Consumes the next token
        // via `++i` (like --hapi-model-mode) so the catch-all does not slurp it.
        const parsedRole = SessionRoleSchema.safeParse(args[++i]);
        if (parsedRole.success) {
          options.sessionRole = parsedRole.data;
        }
      } else if (arg === "--hapi-output-style") {
        // Issue #2626 (D): Hapimatic-internal — seeds runClaude's outputStyle,
        // which is injected into the generated --settings file (the choke point
        // every launcher delivers). Free-form (built-in or custom name); no enum
        // validation — an unknown style is silently no-op'd by Claude Code
        // (Task 1 spike, fail-open). Consumes the next token via `++i` like
        // --hapi-effort so the catch-all does not slurp it.
        options.outputStyle = args[++i];
      } else if (arg === "--started-by") {
        options.startedBy = args[++i] as "daemon" | "terminal";
      } else {
        unknownArgs.push(arg);
        if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
          unknownArgs.push(args[++i]);
        }
      }
    }

    if (unknownArgs.length > 0) {
      options.claudeArgs = [...(options.claudeArgs || []), ...unknownArgs];
    }

    if (showHelp) {
      console.log(`
${chalk.bold("hapi")} - Claude Code On the Go

${chalk.bold("Usage:")}
  hapi [options]         Start Claude with Telegram control (direct-connect)
  hapi auth              Manage authentication
  hapi codex             Start Codex mode
  hapi gemini            Start Gemini ACP mode
  hapi opencode          Start OpenCode ACP mode
  hapi mcp               Start MCP stdio bridge
  hapi connect           (not available in direct-connect mode)
  hapi notify            (not available in direct-connect mode)
  hapi server            Start the API + web server
  hapi daemon            Manage background service that allows
                            to spawn new sessions away from your computer
  hapi doctor            System diagnostics & troubleshooting

${chalk.bold("Examples:")}
  hapi                    Start session (will prompt for token if not set)
  hapi auth login         Configure CLI_API_TOKEN interactively
  hapi --yolo             Start with bypassing permissions
                            hapi sugar for --dangerously-skip-permissions
  hapi auth status        Show direct-connect status
  hapi doctor             Run diagnostics

${chalk.bold("hapi supports ALL Claude options!")}
  Use any claude flag with hapi as you would with claude. Our favorite:

  hapi --resume

${chalk.gray("─".repeat(60))}
${chalk.bold.cyan("Claude Code Options (from `claude --help`):")}
`);

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
    if (!(await readDaemonBuildSkew()).running) {
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
