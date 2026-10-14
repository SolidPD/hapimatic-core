// SPDX-License-Identifier: AGPL-3.0-only
import chalk from "chalk";
import { authAndSetupMachineIfNeeded } from "@/ui/auth";
import { initializeToken } from "@/ui/tokenInit";
import { maybeAutoStartServer } from "@/utils/autoStartServer";
import type { CommandDefinition } from "@/commands/types";
import type { CodexPermissionMode } from "@hapi/protocol/types";
import { CODEX_TMUX_RESUME_FLAG } from "./codex/codexTmuxLauncher";

export const codexCommand: CommandDefinition = {
  name: "codex",
  requiresRuntimeAssets: true,
  run: async ({ commandArgs }) => {
    try {
      const { runCodex } = await import("./codex/runCodex");

      const options: {
        startedBy?: "daemon" | "terminal";
        codexArgs?: string[];
        permissionMode?: CodexPermissionMode;
        // Issue #1733: gateway model id ("provider/model") from --hapi-model.
        model?: string;
        // Issue #1082: codex session id to resume, from the daemon's tmux
        // recovery respawn. Consumed here (NOT forwarded to the codex binary).
        resumeCodexSessionId?: string;
      } = {};
      const unknownArgs: string[] = [];

      for (let i = 0; i < commandArgs.length; i++) {
        const arg = commandArgs[i];
        if (arg === "--started-by") {
          options.startedBy = commandArgs[++i] as "daemon" | "terminal";
        } else if (arg === "--hapi-model") {
          // Issue #1733: OpenRouter model id threaded from the daemon.
          options.model = commandArgs[++i];
        } else if (arg === CODEX_TMUX_RESUME_FLAG) {
          // Issue #1082: codex resume id (remote-mode recovery). Seeds
          // runCodex → CodexSession sessionId → findCodexResumeFile.
          options.resumeCodexSessionId = commandArgs[++i];
        } else if (
          arg === "--yolo" ||
          arg === "--dangerously-bypass-approvals-and-sandbox"
        ) {
          options.permissionMode = "yolo";
          unknownArgs.push(arg);
        } else {
          unknownArgs.push(arg);
        }
      }
      if (unknownArgs.length > 0) {
        options.codexArgs = unknownArgs;
      }

      await initializeToken();
      await maybeAutoStartServer();
      await authAndSetupMachineIfNeeded();
      await runCodex(options);
    } catch (error) {
      console.error(
        chalk.red("Error:"),
        error instanceof Error ? error.message : "Unknown error"
      );
      if (process.env.DEBUG) {
        console.error(error);
      }
      process.exit(1);
    }
  },
};
