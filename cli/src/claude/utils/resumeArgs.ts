// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #6088: the one-time Claude flags a process is started with. The daemon
 * respawns a session (#3618 account switch, reconnect, recovery, a branch) with
 * `--resume <id>`, plus `--fork-session` for a branch; both apply to the first
 * spawn only.
 */

/** A Claude Code session id (a UUID). It becomes a file name, so nothing else passes. */
const SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The session id after the first `--resume`, or null when there is none, the
 * flag has no value, or the value is not a UUID. Launchers read it before the
 * first spawn (the scanner seeds from it, SINK-1); `consumeOneTimeFlags` removes
 * the flag after that spawn.
 */
export function resumeSessionIdFromArgs(
  args: readonly string[] | undefined
): string | null {
  if (!args) {
    return null;
  }
  const at = args.indexOf("--resume");
  if (at < 0 || at + 1 >= args.length) {
    return null;
  }
  const value = args[at + 1];
  return SESSION_ID.test(value) ? value : null;
}

/**
 * True when the value after `--resume` is consumed with it (the flag's existing
 * heuristic: not another flag, and contains a dash).
 */
export function isResumeValue(value: string | undefined): value is string {
  return value !== undefined && !value.startsWith("-") && value.includes("-");
}

/**
 * `args` without the one-time flags: every `--resume [<id>]` and every
 * `--fork-session` (issue #6088: a retained `--fork-session` made each
 * same-process relaunch of a branched session fork again). Returns undefined
 * when nothing is left, like the Session field it feeds.
 */
export function stripOneTimeFlags(
  args: readonly string[] | undefined
): string[] | undefined {
  if (!args) {
    return undefined;
  }
  const kept: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--fork-session") {
      continue;
    }
    if (arg === "--resume") {
      if (isResumeValue(args[i + 1])) {
        i++;
      }
      continue;
    }
    kept.push(arg);
  }
  return kept.length > 0 ? kept : undefined;
}
