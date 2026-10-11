// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Generic, formula-injection-safe CSV export (issue #1675, epic #1662 Sub M).
 *
 * Distinct from `timeLogExport.ts` (which quote-escapes only two fields and has
 * no formula-injection guard). M exports arbitrary `turns` text (repos, model
 * ids, session names), so it needs an escaper that:
 *   1. Quotes EVERY field (RFC-4180) so commas/quotes/newlines round-trip.
 *   2. Neutralizes CSV-injection / DDE: any cell beginning with `=`, `+`, `-`,
 *      `@`, tab, or carriage-return is prefixed with a single apostrophe so a
 *      spreadsheet does not evaluate it as a formula on open.
 */

/** Trigger a browser download of arbitrary text content as a file. */
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
 * Escape one cell value for CSV: neutralize a dangerous lead char (formula
 * injection), then quote the whole field and double internal quotes.
 */
export function escapeCsvCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  // Formula-injection / DDE defense — prefix an apostrophe when the cell would
  // otherwise be interpreted as a formula or command by a spreadsheet.
  if (/^[=+\-@\t\r]/.test(s)) {
    s = `'${s}`;
  }
  // RFC-4180: always quote, escaping embedded double-quotes.
  return `"${s.replace(/"/g, '""')}"`;
}

/** A CSV column: which key to read from each row + the header label. */
export interface CsvColumn<T> {
  key: keyof T;
  header: string;
}

/**
 * Build CSV text from rows + column definitions. Every header and cell is run
 * through `escapeCsvCell`. Rows are joined with `\n`; the header is the first line.
 */
export function toCsv<T>(rows: readonly T[], columns: CsvColumn<T>[]): string {
  const headerLine = columns.map(col => escapeCsvCell(col.header)).join(",");
  const rowLines = rows.map(row =>
    columns.map(col => escapeCsvCell(row[col.key])).join(",")
  );
  return [headerLine, ...rowLines].join("\n");
}

/** Download CSV text as a `text/csv` file. */
export function downloadCsv(csv: string, filename: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  downloadBlob(blob, filename);
}
