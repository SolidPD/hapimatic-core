// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Eastern Time date utilities for time log system
 *
 * Uses Intl.DateTimeFormat with America/New_York timezone for automatic
 * DST handling. This ensures dates are always in Eastern Time regardless
 * of the user's local timezone.
 */

/**
 * Get current date in Eastern Time as YYYY-MM-DD
 *
 * Uses 'en-CA' locale for ISO-like date format (YYYY-MM-DD)
 * Uses 'America/New_York' timezone for Eastern Time (handles DST automatically)
 */
export function getEasternTimeDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/**
 * Check if a date string is before another date string
 * Both should be in YYYY-MM-DD format
 */
export function isDateBefore(date1: string, date2: string): boolean {
  return date1 < date2;
}

/**
 * Format milliseconds as a human-readable duration for display
 * Returns format like "1h 23m" or "45m" or "0m"
 */
export function formatDurationShort(ms: number): string {
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

/**
 * Format a UTC ISO timestamp as Eastern Time date + time parts.
 *
 * The version timestamp is stored as a UTC ISO string (e.g.
 * "2026-06-04T05:49:22.583Z" — produced by `new Date().toISOString()` in
 * scripts/version-bump.ts). The default `toLocale*` formatters render in the
 * VIEWING device's local timezone, so a device resolving to UTC shows the raw
 * UTC wall-clock. Pinning `timeZone: "America/New_York"` (and `en-US` locale
 * for a deterministic M/D/YYYY format) always renders Eastern Time, DST-aware,
 * regardless of where the PWA is viewed. The time carries a `timeZoneName:
 * "short"` suffix ("EDT" in summer, "EST" in winter) so the zone is explicit.
 *
 * Returns empty strings for a falsy/invalid timestamp so callers can render
 * a blank footer without branching.
 */
export function formatEasternDateTime(timestamp: string): {
  date: string;
  time: string;
} {
  if (!timestamp) return { date: "", time: "" };
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return { date: "", time: "" };
  return {
    date: d.toLocaleDateString("en-US", { timeZone: "America/New_York" }),
    time: d.toLocaleTimeString("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }),
  };
}
