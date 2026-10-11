// SPDX-License-Identifier: MIT
/**
 * Manifest-driven harness capability gates (issue #3126, epic #3117 Sub-Issue K).
 *
 * These three pure predicates replace the hardcoded `agent === "claude" [||
 * agent === "codex"]` conditionals that used to gate the daemon's spawn path
 * (`sessionSpawner.ts`). Behavior now flows from the HARNESS MANIFEST
 * (`shared/src/harnessManifests/`, the #3118 keystone) rather than an if-ladder,
 * so a new CLI harness gains correct spawn behavior by AUTHORING A MANIFEST —
 * not by widening a conditional here.
 *
 * 🔴 Fallback Preservation Rule (CLAUDE.md) is load-bearing. Each predicate
 * AUGMENTS the pre-existing conservative default: a missing/unknown manifest
 * resolves to TODAY's behavior, never to an error and never to
 * enabled-by-default persistence. That is why the lookup uses the NON-throwing
 * {@link tryResolveHarnessManifest} (throwing `resolveHarnessManifest` would
 * throw on an unknown id — optional-chaining it would NOT catch the throw) and
 * why each helper carries an explicit `?? current-conservative` tail.
 *
 * Name-collision note (KD4): the manifest axis consulted here is
 * `HarnessManifest.sessionPersistence.tmuxSafe`; the repo also has an unrelated
 * `@/sessionPersistence` MODULE (the recovery/metadata store). They are
 * distinct — this file references the manifest FIELD, not the store.
 *
 * The role/outputStyle axes are tri-state (`native` | `emulated` | `absent`,
 * #3118). The conversion rule is `=== "native"` (expert ruling 1B-15): this is
 * byte-identical with today's claude-only truth (claude is `native`, the other
 * stock-4 are `absent`). Whether an `emulated` axis should ever count as
 * "supported" is deliberately LEFT OPEN as future work — do not decide it here.
 */
import { tryResolveHarnessManifest } from "@hapi/protocol";

/**
 * Whether an agent's sessions survive on the tmux-persistence path.
 *
 * Manifest: `sessionPersistence.tmuxSafe`. Conservative fallback (missing/unknown
 * manifest) reproduces today's `agent === "claude" || agent === "codex"`.
 */
export function harnessSupportsPersistence(agent: string | undefined): boolean {
  const manifest = agent ? tryResolveHarnessManifest(agent) : undefined;
  if (manifest) {
    return manifest.sessionPersistence.tmuxSafe;
  }
  return agent === "claude" || agent === "codex";
}

/**
 * Whether an agent honors Hapimatic's role-scoped `@`-include profile
 * (`--hapi-session-role`).
 *
 * Manifest: `sessionRoles === "native"`. Conservative fallback (missing/unknown
 * manifest) reproduces today's `agent === "claude" || !agent` — the `!agent`
 * branch (undefined agent = claude default) is preserved for byte-identical
 * behavior even though `sessionSpawner`'s caller currently defaults `agent` to
 * `"claude"`.
 */
export function harnessSupportsSessionRole(agent: string | undefined): boolean {
  const manifest = agent ? tryResolveHarnessManifest(agent) : undefined;
  if (manifest) {
    return manifest.sessionRoles === "native";
  }
  return agent === "claude" || !agent;
}

/**
 * Whether an agent honors Hapimatic's per-session output style
 * (`--hapi-output-style`).
 *
 * Manifest: `outputStyles === "native"`. Conservative fallback (missing/unknown
 * manifest) reproduces today's `agent === "claude" || !agent` (see
 * {@link harnessSupportsSessionRole} for the `!agent` rationale).
 */
export function harnessSupportsOutputStyle(agent: string | undefined): boolean {
  const manifest = agent ? tryResolveHarnessManifest(agent) : undefined;
  if (manifest) {
    return manifest.outputStyles === "native";
  }
  return agent === "claude" || !agent;
}
