// SPDX-License-Identifier: AGPL-3.0-only
import type { DerivedDailyBucket, TimeLogEntry } from "@/types/api";
import { formatDurationShort } from "@/utils/easternTime";

/**
 * Time-log-specific export helpers (issue #1278: moved out of core
 * `web/src/utils/timeLogExport.ts` into the `builtin.time-log` extension). The
 * generic `generateExportFilename` stays in core (shared with session-metadata).
 */

/**
 * Download a blob as a file
 */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Export legacy time log entries (the read-only `timelog_entries` archive) to
 * CSV format. No caller since #6675, which made the Time Log's CSV export the
 * derived one ({@link exportDerivedToCSV}). Kept because W5 (#4431) owns the
 * export rework and routes this function through its shared `toCsv` helper.
 */
export function exportToCSV(entries: TimeLogEntry[], filename: string): void {
  // CSV header
  const headers = [
    "Date",
    "Session Name",
    "Project Directory",
    "Duration (ms)",
    "Duration",
  ];

  // CSV rows
  const rows = entries.map(entry => [
    entry.date,
    // Escape quotes in strings
    `"${entry.sessionName.replace(/"/g, '""')}"`,
    `"${entry.projectDirectory.replace(/"/g, '""')}"`,
    entry.durationMs.toString(),
    formatDurationShort(entry.durationMs),
  ]);

  // Combine header and rows
  const csv = [headers.join(","), ...rows.map(row => row.join(","))].join("\n");

  // Create blob and download
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  downloadBlob(blob, filename);
}

/**
 * Issue #1670 (Sub H1, PR-2): export the TS-derived daily buckets to CSV.
 * The Time Log's CSV export since #6675 retired the cutover gate. The columns
 * intentionally differ from the legacy per-entry export (per-day
 * auto/adjustment/net totals).
 */
export function exportDerivedToCSV(
  buckets: DerivedDailyBucket[],
  filename: string
): void {
  const headers = [
    "Date",
    "Namespace",
    "Auto (ms)",
    "Adjustment (ms)",
    "Net (ms)",
    "Net",
  ];
  const rows = buckets.map(b => [
    b.localDate,
    `"${(b.namespace ?? "").replace(/"/g, '""')}"`,
    b.autoMs.toString(),
    b.adjustmentMs.toString(),
    b.netMs.toString(),
    formatDurationShort(b.netMs),
  ]);
  const csv = [headers.join(","), ...rows.map(row => row.join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  downloadBlob(blob, filename);
}

/**
 * Export time log entries to JSON format
 */
export function exportToJSON(entries: TimeLogEntry[], filename: string): void {
  // Create a clean export object with formatted durations
  const exportData = {
    exportedAt: new Date().toISOString(),
    entriesCount: entries.length,
    totalDurationMs: entries.reduce((sum, e) => sum + e.durationMs, 0),
    entries: entries.map(entry => ({
      date: entry.date,
      sessionId: entry.sessionId,
      sessionName: entry.sessionName,
      projectDirectory: entry.projectDirectory,
      durationMs: entry.durationMs,
      durationFormatted: formatDurationShort(entry.durationMs),
    })),
  };

  // Pretty print JSON
  const json = JSON.stringify(exportData, null, 2);

  // Create blob and download
  const blob = new Blob([json], { type: "application/json;charset=utf-8;" });
  downloadBlob(blob, filename);
}
