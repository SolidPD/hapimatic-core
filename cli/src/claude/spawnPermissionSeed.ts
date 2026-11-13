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
  CLAUDE_PERMISSION_MODES,
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
 * mode, and when the args already name a mode (`--permission-mode <m>` or
 * `--permission-mode=<m>`) or skip permissions (#6400: Claude Code takes the
 * LAST mode on its argv, so an appended mode would override the caller's `=`
 * form). `default` is sent too: Claude Code accepts it (the SDK launcher passes
 * it on every launch).
 */
export function withPermissionModeArg(
  args: string[],
  mode: string | undefined
): string[] {
  if (
    !isClaudePermissionMode(mode) ||
    mode === "bypassPermissions" ||
    args.some(
      a =>
        a === "--permission-mode" ||
        a.startsWith("--permission-mode=") ||
        a === "--dangerously-skip-permissions"
    )
  ) {
    return args;
  }
  return [...args, "--permission-mode", mode];
}

/**
 * Issue #6400 P1: read the value of a
 * terminal `hapi --permission-mode <m>` / `--permission-mode=<m>`, which
 * `commands/claudeCommandArgs.ts` takes as the session's starting mode instead
 * of forwarding it to the claude child. Only a Claude mode is accepted; anything
 * else (a typo, a Hapimatic-only mode, a missing value) is refused loudly.
 */
export function parseTerminalPermissionMode(
  value: string | undefined
): ClaudePermissionMode | { error: string } {
  if (isClaudePermissionMode(value)) return value;
  return {
    error: `--permission-mode needs a Claude mode: ${CLAUDE_PERMISSION_MODES.join(", ")} (got ${value === undefined ? "no value" : `"${value}"`}).`,
  };
}

/**
 * Issue #6400 P1: the claude argv for the LOCAL (terminal) launcher. A session
 * started with a terminal `--permission-mode` no longer forwards the flag, so
 * the local child gets the session's live mode instead, as the tmux and pty
 * children do ({@link withPermissionModeArg}); a UI narrowing therefore reaches
 * it on the next launch. Any other session is unchanged: no mode is appended,
 * so a plain `hapi` still honours the user's own `permissions.defaultMode`.
 */
export function localLaunchPermissionArgs(
  args: string[],
  mode: string | undefined,
  permissionModeFromFlag: boolean | undefined
): string[] {
  return permissionModeFromFlag ? withPermissionModeArg(args, mode) : args;
}

/**
 * The SDK launcher's starting mode: a spawn-time `--dangerously-skip-permissions`
 * (from `--yolo`, the flag itself, or `--permission-mode bypassPermissions`)
 * takes precedence over the session's mode, which the SDK launcher otherwise
 * runs (#6400 P1: lifted out of `claudeRemote.ts` unchanged, as a test seam).
 */
export function sdkStartPermissionMode(
  claudeArgs: readonly string[] | undefined,
  sessionMode: ClaudePermissionMode
): ClaudePermissionMode {
  return claudeArgs?.includes("--dangerously-skip-permissions")
    ? "bypassPermissions"
    : sessionMode;
}

/**
 * Issue #6617 (Matt 43a / 43-local a / D2-1, 2026-11-11): the switch for "a
 * narrowing holds". ON unless `HAPI_PERMISSION_NARROWING_HOLDS`, trimmed and
 * lower-cased, is `0`, `false`, `no` or `off` (absent and empty are ON, D5-1).
 * Off, every launcher builds exactly the pre-#6617 argv and start mode, through
 * {@link withPermissionModeArg}, {@link localLaunchPermissionArgs} and
 * {@link sdkStartPermissionMode}, which stay unchanged for that reason.
 */
export function permissionNarrowingHolds(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const value = env.HAPI_PERMISSION_NARROWING_HOLDS?.trim().toLowerCase();
  return !(
    value === "0" ||
    value === "false" ||
    value === "no" ||
    value === "off"
  );
}

/**
 * Issue #6617 R7: the mode a child is launched in, from the session's live mode
 * (`Session.getPermissionMode()`, what the screen shows). A value that is not a
 * Claude mode becomes `default`, so the child is never wider than the screen:
 * bypass comes back only for the exact input `bypassPermissions`.
 */
export function liveChildMode(live: string | undefined): ClaudePermissionMode {
  return isClaudePermissionMode(live) ? live : "default";
}

const BYPASS_TOKENS: ReadonlySet<string> = new Set([
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
]);

/**
 * Issue #6617 (43a, D1-1): the permission flags of a child launched from
 * `args` while the session shows `live`. A live bypass keeps the args, adding
 * `--dangerously-skip-permissions` when they do not carry it (a session
 * switched to YOLO after it started runs bypass, D1-1); a start in bypass that
 * was never narrowed is therefore unchanged byte for byte (R6). Any other mode
 * drops both bypass tokens from a copy (R9: `session.claudeArgs`, the record of
 * how the session started, is never changed) and, with `appendMode`, names the
 * mode through {@link withPermissionModeArg}, which keeps its guards (no second
 * `--permission-mode`, either spelling).
 */
export function relaunchPermissionArgs(
  args: readonly string[],
  live: string | undefined,
  opts: { appendMode: boolean }
): string[] {
  const mode = liveChildMode(live);
  if (mode === "bypassPermissions") {
    return args.includes("--dangerously-skip-permissions")
      ? [...args]
      : [...args, "--dangerously-skip-permissions"];
  }
  const narrowed = args.filter(a => !BYPASS_TOKENS.has(a));
  return opts.appendMode ? withPermissionModeArg(narrowed, mode) : narrowed;
}

/**
 * Issue #6617 R7 (ii), D2-1: read the live mode at a launch. When it is not a
 * Claude mode the session is set to `default`, so the screen shows what the
 * child runs, and `warn` is told the value that was read; the launch then goes
 * ahead in `default`, never in bypass.
 */
export function settleLaunchPermissionMode(
  session: {
    getPermissionMode(): string | undefined;
    setPermissionMode(mode: ClaudePermissionMode): void;
  },
  warn: (message: string) => void
): ClaudePermissionMode {
  const raw = session.getPermissionMode();
  if (!isClaudePermissionMode(raw)) {
    session.setPermissionMode("default");
    warn(
      `permission mode ${JSON.stringify(raw)} is not a Claude mode; launching in default`
    );
  }
  return liveChildMode(raw);
}
