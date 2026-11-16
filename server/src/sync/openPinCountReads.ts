// SPDX-License-Identifier: AGPL-3.0-only
/**
 * #6458 Task 11a (#6487 SF-3): the session list and detail read the open-pin
 * counts from `session_pins`. A failed table migration is only logged at boot
 * (`store/index.ts`), so an unguarded read would throw and take the whole
 * session list down. These readers answer "no count" instead (the routes then
 * omit `openPinCount`, as they do while the gate is closed) and log one error
 * a minute, so a broken table is visible without flooding the log.
 */

type OpenPinCountSource = {
  getOpenPinCounts(): Map<string, number>;
  getOpenPinCount(sessionId: string): number;
};

/** One error line at most this often. */
export const OPEN_PIN_COUNT_LOG_EVERY_MS = 60_000;

let lastLoggedAt = Number.NEGATIVE_INFINITY;

function logUnreadable(error: unknown, now: number): void {
  if (now - lastLoggedAt < OPEN_PIN_COUNT_LOG_EVERY_MS) return;
  lastLoggedAt = now;
  console.error(
    "[pins] open-pin counts could not be read; sessions are served without them (is the session_pins table missing?)",
    error
  );
}

/** Every session's open-pin count, or `null` when the table cannot be read. */
export function readOpenPinCounts(
  engine: Pick<OpenPinCountSource, "getOpenPinCounts">,
  now: number = Date.now()
): Map<string, number> | null {
  try {
    return engine.getOpenPinCounts();
  } catch (error) {
    logUnreadable(error, now);
    return null;
  }
}

/** One session's `{ openPinCount }`, or `{}` when the table cannot be read. */
export function openPinCountField(
  engine: Pick<OpenPinCountSource, "getOpenPinCount">,
  sessionId: string,
  now: number = Date.now()
): { openPinCount?: number } {
  try {
    return { openPinCount: engine.getOpenPinCount(sessionId) };
  } catch (error) {
    logUnreadable(error, now);
    return {};
  }
}

/** Tests: forget when the last line was written. */
export function __resetOpenPinCountLog(): void {
  lastLoggedAt = Number.NEGATIVE_INFINITY;
}
