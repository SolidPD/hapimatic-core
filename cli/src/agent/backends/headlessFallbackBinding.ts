// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Headless/tmux generic fallback binding (issue #3127, Task 6 / R4).
 *
 * ACP-first (epic ruling D1): an ACP-capable CLI rides the ONE generic ACP
 * egress driver (`acp/manifestDriver.ts` + `acp/AcpSdkBackend.ts`). This module
 * is the fallback for CLIs that expose NO ACP server (Crush, Grok Build, Pi, and
 * the stock codex / claude): a non-ACP manifest resolves to a headless/tmux
 * LAUNCH PLAN, never an error (KD5 / Fallback Preservation Rule).
 *
 * WHY THIS IS NOT AN `AgentBackend` (KD4). `AgentBackend` requires a `prompt()`
 * over the ACP wire; a headless CLI driven inside a tmux window has no such wire,
 * and implementing `prompt()` by scraping tmux output would be fragile. So this
 * binding is a pure RESOLVER — manifest/contribution → {@link HeadlessLaunchPlan}
 * — whose plan is consumed by the daemon's EXISTING tmux spawn routing
 * (`cli/src/daemon/tmuxSpawnAdapter.ts`, the same path `buildCodexCommand` feeds).
 * No new spawn subsystem.
 *
 * CONSUMER (`coordinates_with: #3120`). #3120's `driverBinding` switch
 * (`"native" | "acp-generic" | "headless-tmux-generic"`, running in the daemon
 * spawn path) selects this binding for the `"headless-tmux-generic"` case and
 * hands the returned plan to the tmux adapter. This module defines the NAMED
 * interface #3120 consumes; it does not itself mutate the daemon.
 *
 * LIFECYCLE / ZOMBIE POLICY (KD4). The tmux-window lifecycle stays with the
 * existing adapter + reaper (`tmuxSpawnAdapter.reaper.test.ts`): a dead pane is
 * reaped from the daemon's tmux inventory exactly as for codex/claude. A
 * headless-exec child (a plan run outside a persistent tmux window) additionally
 * gets explicit kill-on-session-end, following the ACP transport's
 * `killProcessByChildProcess` precedent (`acp/AcpStdioTransport.ts`), plus the
 * daemon's orphan GC. The plan is data; enforcement lives in the existing daemon
 * spawn/reaper machinery the consumer (#3120) routes it through.
 */
import type { HarnessManifest } from "@hapi/protocol";

/**
 * A resolved headless/tmux launch plan — the fallback binding's output. Shaped
 * to feed the daemon's existing tmux spawn routing (mirrors the argv/window
 * shape `buildCodexCommand` + `spawnSessionInTmux` already consume).
 */
export interface HeadlessLaunchPlan {
  /** Executable to spawn (from the extension contribution's spawn config). */
  command: string;
  /** Arguments (defaults to `[]`). */
  args: string[];
  /** Environment for the spawned process (full passthrough is the caller's job). */
  env?: Record<string, string>;
  /** tmux window name; defaults to the command basename. */
  windowName: string;
}

/**
 * Source for resolving a headless binding: the CLI's stock manifest `acp` axis
 * (the GATE — the ONLY thing the #3118 manifest contributes, per KD2) plus its
 * spawn config (from the extension contribution, per epic ruling D8b). The
 * manifest deliberately does NOT carry the spawn command (widening it re-opens
 * epic decision D8), so `command`/`args`/`env` arrive from the contribution.
 */
export interface HeadlessBindingSource {
  /** The stock manifest `acp` tri-state axis — the routing GATE. */
  acp: HarnessManifest["acp"];
  /** Spawn command for the CLI (from the extension contribution). */
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Optional tmux window name; defaults to the command basename. */
  windowName?: string;
}

/**
 * True iff a CLI can be DRIVEN over ACP by Hapimatic (egress). Egress makes
 * Hapimatic the ACP CLIENT, so the CLI must expose an ACP SERVER — `acp.server`
 * being `native` or `emulated` (i.e. NOT `"absent"`). This is the gate that
 * splits the generic ACP driver from the headless fallback binding: gemini /
 * opencode (`server: "native"`) ride the ACP driver; codex / claude
 * (`server: "absent"`) resolve here.
 */
export function isAcpDrivable(acp: HarnessManifest["acp"]): boolean {
  return acp.server !== "absent";
}

/** Derive a tmux window name from a spawn command (basename, no extension). */
function deriveWindowName(command: string): string {
  const base = command.split("/").pop() ?? command;
  return base.replace(/\.[^.]+$/, "");
}

/**
 * Resolve a CLI to its headless/tmux launch plan, OR `null` when the CLI is
 * ACP-drivable (rides the generic ACP driver instead — NEVER this binding).
 *
 * A non-ACP CLI ALWAYS resolves to a well-formed plan and NEVER throws (KD5 /
 * Fallback Preservation Rule — R4: "a manifest without ACP resolves to the
 * headless/tmux fallback binding, not an error"). Returning `null` for an
 * ACP-capable CLI is the routing signal #3120's `driverBinding` switch uses to
 * keep that CLI on the ACP path.
 */
export function resolveHeadlessBinding(
  source: HeadlessBindingSource
): HeadlessLaunchPlan | null {
  if (isAcpDrivable(source.acp)) {
    return null;
  }
  return {
    command: source.command,
    args: source.args ?? [],
    env: source.env,
    windowName: source.windowName ?? deriveWindowName(source.command),
  };
}
