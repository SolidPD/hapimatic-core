// SPDX-License-Identifier: AGPL-3.0-only
// Issue #6208: built once. Constructing an Intl.DateTimeFormat costs far more
// than formatting with one, and every chat message formats its timestamp on
// each render.
const MESSAGE_TIMESTAMP_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "2-digit",
  day: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "America/New_York",
});

/**
 * Format a message timestamp in consistent MM-DD-YYYY HH:MM format
 * Uses America/New_York timezone and 24-hour time
 *
 * @param date - The date to format
 * @returns Formatted string like "01-30-2026 14:42" or empty string if no date
 */
export function formatMessageTimestamp(date: Date | undefined | null): string {
  if (!date) return "";

  const formatted = MESSAGE_TIMESTAMP_FORMAT.format(date);

  // Intl formats as "MM/DD/YYYY, HH:MM" - convert to "MM-DD-YYYY HH:MM"
  return formatted.replace(/\//g, "-").replace(",", "");
}
