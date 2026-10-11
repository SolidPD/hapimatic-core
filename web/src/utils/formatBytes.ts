// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Format a positive, finite byte count as an IEC size string (e.g. "3.73 GiB").
 *
 * Callers own their own empty/zero/undefined sentinel ("—" / "" / etc.) at the
 * call site — this core only handles positive finite inputs (plus the `0 → "0 B"`
 * convenience for callers that want it). Extracted from the (now deleted)
 * `SystemHealthModal.tsx` private copy and the `NodeDetailDashboard` /
 * `about.tsx` duplicates (issue #3460). The git-rpc Browse formatter
 * (`extensions/git-rpc/routes/files.tsx`) intentionally stays separate — its
 * SI-labelled `KB` format is a deliberate #2518 choice (owner ruling W2 / D2-a).
 *
 * The `Math.min(units.length - 1, …)` clamp renders ≥ 1 PiB inputs in TiB — an
 * intentional robustness change vs the former modal / NodeDetailDashboard copies
 * (which would index past the array for such inputs). No current call site passes
 * ≥ 1 PiB.
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const i = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024))
  );
  const value = bytes / Math.pow(1024, i);
  // Show 2 decimal places for GiB+, 1 for MiB, 0 for smaller
  const decimals = i >= 3 ? 2 : i >= 2 ? 1 : 0;
  return `${value.toFixed(decimals)} ${units[i]}`;
}
