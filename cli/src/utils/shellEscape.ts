// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Shell single-quote escaping + the tmux spawn-command length ceiling.
 *
 * Zero-dependency leaf module (issue #3748, Sub H, Task 3). Hosting the
 * single-quote escaper here lets the daemon (`daemon/tmuxSpawnAdapter.ts`), the
 * launchers (`claude/launcherShared.ts`, `claude/claudeTmuxRemote.ts`) and the
 * tmux layer (`tmux/TmuxManager.ts`) all import ONE implementation without a
 * cross-module import cycle. It consolidates four former byte-identical copies:
 * the local `escapeShellArg`, the exported `shellSingleQuote`, the local
 * `shellQuote`, and an inline copy in TmuxManager. KD-2: one consolidated
 * escaper means the character-safety guarantee is discharged against the
 * function every launch path actually calls, not just the daemon path.
 */

/**
 * Single-quote-wrap a value for safe interpolation into a POSIX shell command.
 *
 * Canonical POSIX escaping: wrap in single quotes and encode every embedded
 * single quote as `'\''` (close-quote, escaped-quote, reopen-quote). Single-
 * quote wrapping neutralises spaces, `$`, backticks, `;`, `&`, newlines and
 * every other shell metacharacter; it round-trips every possible input (there
 * is no character it cannot represent) and no second single-quote layer can
 * re-break it.
 */
export function shellEscape(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Hard ceiling (UTF-8 bytes) on an assembled tmux-launcher spawn command line.
 *
 * `claudeTmuxRemote` ships the ENTIRE spawn command to `tmux send-keys` as a
 * single literal argument (`claudeTmuxRemote.ts`, step 7 — no `-l`, and no
 * temp-script mitigation, unlike the daemon path at
 * `tmuxSpawnAdapter.ts:757-766`). tmux relays that command to its server over an
 * imsg bounded by `MAX_IMSGSIZE` = 16384 bytes, so an over-long command is
 * rejected with "command too long" and the session silently fails to start.
 * Tier-0 capability injection (issue #3748) inflates the `--append-system-prompt`
 * argument, so we bound the assembled command and fail loudly BEFORE spawn.
 *
 * Empirically measured on the deployment's tmux 3.3a (RP1): a 14336-byte
 * send-keys command delivered intact; 16384 was rejected "command too long"
 * (consistent with imsg `MAX_IMSGSIZE`). The R2 budget cap bounds the injected
 * system prompt to ~5.5 KiB, so the realistic `fullCommand` operating point is
 * ~7 KiB. 12 KiB (12288) sits above that — headroom for a long cwd / extra
 * args — and safely below the ~16 KiB tmux wall. When a command exceeds it the
 * spawn fails loudly and the `HAPI_CAPABILITY_TIER0=0` kill-switch restores the
 * pre-Tier-0 prompt (issue #3748 rollback path).
 */
export const MAX_SPAWN_COMMAND_LEN = 12288;

/**
 * Thrown by {@link assertSpawnCommandLength} when an assembled spawn command
 * line exceeds {@link MAX_SPAWN_COMMAND_LEN}. Named so callers (and the launcher
 * retry logic) can distinguish this deterministic pre-spawn guard from a
 * transient tmux/send-keys fault.
 */
export class SpawnCommandTooLongError extends Error {
  readonly commandBytes: number;
  readonly limit: number;

  constructor(commandBytes: number, limit: number = MAX_SPAWN_COMMAND_LEN) {
    super(
      `Spawn command line is ${commandBytes} bytes, exceeding the ${limit}-byte ` +
        `tmux send-keys ceiling — tmux would reject it "command too long" and the ` +
        `session would fail to start. This usually means capability Tier-0 ` +
        `injection inflated the system prompt past the safe bound; set ` +
        `HAPI_CAPABILITY_TIER0=0 to restore the pre-Tier-0 prompt.`
    );
    this.name = "SpawnCommandTooLongError";
    this.commandBytes = commandBytes;
    this.limit = limit;
  }
}

/**
 * Fail loudly, BEFORE spawning, when an assembled spawn command line would
 * exceed the tmux send-keys ceiling. Measures UTF-8 bytes (not JS string
 * length) because the imsg limit is byte-denominated and the command can carry
 * multi-byte characters — measuring `.length` would under-count and let an
 * over-limit command slip through into the exact "command too long" failure
 * this guard prevents. Called by `buildTmuxRemoteSpawnCommand` right after the
 * command is assembled and before it reaches `tmux send-keys`.
 */
export function assertSpawnCommandLength(
  command: string,
  limit: number = MAX_SPAWN_COMMAND_LEN
): void {
  const bytes = Buffer.byteLength(command, "utf8");
  if (bytes > limit) {
    throw new SpawnCommandTooLongError(bytes, limit);
  }
}
