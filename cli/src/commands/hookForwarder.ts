// SPDX-License-Identifier: AGPL-3.0-only
import type { CommandDefinition } from "./types";

export const hookForwarderCommand: CommandDefinition = {
  name: "hook-forwarder",
  requiresRuntimeAssets: false,
  run: async ({ commandArgs }) => {
    const { runSessionHookForwarder } =
      await import("@/claude/utils/sessionHookForwarder");
    await runSessionHookForwarder(commandArgs);
  },
};
