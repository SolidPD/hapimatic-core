// SPDX-License-Identifier: AGPL-3.0-only
import { AgentRegistry } from "@/agent/AgentRegistry";
import { createAcpBackend, resolveAcpConfig } from "@/agent/backends/acp";

/**
 * Issue #1975 — OpenCode (sst/opencode) ACP runner.
 *
 * Mirrors `cli/src/agent/runners/gemini.ts`: registers an `AcpSdkBackend` that
 * spawns `opencode acp`. `buildEnv()` copies the full process env so the
 * daemon-injected `OPENCODE_CONFIG_CONTENT` / `OPENCODE_DISABLE_PROJECT_CONFIG`
 * / `OPENROUTER_API_KEY` (see `cli/src/daemon/run.ts`) reach the spawned
 * `opencode acp` subprocess.
 *
 * Differences from Gemini:
 * - command `opencode`, args `["acp"]` (Gemini uses `["--experimental-acp"]`).
 * - NO `yolo` param: `opencode acp` has no `--yolo` flag — YOLO is expressed in
 *   the inline `permission` block of `OPENCODE_CONFIG_CONTENT` (built by the
 *   daemon, see `opencodeConfig.ts`).
 * - Opts into `fs` + `terminal` ACP client capabilities so OpenCode can act as
 *   a coding harness and raise `session/request_permission` prompts (issue #1975
 *   Task 0). Gemini keeps the text-only default — its handshake is unchanged.
 */
function buildEnv(): Record<string, string> {
  return Object.keys(process.env).reduce(
    (acc, key) => {
      const value = process.env[key];
      if (typeof value === "string") {
        acc[key] = value;
      }
      return acc;
    },
    {} as Record<string, string>
  );
}

export function registerOpenCodeAgent(): void {
  // Byte-identical to the pre-#3127 direct construction: opencode opts into
  // fs+terminal capabilities as declarative config (was the #1975 per-agent
  // override), routed through the generic driver. `env` is layered per factory
  // invocation, preserving the full process-env passthrough.
  const resolved = resolveAcpConfig({
    command: "opencode",
    args: ["acp"],
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    },
  });
  AgentRegistry.register("opencode", () =>
    createAcpBackend({ ...resolved, env: buildEnv() })
  );
}
