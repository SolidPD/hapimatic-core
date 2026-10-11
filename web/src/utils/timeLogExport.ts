// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Generate filename with date.
 *
 * Generic export helper kept in core (issue #1278): consumed by BOTH the
 * `builtin.time-log` extension AND `web/src/routes/settings/session-metadata.tsx`.
 * The time-log-specific export functions (`exportToCSV`, `exportDerivedToCSV`,
 * `exportToJSON`) moved to `web/src/extensions/time-log/timeLogExport.ts`.
 */
export function generateExportFilename(
  prefix: string,
  extension: string,
  date?: string
): string {
  const dateStr = date ?? new Date().toISOString().split("T")[0];
  return `${prefix}-${dateStr}.${extension}`;
}
