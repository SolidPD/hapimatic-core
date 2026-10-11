// SPDX-License-Identifier: AGPL-3.0-only
import type { CommandDefinition } from "./types";

/**
 * Issue #4568 (F1): `hapi api-key-helper --id <vault id> [--mask <mask>]` — the
 * `apiKeyHelper` an API-key session's `--settings` file names. Claude Code runs it
 * and reads the key from stdout for its own requests; see `@/claude/apiKeyHelper`.
 */
export const apiKeyHelperCommand: CommandDefinition = {
  name: "api-key-helper",
  requiresRuntimeAssets: false,
  run: async ({ commandArgs }) => {
    const { runApiKeyHelper } = await import("@/claude/apiKeyHelper");
    process.exitCode = await runApiKeyHelper(commandArgs, {
      stdout: text => process.stdout.write(text),
      stderr: text => process.stderr.write(text),
    });
  },
};
