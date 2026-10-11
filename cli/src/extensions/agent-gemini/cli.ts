// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `builtin.agent-gemini` CLI entry point (issue #1273, Sub-Issue I of epic
 * #1264). Resolved by the loader via `manifest.entryPoints.cli()`, which then
 * invokes the exported `register`.
 */
import type {
  AgentBackendFactory,
  CliExtensionHost,
  CliRegister,
} from "@hapi/protocol/ext";
import { geminiCommand } from "./geminiCommand";
import { buildGeminiBackendFactory } from "./registerAgent";

export const register: CliRegister = (host: CliExtensionHost): void => {
  // Contribute `hapi gemini` to the dispatch table. Throws on a duplicate
  // name, so the static registration in `@/commands/registry` MUST be gone.
  host.commands.add(geminiCommand);

  // Register a no-yolo default backend factory. `geminiCommand.run`
  // re-registers with yolo-aware args at invocation time.
  //
  // The cast bridges two shapes that do not structurally overlap in either
  // direction: the shared `AgentBackend` is the minimal `{ readonly id: string }`,
  // while the CLI's is a 7-method interface with no `id` field. `CliExtensionHostImpl`
  // performs the mirror-image cast on the way in (see `cli/src/ext/host.ts`);
  // reconciling the two contracts is follow-up work on the shared API, not
  // something this extension can fix locally.
  host.agents.register(
    "gemini",
    buildGeminiBackendFactory(false) as unknown as AgentBackendFactory
  );
};
