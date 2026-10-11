// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The `hapi gemini` CLI command, relocated from `cli/src/commands/gemini.ts`
 * (issue #1273, Sub-Issue I of epic #1264).
 *
 * Registered through the extension host (`host.commands.add`) rather than the
 * static `COMMANDS` array in `@/commands/registry`.
 *
 * LOAD-BEARING: every heavy dependency stays behind an `await import(...)`
 * INSIDE `run`. This module is imported on every CLI start (the loader awaits
 * each enabled extension's `entryPoints.cli()`), so a top-level import of the
 * auth / server / session graph would regress startup for every `hapi`
 * invocation. Top-level imports are limited to `chalk` and a type.
 */
import chalk from "chalk";
import type { CommandDefinition } from "@hapi/protocol/ext";

export const geminiCommand: CommandDefinition = {
  name: "gemini",
  requiresRuntimeAssets: true,
  run: async ({ commandArgs }) => {
    try {
      let startedBy: "daemon" | "terminal" | undefined;
      let yolo = false;

      for (let i = 0; i < commandArgs.length; i++) {
        if (commandArgs[i] === "--started-by") {
          startedBy = commandArgs[++i] as "daemon" | "terminal";
        } else if (commandArgs[i] === "--yolo") {
          yolo = true;
        }
      }

      // Lazy-loaded: see the LOAD-BEARING note above.
      const { AgentRegistry } = await import("@/agent/AgentRegistry");
      const { buildGeminiBackendFactory } = await import("./registerAgent");
      const { runAgentSession } =
        await import("@/agent/runners/runAgentSession");
      const { initializeToken } = await import("@/ui/tokenInit");
      const { maybeAutoStartServer } = await import("@/utils/autoStartServer");
      const { authAndSetupMachineIfNeeded } = await import("@/ui/auth");

      // Re-register with a yolo-aware factory. The extension's `register()`
      // installed a no-yolo default at load time; `--yolo` is a per-invocation
      // CLI flag, so the backend args can only be finalised here. This mirrors
      // the pre-migration `registerGeminiAgent(yolo)` call and relies on
      // `AgentRegistry.register` overwriting by key (it is a bare `Map.set`
      // with no collision detection — Open Risk R-2 on #1273).
      AgentRegistry.register("gemini", buildGeminiBackendFactory(yolo));

      await initializeToken();
      await maybeAutoStartServer();
      await authAndSetupMachineIfNeeded();
      await runAgentSession({ agentType: "gemini", startedBy });
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
