// SPDX-License-Identifier: AGPL-3.0-only
// Ported from tiann/hapi@34f931ef5 (cli/src/codex/utils/terminalEventGuard.ts), AGPL-3.0-only, with changes;
// the thread-scoped rules follow tiann/hapi@19e74456.
/**
 * Decides whether a terminal event (`task_complete`, `task_failed`,
 * `turn_aborted`) belongs to the turn a caller is waiting on (#6263). A turn
 * promise must settle only on its own terminal event.
 */

export type TerminalEventGuardInput = {
  /** The turn id the event carries, if any. */
  eventTurnId: string | null;
  /** The turn the caller is waiting on, once `turn/start` answered. */
  currentTurnId: string | null;
  /** A turn is in flight (started, not settled). */
  turnInFlight: boolean;
  /** Accept an event without a turn id while a turn is in flight. */
  allowAnonymousTerminalEvent?: boolean;
  eventThreadId?: string | null;
  currentThreadId?: string | null;
  /** Accept an event without a turn id when its thread matches (thread systemError). */
  allowMatchingThreadIdTerminalEvent?: boolean;
};

export function shouldIgnoreTerminalEvent(
  input: TerminalEventGuardInput
): boolean {
  const hasMatchingThreadId = Boolean(
    input.eventThreadId &&
    input.currentThreadId &&
    input.eventThreadId === input.currentThreadId
  );

  if (input.eventTurnId) {
    return Boolean(
      input.currentTurnId && input.eventTurnId !== input.currentTurnId
    );
  }

  if (
    input.allowMatchingThreadIdTerminalEvent === true &&
    hasMatchingThreadId
  ) {
    return false;
  }

  if (input.currentTurnId) return true;

  if (input.turnInFlight && input.allowAnonymousTerminalEvent !== true) {
    return true;
  }

  return false;
}
