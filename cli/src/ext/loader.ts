// SPDX-License-Identifier: AGPL-3.0-only
/**
 * CLI-side extension loader (Sub-Issue F of epic #1264).
 *
 * Iterates the generated CLI registry and for every ENABLED extension awaits
 * `manifest.entryPoints.cli()` and invokes the resolved module's `register(host)`
 * (D's `CliExtensionHostImpl.commands.add` forwards to `registerCommand`, so the
 * new commands become resolvable by `resolveCommand`). Fail-soft: a `register`
 * that throws is logged (file-only, to avoid disturbing the Claude session) and
 * skipped.
 *
 * CLI enabled-source (§5g gap CLOSED by #1290): `requiredAtBuild` bypasses prefs;
 * otherwise the enable state is read from the SOLE `extension_prefs` store via
 * `readCliExtensionPref` (`./prefs`), falling back to `manifest.defaultEnabled` when
 * no row / DB exists. So `hapi ext disable <id>` now actually withholds a
 * non-`requiredAtBuild` extension's CLI registration. `readCliExtensionPref` is
 * fail-soft (never throws), which matters because this runs on EVERY `hapi`
 * invocation including the short-lived hook-forwarder subprocess.
 *
 * DEFERRED — disabled-command error stubs (locked §5g): the contract also called
 * for registering an error-stub command per DISABLED command-extension so a
 * disabled command name fails loudly instead of falling through to the implicit
 * `claude` default. That requires the codegen to emit each extension's command
 * NAMES, but A's `HapiExtensionManifest` (#1265, merged) declares no command
 * names — commands are registered imperatively inside `register`, so a disabled
 * extension's command names are unknowable at codegen time. Implementing the
 * error stubs needs a manifest-level command-name declaration that A did not
 * ship; it is therefore deferred to a follow-up. Zero impact on the empty-config
 * deliverable (no extensions until Sub-Issue G #1271).
 */
import { CapabilityGate } from "@hapi/protocol/ext";
import type {
  AgentBackendFactory,
  CliExtensionHost,
  CommandDefinition,
  HapiExtensionManifest,
  HarnessContribution,
} from "@hapi/protocol/ext";
import { extensions } from "@/extensions.generated";
import { logger } from "@/ui/logger";
import { readCliExtensionPref } from "./prefs";

/** The generated CLI-registry entry shape (manifests-only). */
export interface CliExtensionEntry {
  manifest: HapiExtensionManifest;
  /**
   * PROVENANCE for capability gating (issue #1291, ADR-0003). `false` ⇒ loaded
   * from the runtime filesystem (untrusted, default-deny gated); absent / `true`
   * ⇒ build-composed (trusted, gate bypassed). Only the filesystem loader sets
   * `false`. See `server/src/ext/loader.ts` for the soundness rationale.
   */
  trusted?: boolean;
}

/**
 * Wrap the shared CLI host in a per-extension capability proxy (issue #1291,
 * ADR-0003). The privileged contribution points (`commands.add`,
 * `agents.register`, `harness.register` — #3120) are gated against the
 * extension's declared capabilities; the ambient `lifecycle` surface forwards
 * unchanged. A trusted (build-composed) extension's gate bypasses every check,
 * so this proxy is transparent for builtins.
 */
function gatedCliHost(
  host: CliExtensionHost,
  gate: CapabilityGate
): CliExtensionHost {
  return {
    commands: {
      add: (definition: CommandDefinition): void => {
        gate.require("cli.commands", "commands.add");
        host.commands.add(definition);
      },
    },
    agents: {
      register: (id: string, factory: AgentBackendFactory): void => {
        gate.require("agents", "agents.register");
        host.agents.register(id, factory);
      },
    },
    harness: {
      register: (id: string, contribution: HarnessContribution): void => {
        gate.require("harness", "harness.register");
        host.harness.register(id, contribution);
      },
    },
    lifecycle: host.lifecycle,
  };
}

/**
 * Load every enabled CLI extension into `host`. `entries` defaults to the
 * committed generated registry and is injectable for testing.
 */
export async function loadCliExtensions(
  host: CliExtensionHost,
  entries: readonly CliExtensionEntry[] = extensions
): Promise<void> {
  for (const entry of entries) {
    const { manifest } = entry;
    // CLI enabled-source (§5g closed by #1290): requiredAtBuild bypasses prefs;
    // otherwise consult the SOLE extension_prefs store (fail-soft — falls back to
    // defaultEnabled when no row / DB exists).
    const enabled =
      manifest.requiredAtBuild ||
      readCliExtensionPref(manifest.id, manifest.defaultEnabled).enabled;
    if (!enabled) continue;

    // The generated CLI file only carries extensions with a `cli` entry point
    // (R8); guard defensively regardless.
    const cliEntry = manifest.entryPoints.cli;
    if (!cliEntry) continue;

    // Capability gate (issue #1291) — per-extension from declared capabilities +
    // provenance; the proxy denies undeclared privileged calls (default-deny for
    // untrusted filesystem extensions; transparent for trusted builtins).
    const gate = new CapabilityGate(manifest.id, manifest.capabilities ?? [], {
      trusted: entry.trusted !== false,
    });
    const extHost = gatedCliHost(host, gate);

    try {
      const mod = await cliEntry();
      await mod.register(extHost);
    } catch (err) {
      logger.warn(
        `[ext:loader] Failed to register CLI extension '${manifest.id}':`,
        err
      );
    }
  }
}
