// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #6218 — the Claude starting-permission-mode seed.
 *
 * The daemon passes `--hapi-permission-mode <mode>` when a spawn should start in
 * a non-default, non-YOLO mode (the one-step-below-YOLO default is
 * `acceptEdits`). `commands/claude.ts` parses it with
 * {@link parseSpawnPermissionSeed}; `runClaude` ranks it below a saved posture
 * ({@link resolveInitialPermissionMode}) and stamps the starting posture
 * ({@link spawnPermissionStamp}). The tmux and pty launchers then pass the
 * session's LIVE mode to the claude child as `--permission-mode` through
 * {@link withPermissionModeArg}, because those launchers forward `claudeArgs`
 * to the child while the SDK launcher builds its own argv from session state.
 */
import {
  isClaudePermissionMode,
  type ClaudePermissionMode,
} from "@hapi/protocol/modes";

/**
 * Parse a `--hapi-permission-mode` value. Only a Claude mode other than
 * `bypassPermissions` is accepted (bypass is `--yolo`'s job); anything else is
 * ignored, so the session starts at its saved posture or `default`.
 */
export function parseSpawnPermissionSeed(
  value: string | undefined
): ClaudePermissionMode | undefined {
  return isClaudePermissionMode(value) && value !== "bypassPermissions"
    ? value
    : undefined;
}

/**
 * The mode a Claude session starts in: a spawn-time `--yolo` (`hard`) outranks
 * the saved posture (`metadata.permissionMode`), which outranks the
 * `--hapi-permission-mode` seed. A reconnect or daemon recovery of a session
 * the user switched therefore comes back in the switched mode.
 */
export function resolveInitialPermissionMode(input: {
  hard?: ClaudePermissionMode;
  saved?: ClaudePermissionMode;
  seed?: ClaudePermissionMode;
}): ClaudePermissionMode | undefined {
  return input.hard ?? input.saved ?? input.seed;
}

/**
 * The spawn-time posture stamp (#6218, absorbs #5353 R3), spread into the
 * session's atomic CLI-side metadata write. Every server respawn derives its
 * `yolo` from `metadata.permissionMode`, so the stamp stores `default` too: an
 * ABSENT posture means a legacy session. A posture already saved (a respawn, or
 * a disconnected save) is left alone, so a reconnect does not overwrite the
 * posture it was restored from.
 */
export function spawnPermissionStamp(
  saved: ClaudePermissionMode | undefined,
  initial: ClaudePermissionMode | undefined
): { permissionMode?: ClaudePermissionMode } {
  return saved ? {} : { permissionMode: initial ?? "default" };
}

/**
 * Append `--permission-mode <mode>` for the tmux / pty claude child, so the
 * terminal child starts in the session's mode and a user / project
 * `permissions.defaultMode` setting cannot widen it. Skipped for bypass (the
 * child already carries `--dangerously-skip-permissions`), for a non-Claude
 * mode, and when the args already name a mode or skip permissions. `default` is
 * sent too: Claude Code accepts it (the SDK launcher passes it on every launch).
 */
export function withPermissionModeArg(
  args: string[],
  mode: string | undefined
): string[] {
  if (
    !isClaudePermissionMode(mode) ||
    mode === "bypassPermissions" ||
    args.includes("--permission-mode") ||
    args.includes("--dangerously-skip-permissions")
  ) {
    return args;
  }
  return [...args, "--permission-mode", mode];
}
