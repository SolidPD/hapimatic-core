// SPDX-License-Identifier: AGPL-3.0-only
/**
 * CLI entry point for `builtin.agent-codex` (issue #1272).
 *
 * Resolved lazily by the loader via `manifest.entryPoints.cli()` and invoked
 * once during `loadCliExtensions` (`cli/src/ext/loader.ts`), which runs BEFORE
 * `resolveCommand` in `runCli.ts` — so `hapi codex` resolves to the command
 * contributed here rather than falling through to the implicit `claude`
 * default.
 *
 * Registers the command ONLY — deliberately no `host.agents.register("codex",
 * …)`. Codex has never gone through `AgentRegistry` (only Gemini and the ACP
 * backends do); its entry path is `hapi codex` → `codexCommand.run` →
 * `runCodex` → `bootstrapSession({ flavor: "codex" })`. Registering an agent
 * backend would mean authoring a new `AgentBackend` adapter around `runCodex`,
 * which is a behavior change — out of scope for a migration whose contract is
 * "mechanical move, no behavior change".
 */
import type { CliExtensionHost } from "@hapi/protocol/ext";
import { codexCommand } from "./command";

export async function register(host: CliExtensionHost): Promise<void> {
  host.commands.add(codexCommand);
}
