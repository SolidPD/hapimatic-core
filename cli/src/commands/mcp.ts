// SPDX-License-Identifier: AGPL-3.0-only
import { runHappyMcpStdioBridge } from "@/extensions/agent-codex/codex/happyMcpStdioBridge";
import type { CommandDefinition } from "./types";

export const mcpCommand: CommandDefinition = {
  name: "mcp",
  requiresRuntimeAssets: false,
  run: async ({ commandArgs }) => {
    await runHappyMcpStdioBridge(commandArgs);
  },
};
