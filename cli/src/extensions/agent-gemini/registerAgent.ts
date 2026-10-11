// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Gemini agent backend factory — the relocated body of the pre-migration
 * `cli/src/agent/runners/gemini.ts` (issue #1273, Sub-Issue I of epic #1264).
 *
 * The original module side-effected `AgentRegistry.register(...)` at call time.
 * That is inverted here into a PURE factory builder so registration flows
 * through the extension host (`host.agents.register`) instead — extension code
 * never touches `AgentRegistry` at load time.
 *
 * The ACP backend deliberately does NOT move: it is generic ACP infrastructure
 * shared by every ACP-style agent. Since #3127 the extension consumes it through
 * the generic driver (`resolveAcpConfig` + `createAcpBackend`) rather than
 * constructing `AcpSdkBackend` directly — gemini declares no client capabilities,
 * so the resolver fills in the text-only default and the handshake is unchanged.
 *
 * The `@/agent/backends/acp` import is deliberately STATIC even though this
 * module is reached on every CLI start (the loader awaits every enabled
 * extension's `entryPoints.cli()`). Measured on a Pi 5, the whole extension
 * entry costs ~77ms cold, ~70ms of which is the ACP chain — against a ~1.5s
 * CLI startup that already eagerly loads all 16 command modules via
 * `@/commands/registry`. Making it lazy would mean a hand-written delegating
 * backend wrapper (the `AgentBackendFactory` signature is synchronous, so the
 * import cannot simply be awaited inside it), trading a fragile
 * initialize-must-run-first invariant for ~4% of startup. Not worth it; revisit
 * if the ACP graph grows or an external SDK is introduced.
 *
 * The laziness that DOES matter lives in `geminiCommand.ts`, which defers the
 * heavy auth/server/session graph until the command actually runs.
 */
import { createAcpBackend, resolveAcpConfig } from "@/agent/backends/acp";
import type { AgentBackendFactory } from "@/agent/types";
import { buildHarnessChildEnv } from "@/sandbox/secretEnvVars";

function buildEnv(): Record<string, string> {
  const base = Object.keys(process.env).reduce(
    (acc, key) => {
      const value = process.env[key];
      if (typeof value === "string") {
        acc[key] = value;
      }
      return acc;
    },
    {} as Record<string, string>
  );
  // #3813: strip secrets at this wrapper→child seam. gemini `keepSecrets` =
  // ["GEMINI_API_KEY", "GOOGLE_API_KEY"] ⇒ the gemini child KEEPS its provider keys
  // (the gated SECRET leg is inert while gemini is never jailed, but the ungated
  // #2383 strip is LIVE — a gemini child now loses HAPI_ONBOARDING_* / GH_TOKEN,
  // exactly as Claude children do; ruling D2).
  return buildHarnessChildEnv("gemini", base);
}

/**
 * Build a Gemini agent backend factory for `AgentRegistry`.
 *
 * `yolo` is baked into the returned factory's args because it is a per-
 * invocation CLI flag, not a manifest setting — see the re-register note in
 * `geminiCommand.ts`.
 */
export function buildGeminiBackendFactory(yolo: boolean): AgentBackendFactory {
  const args = ["--experimental-acp"];
  if (yolo) args.push("--yolo");

  // Byte-identical to the pre-#3127 direct construction: gemini declares no
  // client capabilities, so `resolveAcpConfig` fills the text-only default and
  // no quirks, keeping the `initialize` handshake unchanged (the characterization
  // oracle in `acpCharacterization.test.ts`). `env` is layered per factory
  // invocation, preserving the original full process-env passthrough timing.
  const resolved = resolveAcpConfig({ command: "gemini", args });

  return () => createAcpBackend({ ...resolved, env: buildEnv() });
}
