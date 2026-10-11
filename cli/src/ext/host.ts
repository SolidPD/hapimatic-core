// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `CliExtensionHostImpl` — the object a CLI-side extension's `register` function
 * receives (issue #1268, Sub-Issue D of epic #1264).
 *
 * A thin facade over the CLI's existing infrastructure: the command dispatch
 * table (`@/commands/registry`) and the agent backend registry
 * (`@/agent/AgentRegistry`), plus the session lifecycle emitter in
 * `@/ext/lifecycle`. Extensions never import those modules directly — they only
 * touch this host. The host is deliberately NOT wired into
 * `cli/src/commands/runCli.ts` here; that is Sub-Issue F's loader work.
 *
 * Design invariants:
 * - **The host is stateless.** Every contribution is forwarded to a
 *   process-wide registry (`commandMap`, `AgentRegistry`, the `@/ext/lifecycle`
 *   emitter), so constructing more than one host is harmless. Sub-Issue F picks
 *   the instancing model; this module does not export a singleton.
 * - **The lifecycle emitter lives in a leaf module, not here.** The emit sites
 *   are core session code and must not transitively import
 *   `@/commands/registry`, which eagerly loads all 16 command modules and their
 *   dependency trees. See the header of `@/ext/lifecycle`. This module
 *   re-exports that surface so extension authors still see one entry point.
 * - **A misbehaving handler cannot break a session.** Every handler runs in its
 *   own try/catch (and rejected promises are caught) inside `@/ext/lifecycle`,
 *   so one bad extension neither aborts the emit loop nor propagates into
 *   session teardown.
 *
 * Known limitations (v0.1):
 * - Lifecycle events fire only for sessions built on `AgentSessionBase` +
 *   `createRunnerLifecycle` — i.e. the Claude and Codex paths. The generic
 *   agent runner (`@/agent/runners/runAgentSession`, used by Gemini / ACP /
 *   OpenCode) has its own try/finally cleanup and does NOT route through either
 *   seam, so those sessions emit nothing. Broadening is follow-up work.
 * - Handlers are invoked in insertion order with no priority mechanism, and
 *   async handlers are NOT awaited — an extension owns its own async lifetime.
 */
import type {
  AgentBackendFactory,
  CliExtensionHost,
  CommandDefinition,
  HarnessContribution,
} from "@hapi/protocol/ext";
import type { AgentBackendFactory as CliAgentBackendFactory } from "@/agent/types";
import { AgentRegistry } from "@/agent/AgentRegistry";
import { registerCommand } from "@/commands/registry";
import { registerCatalogHarness } from "@/ext/catalogHarnessRegistry";
import {
  subscribeSessionEnd,
  subscribeSessionStart,
  type SessionLifecycleHandler,
} from "@/ext/lifecycle";

export {
  fireSessionEnd,
  fireSessionStart,
  subscribeSessionEnd,
  subscribeSessionStart,
  type SessionLifecycleHandler,
} from "@/ext/lifecycle";

// Re-export the catalog-harness resolvers (issue #3120) so consumers can reach them from
// the host entry point, matching the directive's "export resolveCatalogManifest" from
// `host.ts`. The canonical home is `@/ext/catalogHarnessRegistry`.
export {
  registerCatalogHarness,
  resolveCatalogManifest,
  resolveCatalogContribution,
  listCatalogHarnesses,
} from "@/ext/catalogHarnessRegistry";

export class CliExtensionHostImpl implements CliExtensionHost {
  readonly commands = {
    /**
     * Contribute a CLI command. Throws on a duplicate name or on the reserved
     * implicit-default name `"claude"` — see `registerCommand`.
     *
     * The shared `CommandDefinition` is a structural match for the CLI's own,
     * so this forwards with no cast.
     */
    add: (definition: CommandDefinition): void => {
      registerCommand(definition);
    },
  };

  readonly agents = {
    /**
     * Register an agent backend factory. Passthrough to `AgentRegistry`, which
     * validates the id and stores the factory for `AgentRegistry.create(id)`.
     *
     * The cast bridges two shapes that do NOT structurally overlap: A's
     * `AgentBackend` is the minimal `{ readonly id: string }`, while the CLI's
     * is a 7-method interface (`initialize`, `newSession`, `prompt`, …) with no
     * `id` field at all — so neither is assignable to the other, in either
     * direction. (A's own comment describes the CLI type as "wider", which is
     * not the case; the shared contract is deliberately left un-widened here
     * rather than edited from D.) In practice an extension registering a usable
     * backend must return an object satisfying the full CLI interface; the
     * shared type simply under-specifies that. Reconciling the two is follow-up
     * work on the shared contract, not something D can fix locally.
     */
    register: (id: string, factory: AgentBackendFactory): void => {
      AgentRegistry.register(id, factory as unknown as CliAgentBackendFactory);
    },
  };

  readonly harness = {
    /**
     * Contribute a catalog CLI harness (issue #3120). Forwards to the process-wide
     * catalog registry, keeping this host stateless. The shared `HarnessContribution` is
     * a structural match for what the registry stores, so this forwards with no cast.
     */
    register: (id: string, contribution: HarnessContribution): void => {
      registerCatalogHarness(id, contribution);
    },
  };

  readonly lifecycle = {
    onSessionStart: (cb: SessionLifecycleHandler): (() => void) =>
      subscribeSessionStart(cb),
    onSessionEnd: (cb: SessionLifecycleHandler): (() => void) =>
      subscribeSessionEnd(cb),
  };
}
