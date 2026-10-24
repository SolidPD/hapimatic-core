// SPDX-License-Identifier: AGPL-3.0-only
import chalk from "chalk";
import { buildServerHelpText } from "./helpText";
import type { CommandDefinition } from "./types";

export const serverCommand: CommandDefinition = {
  name: "server",
  requiresRuntimeAssets: false,
  run: async ({ commandArgs }) => {
    // #5180 F7: help must never import the server, which binds the port and
    // mints an access token as soon as the module loads.
    if (commandArgs.includes("--help") || commandArgs.includes("-h")) {
      console.log(buildServerHelpText());
      return;
    }
    try {
      await import("../../../server/src/index");
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
