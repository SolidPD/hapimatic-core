// SPDX-License-Identifier: MIT
import chalk from "chalk";
import { authAndSetupMachineIfNeeded } from "@/ui/auth";
import { initializeToken } from "@/ui/tokenInit";
import { maybeAutoStartServer } from "@/utils/autoStartServer";
import type { CommandDefinition } from "./types";

/**
 * Issue #1975 — `hapi opencode` command. Mirrors `cli/src/commands/gemini.ts`.
 *
 * Unlike `gemini`, there is no `--yolo` flag to parse: `opencode acp` has none,
 * so YOLO is expressed via the inline `permission` block of the daemon-injected
 * `OPENCODE_CONFIG_CONTENT` (see `opencodeConfig.ts`). The command therefore only
 * parses `--started-by` and delegates to the shared `runAgentSession` runner.
 */
export const opencodeCommand: CommandDefinition = {
  name: "opencode",
  requiresRuntimeAssets: true,
  run: async ({ commandArgs }) => {
    try {
      let startedBy: "daemon" | "terminal" | undefined;

      for (let i = 0; i < commandArgs.length; i++) {
        if (commandArgs[i] === "--started-by") {
          startedBy = commandArgs[++i] as "daemon" | "terminal";
        }
      }

      const { registerOpenCodeAgent } =
        await import("@/agent/runners/opencode");
      const { runAgentSession } =
        await import("@/agent/runners/runAgentSession");
      registerOpenCodeAgent();

      await initializeToken();
      await maybeAutoStartServer();
      await authAndSetupMachineIfNeeded();
      await runAgentSession({ agentType: "opencode", startedBy });
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
