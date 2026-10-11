// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Duration formatting + parsing helpers.
 *
 * Issue #1892 (Sub H2): extracted from `hooks/useSessionTimer.ts` before that
 * legacy free-running client-timer hook was deleted. These two pure helpers are
 * consumed across the app (session list/header, time-log modal + charts,
 * schedule entries, export) and are unrelated to the deleted timer machinery, so
 * they live here as standalone utilities.
 */

/**
 * Parse a human time input into milliseconds.
 * Accepts seconds ("45"), M:SS / MM:SS ("5:00"), or H:MM:SS / HH:MM:SS
 * ("1:30:00"). Returns null for empty or malformed input.
 */
export function parseTimeInput(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Pattern: seconds only (e.g., "45")
  if (/^\d+$/.test(trimmed)) {
    const seconds = parseInt(trimmed, 10);
    if (seconds < 0) return null;
    return seconds * 1000;
  }

  // Pattern: M:SS or MM:SS (e.g., "5:00", "45:30")
  if (/^\d{1,2}:\d{2}$/.test(trimmed)) {
    const [minutes, seconds] = trimmed.split(":").map(n => parseInt(n, 10));
    if (seconds >= 60) return null;
    return (minutes * 60 + seconds) * 1000;
  }

  // Pattern: H:MM:SS or HH:MM:SS (e.g., "1:30:00", "12:45:30")
  if (/^\d{1,2}:\d{2}:\d{2}$/.test(trimmed)) {
    const [hours, minutes, seconds] = trimmed
      .split(":")
      .map(n => parseInt(n, 10));
    if (minutes >= 60 || seconds >= 60) return null;
    return (hours * 3600 + minutes * 60 + seconds) * 1000;
  }

  return null;
}

/**
 * Format milliseconds as a human-readable duration.
 * Always returns HH:MM:SS format (00:00:00) for consistent width.
 */
export function formatDuration(ms: number): string {
  // Safety: clamp negative values to 0 to prevent garbage display.
  // This can happen briefly due to race conditions between state updates.
  const safeMs = Math.max(0, ms);
  const totalSeconds = Math.floor(safeMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
