// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Issue #1653: best-effort epoch-ms extraction from a scanner message for the
 * blocked-on-TUI-prompt since-guard. Transcript entries carry an untyped ISO
 * `timestamp` (RawJSONLines is `.passthrough()` — cli/src/claude/types.ts; the
 * field is not on the typed shape, per fable-review [1653-4]). Returns
 * `undefined` when absent/unparseable, in which case the caller
 * (`clearTuiPromptOnActivity`) falls back to an unconditional clear.
 *
 * Shared by the tmux and pty launchers (issue #6586, Task 14), so both clear a
 * blocking TUI prompt on later transcript activity in the same way.
 */
export function extractActivityEpochMs(message: unknown): number | undefined {
  if (message && typeof message === "object" && "timestamp" in message) {
    const ts = (message as { timestamp?: unknown }).timestamp;
    if (typeof ts === "string") {
      const ms = Date.parse(ts);
      return Number.isNaN(ms) ? undefined : ms;
    }
  }
  return undefined;
}
