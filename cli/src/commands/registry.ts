// SPDX-License-Identifier: MIT
import { accountsCommand } from "./accounts";
import { acpCommand } from "./acp";
import { apiCommand } from "./api";
import { apiKeyHelperCommand } from "./apiKeyHelper";
import { authCommand } from "./auth";
import { capabilitiesCommand } from "./capabilities";
import { claudeCommand } from "./claude";
import { connectCommand } from "./connect";
import { daemonCommand } from "./daemon";
import { doctorCommand } from "./doctor";
import { extCommand } from "./ext";
import { opencodeCommand } from "./opencode";
import { hookForwarderCommand } from "./hookForwarder";
import { launcherCommand } from "./launcher";
import { mcpCommand } from "./mcp";
import { federationCommand } from "./federation";
import { notifyCommand } from "./notify";
import { securityCommand } from "./security";
import { serverCommand } from "./server";
import { voiceEngineCommand } from "./voiceEngine";
import type { CommandContext, CommandDefinition } from "./types";

// Lazily built to break the registry ↔ capabilities import cycle (#3744):
// `capabilities.ts` imports `listCommands` from here, and this module statically
// imports `capabilitiesCommand` to register it. Building `COMMANDS` at module-init
// would capture `capabilitiesCommand` as `undefined` whenever `capabilities.ts` is
// the entry module (e.g. under test) — a `const` export is not hoisted, so during
// the cycle the live binding is still unresolved. Deferring the build to first
// access lets ESM's live bindings resolve first, so the timing no longer matters.
let COMMANDS: CommandDefinition[] | null = null;
let commandMap: Map<string, CommandDefinition> | null = null;

function ensureRegistry(): {
  commands: CommandDefinition[];
  map: Map<string, CommandDefinition>;
} {
  if (COMMANDS === null || commandMap === null) {
    COMMANDS = [
      accountsCommand,
      acpCommand,
      apiCommand,
      authCommand,
      capabilitiesCommand,
      connectCommand,
      federationCommand,
      opencodeCommand,
      launcherCommand,
      securityCommand,
      mcpCommand,
      extCommand,
      serverCommand,
      hookForwarderCommand,
      apiKeyHelperCommand,
      doctorCommand,
      daemonCommand,
      notifyCommand,
      voiceEngineCommand,
    ];
    commandMap = new Map<string, CommandDefinition>();
    for (const command of COMMANDS) {
      commandMap.set(command.name, command);
    }
  }
  return { commands: COMMANDS, map: commandMap };
}

/**
 * Contribute a command to the dispatch table at runtime (issue #1268).
 *
 * This is the single mutation seam behind `CliExtensionHost.commands.add` — the
 * `COMMANDS` array and `commandMap` stay module-private so extensions cannot
 * reach past this validation.
 *
 * Fails loud on both collision classes rather than silently overwriting:
 * - `"claude"` is the *implicit default* command (`resolveCommand` falls back to
 *   `claudeCommand` for unmatched args) but is deliberately absent from
 *   `COMMANDS`/`commandMap`, so the map check below would NOT catch it and the
 *   registration would shadow the default for every bare `hapi claude` call.
 * - An already-registered name (static or from a prior extension) means two
 *   extensions want the same verb — a misconfiguration the loader must surface.
 */
export function registerCommand(definition: CommandDefinition): void {
  if (definition.name === "claude") {
    throw new Error(
      "Command name 'claude' is reserved (implicit default command)"
    );
  }
  const { commands, map } = ensureRegistry();
  if (map.has(definition.name)) {
    throw new Error(
      `Command name collision: '${definition.name}' is already registered`
    );
  }
  commands.push(definition);
  map.set(definition.name, definition);
}

/**
 * Read-only view of the registered command-group NAMES for the capability audit
 * (issue #3744, Sub-Issue D / R2, Task 1). `COMMANDS` stays module-private (its
 * privacy rationale is documented above `registerCommand`); this exposes only a
 * frozen snapshot of the names, so extensions still cannot reach past
 * `registerCommand`'s validation.
 *
 * ⚠️ Two facts the audit's `cli` denominator MUST account for:
 *   - `hapi claude` is NOT in `COMMANDS` — it is the implicit default reached only
 *     through `resolveCommand`'s fallback below, so this accessor structurally
 *     cannot see it. The audit adds `"claude"` as a documented special case.
 *   - `registerCommand` PUSHES into `COMMANDS` at runtime for filesystem
 *     extensions, so this list is extension- and time-dependent (R8's stability
 *     claim is scoped to a fixed extension-command set).
 */
export function listCommands(): readonly string[] {
  return ensureRegistry().commands.map(command => command.name);
}

export function resolveCommand(args: string[]): {
  command: CommandDefinition;
  context: CommandContext;
} {
  const subcommand = args[0];
  const command = subcommand ? ensureRegistry().map.get(subcommand) : undefined;
  const resolvedCommand = command ?? claudeCommand;
  const commandArgs = command ? args.slice(1) : args;

  return {
    command: resolvedCommand,
    context: {
      args,
      subcommand,
      commandArgs,
    },
  };
}
