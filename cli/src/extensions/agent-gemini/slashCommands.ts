// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Gemini slash-command metadata, relocated from the central
 * `BUILTIN_COMMANDS` map in `@/modules/common/slashCommands` (issue #1273).
 *
 * This is NOT a host contribution: v0.1's `CliExtensionHost` (shared/src/ext/
 * hosts.ts) exposes only `commands`, `agents`, and `lifecycle` — there is no
 * `slashCommands.add` contribution point. The central map therefore imports
 * this array by path, which is a known and accepted v0.1 coupling (Open Risk
 * R-3 on #1273). A follow-up can invert it once a slash-command contribution
 * point exists.
 *
 * The only import here is type-only, so this module stays a zero-runtime-cost
 * leaf and the central map's import graph is unchanged.
 */
import type { SlashCommand } from "@/modules/common/slashCommands";

export const geminiSlashCommands: SlashCommand[] = [
  { name: "about", description: "About Gemini", source: "builtin" },
  { name: "clear", description: "Clear conversation", source: "builtin" },
  { name: "compress", description: "Compress context", source: "builtin" },
];
