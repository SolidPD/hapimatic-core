// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Pure helpers for the Account Chip label (epic #3285 correction pass 1). Kept
 * hook-free so `AccountChip`, `useAccountLabels`, and the tests can share them
 * without pulling React Query into a presentational import graph.
 */

/**
 * The chip's controlled character budget (operator ruling 2026-09-05): a
 * nickname longer than this is cut to `max − 1` characters plus an ellipsis, so
 * the chip's width is bounded by a KNOWN worst case ("Personal" and "Matt [NF]"
 * fit whole; a long nickname never pushes the Node Badge or wraps Row 1).
 */
export const ACCOUNT_CHIP_MAX_CHARS = 10;

/**
 * The nickname's own length budget (the editor's input `maxLength`). The
 * Accounts card's Row-2 chip passes this as `maxChars` so the nickname renders
 * UNTRUNCATED there — that chip is the "what the chip looks like fully
 * populated" preview, not a width-bounded list cell.
 */
export const ACCOUNT_NICKNAME_MAX_CHARS = 64;

/** The email's local part (`work@x.com` → `work`) — the last-resort label. */
export function accountShortName(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}

/** Cut `label` to the chip's character budget with a single-character ellipsis. */
export function truncateAccountLabel(
  label: string,
  maxChars: number = ACCOUNT_CHIP_MAX_CHARS
): string {
  const trimmed = label.trim();
  if (maxChars < 2 || trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars - 1).trimEnd()}…`;
}

/** The monogram letter: the label's first character, upper-cased. */
export function accountMonogram(label: string): string {
  const first = label.trim().charAt(0);
  return first ? first.toUpperCase() : "?";
}
